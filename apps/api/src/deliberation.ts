/**
 * Multi-agent deliberation: named agents with role personas deliberate visibly
 * on a question (bounded fan-out -> cross-comment rounds -> one joint answer).
 *
 * The orchestration loop (`runDeliberation`) is pure over an injected `complete`
 * fn so it is unit-testable with stubbed model calls; `createModelComplete` is
 * the production caller backed by the user's existing model credential rows
 * (UserModelCredential / SpaceModelPreference + secret store).
 */

import { parseModelSecret } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";

export type SecretLoader = {
  load: (ciphertext: string, id: string) => Promise<string>;
};

export type DeliberationAgent = {
  id: string;
  name: string;
  role: string;
  persona: string;
  modelProvider: string | null;
  modelId: string | null;
  color: string;
};

export type TurnKind = "user" | "agent" | "note" | "joint";

export type DeliberationTurn = {
  seq: number;
  kind: TurnKind;
  agentId: string | null;
  agentName: string;
  round: number;
  content: string;
  meta?: { error?: boolean; synthesizer?: string };
};

export type CompleteArgs = {
  agent: DeliberationAgent;
  system: string;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
};

export type CompleteFn = (args: CompleteArgs) => Promise<string>;

export type DeliberationResult = {
  turns: DeliberationTurn[];
  jointAnswer: string | null;
  dissent: string | null;
  status: "complete" | "error";
};

export type DeliberationLimits = {
  minAgents: number;
  maxAgents: number;
  crossRounds: number;
  maxTokensPerTurn: number;
  maxTokensSynthesis: number;
  callTimeoutMs: number;
  synthesisTimeoutMs: number;
  timeoutGraceMs: number;
  questionMaxChars: number;
  peerTakeChars: number;
};

export const DELIBERATION_LIMITS: DeliberationLimits = {
  minAgents: 2,
  maxAgents: 6,
  crossRounds: 1,
  maxTokensPerTurn: 500,
  maxTokensSynthesis: 500,
  callTimeoutMs: 60_000,
  synthesisTimeoutMs: 180_000,
  timeoutGraceMs: 5_000,
  questionMaxChars: 4000,
  peerTakeChars: 600,
};

export function truncate(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars)}…`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Bounded wait: a hung model call can never outlive its budget. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Parse the synthesis output into a joint answer plus dissent lines. */
export function parseSynthesis(raw: string): { jointAnswer: string; dissent: string | null } {
  const text = raw.trim();
  const joint = text.match(/JOINT ANSWER:\s*([\s\S]*)$/i);
  const body = joint?.[1]?.trim() ?? text;
  const dissentSplit = body.match(/^([\s\S]*?)\n\s*DISSENT:\s*([\s\S]*)$/i);
  const jointAnswer = (dissentSplit?.[1] ?? body).trim();
  let dissent: string | null = null;
  const dissentText = dissentSplit?.[2]?.trim();
  if (dissentText && !/^none\.?$/i.test(dissentText)) dissent = dissentText;
  return { jointAnswer, dissent };
}

function systemFor(agent: DeliberationAgent, roster: readonly DeliberationAgent[]): string {
  const peers = roster
    .filter((other) => other.id !== agent.id)
    .map((other) => `- ${other.name} (${other.role})`)
    .join("\n");
  return [
    `You are ${agent.name}, ${agent.role}, one member of a small agent team deliberating for one user.`,
    agent.persona,
    `The other members are:\n${peers}`,
    "You are speaking in a shared thread the user reads. Address the question directly; talk to your peers by name when you respond to them. Plain text only.",
  ].join("\n\n");
}

type RoundOutcome = { agent: DeliberationAgent; content?: string; error?: string };

/**
 * Bounded deterministic orchestrator loop:
 *   round 0: fan-out — every agent answers the question independently;
 *   round 1..crossRounds: each agent comments on its peers' takes;
 *   final: one synthesis call produces the joint answer + dissent.
 * Every call is bounded by maxTokens and callTimeoutMs; failures degrade to a
 * visible note turn and the loop continues. No unbounded loops anywhere.
 */
export async function runDeliberation(input: {
  question: string;
  agents: readonly DeliberationAgent[];
  complete: CompleteFn;
  startSeq?: number;
  onTurn?: (turn: DeliberationTurn) => void | Promise<void>;
  limits?: Partial<DeliberationLimits>;
}): Promise<DeliberationResult> {
  const limits: DeliberationLimits = { ...DELIBERATION_LIMITS, ...(input.limits ?? {}) };
  const question = input.question.trim();
  if (!question) throw new Error("A deliberation needs a question.");
  if (question.length > limits.questionMaxChars) {
    throw new Error(`Question is longer than ${limits.questionMaxChars} characters.`);
  }
  const agents = input.agents;
  if (agents.length < limits.minAgents)
    throw new Error(`Pick at least ${limits.minAgents} agents.`);
  if (agents.length > limits.maxAgents)
    throw new Error(`At most ${limits.maxAgents} agents per deliberation.`);

  const turns: DeliberationTurn[] = [];
  let seq = input.startSeq ?? 0;
  const emit = async (turn: Omit<DeliberationTurn, "seq">): Promise<DeliberationTurn> => {
    seq += 1;
    const full: DeliberationTurn = { seq, ...turn };
    turns.push(full);
    await input.onTurn?.(full);
    return full;
  };

  const call = (
    agent: DeliberationAgent,
    system: string,
    prompt: string,
    maxTokens: number,
    timeoutMs = limits.callTimeoutMs,
  ) =>
    withTimeout(
      input.complete({ agent, system, prompt, maxTokens, timeoutMs }),
      timeoutMs + limits.timeoutGraceMs,
      `${agent.name}`,
    );

  // Round 0 — fan-out. Calls run concurrently; turns are emitted in roster order
  // so the transcript sequence stays deterministic.
  const first: RoundOutcome[] = await Promise.all(
    agents.map(async (agent): Promise<RoundOutcome> => {
      try {
        const content = await call(
          agent,
          systemFor(agent, agents),
          `Question from the user:\n${question}\n\nGive your independent take. Be specific and practical. Max 120 words.`,
          limits.maxTokensPerTurn,
        );
        return { agent, content: content.trim() };
      } catch (error) {
        return { agent, error: errorText(error) };
      }
    }),
  );
  for (const outcome of first) {
    await emit(
      outcome.content !== undefined
        ? {
            kind: "agent",
            agentId: outcome.agent.id,
            agentName: outcome.agent.name,
            round: 0,
            content: outcome.content,
          }
        : {
            kind: "note",
            agentId: outcome.agent.id,
            agentName: outcome.agent.name,
            round: 0,
            content: `${outcome.agent.name} could not answer this round: ${outcome.error ?? "unknown error"}`,
            meta: { error: true },
          },
    );
  }

  // Cross-comment rounds — bounded above by limits.crossRounds.
  let previous = first;
  for (let round = 1; round <= limits.crossRounds; round += 1) {
    const takes = previous.filter((outcome) => outcome.content !== undefined);
    if (takes.length < 2) break;
    const next: RoundOutcome[] = await Promise.all(
      takes.map(async (outcome): Promise<RoundOutcome> => {
        const agent = outcome.agent;
        const peers = takes
          .filter((peer) => peer.agent.id !== agent.id)
          .map(
            (peer) =>
              `${peer.agent.name} (${peer.agent.role}):\n${truncate(peer.content ?? "", limits.peerTakeChars)}`,
          )
          .join("\n\n");
        try {
          const content = await call(
            agent,
            systemFor(agent, agents),
            `Question from the user:\n${question}\n\nYour peers' takes so far:\n\n${peers}\n\nRespond to your peers: say where you agree, where you disagree, and what they missed. Max 90 words.`,
            limits.maxTokensPerTurn,
          );
          return { agent, content: content.trim() };
        } catch (error) {
          return { agent, error: errorText(error) };
        }
      }),
    );
    for (const outcome of next) {
      await emit(
        outcome.content !== undefined
          ? {
              kind: "agent",
              agentId: outcome.agent.id,
              agentName: outcome.agent.name,
              round,
              content: outcome.content,
            }
          : {
              kind: "note",
              agentId: outcome.agent.id,
              agentName: outcome.agent.name,
              round,
              content: `${outcome.agent.name} could not answer this round: ${outcome.error ?? "unknown error"}`,
              meta: { error: true },
            },
      );
    }
    previous = next;
  }

  // Synthesis — one bounded call, deterministic speaker: Chief of Staff when
  // present, else the first roster entry.
  const takes = turns.filter((turn) => turn.kind === "agent" && turn.content.trim().length > 0);
  if (takes.length === 0) {
    await emit({
      kind: "note",
      agentId: null,
      agentName: "Deliberation",
      round: 0,
      content: "No agent produced an answer.",
      meta: { error: true },
    });
    return { turns, jointAnswer: null, dissent: null, status: "error" };
  }
  const synthesizer =
    agents.find((agent) => /chief/i.test(`${agent.name} ${agent.role}`)) ?? agents[0] ?? null;
  if (!synthesizer) throw new Error("unreachable: roster validated above");
  const transcript = takes
    .map(
      (turn) =>
        `${turn.agentName} (round ${turn.round}):\n${truncate(turn.content, limits.peerTakeChars)}`,
    )
    .join("\n\n");
  try {
    const raw = await call(
      synthesizer,
      systemFor(synthesizer, agents),
      `Question from the user:\n${question}\n\nThe team's takes:\n\n${transcript}\n\nConverge the team onto one answer the user can act on. Attribute disagreement honestly. Answer in EXACTLY this format:\nJOINT ANSWER:\n<one concrete answer, max 150 words>\nDISSENT:\n<one line per dissenting member in the form "Name: reason", or the single word "none">`,
      limits.maxTokensSynthesis,
      limits.synthesisTimeoutMs,
    );
    const { jointAnswer, dissent } = parseSynthesis(raw);
    await emit({
      kind: "joint",
      agentId: synthesizer.id,
      agentName: "Joint answer",
      round: 0,
      content: jointAnswer,
      meta: { synthesizer: synthesizer.name },
    });
    return { turns, jointAnswer, dissent, status: "complete" };
  } catch (error) {
    await emit({
      kind: "note",
      agentId: synthesizer.id,
      agentName: synthesizer.name,
      round: 0,
      content: `Synthesis failed: ${errorText(error)}`,
      meta: { error: true },
    });
    return { turns, jointAnswer: null, dissent: null, status: "error" };
  }
}

// ---------------------------------------------------------------------------
// Room persistence
// ---------------------------------------------------------------------------

type RoomRow = {
  id: string;
  title: string;
  question: string;
  status: string;
  jointAnswer: string | null;
  dissent: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function roomDto(row: RoomRow) {
  return {
    id: row.id,
    title: row.title,
    question: row.question,
    status: row.status as "running" | "complete" | "error",
    jointAnswer: row.jointAnswer,
    dissent: row.dissent,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listRooms(prisma: PrismaClient, actor: ActorScope) {
  const rows = await prisma.deliberationRoom.findMany({
    where: { spaceId: actor.spaceId, userId: actor.userId },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });
  return rows.map(roomDto);
}

export async function getRoomDetail(prisma: PrismaClient, actor: ActorScope, roomId: string) {
  const room = await prisma.deliberationRoom.findFirst({
    where: { id: roomId, spaceId: actor.spaceId, userId: actor.userId },
  });
  if (!room) throw new Error("Unknown room.");
  const messages = await prisma.deliberationMessage.findMany({
    where: { roomId: room.id },
    orderBy: { seq: "asc" },
    include: { agent: { select: { name: true, role: true, color: true } } },
  });
  return {
    room: roomDto(room),
    turns: messages.map((message) => ({
      id: message.id,
      seq: message.seq,
      kind: message.kind as "user" | "agent" | "note" | "joint",
      agentId: message.agentId,
      agentName: message.agentName,
      agentRole: message.agent?.role ?? null,
      color: message.agent?.color ?? null,
      round: message.round,
      content: message.content,
      error: Boolean((message.meta as { error?: boolean } | null)?.error),
    })),
  };
}

export async function saveTurn(prisma: PrismaClient, roomId: string, turn: DeliberationTurn) {
  await prisma.deliberationMessage.create({
    data: {
      roomId,
      seq: turn.seq,
      kind: turn.kind,
      agentId: turn.agentId,
      agentName: turn.agentName,
      round: turn.round,
      content: turn.content,
      meta: turn.meta ?? undefined,
    },
  });
}

/**
 * Detached driver for one room: persists every turn as it is produced (the room
 * page polls `rooms.get` and shows the deliberation as it happens), then writes
 * the joint answer / dissent / status. Failures land on the room as status=error.
 */
export async function runRoomDeliberation(
  prisma: PrismaClient,
  secrets: SecretLoader,
  actor: ActorScope,
  room: { id: string; question: string },
  agents: DeliberationAgent[],
  fallbackModel: string,
): Promise<void> {
  try {
    const result = await runDeliberation({
      question: room.question,
      agents,
      startSeq: 1,
      complete: createModelComplete(prisma, secrets, actor, fallbackModel),
      onTurn: (turn) => saveTurn(prisma, room.id, turn),
    });
    await prisma.deliberationRoom.update({
      where: { id: room.id },
      data: { status: result.status, jointAnswer: result.jointAnswer, dissent: result.dissent },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.deliberationRoom
      .update({ where: { id: room.id }, data: { status: "error", dissent: message } })
      .catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Model wiring
// ---------------------------------------------------------------------------

export type ActorScope = { userId: string; spaceId: string };

export const SEED_AGENTS: ReadonlyArray<Omit<DeliberationAgent, "id"> & { ordinal: number }> = [
  {
    name: "Chief of Staff",
    role: "orchestrator / generalist",
    persona:
      "You weigh trade-offs across the whole picture, keep the group convergent, and are accountable for one clear recommendation.",
    modelProvider: null,
    modelId: null,
    color: "#9B5CF6",
    ordinal: 0,
  },
  {
    name: "Ortho Clinical",
    role: "clinical reviewer",
    persona:
      "You check medical safety, evidence quality, contraindications, and patient impact. Flag anything that must be verified before clinical use.",
    modelProvider: null,
    modelId: null,
    color: "#3EC5A8",
    ordinal: 1,
  },
  {
    name: "Ship",
    role: "engineering",
    persona:
      "You judge feasibility, effort, failure modes, and what can actually be built and tested today.",
    modelProvider: null,
    modelId: null,
    color: "#F5A03C",
    ordinal: 2,
  },
  {
    name: "Ops",
    role: "infrastructure",
    persona:
      "You judge deployment, reliability, security, monitoring, and rollback. Favour boring, reversible operations.",
    modelProvider: null,
    modelId: null,
    color: "#F2622A",
    ordinal: 3,
  },
];

function agentDto(row: {
  id: string;
  name: string;
  role: string;
  persona: string;
  modelProvider: string | null;
  modelId: string | null;
  color: string;
  ordinal: number;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    persona: row.persona,
    modelProvider: row.modelProvider,
    modelId: row.modelId,
    color: row.color,
    ordinal: row.ordinal,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** List the roster, lazily seeding the four default agents on first use. */
export async function listAgents(prisma: PrismaClient, actor: ActorScope) {
  const rows = await prisma.agentProfile.findMany({
    where: { spaceId: actor.spaceId, userId: actor.userId },
    orderBy: { ordinal: "asc" },
  });
  if (rows.length > 0) return rows.map(agentDto);
  await prisma.agentProfile.createMany({
    data: SEED_AGENTS.map((seed) => ({ ...seed, spaceId: actor.spaceId, userId: actor.userId })),
  });
  const seeded = await prisma.agentProfile.findMany({
    where: { spaceId: actor.spaceId, userId: actor.userId },
    orderBy: { ordinal: "asc" },
  });
  return seeded.map(agentDto);
}

export async function updateAgent(
  prisma: PrismaClient,
  actor: ActorScope,
  input: {
    agentId: string;
    name?: string;
    role?: string;
    persona?: string;
    modelProvider?: string | null;
    modelId?: string | null;
    color?: string;
  },
) {
  const row = await prisma.agentProfile.findFirst({
    where: { id: input.agentId, spaceId: actor.spaceId, userId: actor.userId },
  });
  if (!row) throw new Error("Unknown agent.");
  const updated = await prisma.agentProfile.update({
    where: { id: row.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.persona !== undefined ? { persona: input.persona } : {}),
      ...(input.modelProvider !== undefined ? { modelProvider: input.modelProvider } : {}),
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
    },
  });
  return agentDto(updated);
}

export async function loadAgents(
  prisma: PrismaClient,
  actor: ActorScope,
  agentIds: readonly string[],
) {
  await listAgents(prisma, actor);
  const rows = await prisma.agentProfile.findMany({
    where: { spaceId: actor.spaceId, userId: actor.userId, id: { in: [...agentIds] } },
    orderBy: { ordinal: "asc" },
  });
  if (rows.length < DELIBERATION_LIMITS.minAgents) throw new Error("Pick at least 2 known agents.");
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    persona: row.persona,
    modelProvider: row.modelProvider,
    modelId: row.modelId,
    color: row.color,
  }));
}

const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
};

export type ModelEndpoint = { baseUrl: string; apiKey: string | undefined; model: string };

/**
 * Resolve the endpoint for one agent turn: the agent's pinned model when set,
 * otherwise the user's default model credential (the same rows the brain and
 * the model picker already use).
 */
export async function resolveModelEndpoint(
  prisma: PrismaClient,
  secrets: SecretLoader,
  actor: ActorScope,
  agent: Pick<DeliberationAgent, "modelProvider" | "modelId">,
  fallbackModel: string,
): Promise<ModelEndpoint> {
  const preferred = await prisma.spaceModelPreference.findFirst({
    where: { spaceId: actor.spaceId, userId: actor.userId, isDefault: true },
    include: { credential: true },
  });
  const pinned = agent.modelProvider
    ? await prisma.userModelCredential.findFirst({
        where: { userId: actor.userId, provider: agent.modelProvider },
        orderBy: { updatedAt: "desc" },
      })
    : null;
  const credential =
    pinned ??
    preferred?.credential ??
    (await prisma.userModelCredential.findFirst({
      where: { userId: actor.userId },
      orderBy: { updatedAt: "desc" },
    }));
  if (!credential)
    throw new Error("No model connected. Connect a model in Settings → Models first.");
  const secret = await prisma.secret.findFirst({
    where: { id: credential.secretId, userId: actor.userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  if (!secret) throw new Error("The model credential has no stored key.");
  const plaintext = await secrets.load(secret.ciphertext, secret.id);
  const parsed = parseModelSecret(plaintext);
  if (parsed.kind === "openai_compatible") {
    return {
      baseUrl: parsed.baseUrl,
      apiKey: parsed.apiKey,
      model: agent.modelId ?? preferred?.modelId ?? fallbackModel,
    };
  }
  const baseUrl = PROVIDER_BASE_URLS[credential.provider];
  if (parsed.kind !== "api_key") {
    throw new Error(
      "OAuth-only model credentials are not wired for deliberation; use an API-key credential.",
    );
  }
  if (!baseUrl) {
    throw new Error(
      `Provider ${credential.provider} is not wired for deliberation; use an openai-compatible credential.`,
    );
  }
  return {
    baseUrl,
    apiKey: parsed.key,
    model: agent.modelId ?? preferred?.modelId ?? fallbackModel,
  };
}

/** Production `complete`: one bounded OpenAI-compatible chat completion call. */
export function createModelComplete(
  prisma: PrismaClient,
  secrets: SecretLoader,
  actor: ActorScope,
  fallbackModel: string,
): CompleteFn {
  return async ({ agent, system, prompt, maxTokens, timeoutMs }) => {
    const endpoint = await resolveModelEndpoint(prisma, secrets, actor, agent, fallbackModel);
    const authorization = endpoint.apiKey ? `Bearer ${endpoint.apiKey}` : undefined;
    const response = await fetch(`${endpoint.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`model call ${response.status}: ${truncate(detail, 200)}`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim())
      throw new Error("model returned no content");
    return content;
  };
}
