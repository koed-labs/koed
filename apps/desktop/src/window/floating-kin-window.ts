import { BrowserWindow, screen } from "electron";
import { resolve } from "node:path";
import type { FloatingKinSize } from "../ipc/floating-kin-protocol.js";
import { floatingKinBounds } from "./floating-kin-bounds.js";

const initialSize = { width: 440, height: 800 };

const createWindow = (appDir: string, size: FloatingKinSize) => {
  const window = new BrowserWindow({
    ...floatingKinBounds(size, screen.getPrimaryDisplay().workArea),
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
  contents.once("render-process-gone", () => {
    if (!window.isDestroyed()) window.destroy();
  });
  return window;
};

export const createFloatingKinWindow = ({
  appDir,
  url,
  onDismiss
}: {
  appDir: string;
  url: string;
  onDismiss: () => void;
}) => {
  let window: BrowserWindow | null = null;
  let size = initialSize;
  let enabled = false;
  let disposed = false;
  let focusRequested = false;
  let ready = false;
  const getWindow = () => (window && !window.isDestroyed() ? window : null);
  const position = () => {
    const active = getWindow();
    if (!active) return;
    const bounds = floatingKinBounds(size, screen.getPrimaryDisplay().workArea);
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
  const focus = (active: BrowserWindow) => {
    active.setFocusable(true);
    active.focus();
  };

  const open = (requestFocus = false) => {
    if (!enabled || disposed) return;
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
    ready = false;
    focusRequested = requestFocus;
    size = initialSize;
    const next = createWindow(appDir, size);
    window = next;
    screen.on("display-metrics-changed", position);
    screen.on("display-removed", position);
    next.on("blur", () => next.setFocusable(false));
    next.on("hide", onDismiss);
    next.webContents.on("did-start-navigation", (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      onDismiss();
      next.setIgnoreMouseEvents(true, { forward: true });
    });
    next.once("closed", () => {
      screen.off("display-metrics-changed", position);
      screen.off("display-removed", position);
      onDismiss();
      if (window === next) window = null;
    });
    next.once("ready-to-show", () => {
      if (getWindow() !== next) return;
      ready = true;
      next.showInactive();
      if (focusRequested) focus(next);
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
      if (value) open();
      else getWindow()?.destroy();
    },
    focus: () => open(true),
    reset() {
      const active = getWindow();
      if (!active) return;
      active.destroy();
      open();
    },
    setInteractive(interactive: boolean) {
      const active = getWindow();
      if (interactive) active?.setIgnoreMouseEvents(false);
      else active?.setIgnoreMouseEvents(true, { forward: true });
    },
    setSize(value: FloatingKinSize) {
      size = value;
      position();
    },
    dispose() {
      disposed = true;
      getWindow()?.destroy();
    }
  };
};
