import assert from "node:assert/strict";
import console from "node:console";
import { once } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import { app, BrowserWindow, Menu, protocol } from "electron";
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

async function testZoomSizing() {
  await app.whenReady();
  protocol.handle("koed", ({ url }) => {
    if (new URL(url).pathname === "/panel.js") {
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
  overlay.dispose();
  main.destroy();
}

const timeout = setTimeout(() => {
  console.error("Timed out waiting for the Floating Kin zoom fixture.");
  app.exit(1);
}, 10_000);
void testZoomSizing().then(
  () => {
    clearTimeout(timeout);
    console.log("Floating Kin native zoom sizing passed.");
    app.exit(0);
  },
  (error) => {
    clearTimeout(timeout);
    console.error(error);
    app.exit(1);
  }
);
