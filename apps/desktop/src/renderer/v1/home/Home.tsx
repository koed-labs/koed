import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject
} from "react";
import {
  AUTOMATIC_HISTORICAL_CONVERSATION_CAP,
  AUTOMATIC_HISTORICAL_WINDOW_DAYS
} from "@koed-labs/shared/historical-ingestion-progress";
import { Button, Spinner } from "@koed-labs/ui";
import { Power } from "lucide-react";
import type { DesktopStatusStore } from "../../services/desktop-commands.js";
import { AiClientLogo } from "../../views/personal/AiClientLogo.js";
import {
  integrationConsentCopy,
  type IntegrationMutationCommand
} from "../../views/preferences/integration-consent.js";
import { Pixelkin } from "../pixelkin/Pixelkin.js";
import { wakePixelkins } from "../pixelkin/stage.js";
import { KinSpin } from "../onboarding/kin-spin.js";
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

// Drag a Kin sideways to spin it, as with the onboarding Kin; it springs back
// to face front. A drag doesn't count as a click, so it doesn't open anything.
function useKinSpins() {
  const spins = useRef(new Map<string, KinSpin>());
  const pointer = useRef<number | null>(null);
  const frame = useRef(0);
  const captured = useRef<HTMLElement | null>(null);
  const stopWindow = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      stopWindow.current?.();
    },
    []
  );
  return (id: string) => {
    let spin = spins.current.get(id);
    if (!spin) {
      spin = new KinSpin();
      spins.current.set(id, spin);
    }
    const current = spin;
    // Anything that ends a drag (button up, the browser cancelling it, or the
    // pointer capture being taken away by a re-render) is a release: the Kin
    // keeps the momentum it was given rather than snapping back to the front.
    const finish = (pointerId: number, timeStamp: number) => {
      if (pointer.current !== pointerId) return;
      pointer.current = null;
      stopWindow.current?.();
      cancelAnimationFrame(frame.current);
      current.end(timeStamp, reducedMotion());
      const control = captured.current;
      captured.current = null;
      if (control?.hasPointerCapture?.(pointerId))
        control.releasePointerCapture(pointerId);
      wakePixelkins();
    };
    const handlers = {
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0 || !event.isPrimary || pointer.current !== null)
          return;
        pointer.current = event.pointerId;
        const width = event.currentTarget.getBoundingClientRect().width;
        current.begin(event.clientX, event.timeStamp, width, current.angle);
        const control = event.currentTarget;
        captured.current = control;
        const pointerId = event.pointerId;
        control.setPointerCapture?.(pointerId);
        // A release anywhere in the window counts, even if the element lost
        // the pointer (re-render, re-rank) mid-drag.
        stopWindow.current?.();
        const onWindowEnd = (windowEvent: PointerEvent) => {
          if (windowEvent.pointerId === pointerId)
            finish(pointerId, windowEvent.timeStamp);
        };
        window.addEventListener("pointerup", onWindowEnd);
        window.addEventListener("pointercancel", onWindowEnd);
        stopWindow.current = () => {
          window.removeEventListener("pointerup", onWindowEnd);
          window.removeEventListener("pointercancel", onWindowEnd);
          stopWindow.current = null;
        };
        const checkDrag = () => {
          if (pointer.current !== pointerId) return;
          if (current.dragging) {
            frame.current = requestAnimationFrame(checkDrag);
          } else {
            pointer.current = null;
            stopWindow.current?.();
            if (control.hasPointerCapture?.(pointerId))
              control.releasePointerCapture(pointerId);
          }
        };
        frame.current = requestAnimationFrame(checkDrag);
        wakePixelkins();
      },
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        if (pointer.current !== event.pointerId) return;
        // Every hardware sample since the last frame, for a truer velocity.
        for (const sample of coalesced(event.nativeEvent))
          current.move(sample.clientX, sample.timeStamp);
        wakePixelkins();
      },
      onPointerUp: (event: ReactPointerEvent<HTMLElement>) =>
        finish(event.pointerId, event.timeStamp),
      onPointerCancel: (event: ReactPointerEvent<HTMLElement>) =>
        finish(event.pointerId, event.timeStamp),
      onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) =>
        finish(event.pointerId, event.timeStamp),
      onClickCapture: (event: ReactMouseEvent<HTMLElement>) => {
        if (!current.moved) return;
        current.moved = false;
        event.preventDefault();
        event.stopPropagation();
      }
    };
    return { spin: current, handlers };
  };
}

const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

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

// Closes a card opened from a button when the pointer goes down outside it or
// Escape is pressed.
const useDismiss = (
  root: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void
) => {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : !root.current?.contains(event.target as Node)
      )
        dismiss.current();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open, root]);
};

// A detected client can be connected and a client needing attention
// repaired, with the same consent step as Settings.
const clientCommand = (client: HomeClient): IntegrationMutationCommand | null =>
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
  useDismiss(root, open || error !== null, () => {
    setOpen(false);
    setError(null);
  });
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
  // No clients, no row: the stage closes up instead of keeping a gap.
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
    }
  };
  return (
    <div className="v1-home-action">
      {confirming ? (
        <>
          <span>This changes software on this Mac. Continue?</span>
          <Button type="button" variant="outline" onClick={() => void run()}>
            Continue
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="outline"
          size={primary ? "lg" : "default"}
          disabled={busy}
          onClick={() =>
            action.requiresConsent ? setConfirming(true) : void run()
          }
        >
          {busy ? <Spinner /> : action.command === "start" ? <Power /> : null}
          {busy ? "Working…" : action.label}
        </Button>
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
            <span title={problem.detail}>{problem.message}</span>
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

type MeasuredStage = StageBox & {
  // Room kept at the bottom for the caption.
  reserve: number;
  // Room taken at the top by the AI Client keycaps; 0 when there are none.
  top: number;
};

// Measures the stage, its caption and its keycap row so the layout can fit
// the Kin between them. The height it reports excludes the keycap row.
function useStageBox(
  stage: RefObject<HTMLElement | null>,
  caption: RefObject<HTMLElement | null>,
  topRow: RefObject<HTMLElement | null>
) {
  const [box, setBox] = useState<MeasuredStage | null>(null);
  // Kin glide when the order changes, but a new measurement (the first one,
  // or a window resize) moves them at once instead of bouncing them there.
  const [settled, setSettled] = useState(true);
  const last = useRef<MeasuredStage | null>(null);
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const reserve =
        (caption.current?.getBoundingClientRect().height ?? 0) + CAPTION_INSET;
      const row = topRow.current?.getBoundingClientRect();
      const top = row && row.height > 0 ? row.bottom - rect.top : 0;
      const { width } = rect;
      const height = rect.height - top;
      if (!width || !rect.height) return;
      const current = last.current;
      if (
        current?.width === width &&
        current.height === height &&
        current.reserve === reserve &&
        current.top === top
      )
        return;
      last.current = { width, height, reserve, top };
      setSettled(false);
      setBox(last.current);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (caption.current) observer.observe(caption.current);
    if (topRow.current) observer.observe(topRow.current);
    return () => observer.disconnect();
  }, [stage, caption, topRow]);
  useEffect(() => {
    if (settled) return;
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, [settled, box]);
  return [box, settled] as const;
}

const placementStyle = (layout: StageLayout, index: number) => {
  const placement = layout.placements[index]!;
  return {
    "--kin-x": `calc(50% + ${placement.x}px)`,
    "--kin-y": `${placement.bottom}px`,
    "--kin-size": `${placement.size}px`
  } as CSSProperties;
};

// The beam starts under the keycap row rather than behind it.
const spotStyle = ({ spot }: StageLayout, top = 0) =>
  ({
    "--spot-top": `${top}px`,
    "--spot-x": `${spot.x}px`,
    "--spot-y": `${spot.bottom}px`,
    "--spot-size": `${spot.size}px`
  }) as CSSProperties;

function ProjectsStage({
  entries,
  caption,
  keycaps,
  floorCoins,
  onOpenProject,
  onDropConversation,
  leadHopKey = 0
}: {
  entries: readonly HomeProjectEntry[];
  caption: ReactNode;
  // The AI Client keycap row along the top of the stage.
  keycaps?: ReactNode;
  // Conversations in no Project, lying on the floor.
  floorCoins?: FloorCoinsInput;
  onOpenProject: (projectId: string) => void;
  // Adds a floor coin's conversation to a Project; true once it is added.
  onDropConversation?: (key: string, projectId: string) => Promise<boolean>;
  // Bumped when a coin lands on the lead Kin.
  leadHopKey?: number;
}) {
  const reduced = useReducedMotion();
  const focused = useWindowFocused();
  const now = useNow(30_000);
  const kinSpin = useKinSpins();
  // The Kin a dragged coin is over, and whether it has stayed long enough
  // for letting go to add the conversation.
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  // A Kin hops each time it takes a conversation in.
  const [received, setReceived] = useState<ReadonlyMap<string, number>>(
    new Map()
  );
  const coinDrop = useMemo<CoinDrop | undefined>(
    () =>
      onDropConversation
        ? {
            onTarget: setDropTarget,
            onDrop: async (key, projectId) => {
              const added = await onDropConversation(key, projectId);
              if (added)
                setReceived((current) =>
                  new Map(current).set(
                    projectId,
                    (current.get(projectId) ?? 0) + 1
                  )
                );
              return added;
            }
          }
        : undefined,
    [onDropConversation]
  );
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
  const topRowRef = useRef<HTMLDivElement>(null);
  const [box, settled] = useStageBox(stageRef, captionRef, topRowRef);
  const onStage = shown.slice(0, HOME_STAGE_LIMIT);
  const layout = layoutStage(
    box,
    (box?.reserve ?? CAPTION_FALLBACK) + coinBand(floorCoins),
    onStage.length === 2 ? pairSlots : slots.slice(0, onStage.length || 1)
  );
  // Kin render in a fixed order so a re-rank moves them instead of remounting.
  const stageKin = entries.filter(({ id }) => onStage.includes(id));
  return (
    <section
      ref={stageRef}
      className="v1-home-stage v1-home-stage-projects"
      data-settling={!settled || undefined}
      aria-label="Most active Projects"
      data-reduced-motion={reduced || undefined}
      onPointerEnter={() => setPointerOver(true)}
      onPointerLeave={() => setPointerOver(false)}
    >
      <div
        className="v1-kin-spot"
        aria-hidden="true"
        style={spotStyle(layout, box?.top)}
      />
      <div className="v1-home-stage-top" ref={topRowRef}>
        {keycaps}
      </div>
      {stageKin.map((entry) => {
        const rank = onStage.indexOf(entry.id);
        const front = rank < 3;
        const feed = feeds.get(entry.id);
        const ago = formatHomeAgo(entry.latestAt, now);
        const spinProps = kinSpin(entry.id);
        return (
          <button
            key={entry.id}
            type="button"
            className="v1-home-kin"
            data-lead={rank === 0 || undefined}
            data-coin-target={rank === 0 || undefined}
            data-coin-project={entry.id}
            data-front={front || undefined}
            data-drop-project={coinDrop ? entry.id : undefined}
            data-drop={
              dropTarget?.id === entry.id
                ? dropTarget.armed
                  ? "ready"
                  : "pending"
                : undefined
            }
            data-heat={homeHeat(entry.latestAt, now)}
            style={placementStyle(layout, rank)}
            title={
              front
                ? undefined
                : `${entry.name} · ${entry.eventCount.toLocaleString()} events · ${ago}`
            }
            aria-label={`Open Project ${entry.name}, ${entry.eventCount} captured events, active ${ago}`}
            {...spinProps.handlers}
            onClick={() => onOpenProject(entry.id)}
          >
            {feed && (
              <span key={feed.key} className="v1-home-feed" aria-hidden="true">
                <i />
                <b>+{feed.added}</b>
              </span>
            )}
            <Pixelkin
              presentation="stage"
              look={projectKinLook(entry.id, entry.kin)}
              size={layout.placements[rank]!.size}
              expression={homeHeat(entry.latestAt, now) === 3 ? "happy" : null}
              hopKey={
                (feed?.key ?? 0) +
                (rank === 0 ? leadHopKey : 0) +
                (received.get(entry.id) ?? 0)
              }
              spin={spinProps.spin}
            />
            <span className="v1-home-kin-shadow" aria-hidden="true" />
            {dropTarget?.id === entry.id && (
              <span className="v1-home-kin-drop" aria-hidden="true">
                {dropTarget.armed ? `Add to ${entry.name}` : null}
              </span>
            )}
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
      {floorCoins && (
        <FloorCoins
          width={box?.width}
          floor={box?.reserve ?? CAPTION_FALLBACK}
          coins={floorCoins}
          drop={coinDrop}
        />
      )}
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
      // Nothing read and no selection yet: still finding conversations.
      return finished === 0 && client.selected === null
        ? "Starting"
        : `${of} finished`;
    case "completed":
      return "Done";
    case "waiting":
      return `Waiting · ${of} finished`;
    // A failed pass retries on its own; it is not something to act on here.
    case "failed":
      return client.stuck
        ? `Stuck · ${of} finished`
        : `Retrying · ${of} finished`;
    case "cancelled":
      return `Stopped · ${of} finished`;
    default:
      return `Waiting · ${of} finished`;
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
  keycaps,
  floorCoins,
  wide = false,
  hopKey
}: {
  agent: { name: string; look: AgentLook };
  expression: "neutral" | "surprised" | "happy";
  label: string;
  caption: ReactNode;
  // The AI Client keycap row along the top of the stage.
  keycaps?: ReactNode;
  // Conversations in no Project, lying on the floor.
  floorCoins?: FloorCoinsInput;
  wide?: boolean;
  // Bumped when a coin lands on the Koed Kin.
  hopKey?: number;
}) {
  const stageRef = useRef<HTMLElement>(null);
  const captionRef = useRef<HTMLDivElement>(null);
  const topRowRef = useRef<HTMLDivElement>(null);
  const [box, settled] = useStageBox(stageRef, captionRef, topRowRef);
  const layout = layoutStage(
    box,
    (box?.reserve ?? CAPTION_FALLBACK) + coinBand(floorCoins),
    soloSlots
  );
  const hostSpin = useKinSpins()("host");
  return (
    <section
      ref={stageRef}
      className="v1-home-stage"
      data-settling={!settled || undefined}
      aria-label={label}
    >
      <div
        className="v1-kin-spot"
        aria-hidden="true"
        style={spotStyle(layout, box?.top)}
      />
      <div className="v1-home-stage-top" ref={topRowRef}>
        {keycaps}
      </div>
      <div
        className="v1-home-host"
        data-coin-target
        style={placementStyle(layout, 0)}
        {...hostSpin.handlers}
      >
        <Pixelkin
          presentation="stage"
          look={agent.look}
          size={layout.placements[0]!.size}
          expression={expression}
          hopKey={hopKey}
          spin={hostSpin.spin}
        />
        <span className="v1-home-kin-shadow" aria-hidden="true" />
      </div>
      {floorCoins && (
        <FloorCoins
          width={box?.width}
          floor={box?.reserve ?? CAPTION_FALLBACK}
          coins={floorCoins}
        />
      )}
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

// New sidebar Conversations travel from their AI Client as golden coins.
const COIN_FLIGHT_MS = 1_600;
const MAX_CONCURRENT_COINS = 4;

type Coin = {
  key: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
  delay: number;
};

export type HomeConversation = {
  key: string;
  aliases: readonly string[];
  client: "codex" | "claude" | "pi" | null;
  projectIds: readonly string[];
};

function FlyingCoin({ coin, onDone }: { coin: Coin; onDone: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof element.animate !== "function") {
      done.current();
      return;
    }
    const { from, to } = coin;
    // An arc: up out of the keycap, then down onto the Kin.
    const peak = Math.min(from.y, to.y) - 70;
    const animation = element.animate(
      [
        {
          transform: `translate(${from.x}px, ${from.y}px) scale(0.5)`,
          opacity: 0
        },
        {
          transform: `translate(${(from.x + to.x) / 2}px, ${peak}px) scale(1)`,
          opacity: 1,
          offset: 0.45
        },
        {
          transform: `translate(${to.x}px, ${to.y}px) scale(0.9)`,
          opacity: 1,
          offset: 0.9
        },
        {
          transform: `translate(${to.x}px, ${to.y + 6}px) scale(0.4)`,
          opacity: 0
        }
      ],
      {
        duration: COIN_FLIGHT_MS,
        delay: coin.delay,
        easing: "cubic-bezier(0.4, 0, 0.6, 1)",
        fill: "both"
      }
    );
    animation.onfinish = () => done.current();
    return () => animation.cancel();
  }, [coin]);
  return (
    <span className="v1-home-coin" ref={ref}>
      <CoinArtwork />
    </span>
  );
}

// Vector edges retain detail while the coins scale, flatten and tumble.
function CoinArtwork({
  client = null
}: {
  client?: HomeLooseConversation["client"];
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      shapeRendering="geometricPrecision"
      aria-hidden="true"
    >
      <ellipse cx="16" cy="17" rx="14.25" ry="14" fill="#7a4a12" />
      <circle
        cx="16"
        cy="15"
        r="14"
        fill="#e0a03a"
        stroke="#7a4a12"
        strokeWidth="1.5"
      />
      <circle
        cx="16"
        cy="14.5"
        r="12.5"
        fill="#ffd166"
        stroke="#fff4c2"
        strokeWidth="0.75"
      />
      <circle cx="16" cy="14.5" r="10.25" fill="#e0a03a" />
      <circle cx="16" cy="15.25" r="9.5" fill="#ffd166" />
      <path
        d="M6.5 11a10 10 0 0 1 12-6"
        fill="none"
        stroke="#fff4c2"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {client ? (
        // The originating AI Client's mark, struck into the coin.
        <svg x="9.25" y="8" width="13.5" height="13.5" fill="#7a4a12">
          <AiClientLogo id={client} />
        </svg>
      ) : (
        <>
          <rect x="12.5" y="11.5" width="7" height="7" rx="1" fill="#7a4a12" />
          <path
            d="M13 18.5h5.5a1 1 0 0 0 1-1V12"
            fill="none"
            stroke="#fff4c2"
            strokeWidth="0.75"
          />
        </>
      )}
    </svg>
  );
}

export type HomeLooseConversation = {
  key: string;
  // Earlier keys this Conversation went by, so a draft that gets its
  // permanent key isn't mistaken for a new arrival.
  aliases?: readonly string[];
  title: string;
  latestAt: string;
  client: "codex" | "claude" | "pi" | null;
};
// A dragged coin must stay over a Kin this long before letting go adds its
// conversation, so one flung across the stage doesn't add by accident.
export const COIN_DROP_ARM_MS = 500;
type DropTarget = { id: string; armed: boolean };
type CoinDrop = {
  onTarget: (target: DropTarget | null) => void;
  onDrop: (key: string, projectId: string) => Promise<boolean>;
};
type FloorCoinsInput = {
  conversations: readonly HomeLooseConversation[];
  // Keys of Conversations that arrived after load and are still to be thrown
  // in; a coin reports its launch and is then left alone.
  thrown: ReadonlySet<string>;
  launched: (key: string) => void;
  // Where each coin lies, kept across remounts of the floor.
  resting: Map<string, CoinSpot>;
  onOpen: (key: string) => void;
};
// Every hardware sample behind a pointer move, falling back to the event.
const coalesced = (event: PointerEvent) => {
  const events = event.getCoalescedEvents?.() ?? [];
  return events.length ? events : [event];
};

// Loose coins rest in a shallow band above the caption: a lane is how far up
// the band (towards the back) a coin lies. The band is kept clear of the Kin's
// label above it and the heading below it.
const COIN_LANE_DEPTH = 26;
const COIN_BAND = 56;
const COIN_SPACING_X = 14;
const COIN_SPACING_LANE = 7;
const coinBand = (coins: FloorCoinsInput | undefined) =>
  coins?.conversations.length ? COIN_BAND : 0;

type CoinSpot = { x: number; lane: number };
const hashUnit = (key: string, salt: number) => {
  let hash = 2166136261 ^ salt;
  for (let i = 0; i < key.length; i += 1)
    hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  hash = Math.imul(hash ^ (hash >>> 15), 2246822507);
  return ((hash >>> 0) % 10_000) / 10_000;
};
const clashes = (spot: CoinSpot, others: readonly CoinSpot[]) => {
  for (const other of others)
    if (
      Math.abs(other.x - spot.x) < COIN_SPACING_X &&
      Math.abs(other.lane - spot.lane) < COIN_SPACING_LANE
    )
      return true;
  return false;
};
// A stable pseudo-random spot, trying a few more times to keep clear of the
// coins already placed so they don't pile into one clump.
const restingSpot = (
  key: string,
  half: number,
  placed: readonly CoinSpot[]
) => {
  let spot: CoinSpot = { x: 0, lane: 0 };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    spot = {
      x: (hashUnit(key, attempt * 2) - 0.5) * 2 * half,
      lane: hashUnit(key, attempt * 2 + 1) * COIN_LANE_DEPTH
    };
    if (!clashes(spot, placed)) break;
  }
  return spot;
};

// If the scattered samples all clash, scan from the left at each lane where
// an occupied band ends. A crowded floor may have no open spot left.
const openRestingSpot = (half: number, placed: readonly CoinSpot[]) => {
  const byX = [...placed].sort((a, b) => a.x - b.x);
  // Leave room for floating-point rounding at the minimum spacing.
  const gap = 0.000001;
  for (const lane of [
    0,
    ...placed.map((spot) => spot.lane + COIN_SPACING_LANE + gap)
  ]) {
    if (lane > COIN_LANE_DEPTH) continue;
    let x = -half;
    for (const other of byX) {
      if (Math.abs(other.lane - lane) >= COIN_SPACING_LANE) continue;
      if (x <= other.x - COIN_SPACING_X - gap) break;
      x = Math.max(x, other.x + COIN_SPACING_X + gap);
    }
    if (x <= half) return { x, lane };
  }
  return undefined;
};

const fitRestingSpots = (
  resting: ReadonlyMap<string, CoinSpot>,
  half?: number
) => {
  const spots = new Map<string, CoinSpot>();
  const placed: CoinSpot[] = [];
  const displaced: [string, CoinSpot][] = [];
  const corrected: { key: string; prior: CoinSpot; spot: CoinSpot }[] = [];
  // Give every in-bounds coin its spot before fitting coins displaced by resize.
  for (const [key, spot] of resting) {
    if (half !== undefined && Math.abs(spot.x) > half) {
      displaced.push([key, spot]);
    } else {
      spots.set(key, spot);
      placed.push(spot);
    }
  }
  if (half !== undefined)
    for (const [key, prior] of displaced) {
      let spot = { ...prior, x: Math.sign(prior.x) * half };
      if (clashes(spot, placed)) {
        spot = restingSpot(key, half, placed);
        if (clashes(spot, placed)) spot = openRestingSpot(half, placed) ?? spot;
      }
      spots.set(key, spot);
      placed.push(spot);
      corrected.push({ key, prior, spot });
    }
  return { spots, placed, corrected };
};

// Conversations in no Project are coins on the stage floor, just above the
// caption. Ones already there at load rest at scattered spots; a Conversation
// that appears later is thrown out of its AI Client's key in a random direction
// and bounces to rest wherever it lands. Hover or focus names one; clicking
// opens it.
function FloorCoins({
  width,
  floor,
  coins,
  drop
}: {
  width: number | undefined;
  floor: number;
  coins: FloorCoinsInput;
  drop?: CoinDrop | undefined;
}) {
  const reduced = useReducedMotion();
  const { resting } = coins;
  const [, refreshSpots] = useState(0);
  const onSettle = (key: string, spot: CoinSpot) => {
    resting.set(key, spot);
    refreshSpots((version) => version + 1);
  };
  const conversations = [...coins.conversations].sort((left, right) =>
    right.latestAt.localeCompare(left.latestAt)
  );
  const half = Math.max(0, (width ?? 900) / 2 - 40);
  // Coins already lying keep their spots; the rest are spread in a fixed
  // order, so a new arrival never shifts them. With reduced motion arrivals
  // aren't thrown, so they are placed the same way.
  const keys = new Set(conversations.map(({ key }) => key));
  for (const key of [...resting.keys()])
    if (!keys.has(key)) resting.delete(key);
  const { spots, placed, corrected } = fitRestingSpots(
    resting,
    width === undefined ? undefined : half
  );
  useLayoutEffect(() => {
    for (const { key, prior, spot } of corrected) {
      // A flight may have settled since render; keep its newer position.
      if (resting.get(key) === prior) resting.set(key, spot);
    }
  });
  if (!conversations.length) return null;
  for (const { key } of [...conversations].sort((a, b) =>
    a.key.localeCompare(b.key)
  ))
    if (!spots.has(key) && (reduced || !coins.thrown.has(key))) {
      const spot = restingSpot(key, half, placed);
      spots.set(key, spot);
      placed.push(spot);
    }
  return (
    <div className="v1-home-floor" aria-label="Conversations in no Project">
      {conversations.map((conversation) => (
        <FloorCoin
          key={conversation.key}
          conversation={conversation}
          home={
            spots.get(conversation.key) ??
            restingSpot(conversation.key, half, [])
          }
          resting={resting}
          onSettle={onSettle}
          thrown={coins.thrown.has(conversation.key)}
          launched={coins.launched}
          floor={floor}
          half={half}
          onOpen={coins.onOpen}
          drop={drop}
        />
      ))}
    </div>
  );
}

// Coin physics in stage pixels per second: x from the stage's centre line, y
// height above the floor.
const COIN_GRAVITY = 2400;
const COIN_BOUNCE = 0.48;
const COIN_WALL_BOUNCE = 0.55;
const COIN_FLOOR_FRICTION = 5;
const COIN_MAX_SPEED = 3200;
const COIN_DRAG_THRESHOLD = 4;
const COIN_SAMPLE_WINDOW_MS = 250;
const COIN_SIZE = 20;

type CoinMotion = {
  mode: "rest" | "held" | "flying";
  x: number;
  y: number;
  angle: number;
};

// A coin to pick up and throw: it flies with the flick's speed, spinning,
// bounces off the floor with less energy each time, off the stage's sides and
// top, slides to a stop and settles flat. A click without a drag opens its
// conversation; with reduced motion a dropped coin settles at once.
function FloorCoin({
  conversation,
  home,
  resting,
  onSettle,
  thrown,
  launched,
  floor,
  half,
  onOpen,
  drop
}: {
  conversation: HomeLooseConversation;
  home: CoinSpot;
  resting: Map<string, CoinSpot>;
  onSettle: (key: string, spot: CoinSpot) => void;
  launched: (key: string) => void;
  // Appeared after load: thrown out of its AI Client's key.
  thrown: boolean;
  floor: number;
  half: number;
  onOpen: (key: string) => void;
  drop?: CoinDrop | undefined;
}) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLButtonElement>(null);
  const title = useRef<HTMLSpanElement>(null);
  // A title wider than the tooltip is cut off with an ellipsis and, while the
  // tooltip is up, slides to show the rest (not under reduced motion).
  const measureTitle = () =>
    requestAnimationFrame(() => {
      const label = title.current;
      if (!label) return;
      const overflow = label.scrollWidth - label.clientWidth;
      if (overflow > 0 && !reduced)
        label.style.setProperty("--marquee", `-${overflow + 4}px`);
      else label.style.removeProperty("--marquee");
    });
  const [flight, setFlight] = useState<CoinMotion | null>(null);
  // How far up the resting band this coin lies; it lands on this lane.
  const lane = home.lane;
  // A running flight uses the latest bounds without restarting its frame loop.
  const bounds = useRef({ half, lane });
  useLayoutEffect(() => {
    bounds.current = { half, lane };
  }, [half, lane]);
  const motion: CoinMotion = flight ?? {
    mode: "rest",
    x: home.x,
    y: lane,
    angle: 0
  };
  const body = useRef({ x: 0, y: 0, angle: 0, vx: 0, vy: 0, spin: 0 });
  const samples = useRef<{ t: number; x: number; y: number }[]>([]);
  const start = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);
  // Grabbed while still moving: letting go without a drag must resume it.
  const caught = useRef(false);
  const frame = useRef(0);
  const ceiling = useRef(400);
  // Taken into a Project: it shrinks away until the list catches up.
  const [absorbed, setAbsorbed] = useState(false);
  const alive = useRef(true);
  const over = useRef<DropTarget | null>(null);
  const arming = useRef(0);
  const dropRef = useRef(drop);
  dropRef.current = drop;
  // Tracks the Kin under a held coin; it arms after COIN_DROP_ARM_MS there.
  const hover = (id: string | null) => {
    if ((over.current?.id ?? null) === id) return;
    window.clearTimeout(arming.current);
    over.current = id ? { id, armed: false } : null;
    dropRef.current?.onTarget(over.current);
    if (!id) return;
    arming.current = window.setTimeout(() => {
      if (over.current?.id !== id) return;
      over.current = { id, armed: true };
      dropRef.current?.onTarget(over.current);
    }, COIN_DROP_ARM_MS);
  };
  useEffect(() => {
    alive.current = true;
    if (!thrown && !resting.has(conversation.key))
      resting.set(conversation.key, { x: home.x, lane });
    return () => {
      alive.current = false;
      cancelAnimationFrame(frame.current);
      window.clearTimeout(arming.current);
      if (over.current) dropRef.current?.onTarget(null);
    };
  }, []);

  const toStage = (clientX: number, clientY: number) => {
    const rect = ref.current?.parentElement?.getBoundingClientRect();
    if (!rect) return null;
    ceiling.current = Math.max(60, rect.height - floor - COIN_SIZE);
    return {
      x: clientX - (rect.left + rect.width / 2),
      y: rect.bottom - floor - clientY - COIN_SIZE / 2
    };
  };
  const settle = () => {
    const { half, lane } = bounds.current;
    // Come to rest in the nearest gap, nudging sideways off a neighbour.
    const others = [...resting].filter(([key]) => key !== conversation.key);
    let x = Math.max(-half, Math.min(half, body.current.x));
    for (const nudge of [0, 10, -10, 20, -20, 30, -30, 45, -45]) {
      const next = Math.max(-half, Math.min(half, body.current.x + nudge));
      if (
        !clashes(
          { x: next, lane },
          others.map(([, spot]) => spot)
        )
      ) {
        x = next;
        break;
      }
    }
    onSettle(conversation.key, { x, lane });
    setFlight(null);
  };
  const fly = () => {
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.032);
      last = now;
      const { half, lane } = bounds.current;
      const coin = body.current;
      coin.vy -= COIN_GRAVITY * dt;
      coin.x += coin.vx * dt;
      coin.y += coin.vy * dt;
      coin.angle += coin.spin * dt;
      if (Math.abs(coin.x) > half) {
        coin.x = Math.sign(coin.x) * half;
        coin.vx = -coin.vx * COIN_WALL_BOUNCE;
      }
      if (coin.y > ceiling.current) {
        coin.y = ceiling.current;
        coin.vy = -Math.abs(coin.vy) * COIN_WALL_BOUNCE;
      }
      if (coin.y <= lane) {
        coin.y = lane;
        if (coin.vy < -90) {
          // Each bounce keeps less energy and slows the spin.
          coin.vy = -coin.vy * COIN_BOUNCE;
          coin.vx *= 0.8;
          coin.spin *= 0.6;
        } else {
          // Sliding: friction slows it and the spin dies away.
          const keep = Math.max(0, 1 - COIN_FLOOR_FRICTION * dt);
          coin.vy = 0;
          coin.vx *= keep;
          coin.spin *= keep;
          if (Math.abs(coin.vx) < 12) {
            settle();
            return;
          }
        }
      }
      setFlight({ mode: "flying", x: coin.x, y: coin.y, angle: coin.angle });
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  };

  // A coin caught mid-air and let go without a drag falls on again.
  const resumeCaught = () => {
    if (!caught.current) return;
    caught.current = false;
    body.current = { ...body.current, vx: 0, vy: 0, spin: 0 };
    if (reduced) settle();
    else fly();
  };
  // A new coin is thrown from its AI Client's key at the top in a random
  // direction; it bounces and rests wherever it lands.
  useLayoutEffect(() => {
    if (!thrown) return;
    launched(conversation.key);
    if (reduced) {
      resting.set(conversation.key, { x: home.x, lane });
      return;
    }
    const key = document
      .querySelector(
        `.v1-home-keycap[data-client="${conversation.client ?? ""}"]`
      )
      ?.getBoundingClientRect();
    const stage = ref.current?.parentElement?.getBoundingClientRect();
    if (!stage) return;
    const origin = key
      ? toStage(key.left + key.width / 2, key.bottom)
      : { x: 0, y: ceiling.current };
    if (!origin) return;
    const heading = Math.random() * Math.PI * 2;
    const speed = 600 + Math.random() * 800;
    body.current = {
      x: Math.max(-half, Math.min(half, origin.x)),
      y: Math.max(0, Math.min(ceiling.current, origin.y)),
      angle: 0,
      vx: Math.cos(heading) * speed,
      vy: Math.sin(heading) * speed,
      spin: (Math.random() < 0.5 ? -1 : 1) * (600 + Math.random() * 900)
    };
    setFlight({ mode: "flying", ...body.current });
    fly();
    // Thrown once, when the coin first appears.
  }, []);
  // Anything that ends a drag (button up, the browser cancelling it, or the
  // pointer capture being taken away by a re-render) is a release: the coin
  // carries on with the velocity it was dragged at. Only a real button up
  // (`committed`) over a ready Kin adds the Conversation to its Project.
  const release = (time: number, committed: boolean) => {
    if (!start.current) return;
    start.current = null;
    stopWindow.current?.();
    if (!dragged.current) return resumeCaught();
    const target = over.current;
    hover(null);
    if (committed && drop && target?.armed) {
      // Let go over a Kin that has waited its turn: add it at once.
      setAbsorbed(true);
      void drop
        .onDrop(conversation.key, target.id)
        .catch(() => false)
        .then((added) => {
          if (added || !alive.current) return;
          // Not added: the coin drops back onto the floor.
          setAbsorbed(false);
          body.current = { ...body.current, vx: 0, vy: 0, spin: 0 };
          if (reduced) settle();
          else fly();
        });
      return;
    }
    if (reduced) {
      settle();
      return;
    }
    // A hand slows before letting go, so throw with the fastest recent
    // movement, not the last (slowest) samples. Samples carry the hardware
    // event times, so a busy main thread doesn't distort the speed.
    const recent = samples.current.filter((sample) => time - sample.t < 200);
    const clamp = (value: number) =>
      Math.max(-COIN_MAX_SPEED, Math.min(COIN_MAX_SPEED, value));
    let fx = 0;
    let fy = 0;
    recent.forEach((to, index) => {
      const before = recent.slice(0, index);
      // Prefer a baseline 24ms back; a short flick uses what span it has.
      const from =
        [...before].reverse().find((sample) => to.t - sample.t >= 24) ??
        before.find((sample) => to.t - sample.t >= 6);
      if (!from) return;
      const seconds = (to.t - from.t) / 1000;
      const vx = (to.x - from.x) / seconds;
      const vy = -(to.y - from.y) / seconds;
      if (Math.hypot(vx, vy) > Math.hypot(fx, fy)) {
        fx = vx;
        fy = vy;
      }
    });
    // Held still before letting go: no throw.
    const still = !recent.length || time - recent.at(-1)!.t > 120;
    const coin = body.current;
    coin.vx = still ? 0 : clamp(fx);
    coin.vy = still ? 0 : clamp(fy);
    coin.spin = coin.vx * 1.4;
    fly();
  };
  // Window-level listeners call the latest release, not a stale render's.
  const releaseRef = useRef(release);
  releaseRef.current = release;
  const stopWindow = useRef<(() => void) | null>(null);
  useEffect(() => () => stopWindow.current?.(), []);

  return (
    <button
      ref={ref}
      type="button"
      className="v1-home-floor-coin"
      data-coin-conversation={conversation.key}
      data-motion={absorbed ? "absorbed" : motion.mode}
      style={
        {
          "--coin-x": `calc(50% + ${motion.x}px)`,
          "--coin-y": `${floor + motion.y}px`,
          "--coin-angle": `${motion.angle}deg`,
          "--coin-depth": lane / COIN_LANE_DEPTH,
          // Coins nearer the front lie over those behind.
          zIndex: 100 - Math.round(lane)
        } as CSSProperties
      }
      aria-label={`Open ${conversation.title}`}
      onPointerEnter={measureTitle}
      onFocus={measureTitle}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        cancelAnimationFrame(frame.current);
        caught.current = motion.mode !== "rest";
        // Catching a coin mid-air holds it where it is.
        body.current = {
          x: motion.x,
          y: motion.y,
          angle: motion.angle,
          vx: 0,
          vy: 0,
          spin: 0
        };
        start.current = { x: event.clientX, y: event.clientY };
        dragged.current = false;
        samples.current = [
          { t: event.timeStamp, x: event.clientX, y: event.clientY }
        ];
        event.currentTarget.setPointerCapture?.(event.pointerId);
        stopWindow.current?.();
        const pointerId = event.pointerId;
        const onWindowEnd = (windowEvent: PointerEvent) => {
          if (windowEvent.pointerId === pointerId)
            releaseRef.current(
              windowEvent.timeStamp,
              windowEvent.type === "pointerup"
            );
        };
        window.addEventListener("pointerup", onWindowEnd);
        window.addEventListener("pointercancel", onWindowEnd);
        stopWindow.current = () => {
          window.removeEventListener("pointerup", onWindowEnd);
          window.removeEventListener("pointercancel", onWindowEnd);
          stopWindow.current = null;
        };
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        if (
          !dragged.current &&
          Math.hypot(
            event.clientX - start.current.x,
            event.clientY - start.current.y
          ) < COIN_DRAG_THRESHOLD
        )
          return;
        dragged.current = true;
        const point = toStage(event.clientX, event.clientY);
        if (!point) return;
        samples.current = [
          ...samples.current,
          ...coalesced(event.nativeEvent).map((sample) => ({
            t: sample.timeStamp,
            x: sample.clientX,
            y: sample.clientY
          }))
        ];
        // Keep by elapsed time, not count: a 1,000 Hz mouse delivers a
        // quarter second of movement in hundreds of samples.
        const newest = samples.current.at(-1)!.t;
        samples.current = samples.current.filter(
          (sample) => newest - sample.t <= COIN_SAMPLE_WINDOW_MS
        );
        const coin = body.current;
        coin.x = Math.max(-half, Math.min(half, point.x));
        coin.y = Math.max(0, Math.min(ceiling.current, point.y));
        coin.angle = 0;
        setFlight({ mode: "held", x: coin.x, y: coin.y, angle: 0 });
        if (drop)
          hover(
            document
              .elementsFromPoint?.(event.clientX, event.clientY)
              .map((element) =>
                element.closest<HTMLElement>("[data-drop-project]")
              )
              .find(Boolean)?.dataset.dropProject ?? null
          );
      }}
      onPointerUp={(event) => release(event.timeStamp, true)}
      onPointerCancel={(event) => release(event.timeStamp, false)}
      onLostPointerCapture={(event) => release(event.timeStamp, false)}
      onClick={(event) => {
        // A drag ends with a click; only a plain click opens.
        if (dragged.current) {
          dragged.current = false;
          event.preventDefault();
          return;
        }
        onOpen(conversation.key);
      }}
    >
      <CoinArtwork client={conversation.client} />
      {/* The coin carries the client's mark; the tooltip carries the title. */}
      <span className="v1-home-floor-tip" role="tooltip">
        {conversation.client && (
          <span className="v1-home-floor-client" aria-hidden="true">
            <AiClientLogo id={conversation.client} />
          </span>
        )}
        <span className="v1-home-floor-title" ref={title}>
          {conversation.title}
        </span>
      </span>
    </button>
  );
}

// Tells which loose Conversations arrived after Home loaded, once each. Like
// the Project coins it keeps a baseline even while the floor is empty, and
// counts a Conversation by all of its keys so a draft getting its permanent
// key stays where it was.
function useLooseArrivals(
  loose: readonly HomeLooseConversation[],
  loaded: boolean,
  scope: string | null
): Pick<FloorCoinsInput, "thrown" | "launched" | "resting"> {
  // Where coins lie lives here, not in the floor, so a coin that has landed
  // stays put when the stage changes under it and the floor remounts.
  const resting = useRef(new Map<string, CoinSpot>());
  const state = useRef<{
    scope: string;
    seen: Set<string>;
    thrown: Set<string>;
  } | null>(null);
  const launched = useCallback(
    (key: string) => state.current?.thrown.delete(key),
    []
  );
  if (!loaded || !scope) {
    state.current = null;
    resting.current.clear();
    return { thrown: NO_KEYS, launched, resting: resting.current };
  }
  const baseline = state.current?.scope !== scope;
  const current = baseline
    ? { scope, seen: new Set<string>(), thrown: new Set<string>() }
    : state.current!;
  if (baseline) resting.current.clear();
  state.current = current;
  for (const conversation of loose) {
    const keys = [conversation.key, ...(conversation.aliases ?? [])];
    if (!baseline && !keys.some((key) => current.seen.has(key)))
      current.thrown.add(conversation.key);
    for (const key of keys) current.seen.add(key);
  }
  return { thrown: current.thrown, launched, resting: resting.current };
}
const NO_KEYS: ReadonlySet<string> = new Set();

function useConversationCoins(
  conversations: readonly HomeConversation[] | undefined,
  scope: string | null
) {
  const reduced = useReducedMotion();
  const layer = useRef<HTMLDivElement>(null);
  const previous = useRef<{ scope: string; seen: Set<string> } | null>(null);
  const nextKey = useRef(0);
  const [coins, setCoins] = useState<Coin[]>([]);
  const [, refreshTargets] = useState(0);
  useEffect(() => {
    const root = layer.current?.parentElement;
    if (!root) return;
    const observer = new MutationObserver((records) => {
      if (
        records.some((record) =>
          [...record.addedNodes].some(
            (node) =>
              node instanceof HTMLElement &&
              (node.matches(
                "[data-coin-project], .v1-pixelkin, .v1-home-keycap, .v1-home-stage"
              ) ||
                node.querySelector(
                  "[data-coin-project], .v1-pixelkin, .v1-home-keycap, .v1-home-stage"
                ))
          )
        )
      )
        refreshTargets((value) => value + 1);
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  });
  useEffect(() => {
    if (!scope || !conversations) {
      previous.current = null;
      setCoins((current) => (current.length ? [] : current));
      return;
    }
    if (reduced) setCoins((current) => (current.length ? [] : current));
    const before = previous.current;
    if (before && before.scope !== scope)
      setCoins((current) => (current.length ? [] : current));
    const seen = before?.scope === scope ? before.seen : new Set<string>();
    const fresh: HomeConversation[] = [];
    const baseline = !before || before.scope !== scope;
    for (const conversation of conversations) {
      const aliases = [conversation.key, ...conversation.aliases];
      if (baseline || reduced || aliases.some((key) => seen.has(key))) {
        for (const key of aliases) seen.add(key);
      } else fresh.push(conversation);
    }
    previous.current = { scope, seen };
    const root = layer.current?.parentElement;
    if (baseline || reduced || !root || !layer.current) return;
    const origin = layer.current.getBoundingClientRect();
    const launched: Coin[] = [];
    for (const conversation of fresh) {
      if (
        [conversation.key, ...conversation.aliases].some((key) => seen.has(key))
      ) {
        for (const key of [conversation.key, ...conversation.aliases])
          seen.add(key);
        continue;
      }
      if (!conversation.client) {
        for (const key of [conversation.key, ...conversation.aliases])
          seen.add(key);
        continue;
      }
      const source = root
        .querySelector(`.v1-home-keycap[data-client="${conversation.client}"]`)
        ?.getBoundingClientRect();
      if (!source) continue;
      const target = [
        ...root.querySelectorAll<HTMLElement>("[data-coin-project]")
      ]
        .filter((element) =>
          conversation.projectIds.includes(element.dataset.coinProject ?? "")
        )
        .sort((a, b) =>
          (a.dataset.coinProject ?? "").localeCompare(
            b.dataset.coinProject ?? ""
          )
        )[0]
        ?.querySelector(".v1-pixelkin")
        ?.getBoundingClientRect();
      if (conversation.projectIds.length && !target) continue;
      // Loose Conversations are thrown as floor coins, not flown to a Kin.
      if (!target) {
        for (const key of [conversation.key, ...conversation.aliases])
          seen.add(key);
        continue;
      }
      for (const key of [conversation.key, ...conversation.aliases])
        seen.add(key);
      launched.push({
        key: ++nextKey.current,
        from: {
          x: source.left + source.width / 2 - origin.left,
          y: source.bottom - origin.top
        },
        to: {
          x: target.left + target.width / 2 - origin.left,
          y: target.top + target.height * 0.35 - origin.top
        },
        delay: 0
      });
    }
    if (launched.length) setCoins((current) => [...current, ...launched]);
  });
  return (
    <div className="v1-home-coins" ref={layer} aria-hidden="true">
      {coins.slice(0, MAX_CONCURRENT_COINS).map((coin) => (
        <FlyingCoin
          key={coin.key}
          coin={coin}
          onDone={() =>
            setCoins((current) =>
              current.filter((item) => item.key !== coin.key)
            )
          }
        />
      ))}
    </div>
  );
}

function IngestionProgress({
  ingestion,
  compact = false
}: {
  ingestion: HomeIngestion;
  // Under the Projects caption: the bar and the finished line only.
  compact?: boolean;
}) {
  const [showSkipped, setShowSkipped] = useState(false);
  const total = ingestion.selected;
  // Finished already counts completed and skipped Conversations; only the
  // skipped part is called out, since it needs explaining.
  const skipped = ingestion.clients.reduce(
    (sum, client) => sum + client.skipped,
    0
  );
  const lastProgress = ingestion.clients
    .map((client) => client.lastProgressAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const now = useNow(30_000);
  const activity = ingestion.clients.flatMap((client) =>
    client.activity ? [client.activity] : []
  );
  const recordsRead = activity.reduce((sum, item) => sum + item.recordsRead, 0);
  const embedded = activity.reduce((sum, item) => sum + item.embedded, 0);
  const eligible = activity.reduce((sum, item) => sum + item.eligible, 0);
  const percent =
    total && total > 0
      ? Math.min(100, Math.round((100 * ingestion.finished) / total))
      : null;
  return (
    <div className="v1-home-progress">
      {!compact && activity.length > 0 && (
        <>
          <span className="v1-home-progress-label">
            Reading history · {recordsRead.toLocaleString()} records read
          </span>
          <span className="v1-home-progress-label">
            Making memories searchable · {embedded.toLocaleString()} of{" "}
            {eligible.toLocaleString()} items indexed so far
          </span>
        </>
      )}
      <div
        role="progressbar"
        aria-label="Recent history processed"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={
          total === null
            ? `${ingestion.finished} conversations finished`
            : `${ingestion.finished} of ${total} conversations finished`
        }
        className="v1-home-progress-track"
        data-indeterminate={percent === null || undefined}
      >
        <span style={{ width: `${percent ?? 30}%` }} />
      </div>
      <span className="v1-home-progress-label">
        {total === null
          ? `${ingestion.finished} conversations finished`
          : `${ingestion.finished} of ${total} conversations finished`}
        {skipped > 0 ? (
          <>
            {" "}
            · {skipped} skipped{" "}
            <span
              className="v1-home-skip-help"
              onMouseEnter={() => setShowSkipped(true)}
              onMouseLeave={(event) => {
                if (!event.currentTarget.contains(document.activeElement))
                  setShowSkipped(false);
              }}
            >
              <button
                type="button"
                aria-label="Why conversations are skipped"
                aria-expanded={showSkipped}
                aria-describedby={
                  showSkipped ? "v1-home-skip-explanation" : undefined
                }
                onFocus={() => setShowSkipped(true)}
                onBlur={() => setShowSkipped(false)}
                onClick={() => setShowSkipped(true)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setShowSkipped(false);
                }}
              >
                ?
              </button>
              {showSkipped && (
                <span id="v1-home-skip-explanation" role="tooltip">
                  Koed may skip a conversation it can’t safely process, such as
                  one containing a record that is too large or invalid.
                </span>
              )}
            </span>
          </>
        ) : null}
        {lastProgress
          ? ` · Last activity ${formatHomeAgo(lastProgress, now)}`
          : ""}
      </span>
    </div>
  );
}

// Non-blocking problems stay out of the way: a chip that opens the list.
// AI Client problems are left to their keycaps.
function HomeWarnings({
  problems,
  statusStore
}: {
  problems: readonly HomeProblem[];
  statusStore: DesktopStatusStore;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(root, open, () => setOpen(false));
  if (!problems.length) return null;
  return (
    <div className="v1-home-warnings" ref={root}>
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
  onOpenProject,
  looseConversations = [],
  onOpenConversation,
  onDropConversation,
  conversations,
  conversationScope = "home",
  statusError = null
}: {
  view: HomeView;
  statusError?: string | null;
  clients: readonly HomeClient[];
  entries: readonly HomeProjectEntry[];
  agent: { name: string; look: AgentLook };
  statusStore: DesktopStatusStore;
  onOpenProject: (projectId: string) => void;
  looseConversations?: readonly HomeLooseConversation[];
  conversations?: readonly HomeConversation[];
  conversationScope?: string | null;
  onOpenConversation?: (key: string) => void;
  // Adds a floor coin's conversation to a Project; true once it is added.
  onDropConversation?: (key: string, projectId: string) => Promise<boolean>;
}) {
  const arrivals = useLooseArrivals(
    looseConversations,
    conversations !== undefined,
    conversationScope
  );
  const floorCoins =
    onOpenConversation && looseConversations.length
      ? {
          conversations: looseConversations,
          ...arrivals,
          onOpen: onOpenConversation
        }
      : undefined;
  useEffect(() => {
    const refreshVisible = () => {
      if (!document.hidden) void statusStore.refresh();
    };
    const timer = window.setInterval(refreshVisible, 15_000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [statusStore]);
  const conversationCoins = useConversationCoins(
    conversations,
    conversationScope
  );
  if (view.kind === "loading" || view.kind === "ingesting") {
    const ingestion = view.kind === "ingesting" ? view.ingestion : null;
    const stalled =
      ingestion?.clients
        .filter((client) => client.stuck)
        .map(({ name }) => name) ?? [];
    return (
      <section className="v1-home" data-mood="loading" aria-busy="true">
        {view.kind === "ingesting" && (
          <HomeWarnings problems={view.warnings} statusStore={statusStore} />
        )}
        <div className="v1-home-stage v1-home-startup">
          <div className="v1-home-startup-copy">
            <h1>Making room for your Projects</h1>
            <p className="v1-home-sub">
              {stalled.length
                ? `${stalled.join(" and ")} history has stalled, so ${agent.name} keeps retrying. Projects still appear as they’re found.`
                : "Your stage will be ready in a moment."}
            </p>
          </div>
          <div className="v1-home-startup-spinner">
            <Spinner className="v1-home-spinner" strokeWidth={1.25} />
          </div>
          {ingestion ? (
            <div
              className="v1-home-startup-progress"
              title={`Up to ${AUTOMATIC_HISTORICAL_CONVERSATION_CAP} conversations per AI Client from the last ${AUTOMATIC_HISTORICAL_WINDOW_DAYS} days.`}
            >
              <IngestionProgress ingestion={ingestion} />
            </div>
          ) : (
            <div className="v1-home-startup-caption" aria-hidden="true">
              <span />
              <span />
            </div>
          )}
        </div>
      </section>
    );
  }
  if (view.kind === "attention")
    return (
      <section className="v1-home" data-mood="attention">
        <div className="v1-home-stage v1-home-recovery">
          <div
            className="v1-home-recovery-kin"
            role="img"
            aria-label={`${agent.name} looks concerned`}
          >
            <Pixelkin
              look={agent.look}
              size={290}
              presentation="stage"
              expression="sad"
            />
            <span className="v1-home-recovery-shadow" aria-hidden="true" />
          </div>
          <div className="v1-home-caption">
            <h1>{agent.name} needs a hand</h1>
            <p className="v1-home-sub">
              Your Projects can’t load until this is sorted.
              <br />
              Nothing has been lost.
            </p>
            <ProblemList
              problems={view.problems}
              primary={view.primary}
              statusStore={statusStore}
            />
            {statusError && (
              <p className="v1-home-recovery-error" role="alert">
                {statusError}
              </p>
            )}
          </div>
        </div>
      </section>
    );
  const warnings = (
    <HomeWarnings problems={view.warnings} statusStore={statusStore} />
  );
  // The next step on an empty stage is connecting a detected client.
  const connectable = clients
    .filter(({ state }) => state === "detected")
    .slice(0, 2);
  if (view.kind === "empty")
    return (
      <section className="v1-home" data-mood="empty">
        {warnings}
        <SoloStage
          agent={agent}
          keycaps={<Keycaps clients={clients} statusStore={statusStore} />}
          expression="neutral"
          label="No Projects yet"
          floorCoins={floorCoins}
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
        {conversationCoins}
      </section>
    );
  const total = entries.reduce((sum, entry) => sum + entry.eventCount, 0);
  const offStage = entries.length - HOME_STAGE_LIMIT;
  return (
    <section className="v1-home" data-mood="projects">
      {warnings}
      <ProjectsStage
        floorCoins={floorCoins}
        keycaps={
          <Keycaps
            clients={clients}
            statusStore={statusStore}
            {...(view.ingestion ? { ingestion: view.ingestion } : {})}
          />
        }
        entries={entries}
        onOpenProject={onOpenProject}
        {...(onDropConversation ? { onDropConversation } : {})}
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
            {view.ingestion && (
              <IngestionProgress ingestion={view.ingestion} compact />
            )}
          </>
        }
      />
      {conversationCoins}
    </section>
  );
}
