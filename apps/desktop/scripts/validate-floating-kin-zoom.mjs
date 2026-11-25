import assert from "node:assert/strict";
import console from "node:console";
import { once } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  protocol,
  screen,
  systemPreferences
} from "electron";
import { registerFloatingKinIpc } from "../dist-electron/ipc/floating-kin.js";
import { floatingKinChannels as channels } from "../dist-electron/ipc/floating-kin-protocol.js";
import { kinExitTimeoutMs } from "../dist-electron/window/floating-kin-placement.js";
import { createFloatingKinWindow } from "../dist-electron/window/floating-kin-window.js";
import { createDesktopWindowActivator } from "../dist-electron/window/lifecycle.js";

const scratch = fileURLToPath(new URL("../../../scratch/", import.meta.url));
mkdirSync(scratch, { recursive: true });
app.setPath("userData", mkdtempSync(join(scratch, "pr547-kin-zoom-profile-")));
protocol.registerSchemesAsPrivileged([
  {
    scheme: "koed",
    privileges: { standard: true, secure: true, supportFetchAPI: true }
  }
]);

async function assertPanelFits(window) {
  const layout = await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('button');
    const { left, top, right, bottom } = button.getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, left, top, right, bottom, label: button.textContent };
  })()`);
  assert.equal(layout.label, "Close", "packaged path loads relative assets");
  assert.ok(
    layout.left >= 0 &&
      layout.top >= 0 &&
      layout.right <= layout.width &&
      layout.bottom <= layout.height,
    `preferred size clips overlay: ${JSON.stringify(layout)}`
  );
}

async function zoomFocusedOverlay(overlay, window) {
  const menu = Menu.buildFromTemplate([
    { role: "viewMenu", submenu: [{ id: "zoom-in", role: "zoomIn" }] }
  ]);
  Menu.setApplicationMenu(menu);
  const zoomIn = menu.getMenuItemById("zoom-in");
  assert.ok(zoomIn);
  const focused = once(window, "focus");
  app.focus({ steal: true });
  overlay.focus();
  await focused;
  // Invoke the menu role against Kin without injecting OS-wide keyboard input.
  zoomIn.click({}, window, window.webContents);
  zoomIn.click({}, window, window.webContents);
}

async function assertHandoffRetainsAnchor(overlay, window) {
  const { x, y } = window.getContentBounds();
  overlay.setInteractive(true);
  overlay.drag({ phase: "start", x: x + 20, y: y + 20 });
  overlay.drag({ phase: "move", x: x - 20, y: y - 20 });
  overlay.drag({ phase: "end" });
  const anchor = window.getBounds();
  assert.notEqual(anchor.x, x, "drag moves the overlay before handoff");

  overlay.setVisible(false, 1);
  overlay.completeExit(1);
  assert.equal(window.isVisible(), false);
  overlay.setVisible(true, 2);
  assert.equal(window.isVisible(), true);
  assert.deepEqual(window.getBounds(), anchor);

  overlay.setVisible(false, 3);
  overlay.setVisible(true, 4);
  overlay.completeExit(3);
  await new Promise((resolve) => setTimeout(resolve, kinExitTimeoutMs + 50));
  assert.equal(
    window.isVisible(),
    true,
    "stale handoff must not hide the overlay"
  );
  assert.deepEqual(window.getBounds(), anchor);
}

async function waitFor(check, subject = "the packaged Kin renderer") {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${subject}`);
}

async function armStationaryCursor(window, { x, y }) {
  // Model the panel resizing under a stationary cursor without moving the
  // real system pointer. The native window code must arm the control itself.
  const getCursorScreenPoint = screen.getCursorScreenPoint;
  screen.getCursorScreenPoint = () => {
    const { x: left, y: top } = window.getContentBounds();
    return { x: left + x, y: top + y };
  };
  try {
    await window.webContents.executeJavaScript(
      `window.dispatchEvent(new Event('resize'))`
    );
    await waitFor(() => window.isFocusable(), "the native panel to arm");
  } finally {
    screen.getCursorScreenPoint = getCursorScreenPoint;
  }
}

async function assertChipOpensSummary(window) {
  const { webContents } = window;
  await waitFor(() =>
    webContents.executeJavaScript(`!!document.querySelector('.fk-chip')`)
  );
  const { x, y } = await webContents.executeJavaScript(`(() => {
    const { x, y, width, height } = document.querySelector('.fk-chip').getBoundingClientRect();
    return { x: Math.round(x + width - 8), y: Math.round(y + height / 2) };
  })()`);
  await armStationaryCursor(window, { x, y });
  assert.equal(window.isFocused(), false, "hover only arms the panel");
  for (const type of ["mouseDown", "mouseUp"])
    webContents.sendInputEvent({ type, button: "left", clickCount: 1, x, y });
  await waitFor(() =>
    webContents.executeJavaScript(`
    (() => {
      const text = document.querySelector('#floating-kin-summary')?.textContent;
      return text?.includes('Summarize conversation') && text.includes('Check build status');
    })()
  `)
  );
  await assertPreviewLayout(webContents);
}

const shortDisplayHeight = 470;

async function assertPreviewLayout(webContents) {
  let layout;
  await waitFor(async () => {
    layout = await webContents.executeJavaScript(`(() => {
      const header = document.querySelector('.fk-header');
      const body = document.querySelector('.fk-body');
      const action = document.querySelector('.fk-actions button');
      const text = [...header.querySelectorAll('[title]')];
      body.scrollTop = body.scrollHeight;
      const button = action.getBoundingClientRect();
      const pane = body.getBoundingClientRect();
      return {
        innerHeight, namesClipped: text.filter(node => node.scrollWidth > node.clientWidth).length,
        bodyHeight: body.clientHeight, scrollHeight: body.scrollHeight,
        buttonHeight: action.offsetHeight, top: button.top, bottom: button.bottom,
        paneTop: pane.top, paneBottom: pane.bottom
      };
    })()`);
    return (
      layout.innerHeight <= shortDisplayHeight &&
      layout.namesClipped === 2 &&
      layout.scrollHeight > layout.bodyHeight &&
      layout.bodyHeight >= layout.buttonHeight &&
      layout.top >= Math.max(layout.paneTop, 0) &&
      layout.bottom <= Math.min(layout.paneBottom, layout.innerHeight)
    );
  }, "long preview names to fit while the summary action stays reachable").catch(
    (error) => {
      if (error.code !== "ERR_ASSERTION") throw error;
      assert.fail(`${error.message}: ${JSON.stringify(layout)}`);
    }
  );
}

async function clickPackagedAvatar(window) {
  const { webContents } = window;
  await webContents.executeJavaScript(
    `void document.querySelector('#floating-kin-summary button').click()`
  );
  // The summary unmounts before the resize IPC reaches both the panel and Chromium.
  const { x, y } = await waitFor(async () => {
    const [nativeWidth, nativeHeight] = window.getContentSize();
    return webContents.executeJavaScript(`(() => {
      if (document.querySelector('#floating-kin-summary')) return null;
      const surface = document.querySelector('.fk-surface');
      const bounds = surface.getBoundingClientRect();
      if (innerWidth !== ${nativeWidth} || innerHeight !== ${nativeHeight} ||
          innerWidth !== Math.ceil(bounds.width) || innerHeight !== Math.ceil(bounds.height) ||
          surface.scrollHeight > innerHeight) return null;
      const avatar = document.querySelector('button[aria-label="Open Koed Desktop"]');
      if (!avatar) return null;
      const { x, y, width, height } = avatar.getBoundingClientRect();
      const point = { x: Math.round(x + width / 2), y: Math.round(y + height / 2) };
      return avatar.contains(document.elementFromPoint(point.x, point.y)) ? point : null;
    })()`);
  }, "the summary to close and the avatar to be hit-testable after resizing");
  // Clear the previous chip hover so the avatar must arm the native panel again.
  webContents.sendInputEvent({ type: "mouseMove", x: 0, y: 0 });
  await waitFor(() => !window.isFocusable(), "the native panel to disarm");
  await armStationaryCursor(window, { x, y });
  for (const type of ["mouseDown", "mouseUp"])
    webContents.sendInputEvent({ type, button: "left", clickCount: 1, x, y });
}

async function assertDesktopFocus(desktop) {
  let appWasActive = process.platform !== "darwin";
  try {
    await waitFor(() => {
      appWasActive ||= app.isActive();
      return desktop.isFocused();
    }, "the opened Desktop to focus");
  } catch (error) {
    // macOS can deny foreground activation in unattended GUI sessions.
    if (appWasActive || error.code !== "ERR_ASSERTION") throw error;
    console.log(
      "Desktop opened; focus unavailable while Electron is inactive."
    );
  }
}

async function testPackagedExit() {
  const url = "koed://app/renderer/#floating-kin";
  let presentation = { placement: "desktop", revision: 0 };
  let completed = false;
  let desktop = null;
  let cancelled;
  const openDesktop = createDesktopWindowActivator({
    waitForBootstrap: async () => {},
    getWindow: () => desktop,
    beforeOpen: () => app.focus({ steal: true }),
    createWindow: async () => {
      desktop = new BrowserWindow({ width: 480, height: 340, show: false });
      await desktop.loadURL(
        "data:text/html,<title>Koed Desktop fixture</title>"
      );
      desktop.show();
      desktop.focus();
    }
  });
  const overlay = createFloatingKinWindow({
    appDir: fileURLToPath(new URL("../dist-electron/", import.meta.url)),
    url,
    onDismiss: () => cancelled?.()
  });
  cancelled = registerFloatingKinIpc({
    ipcMain,
    getWebContents: () => overlay.getWindow()?.webContents ?? null,
    url,
    runtime: {
      activity: async () => ({
        state: "running",
        overflowCount: 0,
        conversations: [1, 2, 3].map((index) => ({
          sessionId: `00000000-0000-4000-8000-00000000000${index}`,
          client: "codex",
          lastActivityAt: new Date().toISOString(),
          projectId: null
        }))
      }),
      summarize: async () => ({ status: "unavailable" }),
      preview: async () => ({
        title: "Release checks ".repeat(16).trim(),
        projectName: "Project rollout ".repeat(15).trim(),
        request: {
          text: (
            "Check build status. " + "Review CI completion. ".repeat(10)
          ).trim(),
          occurredAt: new Date().toISOString()
        },
        reply: {
          text: "The release checks are running. ".repeat(7).trim(),
          occurredAt: new Date().toISOString()
        }
      }),
      latest: async () => ({ action: null }),
      reopen: async () => null
    },
    mainWindowFocused: () => false,
    overlayVisible: overlay.isShowing,
    presentation: () => presentation,
    completeExit: (revision) => {
      completed = true;
      overlay.completeExit(revision);
    },
    openDesktop: () => void openDesktop(),
    openAiModels: () => {},
    interactive: overlay.setInteractive,
    resize: overlay.setSize,
    drag: overlay.drag
  });
  const getPrimaryDisplay = screen.getPrimaryDisplay;
  screen.getPrimaryDisplay = () => {
    const display = getPrimaryDisplay();
    return {
      ...display,
      workArea: {
        ...display.workArea,
        height: Math.min(shortDisplayHeight, display.workArea.height)
      }
    };
  };
  try {
    overlay.setEnabled(true);
    const window = overlay.getWindow();
    const { webContents } = window;
    await once(webContents, "did-finish-load");
    await waitFor(
      async () =>
        overlay.isShowing() &&
        webContents.executeJavaScript(
          `document.querySelector('.fk-surface')?.dataset.visible === 'true'`
        )
    );
    await webContents.insertCSS(
      `.fk-surface {transition-duration: 420ms !important}`
    );
    const reduced =
      systemPreferences.getAnimationSettings().prefersReducedMotion;
    if (!reduced)
      await waitFor(() =>
        webContents.executeJavaScript(`(() => {
          const surface = document.querySelector('.fk-surface');
          const style = getComputedStyle(surface);
          return style.opacity === '1' && style.transitionProperty.includes('opacity') && !surface.getAnimations().length;
        })()`)
      );
    await assertChipOpensSummary(window);
    assert.equal(desktop, null, "a chip click must not open Desktop");
    await clickPackagedAvatar(window);
    await waitFor(() => desktop?.isVisible(), "the avatar to open Desktop");
    assert.equal(desktop.webContents.getTitle(), "Koed Desktop fixture");
    await assertDesktopFocus(desktop);
    presentation = { placement: "sidebar", revision: 1, sidebarPending: true };
    webContents.send(channels.presentationChanged, presentation);
    overlay.setVisible(false, presentation.revision);
    if (!reduced) {
      await new Promise((resolve) => setTimeout(resolve, 280));
      assert.equal(
        overlay.isShowing(),
        true,
        "native panel stays visible during the real exit transition"
      );
      assert.equal(completed, false);
    }
    await waitFor(() => !overlay.isShowing());
    if (!reduced)
      assert.equal(
        completed,
        true,
        "preload sends completion before the native watchdog"
      );
  } finally {
    screen.getPrimaryDisplay = getPrimaryDisplay;
    desktop?.destroy();
    overlay.dispose();
  }
}

async function testZoomSizing() {
  await app.whenReady();
  protocol.handle("koed", async ({ url }) => {
    const { pathname } = new URL(url);
    if (
      pathname === "/renderer/" ||
      /^\/renderer\/assets\/[\w.-]+\.(js|css)$/.test(pathname)
    ) {
      const file =
        pathname === "/renderer/"
          ? "index.html"
          : pathname.slice("/renderer/".length);
      const data = await readFile(new URL(`../dist/${file}`, import.meta.url));
      const contentType = file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html";
      return new globalThis.Response(data, {
        headers: { "Content-Type": contentType }
      });
    }
    if (pathname === "/panel.js") {
      return new globalThis.Response(
        'document.querySelector("button").textContent = "Close";',
        { headers: { "Content-Type": "text/javascript" } }
      );
    }
    return new globalThis.Response(
      '<body style="margin:0"><button style="width:394px;height:180px"></button><script src="/panel.js"></script></body>',
      { headers: { "Content-Type": "text/html" } }
    );
  });

  const main = new BrowserWindow({ show: false });
  await main.loadURL("koed://app/");
  main.webContents.setZoomFactor(1.5);
  const url = "koed://app/#floating-kin";
  const overlay = createFloatingKinWindow({
    appDir: fileURLToPath(new URL("../dist-electron/", import.meta.url)),
    url,
    onDismiss: () => {}
  });
  overlay.setEnabled(true);
  const window = overlay.getWindow();
  const loaded = once(window.webContents, "did-finish-load");
  overlay.setSize({ width: 394, height: 180 });
  await loaded;

  assert.equal(window.webContents.getURL(), url);
  assert.deepEqual(window.getContentSize(), [394, 180]);
  await assertPanelFits(window);
  assert.equal(main.webContents.getZoomFactor(), 1.5);
  main.webContents.setZoomFactor(2);
  await assertPanelFits(window);
  assert.equal(main.webContents.getZoomFactor(), 2);

  await zoomFocusedOverlay(overlay, window);
  await assertPanelFits(window);
  assert.equal(window.webContents.getZoomFactor(), 1);
  assert.equal(main.webContents.getZoomFactor(), 2);
  await assertHandoffRetainsAnchor(overlay, window);
  overlay.dispose();
  await testPackagedExit();
  main.destroy();
}

const timeout = setTimeout(() => {
  console.error("Timed out waiting for the Floating Kin zoom fixture.");
  app.exit(1);
}, 10_000);
void testZoomSizing().then(
  () => {
    clearTimeout(timeout);
    console.log(
      "Floating Kin zoom, sizing, handoff, and packaged chip/avatar interactions passed."
    );
    app.exit(0);
  },
  (error) => {
    clearTimeout(timeout);
    console.error(error);
    app.exit(1);
  }
);
