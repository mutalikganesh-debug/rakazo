/**
 * Goal runner — the in-app goal engine.
 *
 * Semantics ported 1:1 from the Hermes engine (reference/fsm/goal_reducer.py +
 * reference/fsm/hermes_goal.py) per goal_rebuild_spec.md §2.2 ("Rakazo goal
 * runner"). Doctrine (spec §0) — one gate function per one-line rule:
 *   bounded loops only      -> gateBoundedLoop
 *   fail-loud               -> gateFailLoud (explicit error string + one stderr line)
 *   verdict lines           -> gateVerdictLine (exactly one `VERDICT: DONE|BLOCKED - …`)
 *   fencing (id+revision)   -> the store's fenced UPDATE (0 rows = stale = fail loud)
 *
 * The continuation/evaluator model calls ride the existing deliberation/brain
 * model config (resolveModelEndpoint: UserModelCredential / SpaceModelPreference
 * + secret store) — no new provider surface.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@rakazo/db";
import type { ActorScope, SecretLoader } from "./deliberation.js";
import { resolveModelEndpoint, withTimeout } from "./deliberation.js";

// ---------------------------------------------------------------------------
// State machine (goal_reducer.py verbatim behavior)
// ---------------------------------------------------------------------------

export type GoalStatus = "active" | "paused" | "blocked" | "budget_limited" | "complete";
export type GoalVerdict = "continue" | "met" | "impossible" | "unavailable";
export type GoalConfidence = "guess" | "partial" | "tested" | "proven";

export type GoalTodo = {
  id: string;
  status: "pending" | "done";
  content: string;
  note: string | null;
};

export type GoalEvaluation = {
  verdict: GoalVerdict;
  reason: string;
  model: string | null;
  payload: unknown;
  evaluatedAt: string;
};

export type GoalState = {
  schemaVersion: 1;
  id: string;
  revision: number;
  objective: string;
  name: string;
  status: GoalStatus;
  blockedReason: string | null;
  completionConfidence: GoalConfidence | null;
  evaluationCount: number;
  lastEvaluation: GoalEvaluation | null;
  consecutiveErrorTurns: number;
  unchangedContinuationTurns: number;
  tokensUsed: number;
  tokenBudget: number | null;
  timeUsedMs: number;
  createdAt: string;
  updatedAt: string;
  // operational extensions (Hermes): delivery verification + progress inputs
  verifyCmd: string;
  todos: GoalTodo[];
  lessons: string[];
  evidence: string[];
  proposedAnswer: string | null;
  lastFingerprint: string | null;
  evaluatorTokensUsed: number;
  // failure surface (spec §2.2): mandatory error string on paused/blocked
  error: string | null;
  // exactly-one VERDICT line contract on the run's output
  verdictLine: string | null;
  output: string | null;
};

export const GOAL_STATUSES: readonly GoalStatus[] = [
  "active",
  "paused",
  "blocked",
  "budget_limited",
  "complete",
];
export const GOAL_VERDICTS: readonly GoalVerdict[] = [
  "continue",
  "met",
  "impossible",
  "unavailable",
];
export const GOAL_CONFIDENCES: readonly GoalConfidence[] = ["guess", "partial", "tested", "proven"];

// Transition table copied 1:1 from the Hermes reducer (rea_report.md §2.3).
// budget_limited is terminal: recovery is replacement-only (new goal, new budget).
export const GOAL_TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
  active: ["paused", "blocked", "budget_limited", "complete"],
  paused: ["active", "blocked", "budget_limited"],
  blocked: ["active", "budget_limited"],
  budget_limited: [],
  complete: ["paused"], // editing a completed run coerces to paused
};

export class GoalError extends Error {}
export class StaleGoalError extends GoalError {}
export class GoalTransitionError extends GoalError {}

export function goalTs(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export type GoalPolicy = {
  maxUnchangedContinuations: number;
  maxConsecutiveErrors: number;
  tokenBudget: number | null;
  evaluationTimeoutMs: number;
  maxTurns: number;
  verdictLine: boolean;
};

// Compiled bounds. Config may only tighten these (spec §4: no unbounded
// auto-continuation under any config).
export const GOAL_POLICY_CAPS = {
  maxUnchangedContinuations: 3,
  maxConsecutiveErrors: 3,
  maxTurns: 300,
  evaluationTimeoutMs: 600_000,
  continuationTimeoutMs: 120_000,
  maxTokensPerCall: 700,
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function goalPolicy(overrides: Partial<GoalPolicy> = {}): GoalPolicy {
  const base: GoalPolicy = {
    maxUnchangedContinuations: Math.min(
      envInt("GOAL_MAX_UNCHANGED_CONTINUATIONS", GOAL_POLICY_CAPS.maxUnchangedContinuations),
      GOAL_POLICY_CAPS.maxUnchangedContinuations,
    ),
    maxConsecutiveErrors: Math.min(
      envInt("GOAL_MAX_CONSECUTIVE_ERRORS", GOAL_POLICY_CAPS.maxConsecutiveErrors),
      GOAL_POLICY_CAPS.maxConsecutiveErrors,
    ),
    tokenBudget: process.env.GOAL_TOKEN_BUDGET ? envInt("GOAL_TOKEN_BUDGET", 0) || null : null,
    evaluationTimeoutMs: Math.min(
      envInt("GOAL_EVALUATION_TIMEOUT_MS", GOAL_POLICY_CAPS.evaluationTimeoutMs),
      GOAL_POLICY_CAPS.evaluationTimeoutMs,
    ),
    maxTurns: Math.min(
      envInt("GOAL_MAX_TURNS", GOAL_POLICY_CAPS.maxTurns),
      GOAL_POLICY_CAPS.maxTurns,
    ),
    verdictLine: true,
  };
  const merged = { ...base, ...overrides };
  // tighten-only on the two guard counters
  merged.maxUnchangedContinuations = Math.min(
    merged.maxUnchangedContinuations,
    GOAL_POLICY_CAPS.maxUnchangedContinuations,
  );
  merged.maxConsecutiveErrors = Math.min(
    merged.maxConsecutiveErrors,
    GOAL_POLICY_CAPS.maxConsecutiveErrors,
  );
  merged.maxTurns = Math.min(merged.maxTurns, GOAL_POLICY_CAPS.maxTurns);
  return merged;
}

export function newGoalState(
  goalId: string,
  objective: string,
  opts: { tokenBudget?: number | null; verifyCmd?: string } = {},
): GoalState {
  const trimmed = (objective ?? "").trim();
  if (!trimmed) throw new GoalError("goal_error: create: objective must be non-empty");
  const words = trimmed.split(/\s+/);
  const now = goalTs();
  return {
    schemaVersion: 1,
    id: goalId,
    revision: 1,
    objective: trimmed,
    name: words.slice(0, 6).join(" ").slice(0, 36),
    status: "active",
    blockedReason: null,
    completionConfidence: null,
    evaluationCount: 0,
    lastEvaluation: null,
    consecutiveErrorTurns: 0,
    unchangedContinuationTurns: 0,
    tokensUsed: 0,
    tokenBudget: opts.tokenBudget ?? null,
    timeUsedMs: 0,
    createdAt: now,
    updatedAt: now,
    verifyCmd: (opts.verifyCmd ?? "").trim(),
    todos: [],
    lessons: [],
    evidence: [],
    proposedAnswer: null,
    lastFingerprint: null,
    evaluatorTokensUsed: 0,
    error: null,
    verdictLine: null,
    output: null,
  };
}

/** Doctrine rule 4: every write is fenced by id AND revision. */
export function gateFresh(
  state: Pick<GoalState, "id" | "revision">,
  expectedId?: string | null,
  expectedRevision?: number | null,
): true {
  if (expectedId != null && state.id !== expectedId) {
    throw new StaleGoalError(
      `goal_error: stale write: expected id ${JSON.stringify(expectedId)}, current ${JSON.stringify(state.id)}. ` +
        "Read the current goal and continue against the latest objective.",
    );
  }
  if (expectedRevision != null && state.revision !== expectedRevision) {
    throw new StaleGoalError(
      `goal_error: stale write: expected revision ${expectedRevision}, current ${state.revision}. ` +
        "Read the current goal and continue against the latest objective.",
    );
  }
  return true;
}

/** Doctrine rule 1: the ONLY place continuation is allowed or refused. */
export function gateBoundedLoop(
  state: Pick<
    GoalState,
    "status" | "unchangedContinuationTurns" | "consecutiveErrorTurns" | "tokenBudget" | "tokensUsed"
  >,
  policy?: GoalPolicy,
  resumeCandidate = false,
): { allowed: boolean; why: string } {
  const p = goalPolicy(policy ?? {});
  if (resumeCandidate) {
    if (state.status !== "active" && state.status !== "paused" && state.status !== "blocked") {
      return { allowed: false, why: `status ${state.status} is not resumable` };
    }
  } else if (state.status !== "active") {
    return { allowed: false, why: `status ${state.status} is not active` };
  }
  if ((state.unchangedContinuationTurns ?? 0) >= p.maxUnchangedContinuations) {
    return { allowed: false, why: "stall guard tripped" };
  }
  if ((state.consecutiveErrorTurns ?? 0) >= p.maxConsecutiveErrors) {
    return { allowed: false, why: "error guard tripped" };
  }
  if (state.tokenBudget != null && (state.tokensUsed ?? 0) >= state.tokenBudget) {
    return { allowed: false, why: "token budget exhausted" };
  }
  return { allowed: true, why: "continuation allowed" };
}

/** Doctrine rule 2: explicit error string + status context + one stderr line. */
export function gateFailLoud(err: unknown, where: string, state?: Partial<GoalState>): string {
  const detail = err instanceof Error ? err.message : String(err);
  const context = state?.id
    ? ` (goal ${state.id} rev ${state.revision ?? "?"} status ${state.status ?? "?"})`
    : "";
  const message = `goal_error: ${where}: ${detail}${context}`;
  process.stderr.write(`${message}\n`);
  return message;
}

/** Doctrine rule 3: parse the run/turn verdict line. */
export function gateVerdictLine(text: string): {
  ok: boolean;
  verdict: "DONE" | "BLOCKED" | null;
  summary: string;
} {
  const lines = (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const hits = lines.filter((line) => line.startsWith("VERDICT:"));
  if (hits.length !== 1) {
    return {
      ok: false,
      verdict: null,
      summary: `expected exactly one VERDICT line, found ${hits.length}`,
    };
  }
  const body = (hits[0] ?? "").slice("VERDICT:".length).trim();
  for (const verdict of ["DONE", "BLOCKED"] as const) {
    if (body.startsWith(verdict)) {
      const rest = body.slice(verdict.length).trim();
      if (rest.startsWith("-") && rest.slice(1).trim()) {
        return { ok: true, verdict, summary: rest.slice(1).trim() };
      }
      return { ok: false, verdict: null, summary: "verdict line lacks '- <summary>'" };
    }
  }
  return { ok: false, verdict: null, summary: `unknown verdict token in ${JSON.stringify(body)}` };
}

export function formatVerdictLine(verdict: "DONE" | "BLOCKED", summary: string): string {
  const oneLine = String(summary ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  return `VERDICT: ${verdict} - ${oneLine}`;
}

function failLoudStatus(
  status: GoalStatus,
  reason: string | null,
  currentError: string | null,
): string {
  if (currentError) return currentError;
  return `goal_error: status ${status}: ${reason || "unspecified"}`;
}

/** Fenced status set with the transition table. Returns a new state. */
export function goalTransition(
  state: GoalState,
  newStatus: GoalStatus,
  reason?: string | null,
  opts: { expectedId?: string | null; expectedRevision?: number | null } = {},
): GoalState {
  gateFresh(state, opts.expectedId, opts.expectedRevision);
  if (!GOAL_STATUSES.includes(newStatus)) {
    throw new GoalTransitionError(`goal_error: unknown status ${JSON.stringify(newStatus)}`);
  }
  if (newStatus !== state.status && !GOAL_TRANSITIONS[state.status].includes(newStatus)) {
    throw new GoalTransitionError(`goal_error: illegal transition ${state.status} -> ${newStatus}`);
  }
  const out: GoalState = { ...state };
  out.status = newStatus;
  if (newStatus === "blocked") {
    if (!(reason ?? "").trim()) {
      throw new GoalTransitionError("goal_error: blocked requires an explicit reason");
    }
    out.blockedReason = (reason ?? "").split(/\s+/).filter(Boolean).join(" ");
    out.error = failLoudStatus(newStatus, reason ?? null, state.error);
  } else if (newStatus === "paused" || newStatus === "budget_limited") {
    out.blockedReason = null;
    out.error = failLoudStatus(newStatus, reason ?? null, state.error);
  } else {
    out.blockedReason = null;
    if (newStatus === "complete") {
      out.error = null;
      if (!out.completionConfidence || !GOAL_CONFIDENCES.includes(out.completionConfidence)) {
        out.completionConfidence = "tested";
      }
    }
  }
  out.updatedAt = goalTs();
  return out;
}

/** paused/blocked -> active, resetting both guard counters. */
export function goalResume(
  state: GoalState,
  opts: { expectedId?: string | null; expectedRevision?: number | null } = {},
): GoalState {
  gateFresh(state, opts.expectedId, opts.expectedRevision);
  if (state.status === "budget_limited") {
    throw new GoalTransitionError("goal_error: resume refused: budget_limited is replacement-only");
  }
  if (state.status === "complete") {
    throw new GoalTransitionError("goal_error: resume refused: goal is complete");
  }
  const out = goalTransition(state, "active", null, opts);
  out.consecutiveErrorTurns = 0;
  out.unchangedContinuationTurns = 0;
  out.error = null;
  return out;
}

/** Objective edit: resets both guards and clears completion claims (same commit). */
export function editObjective(
  state: GoalState,
  objective: string,
  opts: { expectedId?: string | null; expectedRevision?: number | null } = {},
): GoalState {
  gateFresh(state, opts.expectedId, opts.expectedRevision);
  const trimmed = (objective ?? "").trim();
  if (!trimmed) throw new GoalError("goal_error: edit_objective: objective must be non-empty");
  const out: GoalState = { ...state };
  out.objective = trimmed;
  out.name = trimmed.split(/\s+/).slice(0, 6).join(" ").slice(0, 36);
  out.consecutiveErrorTurns = 0;
  out.unchangedContinuationTurns = 0;
  out.completionConfidence = null;
  out.proposedAnswer = null;
  out.lastEvaluation = null;
  if (out.status === "complete") out.status = "paused";
  out.updatedAt = goalTs();
  return out;
}

/**
 * Token accounting, fenced by id AND revision. Spend = assistant turn tokens,
 * clamped >= 0. Crossing the budget flips budget_limited (replacement-only).
 * Evaluation spend is NOT charged to the run (evaluatorTokensUsed tracks it).
 */
export function accountTokens(
  state: GoalState,
  tokens: number,
  opts: { expectedId?: string | null; expectedRevision?: number | null } = {},
): GoalState {
  gateFresh(state, opts.expectedId, opts.expectedRevision);
  const n = Number.parseInt(String(tokens), 10);
  if (!Number.isFinite(n)) {
    throw new GoalError(
      `goal_error: account_tokens: non-numeric token count ${JSON.stringify(tokens)}`,
    );
  }
  let out: GoalState = { ...state };
  out.tokensUsed = (state.tokensUsed ?? 0) + Math.max(n, 0);
  if (
    out.tokenBudget != null &&
    out.tokensUsed >= out.tokenBudget &&
    out.status !== "budget_limited"
  ) {
    out = goalTransition(out, "budget_limited", "token_budget");
  }
  out.updatedAt = goalTs();
  return out;
}

/**
 * Pending-only additions and reordering are not progress. Hash of
 * [goalId, non-pending todos, lessons] — the fence revision is deliberately NOT
 * part of the fingerprint (it bumps on every commit as the optimistic lock;
 * the Hermes engine's revision field only moved on objective edits, which here
 * reset the guards and completion claims explicitly in editObjective).
 */
export function progressFingerprint(state: GoalState): string {
  const nonPending = (state.todos ?? [])
    .filter((todo) => todo.status !== "pending")
    .map((todo) => ({ id: todo.id, status: todo.status, content: todo.content, note: todo.note }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const blob = JSON.stringify([state.id, nonPending, [...(state.lessons ?? [])].sort()]);
  return createHash("sha256").update(blob).digest("hex");
}

export function recordEvaluation(
  state: GoalState,
  verdict: GoalVerdict,
  reason: string,
  opts: { model?: string | null; payload?: unknown; tokens?: number } = {},
): GoalState {
  if (!GOAL_VERDICTS.includes(verdict)) {
    throw new GoalError(
      `goal_error: record_evaluation: unknown verdict ${JSON.stringify(verdict)}`,
    );
  }
  const out: GoalState = { ...state };
  out.evaluationCount = (state.evaluationCount ?? 0) + 1;
  out.lastEvaluation = {
    verdict,
    reason: String(reason ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .join(" "),
    model: opts.model ?? null,
    payload: opts.payload ?? null,
    evaluatedAt: goalTs(),
  };
  if (opts.tokens) {
    out.evaluatorTokensUsed =
      (state.evaluatorTokensUsed ?? 0) + Math.max(Number(opts.tokens) || 0, 0);
  }
  out.updatedAt = goalTs();
  return out;
}

/**
 * Evidence-recording path (operator-approved extension 2026-10-18): the
 * reference engine leaves state.evidence unwritable, so revalidateMet can never
 * accept an evaluator-cited requirement. Workers record evidence ids here (via
 * `EVIDENCE: <id>` turn lines or the goals.evidence RPC) and the evaluator may
 * then cite ids from this set. Validation stays strict (unchanged).
 */
export function recordEvidence(state: GoalState, ids: string[]): GoalState {
  const out: GoalState = { ...state };
  const seen = new Set(state.evidence ?? []);
  let changed = false;
  for (const raw of ids) {
    const id = String(raw ?? "")
      .trim()
      .slice(0, 128);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    changed = true;
    if (seen.size >= 512) break; // ponytail: hard cap, raise if evidence sets ever outgrow it
  }
  if (changed) {
    out.evidence = [...seen];
    out.updatedAt = goalTs();
  }
  return out;
}

/** Last `ANSWER: <text>` envelope line of a continuation turn (worker's proposed answer). */
export function harvestAnswer(text: string): string | null {
  let found: string | null = null;
  for (const line of String(text ?? "").split("\n")) {
    const match = /^\s*ANSWER:\s*(.+?)\s*$/i.exec(line);
    if (match)
      found =
        String(match[1] ?? "")
          .trim()
          .slice(0, 2000) || found;
  }
  return found;
}

/** Worker-proposed answer: the S1.4 literal-match side of the final_answer check. */
export function recordAnswer(state: GoalState, answer: string | null): GoalState {
  if (answer === null || answer === state.proposedAnswer) return state;
  const out: GoalState = { ...state };
  out.proposedAnswer = answer;
  out.updatedAt = goalTs();
  return out;
}

/** Parse `EVIDENCE: <id>` envelope lines from a continuation turn. */
export function harvestEvidenceIds(text: string): string[] {
  const ids: string[] = [];
  for (const line of String(text ?? "").split("\n")) {
    const match = /^\s*EVIDENCE:\s*(.+?)\s*$/i.exec(line);
    if (!match) continue;
    const id = String(match[1] ?? "")
      .trim()
      .slice(0, 128);
    if (id) ids.push(id);
    if (ids.length >= 64) break; // ponytail: per-turn cap, one turn should name a handful
  }
  return ids;
}

/**
 * Fold one work turn into the guard counters (S1.5). Error turns never run the
 * evaluator and never feed the stall counter. Aborts pause immediately.
 */
export function settleTurn(
  state: GoalState,
  opts: {
    verdict: GoalVerdict;
    reason: string;
    fingerprint?: string;
    error?: boolean;
    aborted?: boolean;
    substantiveToolUse?: boolean;
    policy?: GoalPolicy;
  },
): { state: GoalState; events: Array<Record<string, unknown>> } {
  const p = goalPolicy(opts.policy ?? {});
  let out: GoalState = { ...state };
  const events: Array<Record<string, unknown>> = [];
  const fp = opts.fingerprint ?? progressFingerprint(state);
  const fpUnchanged = fp === state.lastFingerprint;
  out.lastFingerprint = fp;

  if (opts.aborted) {
    out = goalTransition(out, "paused", "agent_aborted");
    events.push({ event: "goal:paused", reason: "agent_aborted" });
    return { state: out, events };
  }

  if (opts.error) {
    out.consecutiveErrorTurns = (state.consecutiveErrorTurns ?? 0) + 1;
  } else {
    out.consecutiveErrorTurns = 0;
    const prevReason = state.lastEvaluation?.reason ?? null;
    const stalled =
      fpUnchanged &&
      ((opts.verdict === "met" && (state.todos ?? []).length === 0) ||
        (opts.verdict === "continue" && opts.reason === prevReason) ||
        !opts.substantiveToolUse);
    if (stalled) {
      out.unchangedContinuationTurns = (state.unchangedContinuationTurns ?? 0) + 1;
    } else {
      out.unchangedContinuationTurns = 0;
    }
  }

  if ((out.consecutiveErrorTurns ?? 0) >= p.maxConsecutiveErrors) {
    out = goalTransition(out, "paused", "agent_errors");
    events.push({
      event: "goal:paused",
      reason: "agent_errors",
      consecutiveErrorTurns: out.consecutiveErrorTurns,
    });
  } else if ((out.unchangedContinuationTurns ?? 0) >= p.maxUnchangedContinuations) {
    out = goalTransition(out, "paused", "no_progress");
    events.push({
      event: "goal:stalled",
      reason: "no_progress",
      unchangedContinuationTurns: out.unchangedContinuationTurns,
    });
  }
  out.updatedAt = goalTs();
  return { state: out, events };
}

// ---------------------------------------------------------------------------
// Journal: append-only put/clear with byte-identical snapshot skip (S1.2)
// ---------------------------------------------------------------------------

export type GoalJournalEntry = {
  id: number;
  goalId: string;
  revision: number;
  op: "put" | "clear";
  payload: unknown;
  createdAt: string;
};

export type GoalStore = {
  /** Replay the journal: later put replaces wholesale; clear applies only on id+revision match. */
  load(goalId: string): Promise<GoalState | null>;
  /**
   * The ONLY put write site. Fenced: UPDATE … WHERE (goalId, revision) — 0 rows
   * = stale = fail loud. Skips the append when the snapshot is byte-identical
   * to the last put (returns false). On journal-write failure the whole commit
   * rolls back and throws (in-memory state stays at prev).
   */
  commit(prev: GoalState | null, next: GoalState): Promise<boolean>;
  /** The ONLY clear write site: a tombstone entry; the journal is never pruned. */
  clear(goalId: string, revision: number): Promise<void>;
  journalTail(goalId: string, take: number): Promise<GoalJournalEntry[]>;
};

export function canonicalJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input as Record<string, unknown>).sort()) {
        out[key] = sort((input as Record<string, unknown>)[key]);
      }
      return out;
    }
    return input;
  };
  return JSON.stringify(sort(value));
}

/** In-memory store with the same contract (used by tests and as a semantics reference). */
export function memoryGoalStore(): GoalStore & { entries: GoalJournalEntry[] } {
  const entries: GoalJournalEntry[] = [];
  let nextId = 1;
  return {
    entries,
    async load(goalId) {
      let state: GoalState | null = null;
      for (const entry of entries) {
        if (entry.op === "put" && entry.goalId === goalId) {
          state = entry.payload as GoalState;
        } else if (
          entry.op === "clear" &&
          state &&
          entry.goalId === state.id &&
          entry.revision === state.revision
        ) {
          state = null;
        }
      }
      return state ? { ...state } : null;
    },
    async commit(prev, next) {
      const lastPut = [...entries]
        .reverse()
        .find((entry) => entry.op === "put" && entry.goalId === next.id);
      const prevPayload = lastPut ? (lastPut.payload as GoalState) : null;
      const prevCanonical = prevPayload ? canonicalJson(prevPayload) : null;
      const nextCanonical = canonicalJson({
        ...next,
        revision: prev ? prev.revision : next.revision,
      });
      if (prevCanonical !== null && nextCanonical === prevCanonical) return false; // byte-identical skip
      if (prev && (prevPayload === null || prevPayload.revision !== prev.revision)) {
        throw new StaleGoalError(
          `goal_error: stale write: expected revision ${prev.revision}, current ${prevPayload?.revision}. ` +
            "Read the current goal and continue against the latest objective.",
        );
      }
      const committed: GoalState = { ...next, revision: prev ? prev.revision + 1 : next.revision };
      entries.push({
        id: nextId++,
        goalId: committed.id,
        revision: committed.revision,
        op: "put",
        payload: committed,
        createdAt: goalTs(),
      });
      Object.assign(next, committed);
      return true;
    },
    async clear(goalId, revision) {
      entries.push({
        id: nextId++,
        goalId,
        revision,
        op: "clear",
        payload: null,
        createdAt: goalTs(),
      });
    },
    async journalTail(goalId, take) {
      return entries.filter((entry) => entry.goalId === goalId).slice(-take);
    },
  };
}

type GoalRow = {
  goalId: string;
  revision: number;
  objective: string;
  status: string;
  blockedReason: string | null;
  completionConfidence: string | null;
  lastEvaluation: unknown;
  consecutiveErrorTurns: number;
  unchangedContinuationTurns: number;
  tokensUsed: number;
  tokenBudget: number | null;
  timeUsedMs: number;
  verifyCmd: string;
  evaluationCount: number;
  error: string | null;
  verdictLine: string | null;
  output: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function projectionOf(state: GoalState): Record<string, unknown> {
  return {
    objective: state.objective,
    revision: state.revision,
    status: state.status,
    blockedReason: state.blockedReason,
    completionConfidence: state.completionConfidence,
    lastEvaluation: (state.lastEvaluation ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue,
    consecutiveErrorTurns: state.consecutiveErrorTurns,
    unchangedContinuationTurns: state.unchangedContinuationTurns,
    tokensUsed: state.tokensUsed,
    tokenBudget: state.tokenBudget,
    timeUsedMs: state.timeUsedMs,
    verifyCmd: state.verifyCmd,
    evaluationCount: state.evaluationCount,
    error: state.error,
    verdictLine: state.verdictLine,
    output: state.output,
  };
}

/**
 * Prisma-backed store. Journal insert + fenced row update share one
 * transaction: UPDATE goal_runs … WHERE (goalId, revision) — 0 rows = stale =
 * fail loud (the spec §2.2 leaseFence pattern).
 */
export function prismaGoalStore(prisma: PrismaClient): GoalStore {
  return {
    async load(goalId) {
      const entries = await prisma.goalJournal.findMany({
        where: { goalId },
        orderBy: { id: "asc" },
      });
      let state: GoalState | null = null;
      for (const entry of entries) {
        const op = entry.op as "put" | "clear";
        if (op === "put") {
          const payload = entry.payload as unknown;
          if (payload && typeof payload === "object" && (payload as GoalState).id) {
            state = payload as GoalState;
          } else {
            gateFailLoud("put entry dropped: missing payload/id", "journal:replay");
          }
        } else if (op === "clear") {
          if (state && entry.goalId === state.id && entry.revision === state.revision) {
            state = null;
          }
        } else {
          gateFailLoud(`unknown op ${JSON.stringify(entry.op)} dropped`, "journal:replay");
        }
      }
      return state;
    },
    async commit(prev, next) {
      const lastPut = await prisma.goalJournal.findFirst({
        where: { goalId: next.id, op: "put" },
        orderBy: { id: "desc" },
      });
      const prevPayload = (lastPut?.payload ?? null) as GoalState | null;
      const prevCanonical = prevPayload ? canonicalJson(prevPayload) : null;
      const nextCanonical = canonicalJson({
        ...next,
        revision: prev ? prev.revision : next.revision,
      });
      if (prevCanonical !== null && nextCanonical === prevCanonical) return false; // byte-identical skip
      const committed: GoalState = { ...next, revision: prev ? prev.revision + 1 : next.revision };
      try {
        await prisma.$transaction(async (tx) => {
          const where = prev
            ? { goalId: committed.id, revision: prev.revision }
            : { goalId: committed.id, revision: committed.revision };
          const updated = await tx.goalRun.updateMany({
            where,
            data: projectionOf(committed) as never,
          });
          if (updated.count !== 1) {
            throw new StaleGoalError(
              `goal_error: stale write: expected revision ${prev ? prev.revision : committed.revision}, ` +
                "current differs. Read the current goal and continue against the latest objective.",
            );
          }
          await tx.goalJournal.create({
            data: {
              goalId: committed.id,
              revision: committed.revision,
              op: "put",
              payload: committed as unknown as Prisma.InputJsonValue,
            },
          });
        });
      } catch (error) {
        if (error instanceof StaleGoalError) throw error;
        const message = gateFailLoud(error, "commit:journal");
        throw new GoalError(message);
      }
      Object.assign(next, committed);
      return true;
    },
    async clear(goalId, revision) {
      try {
        await prisma.goalJournal.create({
          data: { goalId, revision, op: "clear", payload: undefined },
        });
      } catch (error) {
        const message = gateFailLoud(error, "commit_clear:journal");
        throw new GoalError(message);
      }
    },
    async journalTail(goalId, take) {
      const rows = await prisma.goalJournal.findMany({
        where: { goalId },
        orderBy: { id: "desc" },
        take,
      });
      return rows
        .map((row) => ({
          id: Number(row.id),
          goalId: row.goalId,
          revision: row.revision,
          op: row.op as "put" | "clear",
          payload: row.payload as unknown,
          createdAt: row.createdAt.toISOString(),
        }))
        .reverse();
    },
  };
}

// ---------------------------------------------------------------------------
// Evaluator gate: bounded, tool-free (hermes_goal.py verbatim behavior)
// ---------------------------------------------------------------------------

export const MAX_EVALUATOR_REQUESTS = 3;
export const EVAL_OBJECTIVE_MAX_CHARS = 8000;
export const EVAL_PROMPT_MAX_CHARS = 16000;

/** Bounded prompt; null = overflow (fail-closed 'unavailable'). */
export function buildEvalPrompt(state: GoalState, transcript = ""): string | null {
  const objective = state.objective ?? "";
  if (objective.length > EVAL_OBJECTIVE_MAX_CHARS) return null;
  const head =
    "Evaluate this goal. Reply with exactly one line " +
    "'VERDICT: met|continue|impossible - <reason>' followed by a JSON object " +
    "with keys verdict, reason, requirements (list of {id, met, failureMode, " +
    "evidence (ONLY ids from the EVIDENCE list below), todos}), final_answer (optional; " +
    "include ONLY if an ANSWER block is recorded below, then copy it EXACTLY).\n\n" +
    `OBJECTIVE:\n${objective}\n\n` +
    `TODOS:\n${JSON.stringify(state.todos ?? [], null, 0)}\n\n` +
    `LESSONS:\n${JSON.stringify([...(state.lessons ?? [])].sort())}\n\n` +
    `EVIDENCE:\n${JSON.stringify(state.evidence ?? [])}\n\n` +
    (state.proposedAnswer !== null ? `ANSWER:\n${state.proposedAnswer}\n\n` : "") +
    "TRANSCRIPT:\n";
  const budget = EVAL_PROMPT_MAX_CHARS - head.length;
  if (budget < 0) return null;
  let body = String(transcript ?? "");
  if (body.length > budget) body = body.slice(-budget);
  return head + body;
}

/**
 * -> {verdict, reason, payload, error}. Unparseable output yields host-generated
 * 'unavailable' plus an explicit error string (never a silent default).
 * 'unavailable' from the model is hard-rejected like any unknown verdict.
 */
export function parseEvaluatorOutput(text: string): {
  verdict: GoalVerdict;
  reason: string;
  payload: Record<string, unknown> | null;
  error: string | null;
} {
  const raw = text ?? "";
  let verdictToken: string | null = null;
  let reason = "";
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (s.startsWith("VERDICT:")) {
      const body = s.slice("VERDICT:".length).trim();
      const token = (body.split(" ", 1)[0] ?? "").toLowerCase().replace(/:$/, "");
      reason = body.slice(token.length).trim().replace(/^-/, "").trim();
      verdictToken = token;
      break;
    }
  }
  let payload: Record<string, unknown> | null = null;
  let jsonErr: string | null = null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      } else {
        jsonErr = "JSON block is not an object";
      }
    } catch (error) {
      jsonErr = `JSON block unparseable: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    jsonErr = "no JSON block";
  }
  if (verdictToken !== "met" && verdictToken !== "continue" && verdictToken !== "impossible") {
    return {
      verdict: "unavailable",
      reason: reason || "invalid evaluator verdict",
      payload,
      error: `evaluator verdict ${JSON.stringify(verdictToken)} hard-rejected (model may not emit 'unavailable')`,
    };
  }
  return { verdict: verdictToken, reason, payload, error: jsonErr };
}

/** S1.4 met revalidation (host-side; returns the remaining requirement on failure). */
export function revalidateMet(
  state: GoalState,
  payload: unknown,
): { ok: boolean; remaining: string } {
  if (!payload || typeof payload !== "object") return { ok: false, remaining: "evaluator output" };
  const p = payload as Record<string, unknown>;
  const knownTodos = new Set((state.todos ?? []).map((todo) => todo.id));
  const evidence = new Set(state.evidence ?? []);
  const requirements = Array.isArray(p.requirements) ? (p.requirements as unknown[]) : [];
  for (const rawReq of requirements) {
    const req = (rawReq ?? {}) as Record<string, unknown>;
    const rid = String(req.id ?? "requirement");
    if (req.met !== true) return { ok: false, remaining: rid };
    if (!("failureMode" in req)) return { ok: false, remaining: rid };
    const ev = Array.isArray(req.evidence) ? (req.evidence as unknown[]).map(String) : [];
    if (ev.length === 0 || !ev.every((id) => evidence.has(id)))
      return { ok: false, remaining: rid };
    const todos = Array.isArray(req.todos) ? (req.todos as unknown[]).map(String) : [];
    if (!todos.every((id) => knownTodos.has(id))) return { ok: false, remaining: rid };
  }
  if ("final_answer" in p && p.final_answer !== state.proposedAnswer) {
    return { ok: false, remaining: "final answer match" };
  }
  return { ok: true, remaining: "" };
}

/** S1.1 delta (a): 'complete' is only reachable when delivery is verified. */
export async function gateDeliveryVerification(
  state: GoalState,
  payload: unknown,
  runVerify: (cmd: string) => Promise<{ exitCode: number }>,
): Promise<boolean> {
  if ((state.verifyCmd ?? "").trim()) {
    const res = await runVerify(state.verifyCmd.trim());
    return res.exitCode === 0;
  }
  if (state.proposedAnswer !== null && payload && typeof payload === "object") {
    return revalidateMet(state, payload).ok;
  }
  return false;
}

export type GoalCompleteFn = (args: {
  system: string;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
}) => Promise<{ text: string; tokens: number }>;

export type GoalDeps = {
  complete: GoalCompleteFn;
  runVerify: (cmd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
};

/**
 * One bounded tool-free evaluation checkpoint. Hard ceiling:
 * MAX_EVALUATOR_REQUESTS provider requests per checkpoint (one timeout retry,
 * one JSON-correction retry). Returns host-generated 'unavailable' whenever the
 * model output is unusable — never a silent default.
 */
export async function evaluateGoal(
  state: GoalState,
  deps: GoalDeps,
  opts: { transcript?: string; policy?: GoalPolicy; model?: string | null } = {},
): Promise<{
  verdict: GoalVerdict;
  reason: string;
  payload: Record<string, unknown> | null;
  error: string | null;
  requests: number;
  tokens: number;
}> {
  const p = goalPolicy(opts.policy ?? {});
  const out = {
    verdict: "unavailable" as GoalVerdict,
    reason: "",
    payload: null as Record<string, unknown> | null,
    error: null as string | null,
    requests: 0,
    tokens: 0,
  };
  let prompt = buildEvalPrompt(state, opts.transcript ?? "");
  if (prompt === null) {
    out.error = "prompt overflow beyond evaluator bounds";
    out.reason = "evaluator unavailable: prompt overflow";
    gateFailLoud(out.error, "evaluate");
    return out;
  }
  let timeoutRetryUsed = false;
  let correctionUsed = false;
  let verdict: GoalVerdict = "unavailable";
  let reason = "evaluator request exhausted";
  let payload: Record<string, unknown> | null = null;
  while (out.requests < MAX_EVALUATOR_REQUESTS) {
    out.requests += 1;
    let raw: string;
    let tokens = 0;
    try {
      const result = await withTimeout(
        deps.complete({
          system:
            "You are a goal evaluator. You are tool-free: judge only from the evidence in the prompt. " +
            "Reply with exactly one VERDICT line and one JSON object.",
          prompt,
          maxTokens: GOAL_POLICY_CAPS.maxTokensPerCall,
          timeoutMs: p.evaluationTimeoutMs,
        }),
        p.evaluationTimeoutMs + 5_000,
        "goal-evaluator",
      );
      raw = result.text;
      tokens = result.tokens ?? 0;
    } catch (error) {
      const message = gateFailLoud(error, "evaluate");
      out.error = message;
      const isTimeout = /timed? ?out/i.test(error instanceof Error ? error.message : String(error));
      if (isTimeout && !timeoutRetryUsed) {
        timeoutRetryUsed = true;
        continue;
      }
      return out;
    }
    out.tokens += Math.max(Number(tokens) || 0, 0);
    const parsed = parseEvaluatorOutput(raw);
    verdict = parsed.verdict;
    reason = parsed.reason;
    payload = parsed.payload;
    if (parsed.error && !correctionUsed && out.requests < MAX_EVALUATOR_REQUESTS) {
      correctionUsed = true;
      prompt += "\n\nReturn a valid JSON object after the verdict line.";
      continue;
    }
    if (parsed.error && !out.error) out.error = parsed.error;
    break;
  }
  if (verdict === "met") {
    const revalidated = revalidateMet(state, payload);
    if (!revalidated.ok) {
      verdict = "continue";
      reason = `Remaining requirement: ${revalidated.remaining}.`;
    }
  }
  out.verdict = verdict;
  out.reason = reason;
  out.payload = payload;
  return out;
}

// ---------------------------------------------------------------------------
// Turn runner + bounded goal-run loop
// ---------------------------------------------------------------------------

export type GoalTurnResult = {
  state: GoalState;
  verdictLine: string;
  events: Array<Record<string, unknown>>;
  evaluation: { verdict: GoalVerdict; reason: string } | null;
};

/**
 * One goal turn (hermes_goal.py cmd_turn semantics): the continuation reply
 * must carry exactly one VERDICT line (a missing/malformed line is an error
 * turn), then an evaluator checkpoint folds into the guard counters. Pure over
 * the injected deps — persistence is the loop's job.
 */
export async function runGoalTurn(
  state: GoalState,
  turnText: string,
  opts: {
    deps: GoalDeps;
    policy?: GoalPolicy;
    tokens?: number;
    error?: boolean;
    aborted?: boolean;
    substantiveToolUse?: boolean;
  },
): Promise<GoalTurnResult> {
  const p = goalPolicy(opts.policy ?? {});
  const allowed = gateBoundedLoop(state, p);
  if (!allowed.allowed) {
    gateFailLoud(allowed.why, "turn:bounded_loop", state);
    return {
      state,
      verdictLine: formatVerdictLine("BLOCKED", `continuation refused: ${allowed.why}`),
      events: [{ event: "goal:blocked", reason: allowed.why }],
      evaluation: null,
    };
  }

  let error = opts.error ?? false;
  let summary = "";
  const verdictCheck = gateVerdictLine(turnText);
  if (!verdictCheck.ok) {
    gateFailLoud(verdictCheck.summary, "turn:verdict_line", state);
    error = true;
    summary = `turn verdict line rejected (${verdictCheck.summary})`;
  } else {
    summary = verdictCheck.summary;
  }

  if (opts.aborted || error) {
    const settled = settleTurn(state, {
      verdict: "continue",
      reason: "",
      aborted: opts.aborted ?? false,
      error,
      policy: p,
    });
    let line = summary || "turn aborted";
    if (settled.events.length) {
      const last = settled.events[settled.events.length - 1] as { event: string; reason: string };
      line += ` [${last.event}:${last.reason}]`;
    }
    return {
      state: settled.state,
      verdictLine: formatVerdictLine("BLOCKED", line),
      events: settled.events,
      evaluation: null,
    };
  }

  const ev = await evaluateGoal(state, opts.deps, { policy: p, transcript: turnText });
  // guard fold runs BEFORE recording: the stall rule compares against the
  // previous evaluation reason
  const settled = settleTurn(state, {
    verdict: ev.verdict,
    reason: ev.reason,
    substantiveToolUse: opts.substantiveToolUse ?? true,
    policy: p,
  });
  const events = settled.events;
  let out = recordEvaluation(settled.state, ev.verdict, ev.reason, {
    payload: ev.payload,
    tokens: ev.tokens,
  });
  const tripped = events.filter((e) => e.event === "goal:stalled" || e.event === "goal:paused");

  if (!tripped.length) {
    if (ev.verdict === "unavailable") {
      out = goalTransition(out, "paused", "evaluator_unavailable");
    } else if (ev.verdict === "impossible") {
      out = goalTransition(out, "blocked", ev.reason || "evaluator: impossible");
    } else if (ev.verdict === "met") {
      const verified = await gateDeliveryVerification(out, ev.payload, opts.deps.runVerify);
      if (verified) {
        const confidence = ev.payload?.completionConfidence as GoalConfidence | undefined;
        out = goalTransition(out, "complete", "delivery verified");
        out.completionConfidence =
          confidence && GOAL_CONFIDENCES.includes(confidence) ? confidence : "tested";
      } else {
        out = goalTransition(out, "paused", "delivery_failed");
      }
    }
  }
  if (opts.tokens) out = accountTokens(out, opts.tokens);

  if (out.status === "complete") {
    return {
      state: out,
      verdictLine: formatVerdictLine(
        "DONE",
        `goal complete: ${out.objective.slice(0, 60)} (delivery verified)`,
      ),
      events,
      evaluation: { verdict: ev.verdict, reason: ev.reason },
    };
  }
  const bits = [`status ${out.status}`];
  for (const e of tripped) bits.push(`${e.event}:${e.reason}`);
  if (ev.verdict === "impossible") bits.push(`impossible: ${ev.reason}`);
  else if (ev.verdict === "unavailable")
    bits.push(`evaluator unavailable: ${ev.error || ev.reason}`);
  else if (ev.verdict === "met") bits.push("delivery verification failed");
  if (out.blockedReason) bits.push(out.blockedReason);
  return {
    state: out,
    verdictLine: formatVerdictLine("BLOCKED", bits.join("; ")),
    events,
    evaluation: { verdict: ev.verdict, reason: ev.reason },
  };
}

export type GoalRunResult = {
  state: GoalState;
  output: string;
  verdictLine: string;
  turns: Array<{ text: string; verdict: "DONE" | "BLOCKED"; summary: string }>;
};

/**
 * The bounded goal-run loop: continuation -> evaluator checkpoint -> fenced
 * commit, repeated while the goal is active and the loop budget allows. Every
 * run ends with exactly one VERDICT line in its output.
 */
export async function runGoalLoop(
  state: GoalState,
  opts: {
    deps: GoalDeps & { store?: GoalStore };
    policy?: GoalPolicy;
    maxTurns?: number;
  },
): Promise<GoalRunResult> {
  const p = goalPolicy(opts.policy ?? {});
  const maxTurns = Math.min(opts.maxTurns ?? p.maxTurns, p.maxTurns);
  const turns: GoalRunResult["turns"] = [];
  let current = state;
  let lastCommitted: GoalState = state;
  let startedAt = Date.now();

  const commit = async (next: GoalState): Promise<void> => {
    if (!opts.deps.store) return;
    try {
      await opts.deps.store.commit(lastCommitted, next);
      lastCommitted = next;
    } catch (error) {
      Object.assign(next, lastCommitted); // roll back in-memory state (S1.2)
      throw error instanceof GoalError
        ? error
        : new GoalError(error instanceof Error ? error.message : String(error));
    }
  };

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const allowed = gateBoundedLoop(current, p);
    if (!allowed.allowed) break;
    const prompt = continuationPrompt(current, turns);
    let turnText = "";
    let turnTokens = 0;
    let turnError = false;
    try {
      const result = await withTimeout(
        opts.deps.complete({
          system:
            "You are the goal worker inside one user's personal-agent app. Advance the objective below " +
            "as far as you can right now. Be concrete and concise; state what you did and what remains. " +
            "Plain text only.\n\nFor each verifiable artifact or check you complete, add its own line " +
            "'EVIDENCE: <id>' (a short stable id such as a filename or hash) before the verdict line, " +
            "so the evaluator can cite it. When the objective asks for an answer or deliverable text, " +
            "also record it as ONE line 'ANSWER: <text>' before the verdict line.\n\n" +
            "End your reply with EXACTLY ONE line in the form " +
            "'VERDICT: DONE - <summary>' when the objective's work is finished, or " +
            "'VERDICT: BLOCKED - <summary>' when you cannot proceed.",
          prompt,
          maxTokens: GOAL_POLICY_CAPS.maxTokensPerCall,
          timeoutMs: GOAL_POLICY_CAPS.continuationTimeoutMs,
        }),
        GOAL_POLICY_CAPS.continuationTimeoutMs + 5_000,
        "goal-continuation",
      );
      turnText = result.text;
      turnTokens = result.tokens ?? 0;
    } catch (error) {
      gateFailLoud(error, "loop:continuation", current);
      turnError = true;
      turnText = "";
    }

    // worker-reported evidence lands BEFORE the evaluator checkpoint so
    // revalidateMet can accept evaluator-cited requirement evidence ids
    const evidenceIds = turnError ? [] : harvestEvidenceIds(turnText);
    const answer = turnError ? null : harvestAnswer(turnText);
    if (evidenceIds.length || answer !== null) {
      current = recordEvidence(current, evidenceIds);
      current = recordAnswer(current, answer);
      await commit(current);
    }

    const result = await runGoalTurn(current, turnText, {
      deps: opts.deps,
      policy: p,
      tokens: turnTokens,
      error: turnError,
      substantiveToolUse: !turnError,
    });
    current = result.state;
    current.timeUsedMs = (current.timeUsedMs ?? 0) + (Date.now() - startedAt);
    startedAt = Date.now();
    await commit(current);
    const parsed = gateVerdictLine(turnText);
    turns.push({
      text: stripVerdictLine(turnText),
      verdict: parsed.ok ? (parsed.verdict as "DONE" | "BLOCKED") : "BLOCKED",
      summary: parsed.ok ? parsed.summary : "error turn",
    });
    if (current.status !== "active") break;
  }

  if (current.status === "active") {
    // loop bound reached with no terminal state: pause loud, never spin
    const message = gateFailLoud(
      `loop bound reached after ${maxTurns} turns`,
      "loop:max_turns",
      current,
    );
    current = goalTransition(current, "paused", "max_turns_reached");
    current.error = message;
  }

  const verdict = current.status === "complete" ? "DONE" : "BLOCKED";
  const summary =
    verdict === "DONE"
      ? `goal complete: ${current.objective.slice(0, 60)} (delivery verified)`
      : `status ${current.status}${current.blockedReason ? `; ${current.blockedReason}` : ""}${
          current.error ? `; ${current.error}` : ""
        }`;
  const verdictLine = formatVerdictLine(verdict, summary);
  const body = turns
    .map((turn) => turn.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const output = body ? `${body}\n\n${verdictLine}` : verdictLine;
  current.verdictLine = verdictLine;
  current.output = output;
  await commit(current);
  return { state: current, output, verdictLine, turns };
}

function stripVerdictLine(text: string): string {
  return (text ?? "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("VERDICT:"))
    .join("\n")
    .trim();
}

function continuationPrompt(state: GoalState, turns: GoalRunResult["turns"]): string {
  const tail = turns
    .slice(-3)
    .map((turn) => turn.text.trim())
    .filter(Boolean)
    .join("\n---\n");
  return [
    `OBJECTIVE:\n${state.objective}`,
    `TODOS:\n${JSON.stringify(state.todos ?? [], null, 0)}`,
    state.lastEvaluation
      ? `LAST EVALUATION: ${state.lastEvaluation.verdict} — ${state.lastEvaluation.reason}`
      : "LAST EVALUATION: none yet",
    tail ? `YOUR RECENT WORK:\n${tail}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Production wiring: brain model config + bounded verify runner
// ---------------------------------------------------------------------------

/** Production continuation/evaluator call: one bounded OpenAI-compatible chat completion. */
export function createGoalComplete(
  prisma: PrismaClient,
  secrets: SecretLoader,
  actor: ActorScope,
  fallbackModel: string,
): GoalCompleteFn {
  return async ({ system, prompt, maxTokens, timeoutMs }) => {
    const endpoint = await resolveModelEndpoint(
      prisma,
      secrets,
      actor,
      { modelProvider: null, modelId: null },
      fallbackModel,
    );
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
      throw new Error(`model call ${response.status}: ${detail.slice(0, 200)}`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { total_tokens?: number };
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim())
      throw new Error("model returned no content");
    return { text: content, tokens: payload.usage?.total_tokens ?? 0 };
  };
}

/** Delivery-verification step: a bounded command with a finite timeout. */
export function createVerifyRunner(timeoutMs = 30_000) {
  return (cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      execFile(
        "bash",
        ["-c", cmd],
        { timeout: timeoutMs, encoding: "utf8" },
        (error, stdout, stderr) => {
          const err = error as { code?: unknown; killed?: boolean } | null;
          const exitCode = err
            ? typeof err.code === "number"
              ? err.code
              : err.killed
                ? 124
                : 1
            : 0;
          resolve({ exitCode, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        },
      );
    });
}

// ---------------------------------------------------------------------------
// API surface helpers (create / fenced commands / DTOs)
// ---------------------------------------------------------------------------

/**
 * Kick the bounded loop detached (the Goals card polls while it runs) — same
 * driver pattern as runRoomDeliberation. Failures land on the run's error
 * column and one stderr line (fail-loud, never silent).
 */
export function startGoalRun(
  prisma: PrismaClient,
  secrets: SecretLoader,
  actor: ActorScope,
  goalId: string,
  fallbackModel: string,
): void {
  void (async () => {
    try {
      const store = prismaGoalStore(prisma);
      const state = await store.load(goalId);
      if (!state) throw new GoalError(`goal_error: run: no journal state for ${goalId}`);
      await runGoalLoop(state, {
        deps: {
          complete: createGoalComplete(prisma, secrets, actor, fallbackModel),
          runVerify: createVerifyRunner(),
          store,
        },
      });
    } catch (error) {
      if (error instanceof StaleGoalError) {
        // someone fenced us out (user pause/block/edit) — their state is authoritative
        gateFailLoud(error, "goals:run:refenced", { id: goalId });
        return;
      }
      const message = gateFailLoud(error, "goals:run", { id: goalId });
      await prisma.goalRun
        .updateMany({ where: { goalId }, data: { error: message } })
        .catch((writeError) => gateFailLoud(writeError, "goals:run:error_persist"));
    }
  })();
}

export async function createGoal(
  prisma: PrismaClient,
  actor: ActorScope,
  input: {
    goalId: string;
    objective: string;
    verifyCmd?: string;
    tokenBudget?: number | null;
    clientId?: string | null;
  },
): Promise<GoalState> {
  const state = newGoalState(input.goalId, input.objective, {
    tokenBudget: input.tokenBudget ?? null,
    verifyCmd: input.verifyCmd ?? "",
  });
  await prisma.goalRun.create({
    data: {
      goalId: state.id,
      spaceId: actor.spaceId,
      userId: actor.userId,
      clientId: input.clientId ?? null,
      objective: state.objective,
      revision: state.revision,
      status: state.status,
      verifyCmd: state.verifyCmd,
      tokenBudget: state.tokenBudget,
    },
  });
  const store = prismaGoalStore(prisma);
  await store.commit(null, state);
  return state;
}

async function fencedState(
  prisma: PrismaClient,
  actor: ActorScope,
  goalId: string,
  revision: number,
): Promise<GoalState> {
  const row = await prisma.goalRun.findFirst({
    where: { goalId, spaceId: actor.spaceId, userId: actor.userId },
  });
  if (!row) throw new GoalError(`goal_error: unknown goal ${JSON.stringify(goalId)}`);
  const store = prismaGoalStore(prisma);
  const state = await store.load(goalId);
  if (!state)
    throw new GoalError(`goal_error: goal ${JSON.stringify(goalId)} has no journal state`);
  gateFresh(state, goalId, revision);
  return state;
}

async function commitUpdate(
  prisma: PrismaClient,
  prev: GoalState,
  next: GoalState,
): Promise<GoalState> {
  const store = prismaGoalStore(prisma);
  await store.commit(prev, next);
  return next;
}

export async function cmdPause(
  prisma: PrismaClient,
  actor: ActorScope,
  goalId: string,
  revision: number,
  reason = "paused by user",
): Promise<GoalState> {
  const state = await fencedState(prisma, actor, goalId, revision);
  const next = goalTransition(state, "paused", reason, {
    expectedId: goalId,
    expectedRevision: revision,
  });
  return commitUpdate(prisma, state, next);
}

export async function cmdResume(
  prisma: PrismaClient,
  actor: ActorScope,
  goalId: string,
  revision: number,
): Promise<GoalState> {
  const state = await fencedState(prisma, actor, goalId, revision);
  const next = goalResume(state, { expectedId: goalId, expectedRevision: revision });
  return commitUpdate(prisma, state, next);
}

/** Fenced evidence recording (goals.evidence RPC): worker/external evidence ids. */
export async function cmdEvidence(
  prisma: PrismaClient,
  actor: ActorScope,
  goalId: string,
  revision: number,
  ids: string[],
): Promise<GoalState> {
  const state = await fencedState(prisma, actor, goalId, revision);
  return commitUpdate(prisma, state, recordEvidence(state, ids));
}

export async function cmdBlock(
  prisma: PrismaClient,
  actor: ActorScope,
  goalId: string,
  revision: number,
  reason: string,
): Promise<GoalState> {
  const state = await fencedState(prisma, actor, goalId, revision);
  const next = goalTransition(state, "blocked", reason, {
    expectedId: goalId,
    expectedRevision: revision,
  });
  return commitUpdate(prisma, state, next);
}

export async function cmdEditObjective(
  prisma: PrismaClient,
  actor: ActorScope,
  goalId: string,
  revision: number,
  objective: string,
): Promise<GoalState> {
  const state = await fencedState(prisma, actor, goalId, revision);
  const next = editObjective(state, objective, { expectedId: goalId, expectedRevision: revision });
  return commitUpdate(prisma, state, next);
}

export async function cmdClear(
  prisma: PrismaClient,
  actor: ActorScope,
  goalId: string,
  revision: number,
): Promise<void> {
  const state = await fencedState(prisma, actor, goalId, revision);
  const store = prismaGoalStore(prisma);
  await store.clear(goalId, state.revision);
  await prisma.goalRun.deleteMany({
    where: { goalId, spaceId: actor.spaceId, userId: actor.userId },
  });
}

export type GoalCardDto = {
  goalId: string;
  objective: string;
  name: string;
  status: GoalStatus;
  revision: number;
  blockedReason: string | null;
  completionConfidence: GoalConfidence | null;
  error: string | null;
  verdictLine: string | null;
  tokensUsed: number;
  tokenBudget: number | null;
  consecutiveErrorTurns: number;
  unchangedContinuationTurns: number;
  evaluationCount: number;
  verifyCmd: string;
  createdAt: string;
  updatedAt: string;
  journalTail: Array<{ id: number; revision: number; op: string; createdAt: string }>;
};

export async function listGoalCards(
  prisma: PrismaClient,
  actor: ActorScope,
): Promise<GoalCardDto[]> {
  const rows = await prisma.goalRun.findMany({
    where: { spaceId: actor.spaceId, userId: actor.userId },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });
  return Promise.all(
    rows.map((row) => cardDto(prisma, row as unknown as GoalRow & { goalId: string })),
  );
}

export async function getGoalCard(
  prisma: PrismaClient,
  actor: ActorScope,
  goalId: string,
): Promise<GoalCardDto> {
  const row = await prisma.goalRun.findFirst({
    where: { goalId, spaceId: actor.spaceId, userId: actor.userId },
  });
  if (!row) throw new GoalError(`goal_error: unknown goal ${JSON.stringify(goalId)}`);
  return cardDto(prisma, row as unknown as GoalRow & { goalId: string });
}

async function cardDto(prisma: PrismaClient, row: GoalRow): Promise<GoalCardDto> {
  const store = prismaGoalStore(prisma);
  const tail = await store.journalTail(row.goalId, 5);
  const state = await store.load(row.goalId);
  return {
    goalId: row.goalId,
    objective: row.objective,
    name: state?.name ?? row.objective.split(/\s+/).slice(0, 6).join(" ").slice(0, 36),
    status: row.status as GoalStatus,
    revision: row.revision,
    blockedReason: row.blockedReason,
    completionConfidence: (row.completionConfidence as GoalConfidence | null) ?? null,
    error: row.error,
    verdictLine: row.verdictLine,
    tokensUsed: row.tokensUsed,
    tokenBudget: row.tokenBudget,
    consecutiveErrorTurns: row.consecutiveErrorTurns,
    unchangedContinuationTurns: row.unchangedContinuationTurns,
    evaluationCount: row.evaluationCount,
    verifyCmd: row.verifyCmd,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    journalTail: tail.map((entry) => ({
      id: entry.id,
      revision: entry.revision,
      op: entry.op,
      createdAt: entry.createdAt,
    })),
  };
}
