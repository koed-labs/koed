import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const output = resolve(scratch, "hq-502", "screenshots");
const reportPath = resolve(scratch, "hq-502", "HQ502.native.json");
const profile = process.env.KOED_HQ502_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-502 Electron profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

async function run() {
  let window;
  try {
    await rm(reportPath, { force: true });
    await app.whenReady();
    window = new BrowserWindow({
      show: true,
      width: 1280,
      height: 800,
      useContentSize: true
    });
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source, label) => {
      for (let attempt = 0; attempt < 160; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      assert.fail(`Timed out waiting for ${label}`);
    };
    await mkdir(output, { recursive: true });
    const debuggerClient = window.webContents.debugger;
    for (const theme of ["light", "dark"]) {
      await window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        { query: { view: "hq", hq502Capture: "yes" } }
      );
      await waitFor(
        "document.documentElement.dataset.hqFixtureReady === 'true'",
        "HQ fixture"
      );
      await js(
        `document.documentElement.classList.remove('light','dark'); document.documentElement.classList.add('${theme}')`
      );
      assert.ok(
        await js(
          "Boolean(document.querySelector('.hq-sidebar__action--now svg')) && !document.querySelector('.hq-sidebar__action--now canvas')"
        ),
        "v50 Now keeps its pulse navigation icon"
      );
      if (!debuggerClient.isAttached()) debuggerClient.attach("1.3");
      await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false
      });
      const capture = async (name) => {
        await delay(100);
        const { data } = await debuggerClient.sendCommand(
          "Page.captureScreenshot",
          { format: "png", captureBeyondViewport: false }
        );
        await writeFile(resolve(output, name), Buffer.from(data, "base64"));
      };
      await capture(`now-${theme}.png`);
      await js(
        "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]').click()"
      );
      await waitFor(
        "Boolean(document.querySelector('.hq-project-view__section--doing .hq-pixelkin'))",
        "assigned Agent Pixelkin in Working now"
      );
      await waitFor(
        "document.querySelector('.hq-project-view__section--doing .hq-pixelkin')?.getContext('2d')?.getImageData(0,0,64,64).data.some((v,i) => i%4===3 && v===255)",
        "painted assigned Agent Pixelkin"
      );
      const row = await js(
        `(() => { const canvas = document.querySelector('.hq-project-view__section--doing .hq-pixelkin'); const pixels = canvas?.getContext('2d')?.getImageData(0,0,64,64).data; return { label: canvas?.getAttribute('aria-label'), opaque: pixels ? Array.from(pixels).filter((v,i) => i%4===3 && v===255).length : 0 }; })()`
      );
      assert.equal(row.label, "Quinn Pixelkin");
      assert.ok(row.opaque > 100);
      await waitFor(
        "Boolean(document.querySelector('.hq-project-conversation__header .hq-pixelkin'))",
        "owner-bound Chief avatar in HQ"
      );
      await capture(`project-${theme}.png`);
    }
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          id: "HQ502.native",
          owner: "HQ-502",
          status: "pass",
          screenshots: [
            "now-light.png",
            "project-light.png",
            "now-dark.png",
            "project-dark.png"
          ]
        },
        null,
        2
      )
    );
    process.stdout.write(`${reportPath}\n`);
  } finally {
    window?.destroy();
    app.quit();
  }
}
void run().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  app.exit(1);
});
