import {
  useCallback,
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
  kinConversationStatus,
  useKinActivity,
  useKinSummaryPanel
} from "./FloatingKin.js";
import { clientNames } from "./FloatingKinPanel.js";
import { useKinSurfaceActivity } from "./use-floating-kin.js";

type FocusFallback = () => void;
type Anchor = { top: number; left: number; pointer: number };

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
    pointer: box.top + box.height / 2 - top
  };
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
  return createPortal(
    <section
      className="fk-surface"
      data-fk-placement="anchored"
      aria-label="Chief of Staff activity"
      ref={surface}
      tabIndex={-1}
      style={
        {
          top: anchor.top,
          left: anchor.left,
          "--fk-pointer-top": `${anchor.pointer}px`
        } as React.CSSProperties
      }
    >
      {panel}
    </section>,
    document.body
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
  openConversation?: (sessionId: string) => boolean
) {
  const [presentation, setPresentation] = useState<KinPresentation | null>(
    null
  );
  useLayoutEffect(() => bridge?.onPresentation(setPresentation), [bridge]);
  useLayoutEffect(() => {
    if (openAiModels) return bridge?.onOpenAiModels(openAiModels);
  }, [bridge, openAiModels]);
  useLayoutEffect(() => {
    if (openConversation)
      return bridge?.onOpenConversation((sessionId) => {
        openConversation(sessionId);
      });
  }, [bridge, openConversation]);
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
  const sample = useKinActivity(activityBridge, "sidebar", inApp, scopeKey);
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
  const open = useCallback(
    (sessionId: string, trigger: HTMLButtonElement) => {
      setAnchor({ trigger, at: anchorFor(trigger) });
      toggle(sessionId, trigger);
    },
    [toggle]
  );

  const avatar = inApp ? <RailKin active={sample.recentCapture} /> : null;
  const chips =
    inApp && activityBridge ? (
      <KinConversationChips sample={sample} {...summary} toggle={open} />
    ) : null;

  const tracked = new Map(
    sample.recent.map((conversation) => [conversation.sessionId, conversation])
  );
  const working = sample.recent.filter(summary.isWorking).length;
  // "Active" means the same as a row's green dot: captured within the minute.
  const active = sample.recent.filter(
    (conversation) =>
      summary.isWorking(conversation) ||
      kinConversationStatus(conversation, sample.at).recent
  ).length;
  const live: SidebarLive | undefined =
    inApp && activityBridge
      ? {
          marker: (row: SidebarConversation) => {
            const conversation = row.sessionId
              ? tracked.get(row.sessionId)
              : undefined;
            if (!conversation) return null;
            const { age, recent } = kinConversationStatus(
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
                data-recent={recent || isWorking}
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
                <span className="fk-row-dot" aria-hidden="true" />
                {isWorking ? (
                  "Working"
                ) : (
                  <time dateTime={conversation.lastActivityAt}>{age}</time>
                )}
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

  const activity =
    working || active ? (
      <span className="fk-live-status" role="status">
        {working ? `${working} working` : `${active} active`}
      </span>
    ) : null;
  return { avatar, chips, activity, live, panel };
}
