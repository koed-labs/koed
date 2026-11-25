import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import type {
  DesktopKinBridge,
  KinPresentation
} from "../../ipc/floating-kin-protocol.js";
import type { SidebarLive } from "../v1/ProjectSidebar.js";
import type { SidebarConversation } from "../v1/project-sidebar-model.js";
import {
  KinConversationChips,
  RailKin,
  KinLiveStatus,
  kinConversationStatus,
  useKinActivity,
  useKinSummaryPanel
} from "./FloatingKin.js";
import { clientNames } from "./FloatingKinPanel.js";
import { useKinSurfaceActivity } from "./use-floating-kin.js";

type FocusFallback = () => void;
type Anchor = {
  top: number;
  left: number;
  pointer: number;
  // The modal sidebar the trigger sits in, if any. The panel must render
  // inside it, or the modal treats clicks on the panel as outside clicks.
  modal: HTMLElement | null;
};

const panelGap = 8;

// Beside the chip or row that opened the panel.
function anchorFor(trigger: HTMLElement): Anchor {
  const row = trigger.closest("li") ?? trigger;
  const edge =
    trigger.closest('[data-slot="sidebar-container"]')?.getBoundingClientRect()
      .right ?? row.getBoundingClientRect().right;
  const box = trigger.getBoundingClientRect();
  const top = Math.max(panelGap, row.getBoundingClientRect().top - panelGap);
  return {
    top,
    left: edge + panelGap,
    // Points back at the trigger's vertical centre.
    pointer: box.top + box.height / 2 - top,
    modal: trigger.closest<HTMLElement>('[data-mobile="true"]')
  };
}

/** The panel's top edge, moved up as needed to keep it inside the window. */
export function fitPanelTop(
  anchorTop: number,
  height: number,
  viewport: number
) {
  return Math.max(panelGap, Math.min(anchorTop, viewport - height - panelGap));
}

function AnchoredPanel({
  panel,
  anchor,
  surface,
  focusFallback
}: {
  panel: React.ReactNode;
  anchor: Anchor;
  surface: RefObject<HTMLElement | null>;
  focusFallback: FocusFallback;
}) {
  useLayoutEffect(
    () => () => {
      if (surface.current?.contains(document.activeElement)) focusFallback();
    },
    [focusFallback, surface]
  );
  // Keep the whole panel inside the window: a row near the bottom shifts the
  // panel up (and its pointer down) rather than pushing actions off screen.
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const node = surface.current;
    if (!node) return;
    const measure = () => setHeight(node.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [surface]);
  const top = fitPanelTop(anchor.top, height, window.innerHeight);
  // Inside the modal sidebar, fixed positioning is relative to its popup
  // (it is transformed), so convert from window coordinates.
  const origin = anchor.modal?.getBoundingClientRect() ?? { top: 0, left: 0 };
  return createPortal(
    <section
      className="fk-surface"
      data-fk-placement="anchored"
      aria-label="Chief of Staff activity"
      ref={surface}
      tabIndex={-1}
      style={
        {
          top: top - origin.top,
          left: anchor.left - origin.left,
          "--fk-pointer-top": `${anchor.pointer + anchor.top - top}px`
        } as React.CSSProperties
      }
    >
      {panel}
    </section>,
    anchor.modal ?? document.body
  );
}

function DismissHiddenPanel({ dismiss }: { dismiss: () => void }) {
  useLayoutEffect(dismiss, [dismiss]);
  return null;
}

export function useDesktopKin(
  bridge: DesktopKinBridge | undefined,
  scopeKey: string | null = null,
  shellVisible = true,
  openAiModels?: () => void,
  // Opens a captured Conversation by its session id; false when Desktop
  // has no row for it.
  openConversation?: (sessionId: string) => boolean,
  // Lets an overlay request made while Desktop loads wait for its row. Any
  // change of `route` (the User choosing somewhere else) cancels it, and so
  // does `rowsLoaded` turning true without a row for it.
  navigation?: { route: unknown; rowsLoaded: boolean }
) {
  const [presentation, setPresentation] = useState<KinPresentation | null>(
    null
  );
  useLayoutEffect(() => bridge?.onPresentation(setPresentation), [bridge]);
  useLayoutEffect(() => {
    if (openAiModels) return bridge?.onOpenAiModels(openAiModels);
  }, [bridge, openAiModels]);
  // A request from the overlay can arrive while Desktop is still loading its
  // rows. Hold it, and retry whenever the rows change, until it opens, the
  // rows finish loading without it, or the User goes somewhere else.
  const pendingOpen = useRef<{ sessionId: string; route: unknown } | null>(
    null
  );
  const route = navigation?.route;
  const rowsLoaded = navigation?.rowsLoaded ?? true;
  const latestNavigation = useRef({ route, rowsLoaded });
  latestNavigation.current = { route, rowsLoaded };
  useLayoutEffect(() => {
    if (openConversation)
      return bridge?.onOpenConversation((sessionId) => {
        const current = latestNavigation.current;
        pendingOpen.current =
          openConversation(sessionId) || current.rowsLoaded
            ? null
            : { sessionId, route: current.route };
      });
  }, [bridge, openConversation]);
  useEffect(() => {
    const pending = pendingOpen.current;
    if (!pending || !openConversation) return;
    if (pending.route !== route) {
      pendingOpen.current = null;
      return;
    }
    if (openConversation(pending.sessionId) || rowsLoaded)
      pendingOpen.current = null;
  }, [openConversation, route, rowsLoaded]);
  useLayoutEffect(() => {
    bridge?.setShellVisible(shellVisible);
  }, [bridge, shellVisible]);
  const placement = presentation?.placement;
  useLayoutEffect(() => {
    if (placement === "desktop" && presentation)
      bridge?.confirmPresentation(presentation.revision);
  }, [bridge, placement, presentation]);
  const activityBridge = useKinSurfaceActivity(bridge, presentation?.revision);
  const inApp =
    shellVisible && placement === "sidebar" && !presentation?.sidebarPending;
  // Rail chips and row markers stay while the Kin floats; only the avatar and
  // the summary panel move with it.
  const sample = useKinActivity(
    activityBridge,
    "sidebar",
    shellVisible,
    scopeKey
  );
  const surface = useRef<HTMLElement>(null);
  const closePanel = useRef<() => void>(() => {});
  const openFromPanel = useCallback(
    (sessionId: string) => {
      if (openConversation?.(sessionId)) closePanel.current();
    },
    [openConversation]
  );
  const summary = useKinSummaryPanel({
    sample,
    bridge: activityBridge,
    surface,
    visible: inApp && Boolean(activityBridge),
    openAiModels,
    openConversation: openConversation ? openFromPanel : undefined
  });
  closePanel.current = summary.close;
  const [anchor, setAnchor] = useState<{
    trigger: HTMLElement;
    at: Anchor;
  } | null>(null);
  // Follow the row when the sidebar scrolls or the window resizes.
  useLayoutEffect(() => {
    if (!anchor || !summary.selected) return;
    const follow = () => {
      if (anchor.trigger.isConnected)
        setAnchor({ trigger: anchor.trigger, at: anchorFor(anchor.trigger) });
    };
    window.addEventListener("resize", follow);
    window.addEventListener("scroll", follow, true);
    return () => {
      window.removeEventListener("resize", follow);
      window.removeEventListener("scroll", follow, true);
    };
  }, [anchor, summary.selected]);
  const { toggle, close } = summary;
  // A click while the Kin is still moving back to the sidebar is queued and
  // replayed once the sidebar holds it, instead of being silently dropped.
  const queuedOpen = useRef<{
    sessionId: string;
    trigger: HTMLButtonElement;
  } | null>(null);
  const open = useCallback(
    (sessionId: string, trigger: HTMLButtonElement) => {
      if (!inApp) {
        queuedOpen.current = { sessionId, trigger };
        return;
      }
      queuedOpen.current = null;
      setAnchor({ trigger, at: anchorFor(trigger) });
      toggle(sessionId, trigger);
    },
    [inApp, toggle]
  );
  useEffect(() => {
    const queued = queuedOpen.current;
    if (!inApp || !queued) return;
    queuedOpen.current = null;
    if (queued.trigger.isConnected) open(queued.sessionId, queued.trigger);
  }, [inApp, open]);

  const avatar = inApp ? <RailKin active={sample.recentCapture} /> : null;
  const chips =
    shellVisible && activityBridge ? (
      <KinConversationChips sample={sample} {...summary} toggle={open} />
    ) : null;

  const tracked = new Map(
    sample.recent.map((conversation) => [conversation.sessionId, conversation])
  );
  const live: SidebarLive | undefined =
    shellVisible && activityBridge
      ? {
          marker: (row: SidebarConversation) => {
            // A row can combine several sessions; any of them may be the
            // live one. Show the most recently active.
            const conversation = [
              row.sessionId,
              ...(row.sourceSessionIds ?? [])
            ]
              .map((id) => (id ? tracked.get(id) : undefined))
              .reduce<(typeof sample.recent)[number] | undefined>(
                (latest, candidate) =>
                  candidate &&
                  (!latest ||
                    Date.parse(candidate.lastActivityAt) >
                      Date.parse(latest.lastActivityAt))
                    ? candidate
                    : latest,
                undefined
              );
            if (!conversation) return null;
            const { age, seconds } = kinConversationStatus(
              conversation,
              sample.at
            );
            const isWorking = summary.isWorking(conversation);
            const expanded =
              summary.selected?.sessionId === conversation.sessionId;
            return (
              <button
                type="button"
                className="fk-row-live"
                data-working={isWorking || undefined}
                aria-expanded={expanded}
                aria-controls={expanded ? "floating-kin-summary" : undefined}
                aria-label={`Chief of Staff summary for ${row.title}. ${clientNames[conversation.client]}. ${isWorking ? "Working. " : ""}Captured ${age} ago.`}
                onClick={(event) =>
                  open(conversation.sessionId, event.currentTarget)
                }
                onKeyDown={(event) => {
                  if (event.key === "Escape" && expanded) {
                    event.preventDefault();
                    close();
                  }
                }}
              >
                <KinLiveStatus
                  working={isWorking}
                  seconds={seconds}
                  lastActivityAt={conversation.lastActivityAt}
                />
              </button>
            );
          }
        }
      : undefined;

  const panel = (focusFallback: FocusFallback, projectsVisible: boolean) => {
    if (!summary.panel || !anchor) return null;
    if (!projectsVisible && !anchor.trigger.closest(".v1-nav-rail"))
      return <DismissHiddenPanel dismiss={summary.dismiss} />;
    return (
      <AnchoredPanel
        key={JSON.stringify([placement, presentation?.revision, scopeKey])}
        panel={summary.panel}
        anchor={anchor.at}
        surface={surface}
        focusFallback={focusFallback}
      />
    );
  };

  return { avatar, chips, live, panel };
}
