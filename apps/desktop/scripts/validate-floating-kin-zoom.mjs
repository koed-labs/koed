import assert from "node:assert/strict";
import console from "node:console";
import { once } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  protocol,
  systemPreferences
} from "electron";
import { registerFloatingKinIpc } from "../dist-electron/ipc/floating-kin.js";
import { floatingKinChannels as channels } from "../dist-electron/ipc/floating-kin-protocol.js";
import { kinExitTimeoutMs } from "../dist-electron/window/floating-kin-placement.js";
import { createFloatingKinWindow } from "../dist-electron/window/floating-kin-window.js";

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

async function waitFor(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for the packaged Kin renderer");
}

async function testPackagedExit() {
  const url = "koed://app/renderer/#floating-kin";
  let presentation = { placement: "desktop", revision: 0 };
  let completed = false;
  let cancelled;
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
      activity: async () => ({ state: "stopped" }),
      summarize: async () => ({ status: "unavailable" })
    },
    mainWindowFocused: () => false,
    presentation: () => presentation,
    completeExit: (revision) => {
      completed = true;
      overlay.completeExit(revision);
    },
    interactive: overlay.setInteractive,
    resize: overlay.setSize,
    drag: overlay.drag
  });
  try {
    overlay.setEnabled(true);
    const { webContents } = overlay.getWindow();
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
    presentation = { placement: "home", revision: 1, homePending: true };
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
    console.log("Floating Kin native zoom, sizing, and handoff passed.");
    app.exit(0);
  },
  (error) => {
    clearTimeout(timeout);
    console.error(error);
    app.exit(1);
  }
);
