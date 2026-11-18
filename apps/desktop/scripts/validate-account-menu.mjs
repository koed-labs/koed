import assert from "node:assert/strict";
import { app, BrowserWindow } from "electron";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import { join } from "node:path";
import console from "node:console";

console.log("Starting account menu validation.");
const deadline = setTimeout(() => {
  console.error("Account menu validation timed out.");
  app.exit(1);
}, 30_000);
const scratch = fileURLToPath(
  new URL("../../../scratch/account-menu-validation/", import.meta.url)
);
await mkdir(scratch, { recursive: true });
app.setPath("userData", await mkdtemp(join(scratch, "account-")));
await app.whenReady();
console.log("Electron ready.");
const window = new BrowserWindow({
  width: 1100,
  height: 900,
  show: false,
  webPreferences: { contextIsolation: true, sandbox: true }
});
const errors = [];
window.webContents.on("console-message", (event) => {
  if (event.level === "error") errors.push(event.message);
});
const evaluate = (code) => window.webContents.executeJavaScript(code);
const paint = () =>
  evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
  );
const page = fileURLToPath(
  new URL("../dist-validation/v1-validation.html", import.meta.url)
);
try {
  for (const scene of ["signed-out", "signed-in", "offline"]) {
    console.log(`Rendering ${scene}.`);
    await window.loadFile(page, { query: { account: scene } });
    await paint();
    await evaluate("document.fonts.ready");
    await evaluate("document.querySelector('.v1-account-badge').click()");
    await paint();
    for (const theme of ["light", "dark"]) {
      await evaluate(
        `document.documentElement.classList.remove('light','dark'); document.documentElement.classList.add('${theme}')`
      );
      for (const zoom of [1, 2]) {
        window.webContents.setZoomFactor(zoom);
        await paint();
        assert.ok(
          await evaluate("!!document.querySelector('.v1-account-popup')")
        );
        assert.equal(
          await evaluate(
            "!!document.querySelector('[data-settings-page=profile]')"
          ),
          false
        );
        assert.equal(
          await evaluate("document.documentElement.scrollWidth > innerWidth"),
          false
        );
        const overflow = await evaluate(
          "[...document.querySelectorAll('.v1-account-popup')].some(el => el.scrollWidth > el.clientWidth + 1)"
        );
        assert.equal(
          overflow,
          false,
          `${scene}/${theme}/${zoom}: account menu content overflow`
        );
        await writeFile(
          join(scratch, `${scene}-${theme}-${zoom}x.png`),
          (await window.webContents.capturePage()).toPNG()
        );
      }
    }
    window.webContents.setZoomFactor(1);
    if (scene !== "signed-out") {
      assert.ok(
        await evaluate(
          "document.querySelector('.v1-account-popup').textContent.includes('alex@example.test')"
        )
      );
      assert.equal(
        await evaluate(
          "document.querySelectorAll('.v1-account-popup input').length"
        ),
        0
      );
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    "Sidebar account scenes passed light/dark and 100%/200% layout checks."
  );
} finally {
  clearTimeout(deadline);
  window.destroy();
  app.quit();
}
