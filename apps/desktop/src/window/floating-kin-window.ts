import {
  BrowserWindow,
  screen,
  session,
  systemPreferences,
  type Point,
  type Rectangle
} from "electron";
import { resolve } from "node:path";
import type {
  FloatingKinDrag,
  FloatingKinSize
} from "../ipc/floating-kin-protocol.js";
import { createKinHandoff } from "./floating-kin-placement.js";
import { KOED_APP_SCHEME } from "./app-protocol.js";
import { floatingKinBounds } from "./floating-kin-bounds.js";

const initialSize = { width: 440, height: 800 };

const floatingKinSession = (url: string) => {
  // Chromium shares page zoom by host within a session. Keep Kin at 1×
  // so renderer dimensions and drag coordinates match native DIPs.
  const isolated = session.fromPartition("koed-floating-kin");
  if (
    new URL(url).protocol === `${KOED_APP_SCHEME}:` &&
    !isolated.protocol.isProtocolHandled(KOED_APP_SCHEME)
  ) {
    isolated.protocol.handle(KOED_APP_SCHEME, (request) =>
      session.defaultSession.fetch(request, { redirect: "manual" })
    );
  }
  return isolated;
};

const createWindow = (appDir: string, bounds: Rectangle, url: string) => {
  const window = new BrowserWindow({
    ...bounds,
    title: "Floating Kin",
    type: "panel",
    show: false,
    focusable: false,
    acceptFirstMouse: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hiddenInMissionControl: true,
    skipTaskbar: true,
    webPreferences: {
      preload: resolve(appDir, "floating-kin-preload.cjs"),
      session: floatingKinSession(url),
      // Keep CSS dimensions and native DIPs aligned even when Kin is focused.
      zoomMode: "disabled",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  });
  window.setIgnoreMouseEvents(true, { forward: true });
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-frame-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
  return window;
};

export const createFloatingKinWindow = ({
  appDir,
  url,
  onDismiss,
  onHidden = () => {}
}: {
  appDir: string;
  url: string;
  onDismiss: () => void;
  onHidden?: () => void;
}) => {
  let window: BrowserWindow | null = null;
  let size = initialSize;
  let enabled = false;
  let disposed = false;
  let focusRequested = false;
  let ready = false;
  let visible = true;
  let presentationRevision = 0;
  let recover = true;
  let anchor: Point | undefined;
  let anchorDisplay: number | undefined;
  let dragOrigin: { pointer: Point; anchor: Point } | null = null;
  let interactive = false;
  const getWindow = () => (window && !window.isDestroyed() ? window : null);
  const targetBounds = () => {
    const display = anchor
      ? (screen.getAllDisplays().find(({ id }) => id === anchorDisplay) ??
        screen.getDisplayNearestPoint({ x: anchor.x - 1, y: anchor.y - 1 }))
      : screen.getPrimaryDisplay();
    return floatingKinBounds(
      size,
      display.workArea,
      anchor,
      dragOrigin !== null
    );
  };
  const position = () => {
    const active = getWindow();
    if (!active) return;
    const bounds = targetBounds();
    const current = active.getBounds();
    if (
      bounds.x !== current.x ||
      bounds.y !== current.y ||
      bounds.width !== current.width ||
      bounds.height !== current.height
    ) {
      active.setBounds(bounds);
    }
  };
  const updateInput = () => {
    const active = getWindow();
    if (dragOrigin || interactive) active?.setIgnoreMouseEvents(false);
    else active?.setIgnoreMouseEvents(true, { forward: true });
  };
  const clearInput = () => {
    dragOrigin = null;
    interactive = false;
    updateInput();
    onDismiss();
  };
  const handoff = createKinHandoff({
    reducedMotion: () =>
      systemPreferences.getAnimationSettings().prefersReducedMotion,
    show: () => {
      position();
      getWindow()?.showInactive();
    },
    slide: (value) => {
      if (!value) clearInput();
    },
    hide: () => {
      getWindow()?.hide();
      onHidden();
    }
  });
  const drag = (input: FloatingKinDrag) => {
    const active = getWindow();
    if (!visible || !active?.isVisible()) return;
    if (input.phase === "end") {
      if (!dragOrigin) return;
      dragOrigin = null;
      const { x, y, width, height } = targetBounds();
      anchor = { x: x + width, y: y + height };
      position();
      updateInput();
      return;
    }
    const pointer = { x: Math.round(input.x), y: Math.round(input.y) };
    if (input.phase === "start") {
      if (!interactive || dragOrigin) return;
      const { x, y, width, height } = active.getContentBounds();
      const right = x + width;
      const bottom = y + height;
      if (
        pointer.x < x ||
        pointer.x >= right ||
        pointer.y < y ||
        pointer.y >= bottom
      )
        return;
      dragOrigin = { pointer, anchor: { x: right, y: bottom } };
      return;
    }
    if (!dragOrigin) return;
    anchor = {
      x: dragOrigin.anchor.x + pointer.x - dragOrigin.pointer.x,
      y: dragOrigin.anchor.y + pointer.y - dragOrigin.pointer.y
    };
    anchorDisplay = screen.getDisplayNearestPoint(pointer).id;
    position();
  };
  const focus = (active: BrowserWindow) => {
    active.setFocusable(true);
    active.focus();
  };

  const open = (requestFocus = false) => {
    if (!enabled || disposed || !visible) return;
    const active = getWindow();
    if (active) {
      if (requestFocus && ready) {
        if (!active.isVisible()) active.showInactive();
        focus(active);
      } else if (requestFocus) {
        focusRequested = true;
      }
      return;
    }
    handoff.dispose();
    ready = false;
    focusRequested = requestFocus;
    size = initialSize;
    const next = createWindow(appDir, targetBounds(), url);
    window = next;
    screen.on("display-metrics-changed", position);
    screen.on("display-removed", position);
    next.on("blur", () => next.setFocusable(false));
    next.on("hide", clearInput);
    next.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) clearInput();
    });
    next.webContents.once("render-process-gone", () => {
      if (getWindow() !== next) return;
      const retry = recover && enabled && visible && !disposed;
      recover = false;
      next.destroy();
      if (retry) open();
    });
    next.once("closed", () => {
      screen.off("display-metrics-changed", position);
      screen.off("display-removed", position);
      if (window === next) {
        handoff.dispose();
        window = null;
      }
      clearInput();
      if (!visible) onHidden();
    });
    next.once("ready-to-show", () => {
      if (getWindow() !== next) return;
      ready = true;
      handoff.setVisible(visible, presentationRevision);
      if (visible && focusRequested) focus(next);
      focusRequested = false;
    });
    void next.loadURL(url).catch((error: unknown) => {
      if (next.isDestroyed()) return;
      console.warn("Floating Kin could not load.", error);
      next.destroy();
    });
  };

  return {
    getWindow,
    setEnabled(value: boolean) {
      if (disposed || value === enabled) return;
      enabled = value;
      recover = true;
      if (value) open();
      else getWindow()?.destroy();
    },
    completeExit: handoff.completeExit,
    setVisible(value: boolean, revision: number) {
      if (visible !== value) recover = true;
      visible = value;
      presentationRevision = revision;
      if (ready && getWindow()) handoff.setVisible(value, revision);
      else if (value) open();
    },
    isShowing: () => getWindow()?.isVisible() ?? false,
    focus: () => open(true),
    reset() {
      const active = getWindow();
      if (!active) return;
      active.destroy();
      open();
    },
    drag,
    setInteractive(value: boolean) {
      if (!visible || interactive === value) return;
      interactive = value;
      updateInput();
    },
    setSize(value: FloatingKinSize) {
      size = value;
      position();
    },
    dispose() {
      disposed = true;
      handoff.dispose();
      getWindow()?.destroy();
    }
  };
};
