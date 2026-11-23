import {
  memo,
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
  onOpenDesktop
}: {
  active: boolean;
  placement?: "desktop" | "sidebar";
  size?: number;
  onOpenDesktop?: () => void;
}) {
  const Avatar = onOpenDesktop ? "button" : "div";
  const wakeTimer = useRef<number | undefined>(undefined);
  const [recentHover, setRecentHover] = useState(false);
  const awake = active || recentHover;
  const wake = () => {
    window.clearTimeout(wakeTimer.current);
    setRecentHover(true);
    wakeTimer.current = window.setTimeout(() => setRecentHover(false), 60_000);
  };
  useEffect(() => () => window.clearTimeout(wakeTimer.current), []);
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
  const { activity, at } = useActivity(bridge, visible, scopeKey);
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
  return { activity, at, recent, recentCapture, conversations, overflow };
}

export function KinActivityContent({
  sample,
  bridge,
  surface,
  visible = true,
  showStatus = false,
  openAiModels
}: {
  sample: ReturnType<typeof useKinActivity>;
  bridge?: KinActivityBridge;
  surface: RefObject<HTMLElement | null>;
  visible?: boolean;
  showStatus?: boolean;
  openAiModels?: () => void;
}) {
  const { activity, at, recent, conversations, overflow } = sample;
  const deadlines = visible ? conversations.map(workingDeadline) : [];
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
  return (
    <>
      {visible && selected ? (
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
      ) : null}
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
              working={(deadlines[index] ?? 0) > workingNow}
              index={index}
              expanded={
                visible && selected?.sessionId === conversation.sessionId
              }
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
      {showStatus && activity.state !== "running" && (
        <ActivityPill state={activity.state} />
      )}
    </>
  );
}

function OverlayKinContent({
  bridge,
  surface,
  focused,
  onOpenDesktop,
  openAiModels
}: {
  bridge?: KinActivityBridge;
  surface: RefObject<HTMLElement | null>;
  focused: boolean;
  onOpenDesktop?: () => void;
  openAiModels?: () => void;
}) {
  const sample = useKinActivity(bridge, "desktop");
  return (
    <>
      <KinActivityContent
        sample={sample}
        bridge={bridge}
        surface={surface}
        showStatus
        openAiModels={openAiModels}
      />
      <StandaloneKin
        active={focused || sample.recentCapture}
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
      data-visible={visible}
      data-dragging={dragging}
      inert={!visible}
    >
      {visible ? (
        <OverlayKinContent
          key={presentation?.revision}
          bridge={activityBridge}
          surface={surface}
          focused={mainWindowFocused}
          openAiModels={
            bridge && revision !== undefined
              ? () => bridge.openAiModels(revision)
              : undefined
          }
          onOpenDesktop={
            bridge && revision !== undefined
              ? () => bridge.openDesktop(revision)
              : undefined
          }
        />
      ) : (
        <StandaloneKin active={false} />
      )}
    </main>
  );
}
