import type { GoalCard } from "@rakazo/contracts";
import { Badge, Button, Card, cn, Input, Spinner, Textarea } from "@rakazo/ui-web";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { GoalGraph } from "./goal-graph";

const POLL_MS = 2000;

function statusBadgeClass(status: GoalCard["status"]): string {
  switch (status) {
    case "complete":
      return "uppercase tracking-wider";
    case "active":
      return "uppercase tracking-wider";
    default:
      return "uppercase tracking-wider";
  }
}

function Progress({ goal }: { goal: GoalCard }) {
  const budget = goal.tokenBudget;
  const pct = budget ? Math.min(100, Math.round((goal.tokensUsed / budget) * 100)) : null;
  return (
    <div className="mt-2 space-y-1 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          tokens {goal.tokensUsed}
          {budget ? ` / ${budget}` : ""}
        </span>
        <span>· {goal.evaluationCount} evaluations</span>
        <span>· errors {goal.consecutiveErrorTurns}</span>
        <span>· stalls {goal.unchangedContinuationTurns}</span>
        {pct !== null ? (
          <span className="inline-flex items-center gap-2">
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-foreground"
                style={{ width: `${pct}%` }}
              />
            </span>
            {pct}%
          </span>
        ) : null}
      </div>
    </div>
  );
}

function JournalTail({ goal }: { goal: GoalCard }) {
  if (goal.journalTail.length === 0) return null;
  return (
    <div className="mt-3 border-t pt-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Journal tail
      </span>
      <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted-foreground">
        {goal.journalTail.map((entry) => (
          <li key={entry.id}>
            #{entry.id} rev {entry.revision} {entry.op} · {entry.createdAt.slice(11, 19)}Z
          </li>
        ))}
      </ul>
    </div>
  );
}

function GoalCardView({
  goal,
  busy,
  onAction,
}: {
  goal: GoalCard;
  busy: boolean;
  onAction: (action: "pause" | "resume" | "block", reason?: string) => void;
}) {
  const [blocking, setBlocking] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <Card className="rounded-xl p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{goal.name}</h2>
        <Badge
          variant={goal.status === "complete" ? "default" : "secondary"}
          className={statusBadgeClass(goal.status)}
        >
          {goal.status.replace("_", " ")}
        </Badge>
        <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
          rev {goal.revision}
        </span>
        {goal.status === "active" ? (
          <span
            className="flex items-center gap-2 text-xs"
            style={{ color: "var(--status-working)" }}
          >
            <Spinner className="h-3 w-3" /> working
          </span>
        ) : null}
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{goal.objective}</p>
      <Progress goal={goal} />
      <GoalGraph goal={goal} />
      {goal.verdictLine ? <p className="mt-2 text-xs font-medium">{goal.verdictLine}</p> : null}
      {goal.blockedReason ? (
        <p className="mt-1 text-xs text-muted-foreground">blocked: {goal.blockedReason}</p>
      ) : null}
      {goal.error ? <p className="mt-1 text-xs text-destructive">{goal.error}</p> : null}
      <JournalTail goal={goal} />
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {goal.status === "active" ? (
          <>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => onAction("pause")}>
              Pause
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setBlocking(true)}>
              Block
            </Button>
          </>
        ) : null}
        {goal.status === "paused" || goal.status === "blocked" ? (
          <Button size="sm" disabled={busy} onClick={() => onAction("resume")}>
            Resume
          </Button>
        ) : null}
        {blocking ? (
          <span className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 w-56"
              placeholder="Why is this blocked?"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <Button
              size="sm"
              disabled={busy || !reason.trim()}
              onClick={() => {
                setBlocking(false);
                onAction("block", reason.trim());
              }}
            >
              Confirm block
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setBlocking(false)}>
              Cancel
            </Button>
          </span>
        ) : null}
      </div>
    </Card>
  );
}

export function GoalsPage() {
  const [goals, setGoals] = useState<GoalCard[]>([]);
  const [objective, setObjective] = useState("");
  const [verifyCmd, setVerifyCmd] = useState("");
  const [tokenBudget, setTokenBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadGoals = useCallback(async () => {
    try {
      const rows = await rpc.goals.list();
      setGoals(rows);
      setError(null);
      return rows;
    } catch (err) {
      setError(errorText(err));
      return [];
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const rows = await loadGoals();
      if (cancelled) return;
      if (rows.some((goal) => goal.status === "active")) {
        timer.current = setTimeout(() => void poll(), POLL_MS);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [loadGoals]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await rpc.goals.create({
        objective,
        verifyCmd: verifyCmd.trim() || undefined,
        tokenBudget: tokenBudget.trim() ? Number.parseInt(tokenBudget, 10) : undefined,
      });
      setObjective("");
      setVerifyCmd("");
      setTokenBudget("");
      await loadGoals();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const action = async (goal: GoalCard, act: "pause" | "resume" | "block", reason?: string) => {
    setBusy(true);
    setError(null);
    try {
      if (act === "pause") await rpc.goals.pause({ goalId: goal.goalId, revision: goal.revision });
      else if (act === "resume")
        await rpc.goals.resume({ goalId: goal.goalId, revision: goal.revision });
      else
        await rpc.goals.block({
          goalId: goal.goalId,
          revision: goal.revision,
          reason: reason ?? "blocked by user",
        });
      await loadGoals();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Goals</h1>
        <span className="text-sm text-muted-foreground">
          Long-running objectives with bounded turns, evaluator checkpoints, and a delivery-verified
          verdict.
        </span>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Card className="rounded-xl p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Start a goal
        </h2>
        <Textarea
          className="mt-3"
          rows={3}
          placeholder="What should the agent drive to completion?"
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
        />
        <Input
          className="mt-3"
          placeholder="Delivery verification command (optional — completion is only accepted when it exits 0)"
          value={verifyCmd}
          onChange={(event) => setVerifyCmd(event.target.value)}
        />
        <Input
          className="mt-3"
          placeholder="Token budget (optional)"
          value={tokenBudget}
          onChange={(event) => setTokenBudget(event.target.value)}
        />
        <Button
          className="mt-3"
          size="sm"
          disabled={busy || !objective.trim()}
          onClick={() => void create()}
        >
          Start goal
        </Button>
      </Card>

      <div className={cn("space-y-4")}>
        {goals.map((goal) => (
          <GoalCardView
            key={goal.goalId}
            goal={goal}
            busy={busy}
            onAction={(act, reason) => void action(goal, act, reason)}
          />
        ))}
        {goals.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">No goals yet.</p>
        ) : null}
      </div>
    </div>
  );
}
