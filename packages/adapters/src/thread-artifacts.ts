import { createHash } from "node:crypto";
import path from "node:path";
import type {
  AdapterContext,
  ArtifactStore,
  ComputerRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { ComputerMode, MessageBlock } from "@rakazo/contracts";
import {
  ARTIFACT_DESCRIPTION_MAX_LENGTH,
  ARTIFACT_NAME_MAX_LENGTH,
  ATTACHMENT_MAX_BYTES,
} from "@rakazo/contracts";
import {
  attachmentExtensionForMimeType,
  inferAttachmentMimeType,
  messageBlockForArtifact,
  validateAttachmentMimeType,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { withResolvedArtifactVersion } from "@rakazo/db";
import { resolveBotWorkspacePath } from "./computer-support.js";

export type MaterializedThreadFile = {
  name: string;
  mimeType: string;
  size: number;
  path: string;
};

export async function attachWorkspaceFileToThread(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
  },
  input: {
    spaceId: string;
    userId: string;
    botId: string;
    groupId?: string;
    runId: string;
    filePath: string;
    bytes: Uint8Array;
    operationId: string;
    name?: string;
    description?: string;
  },
): Promise<{ artifactId: string; block: Extract<MessageBlock, { kind: "image" | "file" }> }> {
  const fileName = path.basename(input.filePath) || input.filePath;
  const mimeType = inferAttachmentMimeType(fileName);
  if (!mimeType) {
    throw new Error(`Unsupported attachment type for ${fileName}`);
  }
  const name = (input.name?.trim() || fileName).slice(0, ARTIFACT_NAME_MAX_LENGTH);
  validateAttachmentMimeType(mimeType);
  if (input.bytes.byteLength > ATTACHMENT_MAX_BYTES) {
    throw new Error("file exceeds the 10 MiB attachment limit");
  }

  const context = {
    operationId: input.operationId,
    traceId: input.operationId,
    spaceId: input.spaceId,
    userId: input.userId,
    botId: input.botId,
    signal: new AbortController().signal,
  };
  const stored = await deps.artifacts.put({ name, mimeType, bytes: input.bytes }, context);
  const hash = createHash("sha256").update(input.bytes).digest("hex");
  const row = await withResolvedArtifactVersion(
    deps.prisma,
    {
      spaceId: input.spaceId,
      userId: input.userId,
      botId: input.botId,
      groupId: input.groupId,
      name,
    },
    (tx, { rootArtifactId, version }) =>
      tx.artifact.create({
        data: {
          spaceId: input.spaceId,
          userId: input.userId,
          botId: input.botId,
          groupId: input.groupId,
          runId: input.runId,
          name,
          description: input.description?.trim().slice(0, ARTIFACT_DESCRIPTION_MAX_LENGTH) || null,
          mimeType,
          size: input.bytes.byteLength,
          hash,
          storageKey: stored.id,
          rootArtifactId,
          version,
        },
      }),
  ).catch(async (error) => {
    await deps.artifacts.remove(stored.id, context).catch(() => undefined);
    throw error;
  });
  return {
    artifactId: row.id,
    block: messageBlockForArtifact({
      id: row.id,
      name: row.name,
      mimeType: row.mimeType,
      size: row.size,
    }),
  };
}

export async function materializeCurrentTurnFiles(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
    sandbox: SandboxProvider;
  },
  blocks: MessageBlock[] | undefined,
  input: {
    context: AdapterContext & { botId: string };
    computer: ComputerRef;
    computerMode: ComputerMode;
    markWorkspaceDirty?: () => void;
  },
): Promise<MaterializedThreadFile[]> {
  // "image" attachments (e.g. a photo pasted or uploaded in chat) are backed
  // by a real artifact exactly like "file" ones — the model seeing them
  // inline for vision (loadCurrentTurnImages) doesn't put them on disk, so
  // they must be included here too or a bot can describe a photo it can't
  // actually attach, forward, or hand to a tool that needs the file.
  const fileBlocks = blocks?.filter(
    (block): block is Extract<MessageBlock, { kind: "file" | "image" }> =>
      block.kind === "file" || block.kind === "image",
  );
  if (!fileBlocks?.length) return [];

  const rows = await deps.prisma.artifact.findMany({
    where: {
      id: { in: fileBlocks.map((block) => block.artifactId) },
      spaceId: input.context.spaceId,
      userId: input.context.userId,
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const materialized: MaterializedThreadFile[] = [];

  for (const block of fileBlocks) {
    const row = byId.get(block.artifactId);
    if (!row) throw new Error(`Attached file is unavailable: ${block.name}`);
    const bytes = await deps.artifacts.get(row.storageKey, input.context);
    if (bytes.byteLength > ATTACHMENT_MAX_BYTES) {
      throw new Error(`Attached file exceeds the 10 MiB limit: ${row.name}`);
    }
    const relativePath = `attachments/${row.id}${attachmentExtensionForMimeType(row.mimeType)}`;
    input.markWorkspaceDirty?.();
    await deps.sandbox.writeFile(
      input.computer,
      {
        path: resolveBotWorkspacePath(input.computerMode, input.context.botId, relativePath),
        content: bytes,
      },
      input.context,
    );
    materialized.push({
      name: row.name,
      mimeType: row.mimeType,
      size: row.size,
      path: relativePath,
    });
  }

  return materialized;
}

export function currentTurnFilesInstruction(files: readonly MaterializedThreadFile[]): string {
  if (!files.length) return "";
  return [
    "Current-turn attached files are available on your computer. Inspect them before answering:",
    ...files.map(
      (file) =>
        `- ${JSON.stringify(file.name)} (${file.mimeType}, ${file.size} bytes): ${JSON.stringify(file.path)}`,
    ),
  ].join("\n");
}

export type ManifestDiagramEntry = {
  file?: string;
  title?: string;
  anatomy_note?: string;
  citation?: string;
  match?: string[];
};

/** Pure concept matcher for a curated image manifest: entries whose `match` phrases
 * (default: file stem with spaces) appear in the lowercased answer text, one per
 * distinct file, capped at maxDiagrams. */
export function manifestDiagramsForAnswer(
  concepts: Record<string, ManifestDiagramEntry>,
  answerText: string,
  maxDiagrams = 3,
): ManifestDiagramEntry[] {
  const haystack = answerText.toLowerCase();
  const picked: ManifestDiagramEntry[] = [];
  const files = new Set<string>();
  for (const entry of Object.values(concepts)) {
    if (picked.length >= maxDiagrams) break;
    const file = typeof entry?.file === "string" ? entry.file : "";
    if (!file || files.has(file)) continue;
    const stem = (file.split("/").pop() ?? "").replace(/\.[^.]+$/, "").replace(/_/g, " ");
    const phrases = (entry.match?.length ? entry.match : [stem])
      .map((phrase) => phrase.toLowerCase().trim())
      .filter(Boolean);
    if (!phrases.some((phrase) => haystack.includes(phrase))) continue;
    files.add(file);
    picked.push(entry);
  }
  return picked;
}

/** Deterministic curated-diagram attach: when the bot workspace carries
 * anatomy/MANIFEST.json and the final answer covers a curated concept, attach the
 * matching diagram even if the model never called attach_file (it sometimes claims
 * the tool or the files are missing when they are not). Images the model already
 * attached this run (identical bytes) are skipped via sha256. */
export async function autoAttachManifestDiagrams(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
    sandbox: SandboxProvider;
  },
  input: {
    computer: ComputerRef;
    context: AdapterContext;
    computerMode: ComputerMode;
    botId: string;
    spaceId: string;
    userId: string;
    runId: string;
    groupId?: string;
    answerText: string;
    maxDiagrams?: number;
  },
): Promise<MessageBlock[]> {
  const readWorkspaceFile = (relativePath: string) =>
    deps.sandbox.readFile(
      input.computer,
      resolveBotWorkspacePath(input.computerMode, input.botId, relativePath),
      input.context,
      { maxBytes: ATTACHMENT_MAX_BYTES },
    );
  let manifestRaw: Uint8Array;
  try {
    manifestRaw = await readWorkspaceFile("anatomy/MANIFEST.json");
  } catch {
    return [];
  }
  let concepts: Record<string, ManifestDiagramEntry> = {};
  try {
    const parsed = JSON.parse(new TextDecoder().decode(manifestRaw)) as {
      concepts?: Record<string, ManifestDiagramEntry>;
    };
    concepts = parsed.concepts ?? {};
  } catch {
    return [];
  }
  const blocks: MessageBlock[] = [];
  for (const entry of manifestDiagramsForAnswer(concepts, input.answerText, input.maxDiagrams)) {
    try {
      const file = entry.file as string;
      const bytes = await readWorkspaceFile(file);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const already = await deps.prisma.artifact.findFirst({
        where: { runId: input.runId, hash },
        select: { id: true },
      });
      if (already) continue;
      const attached = await attachWorkspaceFileToThread(deps, {
        spaceId: input.spaceId,
        userId: input.userId,
        botId: input.botId,
        groupId: input.groupId,
        runId: input.runId,
        filePath: file,
        bytes,
        operationId: `${input.runId}:auto-diagram`,
        name: typeof entry.title === "string" ? entry.title : undefined,
        description: typeof entry.anatomy_note === "string" ? entry.anatomy_note : undefined,
      });
      blocks.push(attached.block);
      if (entry.citation) blocks.push({ kind: "text", text: entry.citation });
    } catch {
      // One unreadable/unattachable diagram never breaks the reply.
      continue;
    }
  }
  return blocks;
}
