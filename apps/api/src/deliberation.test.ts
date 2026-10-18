import { describe, expect, it } from "vitest";
import {
  type CompleteArgs,
  DELIBERATION_LIMITS,
  type DeliberationAgent,
  parseSynthesis,
  runDeliberation,
  truncate,
} from "./deliberation.js";

const agents: DeliberationAgent[] = [
  {
    id: "a1",
    name: "Chief of Staff",
    role: "orchestrator / generalist",
    persona: "You weigh trade-offs across the whole picture.",
    modelProvider: null,
    modelId: null,
    color: "#9B5CF6",
  },
  {
    id: "a2",
    name: "Ship",
    role: "engineering",
    persona: "You judge feasibility and failure modes.",
    modelProvider: null,
    modelId: null,
    color: "#F5A03C",
  },
  {
    id: "a3",
    name: "Ops",
    role: "infrastructure",
    persona: "You judge deployment and rollback.",
    modelProvider: null,
    modelId: null,
    color: "#F2622A",
  },
];

describe("runDeliberation", () => {
  it("fans the question out to every agent in round 0 with its persona", async () => {
    const calls: CompleteArgs[] = [];
    const result = await runDeliberation({
      question: "Should we ship the roster today?",
      agents,
      complete: async (args) => {
        calls.push(args);
        return `${args.agent.name} take`;
      },
      limits: { crossRounds: 0 },
    });
    expect(calls).toHaveLength(4); // 3 fan-out calls in round 0 + 1 synthesis
    for (const call of calls) {
      expect(call.system).toContain(call.agent.name);
      expect(call.system).toContain(call.agent.persona);
      expect(call.prompt).toContain("Should we ship the roster today?");
    }
    const round0 = result.turns.filter((turn) => turn.round === 0 && turn.kind === "agent");
    expect(round0.map((turn) => turn.agentName)).toEqual(["Chief of Staff", "Ship", "Ops"]);
    expect(result.turns[0].seq).toBe(1);
  });

  it("runs a cross-comment round where each agent sees its peers' takes", async () => {
    const calls: CompleteArgs[] = [];
    await runDeliberation({
      question: "Pick a rollout plan.",
      agents: agents.slice(0, 2),
      complete: async (args) => {
        calls.push(args);
        return `${args.agent.name} take`;
      },
      limits: { crossRounds: 1 },
    });
    // 2 fan-out + 2 cross-comment + 1 synthesis
    expect(calls).toHaveLength(5);
    const cross = calls.filter((call) => call.prompt.includes("Your peers' takes so far"));
    expect(cross).toHaveLength(2);
    expect(cross[0].prompt).toContain("Ship (engineering)");
    expect(cross[1].prompt).toContain("Chief of Staff (orchestrator / generalist)");
    expect(cross[1].prompt).toContain("Chief of Staff take");
  });

  it("synthesizes one joint answer and records dissent", async () => {
    const result = await runDeliberation({
      question: "Ship today or tomorrow?",
      agents: agents.slice(0, 2),
      complete: async (args) => {
        if (args.prompt.includes("Converge the team")) {
          return "JOINT ANSWER:\nShip tomorrow after the smoke test.\nDISSENT:\nShip: would ship today";
        }
        return `${args.agent.name} take`;
      },
      limits: { crossRounds: 0 },
    });
    expect(result.status).toBe("complete");
    expect(result.jointAnswer).toBe("Ship tomorrow after the smoke test.");
    expect(result.dissent).toBe("Ship: would ship today");
    const joint = result.turns.filter((turn) => turn.kind === "joint");
    expect(joint).toHaveLength(1);
    expect(joint[0].agentName).toBe("Joint answer");
    expect(joint[0].content).toContain("Ship tomorrow");
  });

  it("records no dissent when the synthesis says none", async () => {
    const result = await runDeliberation({
      question: "Ship today or tomorrow?",
      agents: agents.slice(0, 2),
      complete: async (args) =>
        args.prompt.includes("Converge the team")
          ? "JOINT ANSWER:\nShip tomorrow.\nDISSENT:\nnone"
          : `${args.agent.name} take`,
      limits: { crossRounds: 0 },
    });
    expect(result.jointAnswer).toBe("Ship tomorrow.");
    expect(result.dissent).toBeNull();
    expect(parseSynthesis("JOINT ANSWER:\nA\nDISSENT:\nnone").dissent).toBeNull();
    expect(parseSynthesis("just prose").jointAnswer).toBe("just prose");
    expect(parseSynthesis("JOINT ANSWER:\nA\nDISSENT:\nOps: rollback risk").dissent).toBe(
      "Ops: rollback risk",
    );
  });

  it("degrades a timed-out agent to a note turn and still converges", async () => {
    const result = await runDeliberation({
      question: "Ship today or tomorrow?",
      agents,
      complete: async (args) => {
        if (args.agent.id === "a2") throw new Error("model call timed out after 60000ms");
        if (args.prompt.includes("Converge the team"))
          return "JOINT ANSWER:\nShip tomorrow.\nDISSENT:\nnone";
        return `${args.agent.name} take`;
      },
      limits: { crossRounds: 0 },
    });
    expect(result.status).toBe("complete");
    expect(result.jointAnswer).toBe("Ship tomorrow.");
    const notes = result.turns.filter((turn) => turn.kind === "note");
    expect(notes).toHaveLength(1);
    expect(notes[0].agentName).toBe("Ship");
    expect(notes[0].meta?.error).toBe(true);
    // the failed agent contributes a note turn instead of an agent take
    expect(result.turns.filter((turn) => turn.kind === "agent")).toHaveLength(2);
  });

  it("bounds a hung model call with an engine-level timeout", async () => {
    const result = await runDeliberation({
      question: "Ship today or tomorrow?",
      agents: agents.slice(0, 2),
      complete: () => new Promise<string>(() => {}),
      limits: { crossRounds: 0, callTimeoutMs: 20, timeoutGraceMs: 0 },
    });
    expect(result.status).toBe("error");
    expect(result.jointAnswer).toBeNull();
    const notes = result.turns.filter((turn) => turn.kind === "note");
    expect(notes.filter((turn) => turn.content.includes("timed out"))).toHaveLength(2);
  });

  it("reports an error result when no agent answers at all", async () => {
    const result = await runDeliberation({
      question: "Ship today or tomorrow?",
      agents: agents.slice(0, 2),
      complete: async () => {
        throw new Error("model call 500: boom");
      },
      limits: { crossRounds: 0, callTimeoutMs: 200, timeoutGraceMs: 0 },
    });
    expect(result.status).toBe("error");
    expect(result.jointAnswer).toBeNull();
    expect(result.turns.some((turn) => turn.kind === "joint")).toBe(false);
  });

  it("enforces the roster and question bounds", async () => {
    const noop = async () => "x";
    await expect(
      runDeliberation({ question: "q", agents: agents.slice(0, 1), complete: noop }),
    ).rejects.toThrow(/at least 2/i);
    await expect(runDeliberation({ question: "   ", agents, complete: noop })).rejects.toThrow(
      /question/i,
    );
    await expect(
      runDeliberation({
        question: "q".repeat(DELIBERATION_LIMITS.questionMaxChars + 1),
        agents,
        complete: noop,
      }),
    ).rejects.toThrow(/longer than/i);
    expect(truncate("abcdef", 3)).toBe("abc…");
  });
});
