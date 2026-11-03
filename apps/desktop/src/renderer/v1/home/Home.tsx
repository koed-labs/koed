import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";
import {
  AUTOMATIC_HISTORICAL_CONVERSATION_CAP,
  AUTOMATIC_HISTORICAL_WINDOW_DAYS
} from "@koed/shared/historical-ingestion-progress";
import type { DesktopStatusStore } from "../../services/desktop-commands.js";
import { AiClientLogo } from "../../views/personal/AiClientLogo.js";
import { Pixelkin } from "../pixelkin/Pixelkin.js";
import { projectKinLook, type AgentLook } from "../pixelkin/agent-kin.js";
import {
  HOME_STAGE_LIMIT,
  formatHomeAgo,
  holdHomeOrder,
  homeHeat,
  rankHomeProjects,
  type HomeClient,
  type HomeIngestion,
  type HomeIngestionClient,
  type HomeProblem,
  type HomeProjectEntry,
  type HomeView
} from "./home-model.js";
import "./home.css";

// Re-ranking waits at least this long between moves so Kin don't jostle.
export const HOME_RERANK_MS = 6_000;
// Repeated activity for one Kin within this window shares one tile.
const FEED_COALESCE_MS = 1_200;

const useReducedMotion = () => {
  const query = useMemo(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null,
    []
  );
  const [reduced, setReduced] = useState(query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [query]);
  return reduced;
};

const useWindowFocused = () => {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const focus = () => setFocused(true);
    const blur = () => setFocused(false);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
    };
  }, []);
  return focused;
};

const useNow = (intervalMs: number) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
};

function Keycaps({
  clients,
  ingestion
}: {
  clients: readonly HomeClient[];
  ingestion?: HomeIngestion;
}) {
  if (!clients.length) return null;
  const progress = new Map(
    ingestion?.clients.map((client) => [client.id, client])
  );
  return (
    <ul className="v1-home-keycaps" aria-label="AI Clients">
      {clients.map((client) => (
        <li key={client.id} data-state={client.state}>
          <span
            className="v1-home-keycap"
            data-client={client.id}
            aria-hidden="true"
          >
            <AiClientLogo id={client.id} />
          </span>
          <strong>{client.name}</strong>
          {progress.has(client.id) ? (
            <span
              className="v1-home-pill"
              data-lifecycle={progress.get(client.id)!.lifecycle}
              data-stuck={progress.get(client.id)!.stuck || undefined}
            >
              {ingestionLine(progress.get(client.id)!)}
            </span>
          ) : (
            <span className="v1-home-pill">{client.label}</span>
          )}
          {client.state === "detected" && (
            <small>
              {progress.has(client.id) ? "Not connected" : null}
              {client.version && progress.has(client.id) ? " · " : null}
              {client.version}
            </small>
          )}
        </li>
      ))}
    </ul>
  );
}

function ProblemAction({
  problem,
  statusStore,
  primary
}: {
  problem: HomeProblem;
  statusStore: DesktopStatusStore;
  primary: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = problem.action;
  if (!action) return null;
  const run = async () => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      await statusStore.run(
        action.command,
        action.requiresConsent ? { operatorConsented: true } : undefined
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      void statusStore.refresh();
    }
  };
  return (
    <div className="v1-home-action">
      {confirming ? (
        <>
          <span>This changes software on this Mac. Continue?</span>
          <button
            type="button"
            className="v1-home-primary"
            onClick={() => void run()}
          >
            Continue
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          className={primary ? "v1-home-primary" : undefined}
          disabled={busy}
          onClick={() =>
            action.requiresConsent ? setConfirming(true) : void run()
          }
        >
          {busy ? "Working…" : action.label}
        </button>
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}

function ProblemList({
  problems,
  primary,
  statusStore,
  compact = false
}: {
  problems: readonly HomeProblem[];
  primary: HomeProblem | null;
  statusStore: DesktopStatusStore;
  compact?: boolean;
}) {
  return (
    <ul
      className={`v1-home-problems ${compact ? "v1-home-problems-compact" : ""}`}
    >
      {problems.map((problem) => (
        <li key={problem.id}>
          <span className="v1-home-dot" aria-hidden="true" />
          <div>
            <strong>{problem.title}</strong>
            <span>{problem.message}</span>
          </div>
          <ProblemAction
            problem={problem}
            statusStore={statusStore}
            primary={problem.id === primary?.id}
          />
        </li>
      ))}
    </ul>
  );
}

type Feed = { key: number; added: number; at: number };

const slots: ReadonlyArray<{ x: number; y: number; size: number }> = [
  { x: 50, y: 4, size: 120 },
  { x: 24, y: 10, size: 96 },
  { x: 76, y: 10, size: 96 },
  { x: 10, y: 46, size: 64 },
  { x: 30, y: 50, size: 64 },
  { x: 50, y: 52, size: 64 },
  { x: 70, y: 50, size: 64 },
  { x: 90, y: 46, size: 64 }
];

function ProjectsStage({
  entries,
  onOpenProject
}: {
  entries: readonly HomeProjectEntry[];
  onOpenProject: (projectId: string) => void;
}) {
  const reduced = useReducedMotion();
  const focused = useWindowFocused();
  const now = useNow(30_000);
  const [pointerOver, setPointerOver] = useState(false);
  const held = focused && pointerOver;
  const ranked = useMemo(() => rankHomeProjects(entries), [entries]);
  const [shown, setShown] = useState<string[]>(ranked);
  const appliedAt = useRef(0);
  useEffect(() => {
    if (held) {
      setShown((current) => holdHomeOrder(current, ranked));
      return;
    }
    const apply = () => {
      appliedAt.current = Date.now();
      setShown(ranked);
    };
    const wait = appliedAt.current + HOME_RERANK_MS - Date.now();
    if (wait <= 0) {
      apply();
      return;
    }
    // Show new or removed Projects now; the move waits for the throttle.
    setShown((current) => holdHomeOrder(current, ranked));
    const timer = window.setTimeout(apply, wait);
    return () => window.clearTimeout(timer);
  }, [ranked, held]);

  // Counts come from the Project summaries; a rise feeds that Kin once.
  const counts = useRef<Map<string, number> | null>(null);
  const [feeds, setFeeds] = useState<ReadonlyMap<string, Feed>>(new Map());
  const feedKey = useRef(0);
  useEffect(() => {
    const previous = counts.current;
    counts.current = new Map(
      entries.map(({ id, eventCount }) => [id, eventCount])
    );
    // The first load is history, not new activity: nothing to replay.
    if (!previous || reduced) return;
    const at = Date.now();
    setFeeds((current) => {
      const next = new Map(current);
      for (const { id, eventCount } of entries) {
        const added = eventCount - (previous.get(id) ?? eventCount);
        if (added <= 0) continue;
        const last = next.get(id);
        next.set(
          id,
          last && at - last.at < FEED_COALESCE_MS
            ? { ...last, added: last.added + added }
            : { key: ++feedKey.current, added, at }
        );
      }
      return next;
    });
  }, [entries, reduced]);

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const onStage = shown.slice(0, HOME_STAGE_LIMIT);
  const listed = shown
    .map((id) => byId.get(id))
    .filter((entry): entry is HomeProjectEntry => Boolean(entry));
  // Kin render in a fixed order so a re-rank moves them instead of remounting.
  const stageKin = entries.filter(({ id }) => onStage.includes(id));
  return (
    <>
      <section
        className="v1-home-stage"
        aria-label="Most active Projects"
        data-reduced-motion={reduced || undefined}
        onPointerEnter={() => setPointerOver(true)}
        onPointerLeave={() => setPointerOver(false)}
      >
        {stageKin.map((entry) => {
          const rank = onStage.indexOf(entry.id);
          const slot = slots[rank]!;
          const feed = feeds.get(entry.id);
          const ago = formatHomeAgo(entry.latestAt, now);
          return (
            <button
              key={entry.id}
              type="button"
              className="v1-home-kin"
              data-front={rank < 3 || undefined}
              data-heat={homeHeat(entry.latestAt, now)}
              style={
                {
                  "--kin-x": `${slot.x}%`,
                  "--kin-y": `${slot.y}%`,
                  "--kin-size": `${slot.size}px`
                } as CSSProperties
              }
              aria-label={`Open Project ${entry.name}, ${entry.eventCount} captured events, active ${ago}`}
              onClick={() => onOpenProject(entry.id)}
            >
              {feed && (
                <span
                  key={feed.key}
                  className="v1-home-feed"
                  aria-hidden="true"
                >
                  <i />
                  <b>+{feed.added}</b>
                </span>
              )}
              <Pixelkin
                look={projectKinLook(entry.id)}
                size={slot.size}
                expression={
                  homeHeat(entry.latestAt, now) === 3 ? "happy" : null
                }
                hopKey={feed?.key}
              />
              <span className="v1-home-kin-shadow" aria-hidden="true" />
              <span className="v1-home-kin-label">
                <strong>{entry.name}</strong>
                <span>
                  {entry.eventCount.toLocaleString()} events · {ago}
                </span>
              </span>
            </button>
          );
        })}
      </section>
      <nav className="v1-home-all" aria-label="All Projects">
        <h2>All Projects</h2>
        <ul>
          {listed.map((entry) => (
            <li key={entry.id}>
              <button type="button" onClick={() => onOpenProject(entry.id)}>
                <span
                  className="v1-home-dot"
                  data-heat={homeHeat(entry.latestAt, now)}
                  aria-hidden="true"
                />
                <strong>{entry.name}</strong>
                <span>{formatHomeAgo(entry.latestAt, now)}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

const ingestionLine = (client: HomeIngestionClient) => {
  const finished = client.completed + client.skipped;
  const of =
    client.selected === null
      ? `${finished}`
      : `${finished} of ${client.selected}`;
  switch (client.lifecycle) {
    case "running":
      return `Reading ${of}`;
    case "completed":
      return "Done";
    // A failed pass retries on its own; it is not something to act on here.
    case "failed":
      return client.stuck ? `Stuck · ${of}` : `Retrying · ${of}`;
    case "cancelled":
      return `Stopped · ${of}`;
    default:
      return `Waiting · ${of}`;
  }
};

// Around the Koed Kin in the middle of the stage, nearest first.
const hatchSlots: ReadonlyArray<{ x: number; y: number; size: number }> = [
  { x: 26, y: 18, size: 76 },
  { x: 74, y: 18, size: 76 },
  { x: 12, y: 8, size: 60 },
  { x: 88, y: 8, size: 60 },
  { x: 38, y: 4, size: 56 },
  { x: 62, y: 4, size: 56 }
];

function HatchingStage({
  entries,
  ingestion,
  agent,
  onOpenProject
}: {
  entries: readonly HomeProjectEntry[];
  ingestion: HomeIngestion;
  agent: { name: string; look: AgentLook };
  onOpenProject: (projectId: string) => void;
}) {
  const reduced = useReducedMotion();
  // Projects present on the first render were found before this screen opened.
  const seen = useRef<Set<string> | null>(null);
  seen.current ??= new Set(entries.map(({ id }) => id));
  const shown = rankHomeProjects(entries).slice(0, hatchSlots.length - 1);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const slotStyle = (rank: number) => {
    const slot = hatchSlots[rank]!;
    return {
      "--kin-x": `${slot.x}%`,
      "--kin-y": `${slot.y}%`,
      "--kin-size": `${slot.size}px`
    } as CSSProperties;
  };
  return (
    <section
      className="v1-home-stage v1-home-stage-hatching"
      aria-label="Projects found so far"
    >
      <div className="v1-home-spot" aria-hidden="true" />
      {shown.map((id, rank) => {
        const entry = byId.get(id)!;
        return (
          <button
            key={id}
            type="button"
            className="v1-home-kin"
            data-hatch={(!reduced && !seen.current!.has(id)) || undefined}
            style={slotStyle(rank)}
            aria-label={`Open Project ${entry.name}`}
            onClick={() => onOpenProject(id)}
          >
            <Pixelkin look={projectKinLook(id)} size={hatchSlots[rank]!.size} />
            <span className="v1-home-kin-shadow" aria-hidden="true" />
            <span className="v1-home-kin-label">
              <strong>{entry.name}</strong>
            </span>
          </button>
        );
      })}
      <span
        className="v1-home-egg"
        aria-hidden="true"
        style={slotStyle(shown.length)}
      >
        <i />
      </span>
      <div className="v1-home-host">
        <Pixelkin look={agent.look} size={128} expression="happy" />
        <span className="v1-home-kin-shadow" aria-hidden="true" />
      </div>
      <div className="v1-home-caption">
        <h1>Hatching your Projects</h1>
        <p
          className="v1-home-sub"
          title={`Up to ${AUTOMATIC_HISTORICAL_CONVERSATION_CAP} conversations per AI Client from the last ${AUTOMATIC_HISTORICAL_WINDOW_DAYS} days.`}
        >
          {agent.name} is reading your recent conversations. Projects appear as
          they’re found.
        </p>
        <IngestionProgress ingestion={ingestion} />
      </div>
    </section>
  );
}

function IngestionProgress({ ingestion }: { ingestion: HomeIngestion }) {
  const total = ingestion.selected;
  const percent =
    total && total > 0
      ? Math.min(100, Math.round((100 * ingestion.finished) / total))
      : null;
  return (
    <div className="v1-home-progress">
      <div
        role="progressbar"
        aria-label="Recent history processed"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={
          total === null
            ? `${ingestion.finished} conversations so far`
            : `${ingestion.finished} of ${total} conversations`
        }
        className="v1-home-progress-track"
        data-indeterminate={percent === null || undefined}
      >
        <span style={{ width: `${percent ?? 30}%` }} />
      </div>
      <span className="v1-home-progress-label">
        {total === null
          ? `${ingestion.finished} conversations so far`
          : `${ingestion.finished} of ${total} conversations`}
      </span>
    </div>
  );
}

// Non-blocking problems stay out of the way: a chip that opens the list.
function HomeWarnings({
  problems,
  statusStore
}: {
  problems: readonly HomeProblem[];
  statusStore: DesktopStatusStore;
}) {
  const [open, setOpen] = useState(false);
  if (!problems.length) return null;
  return (
    <div className="v1-home-warnings">
      <button
        type="button"
        className="v1-home-chip"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="v1-home-dot" aria-hidden="true" />
        {problems.length === 1
          ? problems[0]!.title
          : `${problems.length} things to check`}
      </button>
      {open && (
        <ProblemList
          problems={problems}
          primary={null}
          statusStore={statusStore}
          compact
        />
      )}
    </div>
  );
}

export function Home({
  view,
  clients,
  entries,
  agent,
  statusStore,
  onOpenProject
}: {
  view: HomeView;
  clients: readonly HomeClient[];
  entries: readonly HomeProjectEntry[];
  agent: { name: string; look: AgentLook };
  statusStore: DesktopStatusStore;
  onOpenProject: (projectId: string) => void;
}) {
  if (view.kind === "loading")
    return (
      <section className="v1-home v1-home-centred" aria-busy="true">
        <Pixelkin look={agent.look} size={96} expression="neutral" />
        <p className="v1-home-sub">Checking on your Projects…</p>
      </section>
    );
  if (view.kind === "attention")
    return (
      <section className="v1-home v1-home-centred" data-mood="attention">
        <Keycaps clients={clients} />
        <Pixelkin look={agent.look} size={112} expression="surprised" />
        <div className="v1-home-copy">
          <h1>{agent.name} needs a hand</h1>
          <p className="v1-home-sub">
            Your Projects can’t load until this is sorted. Nothing has been
            lost.
          </p>
        </div>
        <ProblemList
          problems={view.problems}
          primary={view.primary}
          statusStore={statusStore}
        />
      </section>
    );
  const warnings = (
    <HomeWarnings problems={view.warnings} statusStore={statusStore} />
  );
  if (view.kind === "ingesting")
    return (
      <section className="v1-home v1-home-fill" data-mood="ingesting">
        {warnings}
        <Keycaps clients={clients} ingestion={view.ingestion} />
        <HatchingStage
          entries={entries}
          ingestion={view.ingestion}
          agent={agent}
          onOpenProject={onOpenProject}
        />
      </section>
    );
  if (view.kind === "empty")
    return (
      <section className="v1-home v1-home-centred" data-mood="empty">
        {warnings}
        <Keycaps clients={clients} />
        <Pixelkin look={agent.look} size={112} expression="neutral" />
        <div className="v1-home-copy">
          <h1>A quiet stage, for now</h1>
          <p className="v1-home-sub">
            {agent.name} is ready, but there’s no history to learn from yet.
            Projects appear here as you work with your AI Clients.
          </p>
        </div>
      </section>
    );
  const total = entries.reduce((sum, entry) => sum + entry.eventCount, 0);
  return (
    <section className="v1-home" data-mood="projects">
      {warnings}
      <header className="v1-home-header">
        <Pixelkin look={agent.look} size={48} />
        <div>
          <h1>Your Projects</h1>
          <p className="v1-home-sub">
            {entries.length} Projects · {total.toLocaleString()} captured
            events. The most recently active step into the spotlight.
          </p>
        </div>
      </header>
      <Keycaps clients={clients} />
      <ProjectsStage entries={entries} onOpenProject={onOpenProject} />
    </section>
  );
}
