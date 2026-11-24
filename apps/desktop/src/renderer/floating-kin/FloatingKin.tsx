import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject
} from "react";
import type {
  FloatingKinBridge,
  KinActivityBridge,
  KinPlacement
} from "../../ipc/floating-kin-protocol.js";
import { KoedLogo } from "../KoedLogo.js";
import { Pixelkin } from "../v1/pixelkin/Pixelkin.js";
import {
  DEFAULT_AGENT_LOOK,
  chiefOfStaffBrand,
  projectKinLook
} from "../v1/pixelkin/agent-kin.js";
import {
  ClientMark,
  clientNames,
  FloatingKinPanel,
  type Conversation
} from "./FloatingKinPanel.js";
import {
  useActivity,
  useCaptureWake,
  useCapturedPreview,
  useMainWindowFocus,
  useOverlayWindow,
  useSummary,
  useKinSurfaceActivity,
  useLatestSummary
} from "./use-floating-kin.js";
import { useKinInteraction } from "./use-kin-interaction.js";
import "./floating-kin.css";

export type { FloatingKinBridge } from "../../ipc/floating-kin-protocol.js";

const chipLimit = 3;
const recentSeconds = 60;
const states = {
  stopped: [
    "Local runtime stopped",
    "Start Koed from Desktop when you’re ready."
  ],
  starting: ["Local runtime starting", "Waiting for Koed to finish starting."],
  unavailable: [
    "Local runtime unavailable",
    "Check service status in Koed Desktop."
  ],
  signed_out: [
    "Sign-in needed",
    "Sign in from Koed Desktop to see recent activity."
  ]
} as const;

function captureSeconds(iso: string, now: number) {
  return Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
}

function captureAge(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function workingDeadline(conversation: Conversation) {
  return conversation.client === "pi" && conversation.workingUntil
    ? Date.parse(conversation.workingUntil)
    : 0;
}

function useWorkingClock(deadlines: number[], sampledAt: number) {
  const [check, setCheck] = useState<{ sampledAt: number; at: number }>();
  const now = check?.sampledAt === sampledAt ? check.at : sampledAt;
  const next = Math.min(...deadlines.filter((deadline) => deadline > now));
  // Expire visible leases even when the activity read never settles.
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    let timer: number | undefined;
    const expire = () => {
      const time = Date.now();
      if (time >= next) setCheck({ sampledAt, at: time });
      else
        timer = window.setTimeout(expire, Math.min(next - time, 2_147_483_647));
    };
    expire();
    return () => window.clearTimeout(timer);
  }, [next, sampledAt]);
  return now;
}

const ChipKin = memo(function ChipKin({
  projectId,
  animate
}: {
  projectId: string | null;
  animate: boolean;
}) {
  return (
    <Pixelkin
      look={projectId ? projectKinLook(projectId) : DEFAULT_AGENT_LOOK}
      size={32}
      motion={animate ? "unfocused" : "still"}
    />
  );
});

function CaptureChip({
  conversation,
  index,
  now,
  working,
  expanded,
  toggle
}: {
  conversation: Conversation;
  index: number;
  now: number;
  working: boolean;
  expanded: boolean;
  toggle: (trigger: HTMLButtonElement) => void;
}) {
  const seconds = captureSeconds(conversation.lastActivityAt, now);
  const recent = seconds < recentSeconds;
  const age = captureAge(seconds);
  return (
    <button
      type="button"
      className="fk-chip"
      data-client={conversation.client}
      data-fk-hit
      aria-expanded={expanded}
      aria-controls={expanded ? "floating-kin-summary" : undefined}
      aria-label={`${clientNames[conversation.client]} Conversation ${index + 1}. ${working ? "Working. " : ""}Captured ${age} ago.`}
      onClick={(event) => toggle(event.currentTarget)}
    >
      <span className="fk-avatar" data-fk-handle>
        <ChipKin
          projectId={conversation.projectId}
          animate={recent && index === 0}
        />
        <ClientMark client={conversation.client} />
      </span>
      <span className="fk-dot" data-recent={recent} aria-hidden="true" />
      <span className="fk-chip-label" aria-hidden="true">
        {working ? (
          <span className="fk-working">Working</span>
        ) : (
          <time dateTime={conversation.lastActivityAt}>{age}</time>
        )}
      </span>
    </button>
  );
}

function ActivityPill({ state }: { state: keyof typeof states }) {
  const [label, detail] = states[state];
  return (
    <div className="fk-state" role="status">
      <div>
        <strong>{label}</strong>
        <div className="fk-note">{detail}</div>
      </div>
    </div>
  );
}

export function StandaloneKin({
  active,
  placement = "desktop",
  size = 88,
  wakeOnAppear = false,
  onOpenDesktop
}: {
  active: boolean;
  placement?: "desktop" | "sidebar";
  size?: number;
  // Starts awake, as if hovered, so it never arrives asleep.
  wakeOnAppear?: boolean;
  onOpenDesktop?: () => void;
}) {
  const Avatar = onOpenDesktop ? "button" : "div";
  const wakeTimer = useRef<number | undefined>(undefined);
  const [recentHover, setRecentHover] = useState(wakeOnAppear);
  const awake = active || recentHover;
  const wake = () => {
    window.clearTimeout(wakeTimer.current);
    setRecentHover(true);
    wakeTimer.current = window.setTimeout(() => setRecentHover(false), 60_000);
  };
  useEffect(() => {
    if (wakeOnAppear) wake();
    return () => window.clearTimeout(wakeTimer.current);
    // Only on appearing; later wakes come from hover.
  }, []);
  return (
    <Avatar
      className="fk-kin-avatar"
      data-fk-hit
      data-fk-handle
      {...(onOpenDesktop
        ? { type: "button" as const, onClick: onOpenDesktop }
        : { role: "img" })}
      aria-label={
        onOpenDesktop
          ? "Open Koed Desktop"
          : placement === "desktop"
            ? "Floating Kin avatar"
            : "Chief of Staff"
      }
      aria-description={awake ? "Awake" : "Sleeping"}
      onMouseEnter={wake}
    >
      <Pixelkin
        {...chiefOfStaffBrand}
        size={size}
        motion={awake ? "unfocused" : "still"}
        expression={awake ? "happy" : "sleepy"}
      />
      {!awake && (
        <span className="fk-sleep-mark" aria-hidden="true">
          z
        </span>
      )}
    </Avatar>
  );
}

// The rail Kin glances up and right with a happy face, then fades to the logo.
// Waking runs the same steps in reverse.
// How long the glance holds before fading: going to rest, and waking.
const restGlanceMs = 700;
const wakeGlanceMs = 900;
const fadeMs = 450;
// After the pointer leaves, the Kin stays live this long before resting.
const hoverLingerMs = 5_000;
const glanceUp = [0.75, 0.65] as const;
// The Kin's body fills about two thirds of a tightly framed canvas. Drawn at
// 80% in a 68px canvas, it matches the 36px logo with room for turned arms.
const railKinSize = 68;
const railKinFit = 0.8;

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The Chief of Staff on the Desktop rail. While a capture is recent, or the
 * pointer is over it, it is the live Kin; otherwise it rests as the Koed logo.
 */
export function RailKin({ active }: { active: boolean }) {
  const [hovered, setHovered] = useState(false);
  const [lingering, setLingering] = useState(false);
  const linger = useRef<number | undefined>(undefined);
  const awake = active || hovered || lingering;
  const [phase, setPhase] = useState<"live" | "arriving" | "leaving" | "logo">(
    awake ? "live" : "logo"
  );
  useEffect(() => {
    if (prefersReducedMotion()) {
      setPhase(awake ? "live" : "logo");
      return;
    }
    if (awake) {
      setPhase((current) => (current === "live" ? "live" : "arriving"));
      const timer = window.setTimeout(
        () => setPhase("live"),
        fadeMs + wakeGlanceMs
      );
      return () => window.clearTimeout(timer);
    }
    setPhase((current) => (current === "logo" ? "logo" : "leaving"));
    const timer = window.setTimeout(
      () => setPhase("logo"),
      restGlanceMs + fadeMs
    );
    return () => window.clearTimeout(timer);
  }, [awake]);
  useEffect(() => () => window.clearTimeout(linger.current), []);
  return (
    <span
      className="fk-rail-kin"
      data-phase={phase}
      role="img"
      aria-label="Chief of Staff"
      aria-description={awake ? "Awake" : "Resting"}
      onMouseEnter={() => {
        window.clearTimeout(linger.current);
        setLingering(false);
        setHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
        setLingering(true);
        linger.current = window.setTimeout(
          () => setLingering(false),
          hoverLingerMs
        );
      }}
    >
      {phase !== "logo" && (
        <Pixelkin
          {...chiefOfStaffBrand}
          size={railKinSize}
          fit={railKinFit}
          motion="unfocused"
          expression={phase === "live" ? "happy" : "joy"}
          gaze={phase === "live" ? null : glanceUp}
        />
      )}
      <KoedLogo color className="fk-rail-logo" />
    </span>
  );
}

function useSelection(
  conversations: Conversation[],
  cancel: (dismiss: boolean) => Promise<void>,
  surface: RefObject<HTMLElement | null>,
  visible: boolean
) {
  const [selection, setSelection] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = conversations.find(
    ({ sessionId }) => sessionId === selection
  );
  useLayoutEffect(() => {
    if (visible || !selection) return;
    setSelection(null);
    void cancel(true);
  }, [cancel, selection, visible]);
  useEffect(() => {
    if (!visible || !selection || selected) return;
    setSelection(null);
    void cancel(true);
    (
      surface.current?.querySelector<HTMLButtonElement>(".fk-chip") ??
      surface.current
    )?.focus();
  }, [cancel, selected, selection, surface, visible]);
  const close = () => {
    setSelection(null);
    void cancel(true);
    if (trigger.current?.isConnected) trigger.current.focus();
    else
      (
        surface.current?.querySelector<HTMLButtonElement>(".fk-chip") ??
        surface.current
      )?.focus();
  };
  const toggle = (sessionId: string, button: HTMLButtonElement) => {
    if (sessionId === selection) return close();
    trigger.current = button;
    void cancel(true);
    setSelection(sessionId);
  };
  return { selected, close, toggle };
}

export function useKinActivity(
  bridge: KinActivityBridge | undefined,
  placement: KinPlacement,
  visible = true,
  scopeKey?: string | null
) {
  const { activity, at, pending } = useActivity(bridge, visible, scopeKey);
  const recent = activity.state === "running" ? activity.conversations : [];
  const latest = Math.max(
    0,
    ...recent.map(({ lastActivityAt }) => Date.parse(lastActivityAt))
  );
  const recentCapture = useCaptureWake(
    latest ? Math.min(latest, at) + recentSeconds * 1000 : 0,
    at
  );
  const conversations = recent.slice(0, chipLimit);
  const overflow =
    (activity.state === "running" ? activity.overflowCount : 0) +
    recent.length -
    conversations.length;
  return {
    activity,
    at,
    pending,
    recent,
    recentCapture,
    conversations,
    overflow
  };
}

export function kinConversationStatus(conversation: Conversation, at: number) {
  const seconds = captureSeconds(conversation.lastActivityAt, at);
  return { age: captureAge(seconds), recent: seconds < recentSeconds };
}

/**
 * Selection and summary panel for the Kin's recent Conversations. The
 * floating dock opens it from chips; the Desktop sidebar opens it from rows.
 */
export function useKinSummaryPanel({
  sample,
  bridge,
  surface,
  visible = true,
  openAiModels,
  openConversation
}: {
  sample: ReturnType<typeof useKinActivity>;
  bridge?: KinActivityBridge;
  surface: RefObject<HTMLElement | null>;
  visible?: boolean;
  openAiModels?: () => void;
  openConversation?: (sessionId: string) => void;
}) {
  const { at, recent } = sample;
  const deadlines = visible ? recent.map(workingDeadline) : [];
  const workingNow = useWorkingClock(deadlines, at);
  const { view, summarize, reopen, cancel, isCancelling } = useSummary(bridge);
  const { selected, close, toggle } = useSelection(
    recent,
    cancel,
    surface,
    visible
  );
  const preview = useCapturedPreview(bridge, visible ? selected : undefined);
  const selectedView =
    view?.request.sessionId === selected?.sessionId ? view : null;
  const staleProjectView =
    selectedView?.request.action === "project" &&
    selectedView.request.projectId !== selected?.projectId;
  const latest = useLatestSummary(
    bridge,
    visible ? selected?.sessionId : undefined,
    selected?.projectId ?? null,
    staleProjectView ? undefined : selectedView?.result
  );
  useLayoutEffect(() => {
    if (staleProjectView) void cancel(true);
  }, [cancel, staleProjectView]);
  useEffect(() => {
    if (!selected || !visible) return;
    const node = surface.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    node?.addEventListener("keydown", onKeyDown);
    return () => node?.removeEventListener("keydown", onKeyDown);
  }, [close, selected, surface, visible]);
  const panel =
    visible && selected ? (
      <FloatingKinPanel
        conversation={selected}
        preview={preview}
        isCancelling={isCancelling}
        view={staleProjectView ? null : selectedView}
        age={captureAge(captureSeconds(selected.lastActivityAt, at))}
        close={close}
        summarize={() =>
          void summarize({
            sessionId: selected.sessionId,
            action: "conversation"
          })
        }
        cancel={() => void cancel()}
        openAiModels={openAiModels}
        openConversation={
          openConversation
            ? () => openConversation(selected.sessionId)
            : undefined
        }
        openLastSummary={
          latest
            ? () =>
                void reopen(
                  {
                    sessionId: selected.sessionId,
                    projectId: selected.projectId
                  },
                  latest
                )
            : undefined
        }
      />
    ) : null;
  return {
    panel,
    selected: visible ? selected : undefined,
    close,
    toggle,
    isWorking: (conversation: Conversation) =>
      workingDeadline(conversation) > workingNow
  };
}

export function KinActivityContent({
  sample,
  bridge,
  surface,
  visible = true,
  showStatus = false,
  openAiModels,
  openConversation
}: {
  sample: ReturnType<typeof useKinActivity>;
  bridge?: KinActivityBridge;
  surface: RefObject<HTMLElement | null>;
  visible?: boolean;
  showStatus?: boolean;
  openAiModels?: () => void;
  openConversation?: (sessionId: string) => void;
}) {
  const { activity, at, conversations, overflow } = sample;
  const { panel, selected, toggle, isWorking } = useKinSummaryPanel({
    sample,
    bridge,
    surface,
    visible,
    openAiModels,
    openConversation
  });
  return (
    <>
      {panel}
      {conversations.length > 0 || overflow > 0 ? (
        <div
          className="fk-dock"
          role="group"
          aria-label="Recently captured Conversations"
        >
          {conversations.map((conversation, index) => (
            <CaptureChip
              key={conversation.sessionId}
              conversation={conversation}
              now={at}
              working={isWorking(conversation)}
              index={index}
              expanded={selected?.sessionId === conversation.sessionId}
              toggle={(button) => toggle(conversation.sessionId, button)}
            />
          ))}
          {overflow ? (
            <span
              className="fk-overflow"
              aria-label={`${overflow} more Conversations`}
            >
              +{overflow}
            </span>
          ) : null}
        </div>
      ) : null}
      {/* A pending read is not a runtime state; showing it flashes a pill. */}
      {showStatus && !sample.pending && activity.state !== "running" && (
        <ActivityPill state={activity.state} />
      )}
    </>
  );
}

// Slide in only once the window can paint and the content has its size, so the
// entrance animates and the window does not resize mid-slide.
const entranceFallbackMs = 400;

function useEntrance(visible: boolean, ready: boolean, animate: boolean) {
  const [shown, setShown] = useState(visible && !animate);
  useEffect(() => {
    if (!visible) {
      setShown(false);
      return;
    }
    if (!animate) {
      setShown(true);
      return;
    }
    let frame = 0;
    // Two frames: one to paint the hidden start, one to change from it.
    const enter = () => {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => setShown(true));
      });
    };
    const timer = ready
      ? undefined
      : window.setTimeout(enter, entranceFallbackMs);
    if (ready) enter();
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [animate, ready, visible]);
  return visible && shown;
}

function OverlayKinContent({
  bridge,
  surface,
  focused,
  onOpenDesktop,
  openAiModels,
  openConversation,
  onReady
}: {
  bridge?: KinActivityBridge;
  surface: RefObject<HTMLElement | null>;
  focused: boolean;
  onOpenDesktop?: () => void;
  openAiModels?: () => void;
  openConversation?: (sessionId: string) => void;
  // Called once the first activity read has settled the content's size.
  onReady?: () => void;
}) {
  const sample = useKinActivity(bridge, "desktop");
  useEffect(() => {
    if (!sample.pending) onReady?.();
  }, [onReady, sample.pending]);
  return (
    <>
      <KinActivityContent
        sample={sample}
        bridge={bridge}
        surface={surface}
        showStatus
        openAiModels={openAiModels}
        openConversation={openConversation}
      />
      <StandaloneKin
        active={focused || sample.recentCapture}
        wakeOnAppear
        onOpenDesktop={onOpenDesktop}
      />
    </>
  );
}

function useExitCompletion(
  bridge: FloatingKinBridge | undefined,
  surface: RefObject<HTMLElement | null>,
  revision: number | undefined
) {
  useLayoutEffect(() => {
    const element = surface.current;
    if (!bridge || !element || revision === undefined) return;
    // Resolve the committed visibility style before inspecting its transitions.
    void window.getComputedStyle(element).opacity;
    const transitions =
      element
        .getAnimations?.()
        .filter(
          (animation) =>
            "transitionProperty" in animation &&
            (animation.transitionProperty === "opacity" ||
              animation.transitionProperty === "transform")
        ) ?? [];
    let current = true;
    void Promise.all(transitions.map((animation) => animation.finished)).then(
      () => {
        if (current) bridge.completeExit(revision);
      },
      () => undefined // A cancelled transition is not a completed exit.
    );
    return () => {
      current = false;
    };
  }, [bridge, surface, revision]);
}

export function FloatingKin({ bridge }: { bridge?: FloatingKinBridge }) {
  const [presentation, setPresentation] = useState<
    import("../../ipc/floating-kin-protocol.js").KinPresentation | null
  >(null);
  useEffect(() => bridge?.onPresentation?.(setPresentation), [bridge]);
  const visible =
    !bridge?.onPresentation || presentation?.placement === "desktop";
  const revision = presentation?.revision;
  const [readyRevision, setReadyRevision] = useState<number>();
  const markReady = useCallback(() => setReadyRevision(revision), [revision]);
  const shown = useEntrance(
    visible,
    readyRevision === revision,
    Boolean(bridge?.onPresentation)
  );
  const activityBridge = useKinSurfaceActivity(bridge, revision);
  const mainWindowFocused = useMainWindowFocus(bridge);
  const { surface, setInteractive } = useOverlayWindow(bridge, visible);
  useExitCompletion(
    bridge,
    surface,
    presentation?.sidebarPending ? presentation.revision : undefined
  );
  const { dragging, handlers } = useKinInteraction(
    visible ? bridge : undefined,
    surface,
    setInteractive
  );
  return (
    <main
      className="fk-surface"
      aria-label="Floating Kin"
      tabIndex={-1}
      ref={surface}
      {...handlers}
      data-fk-placement="desktop"
      data-visible={shown}
      data-dragging={dragging}
      inert={!visible}
    >
      {visible ? (
        <OverlayKinContent
          key={presentation?.revision}
          bridge={activityBridge}
          surface={surface}
          focused={mainWindowFocused}
          onReady={markReady}
          openAiModels={
            bridge && revision !== undefined
              ? () => bridge.openAiModels(revision)
              : undefined
          }
          openConversation={
            bridge && revision !== undefined
              ? (sessionId) => bridge.openConversation(revision, sessionId)
              : undefined
          }
          onOpenDesktop={
            bridge && revision !== undefined
              ? () => bridge.openDesktop(revision)
              : undefined
          }
        />
      ) : (
        // Leaving, it stays awake through the fade instead of dozing off.
        <StandaloneKin active />
      )}
    </main>
  );
}
