import type { GoalCard } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { graphModel } from "./goal-graph";

const base = { status: "active", evaluationCount: 0 } as Pick<
  GoalCard,
  "status" | "evaluationCount"
>;

describe("goal workflow graph model", () => {
  it("marks the pipeline nodes done and the terminal node done on complete", () => {
    const { nodes } = graphModel({ ...base, status: "complete", evaluationCount: 7 });
    const state = (id: string) => nodes.find((n) => n.id === id)?.state;
    expect(state("done")).toBe("done");
    expect(state("turn")).toBe("done");
    expect(state("blocked")).toBe("idle");
  });

  it("highlights the approximate phase while active", () => {
    expect(
      graphModel({ ...base, evaluationCount: 0 }).nodes.find((n) => n.id === "turn")?.state,
    ).toBe("current");
    expect(
      graphModel({ ...base, evaluationCount: 3 }).nodes.find((n) => n.id === "evaluator")?.state,
    ).toBe("current");
  });

  it("alerts the evaluator node on pause and the blocked node when halted", () => {
    const paused = graphModel({ ...base, status: "paused", evaluationCount: 6 }).nodes;
    expect(paused.find((n) => n.id === "evaluator")?.state).toBe("alert");
    const blocked = graphModel({ ...base, status: "blocked", evaluationCount: 6 }).nodes;
    expect(blocked.find((n) => n.id === "blocked")?.state).toBe("alert");
  });

  it("keeps the branch edges: met→verify, continue-loop, impossible→blocked", () => {
    const { edges } = graphModel(base);
    const has = (from: string, to: string) => edges.some((e) => e.from === from && e.to === to);
    expect(has("evaluator", "verify")).toBe(true);
    expect(edges.some((e) => e.from === "evaluator" && e.to === "turn" && e.loop)).toBe(true);
    expect(has("evaluator", "blocked")).toBe(true);
  });
});
