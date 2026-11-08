import assert from "node:assert/strict";
import { app, BrowserWindow } from "electron";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { join } from "node:path";
import console from "node:console";
const run = async () => {
  const scratch = fileURLToPath(
    new URL("../../../scratch/v1-ui-validation/", import.meta.url)
  );
  await mkdir(scratch, { recursive: true });
  const profile = await mkdtemp(join(scratch, "profile-"));
  app.setPath("userData", profile);
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1440,
    height: 1000,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  const errors = [];
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  const page = fileURLToPath(
    new URL("../dist-validation/v1-validation.html", import.meta.url)
  );
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  const paint = () =>
    evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))"
    );
  const capture = async (name) => {
    await paint();
    await writeFile(
      join(scratch, name + ".png"),
      (await window.webContents.capturePage()).toPNG()
    );
  };
  try {
    await window.loadFile(page);
    await evaluate("document.fonts.ready");
    await paint();
    assert.equal(
      await evaluate("document.querySelectorAll('.v1-navigation').length"),
      1
    );
    assert.equal(
      await evaluate("document.documentElement.scrollWidth>innerWidth"),
      false
    );
    await capture("home-light");
    await evaluate("document.querySelector('.v1-mode-button').click()");
    await paint();
    assert.ok(
      await evaluate("document.body.innerText.includes('Example model')")
    );
    await capture("model-picker-light");
    await evaluate(
      "document.documentElement.classList.remove('light');document.documentElement.classList.add('dark')"
    );
    await capture("model-picker-dark");
    await window.loadFile(page, { query: { onboarding: "1" } });
    await paint();
    assert.ok(await evaluate("!!document.querySelector('.lp-workspace')"));
    assert.equal(
      await evaluate(
        "(()=>{const b=document.querySelector('.lp-primary-button');return getComputedStyle(b).color!==getComputedStyle(b).backgroundColor;})()"
      ),
      true
    );
    await capture("onboarding-ready");
    assert.deepEqual(errors, []);
    console.log("V1 Electron presentation checks passed; captures:", scratch);
  } finally {
    // Chromium can still write caches until process exit. Keep this isolated
    // scratch profile for inspection; deleting it here races those writes.
    window.destroy();
    app.quit();
  }
};
void run().catch((error) => {
  console.error(error);
  app.exit(1);
});
