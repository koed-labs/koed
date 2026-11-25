import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject
} from "react";
import type { FloatingKinBridge } from "../../ipc/floating-kin-protocol.js";
import { Pixelkin } from "../v1/pixelkin/Pixelkin.js";
import {
  DEFAULT_AGENT_LOOK,
  projectKinLook,
  type AgentLook
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
  useMainWindowFocus,
  useOverlayWindow,
  useSummary
} from "./use-floating-kin.js";
import { useKinInteraction } from "./use-kin-interaction.js";
import "./floating-kin.css";

export type { FloatingKinBridge } from "../../ipc/floating-kin-protocol.js";

const chipLimit = 3;
const recentSeconds = 60;
const floatingKinLook: AgentLook = {
  ...DEFAULT_AGENT_LOOK,
  body: {
    ...DEFAULT_AGENT_LOOK.body,
    shape: "roundedBox",
    width: 2,
    height: 2,
    depth: 0.9,
    arms: true
  },
  face: { ...DEFAULT_AGENT_LOOK.face, personality: "joyful" },
  palette: { base: "#3083ff", grayscale: false, gradient: true }
};
const floatingKinGradientTop = "#e8d31a";
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
  expanded,
  toggle
}: {
  conversation: Conversation;
  index: number;
  now: number;
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
      data-fk-hit
      aria-expanded={expanded}
      aria-controls={expanded ? "floating-kin-summary" : undefined}
      aria-label={`${clientNames[conversation.client]} Conversation ${index + 1}. Captured ${age} ago.`}
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
      <time dateTime={conversation.lastActivityAt} aria-hidden="true">
        {age}
      </time>
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

function StandaloneKin({
  hasChips,
  active
}: {
  hasChips: boolean;
  active: boolean;
}) {
  const avatar = useRef<HTMLDivElement>(null);
  const wakeTimer = useRef<number | undefined>(undefined);
  const [recentHover, setRecentHover] = useState(false);
  const awake = active || recentHover;
  const wake = () => {
    window.clearTimeout(wakeTimer.current);
    setRecentHover(true);
    wakeTimer.current = window.setTimeout(() => setRecentHover(false), 60_000);
  };
  useEffect(() => () => window.clearTimeout(wakeTimer.current), []);
  useEffect(() => {
    const element = avatar.current;
    if (!hasChips || !element || document.activeElement !== element) return;
    element
      .closest("main")
      ?.querySelector<HTMLButtonElement>(".fk-chip")
      ?.focus();
  }, [hasChips]);
  return (
    <div
      className="fk-kin-avatar"
      ref={avatar}
      data-fk-hit
      data-fk-handle
      role="img"
      aria-label="Floating Kin avatar"
      aria-description={awake ? "Awake" : "Sleeping"}
      tabIndex={hasChips ? -1 : 0}
      onMouseEnter={wake}
    >
      <Pixelkin
        look={floatingKinLook}
        gradientTop={floatingKinGradientTop}
        size={88}
        motion={awake ? "unfocused" : "still"}
        expression={awake ? "happy" : "sleepy"}
      />
      {!awake && (
        <span className="fk-sleep-mark" aria-hidden="true">
          z
        </span>
      )}
    </div>
  );
}

function useSelection(
  conversations: Conversation[],
  cancel: (dismiss: boolean) => Promise<void>,
  surface: RefObject<HTMLElement | null>
) {
  const [selection, setSelection] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = conversations.find(
    ({ sessionId }) => sessionId === selection
  );
  useEffect(() => {
    if (!selection || selected) return;
    setSelection(null);
    void cancel(true);
    (
      surface.current?.querySelector<HTMLButtonElement>(".fk-chip") ??
      surface.current
    )?.focus();
  }, [cancel, selected, selection, surface]);
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

export function FloatingKin({ bridge }: { bridge?: FloatingKinBridge }) {
  const { activity, at } = useActivity(bridge);
  const mainWindowFocused = useMainWindowFocus(bridge);
  const { view, summarize, cancel, isCancelling } = useSummary(bridge);
  const { surface, setInteractive } = useOverlayWindow(bridge);
  const { dragging, handlers } = useKinInteraction(
    bridge,
    surface,
    setInteractive
  );
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
  const { selected, close, toggle } = useSelection(recent, cancel, surface);
  const selectedView =
    view?.request.sessionId === selected?.sessionId ? view : null;
  const staleProjectView =
    selectedView?.request.action === "project" &&
    selectedView.request.projectId !== selected?.projectId;
  useLayoutEffect(() => {
    if (staleProjectView) void cancel(true);
  }, [cancel, staleProjectView]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && selected) {
      event.preventDefault();
      close();
    }
  };
  return (
    <main
      className="fk-surface"
      aria-label="Floating Kin"
      tabIndex={-1}
      ref={surface}
      {...handlers}
      data-dragging={dragging}
      onKeyDown={onKeyDown}
    >
      {selected ? (
        <FloatingKinPanel
          conversation={selected}
          isCancelling={isCancelling}
          view={staleProjectView ? null : selectedView}
          age={captureAge(captureSeconds(selected.lastActivityAt, at))}
          close={close}
          summarize={(action) => {
            const { sessionId, projectId } = selected;
            if (action === "conversation")
              void summarize({ sessionId, action });
            else if (projectId)
              void summarize({ sessionId, action, projectId });
          }}
          cancel={() => void cancel()}
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
      {activity.state !== "running" && <ActivityPill state={activity.state} />}
      <StandaloneKin
        hasChips={conversations.length > 0}
        active={mainWindowFocused || recentCapture}
      />
    </main>
  );
}
