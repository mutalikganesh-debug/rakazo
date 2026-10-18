import type {
  AgentProfile,
  DeliberationRoom,
  DeliberationRoomDetail,
  DeliberationTurnDto,
  ModelCatalogEntry,
} from "@rakazo/contracts";
import { Badge, Button, Card, cn, Input, Spinner, Textarea } from "@rakazo/ui-web";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

const POLL_MS = 2000;

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function AgentAvatar({ name, color, size = 32 }: { name: string; color: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        color,
        background: `color-mix(in srgb, ${color} 18%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
        fontSize: size * 0.36,
      }}
    >
      {initials(name)}
    </span>
  );
}

function TurnRow({ turn }: { turn: DeliberationTurnDto }) {
  return (
    <div className="flex gap-3 py-3">
      <AgentAvatar name={turn.agentName} color={turn.color ?? "#85858a"} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-semibold">{turn.agentName}</span>
          {turn.agentRole ? (
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {turn.agentRole}
            </span>
          ) : null}
          <span className="text-[11px] text-muted-foreground">
            {turn.round === 0 ? "opening take" : `exchange ${turn.round}`}
          </span>
        </div>
        <p
          className={cn(
            "mt-1 whitespace-pre-wrap text-sm leading-6",
            turn.error && "italic text-muted-foreground",
          )}
        >
          {turn.content}
        </p>
      </div>
    </div>
  );
}

function JointAnswerCard({ room }: { room: DeliberationRoom }) {
  return (
    <Card className="mt-4 p-5" style={{ borderLeft: "4px solid var(--primary)" }}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          className="uppercase tracking-wider"
          style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
        >
          Joint answer · converged verdict
        </Badge>
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          decision support — verify before acting
        </span>
      </div>
      <p className="mt-3 whitespace-pre-wrap text-sm font-medium leading-6">{room.jointAnswer}</p>
      <div className="mt-4 border-t pt-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Dissent
        </span>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
          {room.dissent ?? "No dissent — the team converged without recorded disagreement."}
        </p>
      </div>
    </Card>
  );
}

function RoomThread({ detail, running }: { detail: DeliberationRoomDetail; running: boolean }) {
  const { room, turns } = detail;
  const deliberationTurns = turns.filter((turn) => turn.kind === "agent" || turn.kind === "note");
  const [open, setOpen] = useState(running);
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{room.title}</h2>
        <Badge
          variant={room.status === "complete" ? "default" : "secondary"}
          className="uppercase tracking-wider"
        >
          {room.status}
        </Badge>
        {running ? (
          <span
            className="flex items-center gap-2 text-sm"
            style={{ color: "var(--status-working)" }}
          >
            <Spinner className="size-3.5" /> agents are deliberating
          </span>
        ) : null}
      </div>
      <div className="mt-4 rounded-xl p-4" style={{ background: "var(--chat-user)" }}>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          You asked
        </span>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-6">{room.question}</p>
      </div>

      <div className="mt-4">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
          aria-expanded={open}
        >
          <span aria-hidden>{open ? "▾" : "▸"}</span>
          Deliberation · {deliberationTurns.length}{" "}
          {deliberationTurns.length === 1 ? "turn" : "turns"}
        </button>
        {open ? (
          <div className="mt-1 divide-y">
            {deliberationTurns.map((turn) => (
              <TurnRow key={turn.id} turn={turn} />
            ))}
            {deliberationTurns.length === 0 && running ? (
              <p className="py-3 text-sm text-muted-foreground">Waiting for the first take…</p>
            ) : null}
          </div>
        ) : null}
      </div>

      {room.jointAnswer ? <JointAnswerCard room={room} /> : null}
    </div>
  );
}

function RosterEditor({
  agents,
  catalog,
  onSaved,
}: {
  agents: AgentProfile[];
  catalog: ModelCatalogEntry[];
  onSaved: (agent: AgentProfile) => void;
}) {
  const [drafts, setDrafts] = useState<
    Record<string, { name: string; role: string; persona: string; modelChoice: string }>
  >({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const draftFor = (agent: AgentProfile) =>
    drafts[agent.id] ?? {
      name: agent.name,
      role: agent.role,
      persona: agent.persona,
      modelChoice:
        agent.modelProvider && agent.modelId ? `${agent.modelProvider}::${agent.modelId}` : "",
    };

  const save = async (agent: AgentProfile) => {
    setBusy(agent.id);
    setError(null);
    try {
      const draft = draftFor(agent);
      const [modelProvider, modelId] = draft.modelChoice.includes("::")
        ? draft.modelChoice.split("::", 2)
        : [null, null];
      const updated = await rpc.deliberation.agents.update({
        agentId: agent.id,
        name: draft.name,
        role: draft.role,
        persona: draft.persona,
        modelProvider,
        modelId,
      });
      onSaved(updated);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Agent roster
      </h2>
      <div className="mt-3 space-y-4">
        {agents.map((agent) => {
          const draft = draftFor(agent);
          return (
            <div key={agent.id} className="rounded-xl border p-4">
              <div className="flex flex-wrap items-center gap-3">
                <AgentAvatar name={draft.name || agent.name} color={agent.color} />
                <Input
                  aria-label="Agent name"
                  className="w-44"
                  value={draft.name}
                  onChange={(event) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [agent.id]: { ...draft, name: event.target.value },
                    }))
                  }
                />
                <Input
                  aria-label="Agent role"
                  className="w-56"
                  value={draft.role}
                  onChange={(event) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [agent.id]: { ...draft, role: event.target.value },
                    }))
                  }
                />
                <select
                  aria-label="Agent model"
                  className="h-9 rounded-lg border bg-input px-2 text-sm"
                  value={draft.modelChoice}
                  onChange={(event) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [agent.id]: { ...draft, modelChoice: event.target.value },
                    }))
                  }
                >
                  <option value="">Your default model</option>
                  {catalog.map((entry) => (
                    <option
                      key={`${entry.provider}::${entry.id}`}
                      value={`${entry.provider}::${entry.id}`}
                    >
                      {entry.providerName ?? entry.provider} · {entry.label}
                    </option>
                  ))}
                </select>
                <Button size="sm" onClick={() => save(agent)} disabled={busy === agent.id}>
                  {busy === agent.id ? "Saving…" : "Save"}
                </Button>
              </div>
              <Textarea
                aria-label="Agent persona"
                className="mt-3"
                rows={2}
                value={draft.persona}
                placeholder="Role persona — how this agent thinks and what it guards"
                onChange={(event) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [agent.id]: { ...draft, persona: event.target.value },
                  }))
                }
              />
            </div>
          );
        })}
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
    </Card>
  );
}

function NewRoomCard({ agents }: { agents: AgentProfile[] }) {
  const navigate = useNavigate();
  const [question, setQuestion] = useState("");
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<string[]>(() =>
    agents.slice(0, 2).map((agent) => agent.id),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelected((prev) => (prev.length > 0 ? prev : agents.slice(0, 2).map((agent) => agent.id)));
  }, [agents]);

  const toggle = (agentId: string) =>
    setSelected((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId],
    );

  const convene = async () => {
    setBusy(true);
    setError(null);
    try {
      const detail = await rpc.deliberation.rooms.create({
        question,
        title: title.trim() || undefined,
        agentIds: selected,
      });
      navigate(`/app/deliberation/${detail.room.id}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Convene a room
      </h2>
      <Textarea
        className="mt-3"
        rows={3}
        placeholder="Ask the team a question — every selected agent deliberates, then the room posts one joint answer."
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
      />
      <Input
        className="mt-3"
        placeholder="Room title (optional)"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        {agents.map((agent) => {
          const checked = selected.includes(agent.id);
          return (
            <button
              key={agent.id}
              type="button"
              onClick={() => toggle(agent.id)}
              aria-pressed={checked}
              className={cn(
                "flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm",
                checked ? "border-foreground bg-accent" : "border-border text-muted-foreground",
              )}
            >
              <AgentAvatar name={agent.name} color={agent.color} size={20} />
              {agent.name}
            </button>
          );
        })}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button
          onClick={convene}
          disabled={busy || selected.length < 2 || question.trim().length === 0}
        >
          {busy ? "Convening…" : "Convene"}
        </Button>
        <span className="text-xs text-muted-foreground">
          {selected.length < 2
            ? "Pick at least 2 agents"
            : `${selected.length} agents will deliberate`}
        </span>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
    </Card>
  );
}

function RoomListView({ rooms }: { rooms: DeliberationRoom[] }) {
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Rooms
      </h2>
      <div className="mt-2 divide-y">
        {rooms.map((room) => (
          <Link
            key={room.id}
            to={`/app/deliberation/${room.id}`}
            className="flex items-center justify-between gap-3 py-3 hover:bg-accent"
          >
            <span className="min-w-0 truncate text-sm">{room.title}</span>
            <Badge variant="secondary" className="uppercase tracking-wider">
              {room.status}
            </Badge>
          </Link>
        ))}
        {rooms.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">No rooms yet.</p>
        ) : null}
      </div>
    </Card>
  );
}

export function DeliberationPage() {
  const { roomId } = useParams();
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [rooms, setRooms] = useState<DeliberationRoom[]>([]);
  const [detail, setDetail] = useState<DeliberationRoomDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadRoster = useCallback(async () => {
    try {
      const [agentRows, modelEntries] = await Promise.all([
        rpc.deliberation.agents.list(),
        rpc.models.list(),
      ]);
      setAgents(agentRows);
      setCatalog(modelEntries);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  const loadRooms = useCallback(async () => {
    try {
      setRooms(await rpc.deliberation.rooms.list());
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    if (!roomId) {
      void loadRooms();
    }
  }, [roomId, loadRooms]);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await rpc.deliberation.rooms.get({ roomId });
        if (cancelled) return;
        setDetail(next);
        setError(null);
        if (next.room.status === "running") {
          timer.current = setTimeout(() => void poll(), POLL_MS);
        }
      } catch (err) {
        if (!cancelled) setError(errorText(err));
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [roomId]);

  const sortedRooms = useMemo(
    () => [...rooms].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [rooms],
  );

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="flex flex-wrap items-center gap-3">
        {roomId ? (
          <Link
            to="/app/deliberation"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← All rooms
          </Link>
        ) : null}
        <h1 className="text-xl font-semibold">Deliberation</h1>
        <span className="text-sm text-muted-foreground">
          Named agents deliberate in the open, then converge on one joint answer.
        </span>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {roomId ? (
        detail ? (
          <RoomThread detail={detail} running={detail.room.status === "running"} />
        ) : (
          <p className="text-sm text-muted-foreground">Loading room…</p>
        )
      ) : (
        <>
          <NewRoomCard agents={agents} />
          <RosterEditor
            agents={agents}
            catalog={catalog}
            onSaved={(agent) =>
              setAgents((prev) => prev.map((row) => (row.id === agent.id ? agent : row)))
            }
          />
          <RoomListView rooms={sortedRooms} />
        </>
      )}
    </div>
  );
}
