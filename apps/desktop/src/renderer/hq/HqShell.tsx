import { Button, Resizable, ResizableHandle, ResizablePanel } from "@koed/ui";
import { ArrowLeft, PanelRight, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
  type KeyboardEvent,
  type ReactNode
} from "react";

import type { DesktopRoute } from "../navigation.js";
import { HqLayoutPreferencesStore } from "../state/hq-layout-preferences.js";
import "./hq-shell.css";

const NARROW_VIEWPORT_QUERY = "(max-width: 760px)";
const MIN_MAIN_WIDTH = 240;
const MIN_SIDEBAR_WIDTH = 200;
const MIN_RIGHT_WIDTH = 300;
const RESIZE_HANDLE_WIDTH = 1;

type Viewport = { narrow: boolean; width: number };

const readViewport = (): Viewport => ({
  narrow:
    window.matchMedia?.(NARROW_VIEWPORT_QUERY).matches ??
    window.innerWidth <= 760,
  width: window.innerWidth
});

const useViewport = (): Viewport => {
  const [viewport, setViewport] = useState(readViewport);

  useEffect(() => {
    const media = window.matchMedia?.(NARROW_VIEWPORT_QUERY);
    const update = () => setViewport(readViewport());
    update();
    window.addEventListener("resize", update);
    media?.addEventListener("change", update);
    return () => {
      window.removeEventListener("resize", update);
      media?.removeEventListener("change", update);
    };
  }, []);

  return viewport;
};

const defaultRightWidth = (viewportWidth: number): number =>
  Math.round(Math.min(440, Math.max(340, viewportWidth * 0.31)));

const maxRightWidth = (viewportWidth: number, sidebarWidth: number): number =>
  Math.max(
    MIN_RIGHT_WIDTH,
    Math.min(
      16_384,
      Math.floor(viewportWidth * 0.55),
      viewportWidth - sidebarWidth - MIN_MAIN_WIDTH - RESIZE_HANDLE_WIDTH * 2
    )
  );

const focusableElements = (container: HTMLElement): HTMLElement[] =>
  Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => element.getAttribute("aria-hidden") !== "true");

function ContextPanel({
  dialog = false,
  onClose,
  closeRef,
  dialogRef
}: {
  dialog?: boolean;
  onClose?: () => void;
  closeRef?: Ref<HTMLButtonElement>;
  dialogRef?: Ref<HTMLElement>;
}) {
  return (
    <section
      aria-label="Project context"
      className={dialog ? "hq-context hq-context--dialog" : "hq-context"}
      data-hq-context=""
      id={dialog ? "hq-context-dialog" : "hq-context-panel"}
      role={dialog ? "dialog" : "complementary"}
      aria-modal={dialog ? true : undefined}
      aria-labelledby={dialog ? "hq-context-dialog-title" : undefined}
      ref={dialogRef}
      tabIndex={dialog ? -1 : undefined}
    >
      <div className="hq-context__header">
        {dialog ? (
          <Button
            aria-label="Close project context"
            className="hq-icon-button"
            onClick={onClose}
            ref={closeRef}
            size="icon"
            variant="ghost"
          >
            <X aria-hidden="true" />
          </Button>
        ) : (
          <span aria-hidden="true" className="hq-context__eyebrow">
            CONTEXT
          </span>
        )}
        <h2
          className="hq-context__title"
          id={dialog ? "hq-context-dialog-title" : undefined}
        >
          Project context
        </h2>
        {!dialog ? (
          <PanelRight aria-hidden="true" className="hq-context__icon" />
        ) : null}
      </div>
      <div className="hq-context__body"></div>
    </section>
  );
}

export function HqShell({
  children,
  sidebar
}: {
  children?: ReactNode;
  onBack?: () => void;
  route?: DesktopRoute;
  sidebar?: ReactNode;
} = {}) {
  const storeRef = useRef<HqLayoutPreferencesStore | null>(null);
  if (!storeRef.current) storeRef.current = new HqLayoutPreferencesStore();
  const store = storeRef.current;
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.current,
    store.current
  );
  const viewport = useViewport();
  const { narrow } = viewport;
  const [mobileContextOpen, setMobileContextOpen] = useState(false);
  const contextOpenerRef = useRef<HTMLButtonElement>(null);
  const contextCloseRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const previousMobileContextOpen = useRef(false);
  const rightIsVisible = !snapshot.preferences.rightColumnHidden;

  useEffect(() => {
    void store.load();
    return () => store.dispose();
  }, [store]);

  const modalOpen = narrow && mobileContextOpen && rightIsVisible;

  useLayoutEffect(() => {
    if (modalOpen) {
      contextCloseRef.current?.focus();
    } else if (previousMobileContextOpen.current) {
      contextOpenerRef.current?.focus();
    }
    previousMobileContextOpen.current = modalOpen;
  }, [modalOpen]);

  const desktopRightIsVisible = rightIsVisible && !narrow;
  const sidebarMax = Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(
      440,
      viewport.width -
        MIN_MAIN_WIDTH -
        RESIZE_HANDLE_WIDTH -
        (desktopRightIsVisible ? MIN_RIGHT_WIDTH + RESIZE_HANDLE_WIDTH : 0)
    )
  );
  const sidebarWidth = Math.min(snapshot.preferences.sidebarWidth, sidebarMax);
  const rightWidth = Math.min(
    maxRightWidth(viewport.width, sidebarWidth),
    snapshot.preferences.rightColumnWidth ?? defaultRightWidth(viewport.width)
  );
  const rightMax = maxRightWidth(viewport.width, sidebarWidth);

  const showContext = useCallback(() => {
    store.setRightColumnHidden(false);
    if (narrow) setMobileContextOpen(true);
    void store.flush();
  }, [narrow, store]);

  const closeMobileContext = useCallback(() => {
    setMobileContextOpen(false);
    store.setRightColumnHidden(true);
    void store.flush();
  }, [store]);

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMobileContext();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;

    const focusable = focusableElements(dialogRef.current);
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return (
    <div className="hq-shell" data-hq-shell="">
      <div className="hq-shell__layout" inert={modalOpen}>
        <Resizable
          aria-label="HQ layout"
          className="hq-shell__columns"
          data-hq-layout=""
          max={sidebarMax}
          min={200}
          onDoubleClick={() => void store.flush()}
          onKeyUpCapture={() => void store.flush()}
          onSizeChange={(size) => store.setSidebarWidth(Math.round(size))}
          onPointerUpCapture={() => void store.flush()}
          onPointerCancelCapture={() => void store.flush()}
          role="group"
          size={sidebarWidth}
        >
          <ResizablePanel className="hq-sidebar" primary>
            {sidebar ?? (
              <aside
                aria-label="Project navigation"
                className="hq-sidebar__inner"
                id="hq-project-navigation"
              >
                <header className="hq-sidebar__brand">
                  <span className="hq-brand-name">Koed</span>
                  <span className="hq-brand-section">HQ</span>
                </header>
                <nav
                  aria-label="Project navigation"
                  className="hq-sidebar__nav"
                >
                  <div className="hq-sidebar__section-heading">
                    <span>PROJECTS</span>
                    <button
                      aria-label="Narrow project navigation"
                      className="hq-icon-button hq-sidebar__collapse"
                      onClick={() => {
                        store.setSidebarWidth(200);
                        void store.flush();
                      }}
                      title="Narrow project navigation"
                      type="button"
                    >
                      <ArrowLeft aria-hidden="true" />
                    </button>
                  </div>
                </nav>
              </aside>
            )}
          </ResizablePanel>
          <ResizableHandle
            aria-label="Resize project navigation"
            className="hq-resize-handle"
            data-hq-sidebar-handle=""
            onDoubleClick={() => store.setSidebarWidth(268)}
          />
          <ResizablePanel className="hq-shell__workspace">
            <Resizable
              className="hq-shell__workspace-columns"
              data-hq-workspace-layout=""
              max={rightMax}
              min={300}
              onSizeChange={(size) =>
                store.setRightColumnWidth(Math.round(size))
              }
              reverse
              size={rightWidth}
            >
              <ResizablePanel className="hq-main-panel">
                <main aria-label="HQ workspace" className="hq-main">
                  <header className="hq-main__header">
                    <div className="hq-main__heading">
                      <h1>HQ</h1>
                    </div>
                    <div className="hq-main__actions">
                      <Button
                        aria-controls={
                          narrow
                            ? modalOpen
                              ? "hq-context-dialog"
                              : undefined
                            : rightIsVisible
                              ? "hq-context-panel"
                              : undefined
                        }
                        aria-expanded={narrow ? modalOpen : rightIsVisible}
                        aria-label={
                          (narrow ? modalOpen : rightIsVisible)
                            ? "Hide project context"
                            : "Show project context"
                        }
                        className="hq-icon-button"
                        onClick={() => {
                          if (narrow) {
                            if (modalOpen) closeMobileContext();
                            else showContext();
                          } else if (rightIsVisible) {
                            store.setRightColumnHidden(true);
                            void store.flush();
                          } else {
                            showContext();
                          }
                        }}
                        ref={contextOpenerRef}
                        title={
                          (narrow ? modalOpen : rightIsVisible)
                            ? "Hide context"
                            : "Show context"
                        }
                        type="button"
                      >
                        <PanelRight aria-hidden="true" />
                      </Button>
                    </div>
                  </header>
                  <div className="hq-main__content">
                    {snapshot.error ? (
                      <p className="hq-layout-error" role="status">
                        Layout preferences are unavailable. Changes may reset
                        when you reopen Koed.
                      </p>
                    ) : null}
                    {children}
                  </div>
                </main>
              </ResizablePanel>
              {rightIsVisible && !narrow ? (
                <>
                  <ResizableHandle
                    aria-label="Resize project context"
                    className="hq-resize-handle"
                    data-hq-context-handle=""
                    onDoubleClick={() => store.setRightColumnWidth(null)}
                  />
                  <ResizablePanel className="hq-context-panel" primary>
                    <ContextPanel />
                  </ResizablePanel>
                </>
              ) : null}
            </Resizable>
          </ResizablePanel>
        </Resizable>
      </div>
      {modalOpen ? (
        <div
          className="hq-mobile-context-backdrop"
          data-hq-mobile-context=""
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeMobileContext();
          }}
        >
          <div
            className="hq-mobile-context-dialog"
            onKeyDown={handleDialogKeyDown}
          >
            <ContextPanel
              closeRef={contextCloseRef}
              dialog
              dialogRef={dialogRef}
              onClose={closeMobileContext}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
