import { describe, expect, it } from "vitest";
import {
  accountTokens,
  editObjective,
  evaluateGoal,
  formatVerdictLine,
  type GoalCompleteFn,
  type GoalDeps,
  type GoalState,
  type GoalStore,
  gateBoundedLoop,
  gateDeliveryVerification,
  gateFresh,
  gateVerdictLine,
  goalResume,
  goalTransition,
  memoryGoalStore,
  newGoalState,
  parseEvaluatorOutput,
  revalidateMet,
  runGoalLoop,
  runGoalTurn,
  StaleGoalError,
  settleTurn,
} from "./goals.js";

function evaluatorReply(
  verdict: "met" | "continue" | "impossible",
  reason: string,
  extra = "",
): string {
  return `VERDICT: ${verdict} - ${reason}\n${JSON.stringify({
    verdict,
    reason,
    requirements: [],
    ...(extra ? JSON.parse(extra) : {}),
  })}`;
}

/** Stub model calls: the evaluator system prompt marks evaluation calls. */
function stubComplete(
  continuation: (prompt: string) => { text: string; tokens?: number } | Error,
  evaluator: (prompt: string) => { text: string; tokens?: number } | Error,
): GoalCompleteFn {
  return async ({ system, prompt }) => {
    const result = system.includes("goal evaluator") ? evaluator(prompt) : continuation(prompt);
    if (result instanceof Error) throw result;
    return { text: result.text, tokens: result.tokens ?? 0 };
  };
}

const okVerify = async (cmd: string) => ({ exitCode: 0, stdout: cmd, stderr: "" });
const failVerify = async () => ({ exitCode: 1, stdout: "", stderr: "missing" });

function deps(
  complete: GoalCompleteFn,
  runVerify: (
    cmd: string,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }> = okVerify,
  store?: GoalStore,
): GoalDeps & { store?: GoalStore } {
  return store ? { complete, runVerify, store } : { complete, runVerify };
}

async function created(
  objective = "Create the tiny artifact and prove it exists",
  verifyCmd = "test -f /tmp/goal-artifact",
  tokenBudget: number | null = null,
): Promise<{ state: GoalState; store: ReturnType<typeof memoryGoalStore> }> {
  const store = memoryGoalStore();
  const state = newGoalState("g1", objective, { verifyCmd, tokenBudget });
  await store.commit(null, state);
  return { state, store };
}

describe("verdict line contract", () => {
  it("parses exactly one VERDICT line and rejects anything else", () => {
    expect(gateVerdictLine("work happened\nVERDICT: DONE - shipped it")).toEqual({
      ok: true,
      verdict: "DONE",
      summary: "shipped it",
    });
    expect(gateVerdictLine("no verdict here").ok).toBe(false);
    expect(gateVerdictLine("VERDICT: DONE - a\nVERDICT: BLOCKED - b").ok).toBe(false);
    expect(gateVerdictLine("VERDICT: DONE - ").ok).toBe(false);
    expect(gateVerdictLine("VERDICT: MAYBE - x").ok).toBe(false);
    expect(formatVerdictLine("DONE", "  a\n b  ")).toBe("VERDICT: DONE - a b");
  });
});

describe("fencing (id + revision)", () => {
  it("rejects a stale (goalId, revision) write with StaleGoalError", async () => {
    const { state, store } = await created();
    const next = goalTransition(state, "paused", "paused by user");
    await store.commit(state, next);
    await expect(
      store.commit(state, goalTransition(state, "paused", "again")),
    ).rejects.toBeInstanceOf(StaleGoalError);
  });
  it("gateFresh throws on a mismatched id or revision", () => {
    const state = newGoalState("g1", "objective");
    expect(() => gateFresh(state, "g2", 1)).toThrow(/stale write/);
    expect(() => gateFresh(state, "g1", 2)).toThrow(/stale write/);
  });
});

describe("journal put/clear", () => {
  it("skips a byte-identical snapshot and replays put x3 + clear", async () => {
    const { state, store } = await created();
    expect(await store.commit(state, { ...state })).toBe(false); // identical -> no append
    expect(store.entries.filter((entry) => entry.op === "put")).toHaveLength(1);
    let current = state;
    for (let i = 0; i < 2; i += 1) {
      const next = { ...current, objective: `${state.objective} v${i}` };
      expect(await store.commit(current, next)).toBe(true);
      current = next;
    }
    expect(store.entries.filter((entry) => entry.op === "put")).toHaveLength(3);
    expect((await store.load("g1"))?.objective).toBe(`${state.objective} v1`);
    await store.clear("g1", current.revision);
    expect(await store.load("g1")).toBeNull();
  });
});

describe("evaluator gate", () => {
  it("hard-rejects a bad verdict string into host-generated unavailable", () => {
    const parsed = parseEvaluatorOutput("VERDICT: later - hmm\n{}");
    expect(parsed.verdict).toBe("unavailable");
    expect(parsed.error).toContain("hard-rejected");
    expect(parseEvaluatorOutput("VERDICT: unavailable - x\n{}").verdict).toBe("unavailable");
  });

  it("downgrades met to continue when revalidation finds a remaining requirement", async () => {
    const { state } = await created();
    const complete = stubComplete(
      () => ({ text: "work\nVERDICT: DONE - x" }),
      () => ({
        text: evaluatorReply("met", "looks done", '{"requirements":[{"id":"r1","met":false}]}'),
      }),
    );
    const ev = await evaluateGoal(state, deps(complete));
    expect(ev.verdict).toBe("continue");
    expect(ev.reason).toContain("Remaining requirement: r1");
    expect(revalidateMet(state, { requirements: [{ id: "r1", met: true }] }).ok).toBe(false);
  });

  it("evaluator timeout degrades to unavailable (bounded requests)", async () => {
    const { state } = await created();
    const calls: string[] = [];
    const complete = stubComplete(
      () => ({ text: "x\nVERDICT: DONE - x" }),
      () => {
        calls.push("eval");
        return new Error("goal-evaluator timed out after 600000ms");
      },
    );
    const ev = await evaluateGoal(state, deps(complete));
    expect(ev.verdict).toBe("unavailable");
    expect(ev.error).toContain("timed out");
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  it("prompt overflow is fail-closed unavailable", async () => {
    const state = newGoalState("g1", "x".repeat(8001));
    const ev = await evaluateGoal(
      state,
      deps(
        stubComplete(
          () => ({ text: "x" }),
          () => ({ text: "x" }),
        ),
      ),
    );
    expect(ev.verdict).toBe("unavailable");
    expect(ev.error).toContain("prompt overflow");
  });

  it("met requires delivery verification before complete", async () => {
    const { state } = await created();
    const verified = await gateDeliveryVerification(state, null, okVerify);
    expect(verified).toBe(true);
    const failed = await gateDeliveryVerification(state, null, failVerify);
    expect(failed).toBe(false);
    const noMethod = await gateDeliveryVerification(newGoalState("g2", "obj"), null, okVerify);
    expect(noMethod).toBe(false);
  });
});

describe("guards and budgets", () => {
  it("trips the stall guard at the configured cap", async () => {
    const { state, store } = await created();
    const complete = stubComplete(
      () => ({ text: "still looking\nVERDICT: BLOCKED - still looking" }),
      () => ({ text: evaluatorReply("continue", "no movement") }),
    );
    const result = await runGoalLoop(state, {
      deps: deps(complete, okVerify, store),
      policy: { maxUnchangedContinuations: 2 },
      maxTurns: 10,
    });
    expect(result.state.status).toBe("paused");
    expect(result.state.unchangedContinuationTurns).toBe(2);
    expect(result.state.error).toContain("no_progress");
    expect(gateVerdictLine(result.output).ok).toBe(true);
  });

  it("trips the error guard at the configured cap on verdict-less turns", async () => {
    const { state, store } = await created();
    const complete = stubComplete(
      () => ({ text: "a reply without any verdict line" }),
      () => ({ text: evaluatorReply("continue", "n/a") }),
    );
    const result = await runGoalLoop(state, {
      deps: deps(complete, okVerify, store),
      policy: { maxConsecutiveErrors: 2 },
      maxTurns: 10,
    });
    expect(result.state.status).toBe("paused");
    expect(result.state.consecutiveErrorTurns).toBe(2);
    expect(result.state.error).toContain("agent_errors");
  });

  it("crossing the token budget flips budget_limited and recovery is replacement-only", async () => {
    const { state, store } = await created("tiny goal", "test -x /bin/sh", 50);
    const complete = stubComplete(
      () => ({ text: "working\nVERDICT: BLOCKED - working", tokens: 40 }),
      () => ({ text: evaluatorReply("continue", "keep going"), tokens: 1 }),
    );
    const result = await runGoalLoop(state, {
      deps: deps(complete, okVerify, store),
      maxTurns: 10,
    });
    expect(result.state.status).toBe("budget_limited");
    expect(result.state.tokensUsed).toBeGreaterThanOrEqual(50);
    expect(gateBoundedLoop(result.state).allowed).toBe(false);
    expect(() => goalResume(result.state)).toThrow(/replacement-only/);
  });
});

describe("run loop", () => {
  it("runs continuation + evaluator checkpoints to complete with delivery verification", async () => {
    const { state, store } = await created();
    const verifyCalls: string[] = [];
    const complete = stubComplete(
      () => ({ text: "created the artifact\nVERDICT: DONE - artifact created", tokens: 10 }),
      () => ({ text: evaluatorReply("met", "the artifact exists"), tokens: 5 }),
    );
    const result = await runGoalLoop(state, {
      deps: deps(
        complete,
        async (cmd) => {
          verifyCalls.push(cmd);
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        store,
      ),
    });
    expect(result.state.status).toBe("complete");
    expect(result.state.completionConfidence).toBe("tested");
    expect(verifyCalls).toEqual(["test -f /tmp/goal-artifact"]);
    // exactly one VERDICT line on the run output, and it is the last line
    expect(gateVerdictLine(result.output)).toMatchObject({ ok: true, verdict: "DONE" });
    expect(result.output.trimEnd().endsWith(result.verdictLine)).toBe(true);
    // evaluator spend is tracked separately from run spend
    expect(result.state.tokensUsed).toBe(10);
    expect(result.state.evaluatorTokensUsed).toBe(5);
  });

  it("pauses on delivery failure when the evaluator says met", async () => {
    const { state, store } = await created();
    const complete = stubComplete(
      () => ({ text: "done?\nVERDICT: DONE - done?" }),
      () => ({ text: evaluatorReply("met", "looks done") }),
    );
    const result = await runGoalLoop(state, { deps: deps(complete, failVerify, store) });
    expect(result.state.status).toBe("paused");
    expect(result.state.error).toContain("delivery_failed");
    expect(result.verdictLine.startsWith("VERDICT: BLOCKED - ")).toBe(true);
  });

  it("blocks on an impossible verdict and pauses on an unavailable one", async () => {
    const { state, store } = await created();
    const impossible = await runGoalLoop(state, {
      deps: deps(
        stubComplete(
          () => ({ text: "cannot\nVERDICT: BLOCKED - cannot proceed" }),
          () => ({ text: evaluatorReply("impossible", "physics says no") }),
        ),
        okVerify,
        store,
      ),
    });
    expect(impossible.state.status).toBe("blocked");
    expect(impossible.state.blockedReason).toContain("physics says no");
    expect(impossible.state.error).toContain("goal_error");

    const { state: s2, store: store2 } = await created("second goal");
    const unavailable = await runGoalLoop(s2, {
      deps: deps(
        stubComplete(
          () => ({ text: "hmm\nVERDICT: BLOCKED - hmm" }),
          () => ({ text: "garbage with no verdict line or json" }),
        ),
        okVerify,
        store2,
      ),
    });
    expect(unavailable.state.status).toBe("paused");
    expect(unavailable.state.error).toContain("evaluator_unavailable");
  });

  it("counts a continuation without a VERDICT line as an error turn", async () => {
    const { state } = await created();
    const result = await runGoalTurn(state, "plain text, no contract", {
      deps: deps(
        stubComplete(
          () => ({ text: "x" }),
          () => ({ text: "x" }),
        ),
      ),
      policy: { maxConsecutiveErrors: 3 },
    });
    expect(result.state.consecutiveErrorTurns).toBe(1);
    expect(result.verdictLine).toContain("turn verdict line rejected");
  });

  it("objective edit resets guards and clears completion claims", async () => {
    const { state } = await created();
    const settled = settleTurn(state, { verdict: "continue", reason: "r", error: true });
    const edited = editObjective(settled.state, "a new objective");
    expect(edited.consecutiveErrorTurns).toBe(0);
    expect(edited.unchangedContinuationTurns).toBe(0);
    expect(edited.lastEvaluation).toBeNull();
    expect(edited.completionConfidence).toBeNull();
    const accounted = accountTokens(edited, 5);
    expect(accounted.tokensUsed).toBe(5);
  });
});
