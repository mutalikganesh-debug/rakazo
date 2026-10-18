import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { Actor } from "@rakazo/contracts";
import type { Context, Hono } from "hono";
import { readBoundedBody } from "./http-body.js";

// Zero-cap file delivery: chunked/resumable uploads + Range downloads.
// No request-body limit is mounted here on purpose: chunks may be any size and
// files may be any size (bounded only by disk). State lives on the dataDir
// volume, so uploads survive container recreation and remain resumable.

export const MAX_META_REQUEST_BYTES = 8 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

interface FileMeta {
  id: string;
  name: string;
  mimeType: string;
  /** Declared total size when the client provides one; null = unbounded until complete. */
  size: number | null;
  spaceId: string;
  userId: string;
  createdAt: string;
  completedAt: string | null;
  sha256: string | null;
  state: "uploading" | "complete";
}

/** Single-range header parse. null = serve the full body; "unsatisfiable" = 416. */
export function parseRangeHeader(
  header: string | null | undefined,
  size: number,
): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null; // malformed or multi-range: RFC allows ignoring Range
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  if (size === 0) return "unsatisfiable";
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (start > size - 1 || start > end) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, "_").slice(0, 200) || "download";
}

function transferRoot(dataDir: string): string {
  return path.join(dataDir, "file-transfers");
}

function fileDir(dataDir: string, spaceId: string, fileId: string): string {
  return path.join(transferRoot(dataDir), spaceId, fileId);
}

function metaPath(dir: string): string {
  return path.join(dir, "meta.json");
}

function partPath(dir: string): string {
  return path.join(dir, "data.part");
}

function dataPath(dir: string): string {
  return path.join(dir, "data");
}

async function readMeta(dir: string): Promise<FileMeta | null> {
  try {
    const handle = await open(metaPath(dir), "r");
    try {
      return JSON.parse(await handle.readFile("utf8")) as FileMeta;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function writeMeta(dir: string, meta: FileMeta): Promise<void> {
  const tmp = `${metaPath(dir)}.tmp`;
  await writeFile(tmp, JSON.stringify(meta), "utf8");
  await rename(tmp, metaPath(dir));
}

/** Bytes accepted so far, straight from disk — no in-memory accounting to drift. */
async function receivedBytes(dir: string, state: FileMeta["state"]): Promise<number> {
  try {
    return (await stat(state === "complete" ? dataPath(dir) : partPath(dir))).size;
  } catch {
    return 0;
  }
}

function owner(meta: FileMeta, actor: Actor): boolean {
  return meta.spaceId === actor.spaceId && meta.userId === actor.userId;
}

function transferResponse(meta: FileMeta, received: number) {
  return {
    fileId: meta.id,
    uploadId: meta.id,
    name: meta.name,
    mimeType: meta.mimeType,
    size: meta.size,
    receivedBytes: received,
    state: meta.state,
    sha256: meta.sha256,
    downloadPath: `/api/files/${meta.id}`,
  };
}

export function mountFileTransferRoutes(
  app: Hono,
  deps: { dataDir: string },
  authenticate: (c: Context) => Promise<Actor | null>,
) {
  // Start (or restart) an upload session.
  app.post("/api/files/uploads", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const raw = await readBoundedBody(c.req.raw, MAX_META_REQUEST_BYTES);
    if (raw === null) return c.json({ error: "Request body is too large." }, 413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body." }, 400);
    }
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 255) : "";
    if (!name) return c.json({ error: "name is required." }, 400);
    const mimeType =
      typeof body.mimeType === "string" && body.mimeType.trim()
        ? body.mimeType.trim().slice(0, 255)
        : "application/octet-stream";
    const size =
      typeof body.size === "number" && Number.isSafeInteger(body.size) && body.size >= 0
        ? body.size
        : null;
    const id = randomUUID();
    const dir = fileDir(deps.dataDir, actor.spaceId, id);
    await mkdir(dir, { recursive: true });
    await writeMeta(dir, {
      id,
      name,
      mimeType,
      size,
      spaceId: actor.spaceId,
      userId: actor.userId,
      createdAt: new Date().toISOString(),
      completedAt: null,
      sha256: null,
      state: "uploading",
    });
    await (await open(partPath(dir), "a")).close();
    return c.json(
      {
        uploadId: id,
        fileId: id,
        receivedBytes: 0,
        size,
        state: "uploading",
        downloadPath: `/api/files/${id}`,
      },
      201,
    );
  });

  // Resume probe: where do I continue from?
  app.get("/api/files/uploads/:id", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    if (!ID_PATTERN.test(id)) return c.json({ error: "Not found" }, 404);
    const dir = fileDir(deps.dataDir, actor.spaceId, id);
    const meta = await readMeta(dir);
    if (!meta || !owner(meta, actor)) return c.json({ error: "Not found" }, 404);
    return c.json(transferResponse(meta, await receivedBytes(dir, meta.state)));
  });

  // Append a chunk at the given offset. Overlap is tolerated (idempotent retry);
  // a gap is refused with the current offset so the client can resync.
  app.patch("/api/files/uploads/:id", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    if (!ID_PATTERN.test(id)) return c.json({ error: "Not found" }, 404);
    const dir = fileDir(deps.dataDir, actor.spaceId, id);
    const meta = await readMeta(dir);
    if (!meta || !owner(meta, actor)) return c.json({ error: "Not found" }, 404);
    if (meta.state !== "uploading") return c.json({ error: "Upload already complete." }, 409);
    const offsetHeader = c.req.header("x-upload-offset");
    const offset =
      offsetHeader !== undefined && /^[0-9]+$/.test(offsetHeader) ? Number(offsetHeader) : -1;
    if (offset < 0 || !Number.isSafeInteger(offset)) {
      return c.json({ error: "x-upload-offset header required." }, 400);
    }
    const received = await receivedBytes(dir, meta.state);
    if (offset > received) {
      return c.json(
        { error: "Offset gap; resend from receivedBytes.", receivedBytes: received },
        409,
      );
    }
    const handle = await open(partPath(dir), "r+");
    try {
      let pos = offset;
      if (c.req.raw.body) {
        const stream = Readable.fromWeb(
          c.req.raw.body as unknown as import("node:stream/web").ReadableStream,
        );
        for await (const chunk of stream) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          await handle.write(buf, 0, buf.length, pos);
          pos += buf.length;
        }
      }
    } finally {
      await handle.close();
    }
    return c.json({ uploadId: id, receivedBytes: await receivedBytes(dir, meta.state) });
  });

  // Seal the upload: verify the declared size (if any), hash, finalize.
  app.post("/api/files/uploads/:id/complete", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    if (!ID_PATTERN.test(id)) return c.json({ error: "Not found" }, 404);
    const dir = fileDir(deps.dataDir, actor.spaceId, id);
    const meta = await readMeta(dir);
    if (!meta || !owner(meta, actor)) return c.json({ error: "Not found" }, 404);
    if (meta.state === "complete") return c.json(transferResponse(meta, meta.size ?? 0));
    const received = await receivedBytes(dir, meta.state);
    if (meta.size !== null && meta.size !== received) {
      return c.json({ error: "Size mismatch.", receivedBytes: received, expected: meta.size }, 422);
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(partPath(dir))) {
      hash.update(chunk as Buffer);
    }
    await rename(partPath(dir), dataPath(dir));
    const done: FileMeta = {
      ...meta,
      state: "complete",
      size: received,
      sha256: hash.digest("hex"),
      completedAt: new Date().toISOString(),
    };
    await writeMeta(dir, done);
    return c.json(transferResponse(done, received));
  });

  // Delivered files for the caller.
  app.get("/api/files", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const spaceRoot = path.join(transferRoot(deps.dataDir), actor.spaceId);
    let entries: string[] = [];
    try {
      entries = await readdir(spaceRoot);
    } catch {
      entries = [];
    }
    const files: unknown[] = [];
    for (const entry of entries.slice(0, 1000)) {
      if (!ID_PATTERN.test(entry)) continue;
      const meta = await readMeta(path.join(spaceRoot, entry));
      if (meta?.state !== "complete" || !owner(meta, actor)) continue;
      files.push(transferResponse(meta, meta.size ?? 0));
    }
    files.sort((a, b) =>
      String((b as { createdAt: string }).createdAt).localeCompare(
        String((a as { createdAt: string }).createdAt),
      ),
    );
    return c.json({ files: files.slice(0, 100) });
  });

  // Streamed download with HTTP Range support (206/416), any size.
  app.on(["GET", "HEAD"], "/api/files/:id", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    if (!ID_PATTERN.test(id)) return c.json({ error: "Not found" }, 404);
    const dir = fileDir(deps.dataDir, actor.spaceId, id);
    const meta = await readMeta(dir);
    if (meta?.state !== "complete" || !owner(meta, actor)) {
      return c.json({ error: "Not found" }, 404);
    }
    const size = await receivedBytes(dir, meta.state);
    const headers: Record<string, string> = {
      "accept-ranges": "bytes",
      "content-type": meta.mimeType || "application/octet-stream",
      "content-disposition": `attachment; filename="${sanitizeFilename(meta.name)}"`,
      "cache-control": "no-store",
    };
    if (meta.sha256) headers["x-content-sha256"] = meta.sha256;
    const range = parseRangeHeader(c.req.header("range"), size);
    if (range === "unsatisfiable") {
      return c.body(null, 416, { ...headers, "content-range": `bytes */${size}` });
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const length = size === 0 ? 0 : end - start + 1;
    headers["content-length"] = String(length);
    if (range) {
      headers["content-range"] = `bytes ${start}-${end}/${size}`;
    }
    if (c.req.method === "HEAD" || length === 0) {
      return c.body(null, range ? 206 : 200, headers);
    }
    const stream = createReadStream(dataPath(dir), { start, end });
    return c.body(Readable.toWeb(stream) as unknown as ReadableStream, range ? 206 : 200, headers);
  });
}
