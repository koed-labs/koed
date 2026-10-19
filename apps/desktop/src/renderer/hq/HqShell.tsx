import { Button, Resizable, ResizableHandle, ResizablePanel } from "@koed/ui";
import { Menu, PanelLeft, PanelRight, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
  type KeyboardEvent,
  type ReactNode
} from "react";

import type { HqRoute } from "./hq-navigation.js";
import { HqLayoutPreferencesStore } from "../state/hq-layout-preferences.js";
import { HqControlTooltip } from "./HqControlTooltip.js";
import { HqBrand } from "./HqSidebar.js";
import "./hq-shell.css";

export type HqShellActions = {
  dismissOverlays: () => void;
  toggleSidebar: () => void;
  toggleContext: () => void;
};
export type HqSidebarLayout = { compact: boolean };

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
  ).filter((element) => {
    for (
      let ancestor: HTMLElement | null = element;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      if (
        ancestor.hidden ||
        ancestor.hasAttribute("inert") ||
        ancestor.getAttribute("aria-hidden") === "true"
      ) {
        return false;
      }
      const { display, visibility } = window.getComputedStyle(ancestor);
      if (display === "none" || visibility === "hidden") return false;
      if (ancestor === container) break;
    }
    return true;
  });

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
        ) : null}
        <h2
          className="hq-visually-hidden"
          id={dialog ? "hq-context-dialog-title" : undefined}
        >
          Project context
        </h2>
      </div>
      <div className="hq-context__body"></div>
    </section>
  );
}

export function HqShell({
  children,
  title = "HQ",
  sidebar,
  actionsRef,
  route,
  contextAvailable = true
}: {
  children?: ReactNode;
  title?: string;
  route?: HqRoute;
  sidebar?: ReactNode | ((layout: HqSidebarLayout) => ReactNode);
  actionsRef?: Ref<HqShellActions>;
  contextAvailable?: boolean;
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
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const contextOpenerRef = useRef<HTMLButtonElement>(null);
  const contextCloseRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const sidebarOpenerRef = useRef<HTMLButtonElement>(null);
  const sidebarCloseRef = useRef<HTMLButtonElement>(null);
  const sidebarDialogRef = useRef<HTMLDivElement>(null);
  const previousMobileContextOpen = useRef(false);
  const previousMobileSidebarOpen = useRef(false);
  const previousRoute = useRef(route ? JSON.stringify(route) : "");
  const rightIsVisible =
    contextAvailable && !snapshot.preferences.rightColumnHidden;

  useEffect(() => {
    void store.load();
    return () => store.dispose();
  }, [store]);

  const modalOpen = narrow && mobileContextOpen && rightIsVisible;
  const sidebarDialogOpen = narrow && mobileSidebarOpen;

  useLayoutEffect(() => {
    if (modalOpen) {
      contextCloseRef.current?.focus();
    } else if (previousMobileContextOpen.current && !sidebarDialogOpen) {
      contextOpenerRef.current?.focus();
    }
    previousMobileContextOpen.current = modalOpen;
  }, [modalOpen, sidebarDialogOpen]);

  useLayoutEffect(() => {
    if (sidebarDialogOpen) {
      sidebarCloseRef.current?.focus();
    } else if (previousMobileSidebarOpen.current && !modalOpen) {
      sidebarOpenerRef.current?.focus();
    }
    previousMobileSidebarOpen.current = sidebarDialogOpen;
  }, [sidebarDialogOpen, modalOpen]);

  useEffect(() => {
    const routeKey = route ? JSON.stringify(route) : "";
    if (previousRoute.current !== routeKey) {
      setMobileSidebarOpen(false);
      previousRoute.current = routeKey;
    }
  }, [route]);

  useEffect(() => {
    if (!narrow) setMobileSidebarOpen(false);
  }, [narrow]);

  useEffect(() => {
    if (!contextAvailable) setMobileContextOpen(false);
  }, [contextAvailable]);

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
  const compact = snapshot.preferences.sidebarCollapsed && !narrow;
  const sidebarWidth = compact
    ? 64
    : Math.min(snapshot.preferences.sidebarWidth, sidebarMax);
  const rightWidth = Math.min(
    maxRightWidth(viewport.width, sidebarWidth),
    snapshot.preferences.rightColumnWidth ?? defaultRightWidth(viewport.width)
  );
  const rightMax = maxRightWidth(viewport.width, sidebarWidth);

  const showContext = useCallback(() => {
    setMobileSidebarOpen(false);
    store.setRightColumnHidden(false);
    if (narrow) setMobileContextOpen(true);
    void store.flush();
  }, [narrow, store]);

  const closeMobileSidebar = useCallback(() => {
    setMobileSidebarOpen(false);
  }, []);

  const openMobileSidebar = useCallback(() => {
    setMobileContextOpen(false);
    setMobileSidebarOpen(true);
  }, []);

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

  const handleSidebarDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMobileSidebar();
      return;
    }
    if (event.key !== "Tab" || !sidebarDialogRef.current) return;

    const focusable = focusableElements(sidebarDialogRef.current);
    if (focusable.length === 0) {
      event.preventDefault();
      sidebarDialogRef.current.focus();
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

  const toggleSidebar = () => {
    if (narrow) {
      if (sidebarDialogOpen) closeMobileSidebar();
      else openMobileSidebar();
      return;
    }
    store.setSidebarCollapsed(!snapshot.preferences.sidebarCollapsed);
    void store.flush();
  };
  const toggleContext = () => {
    if (!contextAvailable) return;
    if (narrow) {
      if (modalOpen) closeMobileContext();
      else showContext();
    } else {
      store.setRightColumnHidden(rightIsVisible);
      void store.flush();
    }
  };
  useImperativeHandle(actionsRef, () => ({
    toggleSidebar,
    toggleContext,
    dismissOverlays: () => {
      setMobileSidebarOpen(false);
      setMobileContextOpen(false);
    }
  }));

  return (
    <div
      className="hq-shell"
      data-hq-shell=""
      data-hq-compact={compact || undefined}
    >
      <div
        className="hq-shell__layout"
        data-hq-mobile-sidebar-open={sidebarDialogOpen || undefined}
        inert={modalOpen}
      >
        <Resizable
          aria-label="HQ layout"
          className="hq-shell__columns"
          data-hq-layout=""
          max={compact ? 64 : sidebarMax}
          min={compact ? 64 : 200}
          onDoubleClick={() => void store.flush()}
          onKeyUpCapture={() => void store.flush()}
          onSizeChange={(size) => {
            if (!compact) store.setSidebarWidth(Math.round(size));
          }}
          onPointerUpCapture={() => void store.flush()}
          onPointerCancelCapture={() => void store.flush()}
          role="group"
          size={sidebarWidth}
        >
          <ResizablePanel
            aria-hidden={narrow && !sidebarDialogOpen ? true : undefined}
            className="hq-sidebar"
            data-hq-mobile-open={sidebarDialogOpen || undefined}
            inert={narrow && !sidebarDialogOpen}
            primary
          >
            <div
              aria-label="Project navigation"
              aria-modal={sidebarDialogOpen ? true : undefined}
              className="hq-sidebar__drawer"
              data-hq-sidebar-dialog=""
              id="hq-sidebar-dialog"
              onClickCapture={(event) => {
                const target = event.target;
                if (
                  target instanceof Element &&
                  (target.closest(
                    ".hq-sidebar__action, [data-hq-chat-row], .hq-account"
                  ) ||
                    target.closest(
                      '[data-hq-project-link]:not([aria-current="page"])'
                    ))
                ) {
                  closeMobileSidebar();
                }
              }}
              onKeyDown={handleSidebarDialogKeyDown}
              ref={sidebarDialogRef}
              role={sidebarDialogOpen ? "dialog" : undefined}
              tabIndex={-1}
            >
              {sidebarDialogOpen ? (
                <Button
                  aria-label="Close project navigation"
                  className="hq-icon-button hq-sidebar__drawer-close"
                  onClick={closeMobileSidebar}
                  ref={sidebarCloseRef}
                  size="icon"
                  variant="ghost"
                >
                  <X aria-hidden="true" />
                </Button>
              ) : null}
              {typeof sidebar === "function"
                ? sidebar({ compact })
                : (sidebar ?? (
                    <aside
                      aria-label="Project navigation"
                      className="hq-sidebar__inner"
                      id="hq-project-navigation"
                    >
                      <header className="hq-sidebar__brand">
                        <HqBrand />
                      </header>
                    </aside>
                  ))}
            </div>
          </ResizablePanel>
          <ResizableHandle
            aria-label="Resize project navigation"
            className="hq-resize-handle"
            data-hq-sidebar-handle=""
            hidden={compact}
            onDoubleClick={() => store.setSidebarWidth(268)}
          />
          <ResizablePanel
            className="hq-shell__workspace"
            inert={sidebarDialogOpen}
          >
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
                    <HqControlTooltip label="Show or hide the sidebar">
                      <Button
                        aria-label={
                          compact ? "Expand sidebar" : "Collapse sidebar"
                        }
                        aria-expanded={!compact}
                        className="hq-icon-button hq-desktop-navigation-trigger"
                        onClick={toggleSidebar}
                        size="icon"
                        variant="ghost"
                      >
                        <PanelLeft aria-hidden="true" />
                      </Button>
                    </HqControlTooltip>
                    <Button
                      aria-controls={
                        sidebarDialogOpen ? "hq-sidebar-dialog" : undefined
                      }
                      aria-expanded={sidebarDialogOpen}
                      aria-haspopup="dialog"
                      aria-label={
                        sidebarDialogOpen
                          ? "Hide project navigation"
                          : "Show project navigation"
                      }
                      className="hq-icon-button hq-mobile-navigation-trigger"
                      onClick={() =>
                        sidebarDialogOpen
                          ? closeMobileSidebar()
                          : openMobileSidebar()
                      }
                      ref={sidebarOpenerRef}
                      type="button"
                      title="Project navigation"
                    >
                      <Menu aria-hidden="true" />
                    </Button>
                    <div className="hq-main__heading">
                      <h1>{title}</h1>
                    </div>
                    <div className="hq-main__actions">
                      {contextAvailable ? (
                        <HqControlTooltip label="Show or hide context panel">
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
                        </HqControlTooltip>
                      ) : null}
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
      {sidebarDialogOpen ? (
        <div
          aria-hidden="true"
          className="hq-mobile-sidebar-backdrop"
          data-hq-mobile-sidebar-backdrop=""
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeMobileSidebar();
          }}
        />
      ) : null}
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
