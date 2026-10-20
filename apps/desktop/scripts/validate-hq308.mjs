import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const output = resolve(scratch, "hq-308", "screenshots");
const reportPath = resolve(scratch, "hq-308", "HQ308.native.json");
const profile = process.env.KOED_HQ308_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-308 Electron profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

async function run() {
  let window;
  try {
    await rm(reportPath, { force: true });
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      useContentSize: true
    });
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source, label) => {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      assert.fail(`Timed out waiting for ${label}`);
    };
    const debuggerClient = window.webContents.debugger;
    await mkdir(output, { recursive: true });
    for (const theme of ["light", "dark"]) {
      await window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        { query: { view: "hq", hq308Capture: "yes" } }
      );
      await waitFor(
        "document.documentElement.dataset.hqFixtureReady === 'true'",
        "HQ fixture"
      );
      await js(
        `document.documentElement.classList.remove('light','dark'); document.documentElement.classList.add('${theme}')`
      );
      await waitFor(
        "document.querySelector('.hq-now__memory-row .hq-execution-memory__chip')?.textContent.includes('Why: Clock skew on staging')",
        "Now Why chip"
      );
      assert.equal(
        await js(`(() => {
          const row = document.querySelector('.hq-now__memory-row');
          const title = row?.querySelector('.hq-now__row strong')?.getBoundingClientRect();
          const chip = row?.querySelector('.hq-execution-memory__chip')?.getBoundingClientRect();
          const context = row?.querySelector('.hq-execution-memory__secondary small')?.getBoundingClientRect();
          return Boolean(title && chip && context && chip.top > title.top && Math.abs(chip.left - title.left) < 8 && context.left >= chip.right);
        })()`),
        true
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
      await capture(`now-why-${theme}.png`);
      await js(
        "document.querySelector('.hq-now__memory-row .hq-execution-memory__chip').click()"
      );
      await waitFor(
        "Boolean(document.querySelector('.hq-now-memory-host [aria-label=\"Memory source detail\"]'))",
        "Now source detail"
      );
      assert.equal(await js("window.__koedHq308Trace.detailOpens"), 1);
      assert.equal(
        await js(
          "document.querySelector('.hq-context')?.getBoundingClientRect().width > 300"
        ),
        true
      );
      await capture(`now-detail-${theme}.png`);
      await js(
        "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]').click()"
      );
      await waitFor(
        "document.querySelector('.hq-project-view__memory-row .hq-execution-memory__chip')?.textContent.includes('Why: Clock skew on staging')",
        "Project Why chip"
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-project-view__section--doing .hq-execution-memory__chip')?.textContent.includes('2 memories')"
        ),
        true
      );
      assert.equal(
        await js(`(() => {
          const rows = [document.querySelector('.hq-project-view__section--need .hq-project-view__memory-row'), document.querySelector('.hq-project-view__section--doing .hq-project-view__memory-row')];
          return rows.every((row) => {
            const title = row?.querySelector('b')?.getBoundingClientRect();
            const chipElement = row?.querySelector('.hq-execution-memory__chip');
            const chip = chipElement?.getBoundingClientRect();
            const context = row?.querySelector('.hq-execution-memory__secondary small')?.getBoundingClientRect();
            return Boolean(title && chip && context && chip.top > title.top && Math.abs(chip.left - title.left) < 8 && context.left >= chip.right && !chipElement?.parentElement?.closest('button'));
          });
        })()`),
        true
      );
      await capture(`project-memory-${theme}.png`);
      await js(
        "document.querySelector('[aria-label=\"Hide project context\"]').click()"
      );
      await waitFor(
        "Boolean(document.querySelector('[aria-label=\"Show project context\"]'))",
        "hidden Project context"
      );
      await js(
        "document.querySelector('.hq-project-view__section--doing .hq-execution-memory__chip').click()"
      );
      await waitFor(
        "Boolean(document.querySelector('[aria-label=\"Hide project context\"]'))",
        "memory source restores Project context"
      );
      await waitFor(
        "document.querySelectorAll('.hq-project-conversation__inspector .hq-execution-memory__panel > button').length === 2",
        "two source choices"
      );
      await js(
        "document.querySelectorAll('.hq-project-conversation__inspector .hq-execution-memory__panel > button')[1].click()"
      );
      await waitFor(
        "document.querySelector('.hq-project-conversation__inspector [aria-label=\"Memory source detail\"] h2')?.textContent === 'Release checklist'",
        "second source detail"
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-project-conversation__inspector').hidden"
        ),
        false
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-project-conversation .hq-conversation__dock')?.getBoundingClientRect().height > 0"
        ),
        true
      );
      await capture(`project-detail-${theme}.png`);
    }
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          id: "HQ308.native",
          owner: "HQ-308",
          status: "pass",
          ticket: "HQ-308",
          proof: "Native HqApplication fixture",
          viewport: { width: 1280, height: 800 },
          checks: [
            "Now Why chip",
            "Project Needs you Why chip",
            "Working now two-memory count",
            "chips start the secondary line below row titles",
            "reauthorized source detail",
            "light and dark themes"
          ],
          screenshots: [
            "now-why-light.png",
            "now-detail-light.png",
            "project-memory-light.png",
            "project-detail-light.png",
            "now-why-dark.png",
            "now-detail-dark.png",
            "project-memory-dark.png",
            "project-detail-dark.png"
          ]
        },
        null,
        2
      )
    );
    process.stdout.write(
      `HQ-308 native proof passed; screenshots: ${output}\n`
    );
  } finally {
    window?.destroy();
    app.quit();
  }
}

void run().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  app.exit(1);
});
