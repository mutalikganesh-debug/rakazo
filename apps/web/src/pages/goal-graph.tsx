import type { GoalCard } from "@rakazo/contracts";

/**
 * Mastra-style workflow graph for a goal run: deterministic pipeline of the
 * goal loop with its branch (met/continue/blocked) and loop-back edges.
 * Pure model first so it is unit-testable without a DOM.
 */

export type GraphNodeState = "done" | "current" | "idle" | "alert";

export interface GraphNode {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  state: GraphNodeState;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
  loop?: boolean;
}

const NODES: ReadonlyArray<Pick<GraphNode, "id" | "label" | "x" | "y" | "w">> = [
  { id: "create", label: "create", x: 12, y: 84, w: 64 },
  { id: "turn", label: "worker turn", x: 106, y: 84, w: 96 },
  { id: "harvest", label: "EVIDENCE / ANSWER", x: 232, y: 84, w: 132 },
  { id: "evaluator", label: "evaluator", x: 394, y: 84, w: 88 },
  { id: "verify", label: "delivery verify", x: 512, y: 24, w: 116 },
  { id: "done", label: "done", x: 512, y: 84, w: 88 },
  { id: "blocked", label: "blocked / impossible", x: 394, y: 168, w: 128 },
];

const EDGES: ReadonlyArray<GraphEdge> = [
  { from: "create", to: "turn" },
  { from: "turn", to: "harvest" },
  { from: "harvest", to: "evaluator" },
  { from: "evaluator", to: "verify", label: "met" },
  { from: "verify", to: "done", label: "pass" },
  { from: "evaluator", to: "turn", label: "continue / verify fail", loop: true },
  { from: "evaluator", to: "blocked", label: "impossible / guards" },
];

export function graphModel(goal: Pick<GoalCard, "status" | "evaluationCount">): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const halted = goal.status === "blocked" || goal.status === "budget_limited";
  // ponytail: exact loop phase is not tracked; approximate from status + eval count.
  const phase = goal.status === "active" ? (goal.evaluationCount > 0 ? "evaluator" : "turn") : null;
  const nodes = NODES.map((node) => {
    let state: GraphNodeState = "idle";
    if (node.id === "blocked") state = halted ? "alert" : "idle";
    else if (goal.status === "complete") state = "done";
    else if (node.id === "done") state = "idle";
    else if (phase && node.id === phase) state = "current";
    else if (goal.status === "paused" && node.id === "evaluator") state = "alert";
    else if (goal.status === "paused") state = "done";
    else if (halted) state = node.id === "create" ? "done" : "idle";
    else if (goal.status === "active") state = "done";
    return { ...node, state };
  });
  return { nodes, edges: [...EDGES] };
}

const STROKE = "var(--border, #d4d4d8)";
const FILL = "var(--card, #ffffff)";
const TEXT = "var(--foreground, #18181b)";
const MUTED = "var(--muted-foreground, #71717a)";
const WORKING = "var(--status-working, #2563eb)";

function nodeFill(state: GraphNodeState): string {
  if (state === "current") return WORKING;
  if (state === "alert") return "var(--destructive, #dc2626)";
  return FILL;
}

function nodeText(state: GraphNodeState): string {
  return state === "current" || state === "alert" ? "#ffffff" : state === "done" ? TEXT : MUTED;
}

export function GoalGraph({ goal }: { goal: GoalCard }) {
  const { nodes, edges } = graphModel(goal);
  const at = (id: string): GraphNode => {
    const found = nodes.find((node) => node.id === id);
    if (!found) throw new Error(`graph node missing: ${id}`);
    return found;
  };
  return (
    <svg
      viewBox="0 0 640 224"
      role="img"
      aria-label="Goal workflow graph"
      className="mt-3 w-full rounded-lg border bg-card/30"
    >
      {edges.map((edge) => {
        const from = at(edge.from);
        const to = at(edge.to);
        const x1 = from.x + from.w;
        const y1 = from.y + 16;
        const x2 = to.x;
        const y2 = to.y + 16;
        const d = edge.loop
          ? `M ${x1} ${y1} C 470 210, 60 210, ${x2 + to.w / 2} ${y2 + 32}`
          : `M ${x1} ${y1} C ${x1 + 24} ${y1}, ${x2 - 24} ${y2}, ${x2} ${y2}`;
        return (
          <g key={`${edge.from}-${edge.to}`}>
            <path d={d} stroke={STROKE} strokeWidth={1.5} fill="none" markerEnd="url(#arrow)" />
            {edge.label ? (
              <text
                x={(x1 + x2) / 2}
                y={edge.loop ? 214 : (y1 + y2) / 2 - 6}
                textAnchor="middle"
                fontSize={9}
                fill={MUTED}
              >
                {edge.label}
              </text>
            ) : null}
          </g>
        );
      })}
      <defs>
        <marker id="arrow" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={6} markerHeight={6} orient="auto">
          <path d="M 0 0 L 8 4 L 0 8 z" fill={STROKE} />
        </marker>
      </defs>
      {nodes.map((node) => (
        <g key={node.id}>
          <rect
            x={node.x}
            y={node.y}
            width={node.w}
            height={32}
            rx={8}
            fill={nodeFill(node.state)}
            stroke={node.state === "idle" ? STROKE : nodeFill(node.state)}
            strokeWidth={1.5}
          />
          <text
            x={node.x + node.w / 2}
            y={node.y + 20}
            textAnchor="middle"
            fontSize={10}
            fontWeight={600}
            fill={nodeText(node.state)}
          >
            {node.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
