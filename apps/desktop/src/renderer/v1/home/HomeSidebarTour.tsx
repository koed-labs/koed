import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import { Button, Popover } from "@koed-labs/ui";
import "./home-sidebar-tour.css";

export type HomeSidebarTourStep = 1 | 2 | 3;

export type HomeSidebarTourState = {
  step: HomeSidebarTourStep;
  projectId?: string;
  onStep: (step: HomeSidebarTourStep) => void;
  onDismiss: () => Promise<void>;
};

const steps = {
  1: {
    title: "Find your conversations",
    text: "Find your Codex, Claude Code, and Pi conversations under Anchors, grouped by Git repository or folder. If Koed couldn’t identify either, look under No anchor."
  },
  2: {
    title: "Create a Project",
    text: "Select + next to Projects to create a Project for related conversations."
  },
  3: {
    title: "Add a conversation to a Project",
    text: "Drag a conversation from Anchors onto a Project. It stays under its original Anchor and also appears in the Project."
  }
};

export function HomeSidebarTour({
  tour,
  anchor,
  focusFallback,
  sidebarVisible,
  sidebarWidth,
  inline,
  hasConversations,
  hasProject,
  canCreate
}: {
  tour: HomeSidebarTourState;
  anchor: HTMLElement;
  focusFallback: HTMLElement | null;
  sidebarVisible: boolean;
  sidebarWidth: number;
  inline: boolean;
  hasConversations: boolean;
  hasProject: boolean;
  canCreate: boolean;
}) {
  const { step, onStep, onDismiss } = tour;
  const { title, text } = steps[step];
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusStep = useRef(false);
  const saving = useRef(false);
  const [dismissing, setDismissing] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const positionAnchor = useMemo(() => {
    const sidebar = sidebarVisible
      ? anchor.closest(".v1-navigation-sidebar")
      : null;
    if (!sidebar || inline) return anchor;
    // Keep the card clear of both scroll areas and the resize handle.
    return {
      contextElement: anchor,
      getBoundingClientRect: () => {
        const target = anchor.getBoundingClientRect();
        return new DOMRect(
          sidebar.getBoundingClientRect().left + sidebarWidth,
          target.top,
          0,
          target.height
        );
      }
    };
  }, [anchor, inline, sidebarVisible, sidebarWidth]);

  useEffect(() => {
    if (!focusStep.current) return;
    focusStep.current = false;
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  const go = (next: HomeSidebarTourStep) => {
    focusStep.current = true;
    onStep(next);
  };
  const dismiss = async () => {
    if (saving.current) return;
    saving.current = true;
    setDismissing(true);
    setSaveError(false);
    try {
      await onDismiss();
      if (
        panelRef.current?.contains(document.activeElement) ||
        document.activeElement === document.body
      )
        (anchor.isConnected ? anchor : focusFallback)?.focus({
          preventScroll: true
        });
    } catch {
      setSaveError(true);
      setDismissing(false);
    } finally {
      saving.current = false;
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    void dismiss();
  };

  const card = (
    <>
      <div aria-live="polite">
        <p className="v1-home-tour-progress">Step {step} of 3</p>
        <h2 ref={headingRef} tabIndex={-1}>
          {title}
        </h2>
        <p>{text}</p>
        {!sidebarVisible && <p>Open navigation to try this in the sidebar.</p>}
        {step === 1 && !hasConversations && (
          <p>Anchors appear after you import or capture conversations.</p>
        )}
        {step === 2 && !canCreate && (
          <p>Project creation is available when Koed’s services are ready.</p>
        )}
        {step === 3 &&
          (hasProject && hasConversations ? (
            <p>
              You can also choose Project memberships from a conversation’s
              actions menu.
            </p>
          ) : (
            <p>
              You’ll need a captured conversation and a Project to try this.
            </p>
          ))}
      </div>
      {saveError && <p role="alert">Couldn’t save your choice. Try again.</p>}
      <div className="v1-home-tour-actions">
        <Button
          size="xs"
          variant="ghost"
          disabled={dismissing}
          onClick={() => void dismiss()}
        >
          Skip tour
        </Button>
        <div>
          {step > 1 && (
            <Button
              size="xs"
              variant="ghost"
              disabled={dismissing}
              onClick={() => go(step === 3 ? 2 : 1)}
            >
              Back
            </Button>
          )}
          <Button
            size="xs"
            disabled={dismissing}
            onClick={() => {
              if (step === 3) void dismiss();
              else go(step === 1 ? 2 : 3);
            }}
          >
            {step === 3 ? "Done" : "Next"}
          </Button>
        </div>
      </div>
    </>
  );
  if (inline)
    return (
      <div
        aria-label="Sidebar tour"
        className="v1-home-tour v1-home-tour-inline"
        data-home-tour={step}
        onKeyDown={onKeyDown}
        ref={panelRef}
        role="region"
      >
        {card}
      </div>
    );
  return (
    <Popover.Root
      open
      modal={false}
      onOpenChange={(_, event) => {
        event.cancel();
        event.allowPropagation();
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          className="v1-home-tour-positioner"
          anchor={positionAnchor}
          positionMethod="fixed"
          side={sidebarVisible ? "right" : "bottom"}
          align={sidebarVisible ? "center" : "start"}
          sideOffset={sidebarVisible ? 20 : 12}
          collisionPadding={12}
          collisionAvoidance={{
            side: "none",
            align: "shift",
            fallbackAxisSide: "none"
          }}
          sticky
        >
          <Popover.Popup
            data-home-tour={step}
            aria-label="Sidebar tour"
            className="v1-app v1-home-tour"
            ref={panelRef}
            initialFocus={false}
            finalFocus={false}
            onKeyDown={onKeyDown}
          >
            <Popover.Arrow className="v1-home-tour-arrow" />
            {card}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
