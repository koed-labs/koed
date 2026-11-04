import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from "react";
import {
  AUTOMATIC_HISTORICAL_CONVERSATION_CAP,
  AUTOMATIC_HISTORICAL_WINDOW_DAYS
} from "@koed/shared/historical-ingestion-progress";
import type { DesktopStatusStore } from "../../services/desktop-commands.js";
import { AiClientLogo } from "../../views/personal/AiClientLogo.js";
import {
  integrationConsentCopy,
  type IntegrationMutationCommand
} from "../../views/preferences/integration-consent.js";
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
import {
  layoutStage,
  type StageBox,
  type StageLayout,
  type StageSlot
} from "./stage-layout.js";
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

// A detected client can be connected and a client needing attention
// repaired, with the same consent step as Settings.
const clientCommand = (
  client: HomeClient
): IntegrationMutationCommand | null =>
  client.state === "detected"
    ? `setup_${client.id}`
    : client.state === "attention"
      ? `repair_${client.id}`
      : null;

function ClientAction({
  client,
  statusStore,
  variant,
  label
}: {
  client: HomeClient;
  statusStore: DesktopStatusStore;
  // A pill under a keycap, a link in its small line, or a caption button.
  variant: "pill" | "link" | "primary" | "secondary";
  label?: string;
}) {
  const command = clientCommand(client);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const card = open || error !== null;
  useEffect(() => {
    if (!card) return;
    const close = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : !root.current?.contains(event.target as Node)
      ) {
        setOpen(false);
        setError(null);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [card]);
  if (!command) return null;
  const connect = client.state === "detected";
  const copy = integrationConsentCopy[command];
  const run = async () => {
    setOpen(false);
    setBusy(true);
    setError(null);
    try {
      const result = await statusStore.run<{ ok?: boolean; message?: string }>(
        command,
        { operatorConsented: true }
      );
      if (result?.ok === false)
        setError(result.message ?? "Nothing was changed.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      void statusStore.refresh();
    }
  };
  return (
    <span className="v1-home-client-action" ref={root}>
      <button
        type="button"
        className={`v1-home-${variant}`}
        data-repair={!connect || undefined}
        disabled={busy}
        aria-expanded={open}
        aria-label={
          label ? undefined : `${connect ? "Connect" : "Repair"} ${client.name}`
        }
        title={connect ? undefined : client.label}
        onClick={() => {
          setError(null);
          setOpen((value) => !value);
        }}
      >
        {busy
          ? connect
            ? "Connecting…"
            : "Repairing…"
          : (label ?? (connect ? "Connect" : "Repair"))}
      </button>
      {open && (
        <span className="v1-home-consent" role="dialog" aria-label={copy.title}>
          <strong>{copy.title}</strong>
          <span>{copy.description}</span>
          <span className="v1-home-consent-actions">
            <button
              type="button"
              className="v1-home-primary"
              autoFocus
              onClick={() => void run()}
            >
              {copy.confirmLabel}
            </button>
            <button type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </span>
        </span>
      )}
      {error !== null && (
        <span className="v1-home-consent" role="alert">
          <strong>
            Couldn’t {connect ? "connect" : "repair"} {client.name}
          </strong>
          <span>{error}</span>
          <span className="v1-home-consent-actions">
            <button
              type="button"
              className="v1-home-primary"
              onClick={() => {
                setError(null);
                setOpen(true);
              }}
            >
              Try again
            </button>
            <button type="button" onClick={() => setError(null)}>
              Close
            </button>
          </span>
        </span>
      )}
    </span>
  );
}

function Keycaps({
  clients,
  ingestion,
  statusStore
}: {
  clients: readonly HomeClient[];
  ingestion?: HomeIngestion;
  statusStore?: DesktopStatusStore;
}) {
  // An empty row keeps the stage where it will be once the clients load.
  if (!clients.length)
    return <div className="v1-home-keycaps" aria-hidden="true" />;
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
          ) : statusStore && clientCommand(client) ? (
            <ClientAction
              client={client}
              statusStore={statusStore}
              variant="pill"
            />
          ) : (
            <span className="v1-home-pill">{client.label}</span>
          )}
          {/* While history is read the pill shows progress, so the action
              moves to the small line. */}
          {(client.state === "detected" || client.state === "attention") && (
            <small>
              {progress.has(client.id) &&
                (statusStore ? (
                  <ClientAction
                    client={client}
                    statusStore={statusStore}
                    variant="link"
                  />
                ) : client.state === "detected" ? (
                  "Not connected"
                ) : (
                  "Needs attention"
                ))}
              {progress.has(client.id) && client.version ? " · " : null}
              {client.state === "detected" ? client.version : null}
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

// Design units; the most recently active Project leads in the spotlight,
// with the rest standing further back, out of the beam.
const LABEL_FRONT = 38;
const LABEL_BACK = 17;
const slots: readonly StageSlot[] = [
  { x: 0, y: 0, size: 144, label: LABEL_FRONT },
  { x: -250, y: 34, size: 100, label: LABEL_FRONT },
  { x: 250, y: 34, size: 100, label: LABEL_FRONT },
  { x: -150, y: 200, size: 64, label: LABEL_BACK },
  { x: 150, y: 200, size: 64, label: LABEL_BACK },
  { x: -410, y: 140, size: 64, label: LABEL_BACK },
  { x: 410, y: 140, size: 64, label: LABEL_BACK }
];
// Two Projects share the stage instead of leaving one side empty.
const pairSlots: readonly StageSlot[] = [
  { x: -110, y: 0, size: 144, label: LABEL_FRONT },
  { x: 110, y: 16, size: 112, label: LABEL_FRONT }
];
// Room kept under the Kin for the caption until it has been measured.
const CAPTION_FALLBACK = 120;
// The caption sits this far above the stage's bottom edge, with a gap above.
const CAPTION_INSET = 28 + 16;

// Measures the stage and its caption so the layout can fit around them.
function useStageBox(
  stage: RefObject<HTMLElement | null>,
  caption: RefObject<HTMLElement | null>
) {
  const [box, setBox] = useState<(StageBox & { reserve: number }) | null>(null);
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      const reserve =
        (caption.current?.getBoundingClientRect().height ?? 0) + CAPTION_INSET;
      if (!width || !height) return;
      setBox((current) =>
        current?.width === width &&
        current.height === height &&
        current.reserve === reserve
          ? current
          : { width, height, reserve }
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (caption.current) observer.observe(caption.current);
    return () => observer.disconnect();
  }, [stage, caption]);
  return box;
}

const placementStyle = (layout: StageLayout, index: number) => {
  const placement = layout.placements[index]!;
  return {
    "--kin-x": `calc(50% + ${placement.x}px)`,
    "--kin-y": `${placement.bottom}px`,
    "--kin-size": `${placement.size}px`
  } as CSSProperties;
};

const spotStyle = ({ spot }: StageLayout) =>
  ({
    "--spot-x": `${spot.x}px`,
    "--spot-y": `${spot.bottom}px`,
    "--spot-size": `${spot.size}px`
  }) as CSSProperties;

function ProjectsStage({
  entries,
  caption,
  onOpenProject
}: {
  entries: readonly HomeProjectEntry[];
  caption: ReactNode;
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

  const stageRef = useRef<HTMLElement>(null);
  const captionRef = useRef<HTMLDivElement>(null);
  const box = useStageBox(stageRef, captionRef);
  const onStage = shown.slice(0, HOME_STAGE_LIMIT);
  const layout = layoutStage(
    box,
    box?.reserve ?? CAPTION_FALLBACK,
    onStage.length === 2 ? pairSlots : slots.slice(0, onStage.length || 1)
  );
  // Kin render in a fixed order so a re-rank moves them instead of remounting.
  const stageKin = entries.filter(({ id }) => onStage.includes(id));
  return (
    <section
      ref={stageRef}
      className="v1-home-stage v1-home-stage-projects"
      aria-label="Most active Projects"
      data-reduced-motion={reduced || undefined}
      onPointerEnter={() => setPointerOver(true)}
      onPointerLeave={() => setPointerOver(false)}
    >
      <div
        className="v1-home-spot"
        aria-hidden="true"
        style={spotStyle(layout)}
      />
      {stageKin.map((entry) => {
        const rank = onStage.indexOf(entry.id);
        const front = rank < 3;
        const feed = feeds.get(entry.id);
        const ago = formatHomeAgo(entry.latestAt, now);
        return (
          <button
            key={entry.id}
            type="button"
            className="v1-home-kin"
            data-lead={rank === 0 || undefined}
            data-front={front || undefined}
            data-heat={homeHeat(entry.latestAt, now)}
            style={placementStyle(layout, rank)}
            title={
              front
                ? undefined
                : `${entry.name} · ${entry.eventCount.toLocaleString()} events · ${ago}`
            }
            aria-label={`Open Project ${entry.name}, ${entry.eventCount} captured events, active ${ago}`}
            onClick={() => onOpenProject(entry.id)}
          >
            {feed && (
              <span key={feed.key} className="v1-home-feed" aria-hidden="true">
                <i />
                <b>+{feed.added}</b>
              </span>
            )}
            <Pixelkin
              look={projectKinLook(entry.id)}
              size={layout.placements[rank]!.size}
              expression={homeHeat(entry.latestAt, now) === 3 ? "happy" : null}
              hopKey={feed?.key}
            />
            <span className="v1-home-kin-shadow" aria-hidden="true" />
            <span className="v1-home-kin-label">
              <strong>{entry.name}</strong>
              {/* Back-row Kin carry just a name; the rest is in the tooltip. */}
              {front && (
                <span>
                  {entry.eventCount.toLocaleString()} events · {ago}
                </span>
              )}
            </span>
          </button>
        );
      })}
      <div className="v1-home-caption" ref={captionRef}>
        {caption}
      </div>
    </section>
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

// Every Home state shares one stage; without Projects the Koed Kin stands
// alone in the spotlight above the caption.
const soloSlots: readonly StageSlot[] = [{ x: 0, y: 0, size: 96, label: 0 }];

function SoloStage({
  agent,
  expression,
  label,
  caption,
  wide = false
}: {
  agent: { name: string; look: AgentLook };
  expression: "neutral" | "surprised";
  label: string;
  caption: ReactNode;
  wide?: boolean;
}) {
  const stageRef = useRef<HTMLElement>(null);
  const captionRef = useRef<HTMLDivElement>(null);
  const box = useStageBox(stageRef, captionRef);
  const layout = layoutStage(box, box?.reserve ?? CAPTION_FALLBACK, soloSlots);
  return (
    <section ref={stageRef} className="v1-home-stage" aria-label={label}>
      <div
        className="v1-home-spot"
        aria-hidden="true"
        style={spotStyle(layout)}
      />
      <div className="v1-home-host" style={placementStyle(layout, 0)}>
        <Pixelkin
          look={agent.look}
          size={layout.placements[0]!.size}
          expression={expression}
        />
        <span className="v1-home-kin-shadow" aria-hidden="true" />
      </div>
      <div
        className="v1-home-caption"
        data-wide={wide || undefined}
        ref={captionRef}
      >
        {caption}
      </div>
    </section>
  );
}

// The Koed Kin leads; Projects gather around it, nearest first, and the
// further back they stand the higher and smaller they are.
const hatchSlots: readonly StageSlot[] = [
  { x: 0, y: 0, size: 128, label: 0 },
  { x: -230, y: 24, size: 76, label: LABEL_BACK },
  { x: 230, y: 24, size: 76, label: LABEL_BACK },
  { x: -390, y: 80, size: 60, label: LABEL_BACK },
  { x: 390, y: 80, size: 60, label: LABEL_BACK },
  { x: -180, y: 140, size: 52, label: LABEL_BACK },
  { x: 180, y: 140, size: 52, label: LABEL_BACK }
];
// The hatching caption carries a progress bar, so it needs more room.
const HATCH_CAPTION_FALLBACK = 170;

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
  const stageRef = useRef<HTMLElement>(null);
  const captionRef = useRef<HTMLDivElement>(null);
  const box = useStageBox(stageRef, captionRef);
  // Projects present on the first render were found before this screen opened.
  const seen = useRef<Set<string> | null>(null);
  seen.current ??= new Set(entries.map(({ id }) => id));
  // One satellite slot stays free for the egg.
  const shown = rankHomeProjects(entries).slice(0, hatchSlots.length - 2);
  // Fit only the slots in use (at least the first ring), so the back row
  // doesn't shrink the stage before anything stands there.
  const layout = layoutStage(
    box,
    box?.reserve ?? HATCH_CAPTION_FALLBACK,
    hatchSlots.slice(0, Math.max(3, shown.length + 2))
  );
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const egg = layout.placements[shown.length + 1]!;
  return (
    <section
      ref={stageRef}
      className="v1-home-stage v1-home-stage-hatching"
      aria-label="Projects found so far"
    >
      <div
        className="v1-home-spot"
        aria-hidden="true"
        style={spotStyle(layout)}
      />
      <div className="v1-home-host" style={placementStyle(layout, 0)}>
        <Pixelkin
          look={agent.look}
          size={layout.placements[0]!.size}
          expression="happy"
        />
        <span className="v1-home-kin-shadow" aria-hidden="true" />
      </div>
      {shown.map((id, rank) => {
        const entry = byId.get(id)!;
        return (
          <button
            key={id}
            type="button"
            className="v1-home-kin"
            data-hatch={(!reduced && !seen.current!.has(id)) || undefined}
            style={placementStyle(layout, rank + 1)}
            aria-label={`Open Project ${entry.name}`}
            onClick={() => onOpenProject(id)}
          >
            <Pixelkin
              look={projectKinLook(id)}
              size={layout.placements[rank + 1]!.size}
            />
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
        style={
          {
            "--kin-x": `calc(50% + ${egg.x}px)`,
            // The egg stands where the Kin's feet will be, above its label.
            "--kin-y": `${egg.bottom + LABEL_BACK + 8}px`,
            "--kin-size": `${egg.size}px`
          } as CSSProperties
        }
      >
        <i />
      </span>
      <div className="v1-home-caption" ref={captionRef}>
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
          ? `Check ${problems[0]!.title}`
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
      <section className="v1-home" aria-busy="true">
        <Keycaps clients={[]} />
        <SoloStage
          agent={agent}
          expression="neutral"
          label="Checking on your Projects"
          caption={<p className="v1-home-sub">Checking on your Projects…</p>}
        />
      </section>
    );
  if (view.kind === "attention")
    return (
      <section className="v1-home" data-mood="attention">
        {/* Koed has to be running again first; client changes can wait. */}
        <Keycaps clients={clients} />
        <SoloStage
          agent={agent}
          expression="surprised"
          label={`${agent.name} needs a hand`}
          wide
          caption={
            <>
              <h1>{agent.name} needs a hand</h1>
              <p className="v1-home-sub">
                Your Projects can’t load until this is sorted. Nothing has been
                lost.
              </p>
              <ProblemList
                problems={view.problems}
                primary={view.primary}
                statusStore={statusStore}
              />
            </>
          }
        />
      </section>
    );
  const warnings = (
    <HomeWarnings problems={view.warnings} statusStore={statusStore} />
  );
  if (view.kind === "ingesting")
    return (
      <section className="v1-home" data-mood="ingesting">
        {warnings}
        <Keycaps
          clients={clients}
          ingestion={view.ingestion}
          statusStore={statusStore}
        />
        <HatchingStage
          entries={entries}
          ingestion={view.ingestion}
          agent={agent}
          onOpenProject={onOpenProject}
        />
      </section>
    );
  // The next step on an empty stage is connecting a detected client.
  const connectable = clients
    .filter(({ state }) => state === "detected")
    .slice(0, 2);
  if (view.kind === "empty")
    return (
      <section className="v1-home" data-mood="empty">
        {warnings}
        <Keycaps clients={clients} statusStore={statusStore} />
        <SoloStage
          agent={agent}
          expression="neutral"
          label="No Projects yet"
          caption={
            <>
              <h1>A quiet stage, for now</h1>
              <p className="v1-home-sub">
                {clients.some(({ state }) => state !== "detected")
                  ? `${agent.name} is ready, but there’s no history to learn from yet. Projects appear here as you work with your AI Clients.`
                  : `${agent.name} is ready. Connect an AI Client and your Projects appear here as you work.`}
              </p>
              {connectable.length > 0 && (
                <div className="v1-home-actions">
                  {connectable.map((client, index) => (
                    <ClientAction
                      key={client.id}
                      client={client}
                      statusStore={statusStore}
                      variant={index === 0 ? "primary" : "secondary"}
                      label={`Connect ${client.name}`}
                    />
                  ))}
                </div>
              )}
            </>
          }
        />
      </section>
    );
  const total = entries.reduce((sum, entry) => sum + entry.eventCount, 0);
  const offStage = entries.length - HOME_STAGE_LIMIT;
  return (
    <section className="v1-home" data-mood="projects">
      {warnings}
      <Keycaps clients={clients} statusStore={statusStore} />
      <ProjectsStage
        entries={entries}
        onOpenProject={onOpenProject}
        caption={
          <>
            <h1>Your Projects</h1>
            <p className="v1-home-sub">
              {entries.length === 1
                ? "1 Project"
                : `${entries.length} Projects`}{" "}
              · {total.toLocaleString()} captured events
              {offStage > 0 && ` · ${offStage} more in the sidebar`}
            </p>
          </>
        }
      />
    </section>
  );
}
