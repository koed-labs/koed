import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const output = resolve(scratch, "hq-305", "screenshots");
const reportPath = resolve(scratch, "hq-305", "HQ305.native.json");
const profile = process.env.KOED_HQ305_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-305 Electron profile.");
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
    const errors = [];
    window.webContents.on("console-message", (_event, details) => {
      if (details.level === "error") errors.push(details.message);
    });
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(`HQ-305 timed out: ${source}; ${errors.join(" | ")}`);
    };
    await window.loadFile(
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      {
        query: { view: "hq", hq305Capture: "yes" }
      }
    );
    await waitFor("document.documentElement.dataset.hqFixtureReady === 'true'");
    await js(
      "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]').click()"
    );
    await waitFor(
      "document.querySelector('.hq-learned-today__heading')?.textContent.includes('Learned 2 things today')"
    );
    assert.equal(await js("window.__koedHq305Trace.pages >= 2"), true);
    assert.equal(
      await js(
        "window.__koedHq305Trace.since.every(s => s === new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).toISOString())"
      ),
      true
    );
    await js(
      "document.querySelector('.hq-learned-today').scrollIntoView({block:'center'})"
    );
    const debuggerClient = window.webContents.debugger;
    debuggerClient.attach("1.3");
    await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    });
    await mkdir(output, { recursive: true });
    const capture = async (name) => {
      await delay(100);
      const { data } = await debuggerClient.sendCommand(
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: false
        }
      );
      await writeFile(resolve(output, name), Buffer.from(data, "base64"));
    };
    for (const theme of ["light", "dark"]) {
      await js(
        `document.documentElement.classList.remove('light','dark'); document.documentElement.classList.add('${theme}')`
      );
      await capture(`learned-row-${theme}.png`);
      await js("document.querySelector('.hq-learned-today__heading').click()");
      assert.equal(
        await js(
          "document.querySelector('.hq-learned-today__heading').getAttribute('aria-expanded')"
        ),
        "true"
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-learned-today__list').textContent.includes('An older Project memory')"
        ),
        false
      );
      await js(
        "document.querySelector('.hq-learned-today__item:last-child').scrollIntoView({block:'center'})"
      );
      await capture(`learned-expanded-${theme}.png`);
      await js("document.querySelector('.hq-learned-today__heading').click()");
    }
    await js("document.querySelector('.hq-learned-today__heading').click()");
    await js(
      "document.querySelector('[aria-label=\"Forget: Use the midpoint formula for large price changes\"]').click()"
    );
    await waitFor(
      "Boolean(document.querySelector('.hq-learned-today__undo button'))"
    );
    assert.deepEqual(await js("window.__koedHq305Trace.forgets"), [
      "00000000-0000-4000-8000-000000003051"
    ]);
    assert.equal(
      await js(
        "document.querySelector('.hq-learned-today__heading')?.textContent.includes('Learned 1 thing today')"
      ),
      true
    );
    await capture("learned-forgotten-dark.png");
    await js(
      "document.querySelector('.hq-learned-today__undo button').click()"
    );
    await waitFor(
      "document.querySelector('.hq-learned-today__heading')?.textContent.includes('Learned 2 things today')"
    );
    assert.deepEqual(await js("window.__koedHq305Trace.undos"), [
      "00000000-0000-4000-8000-000000003051:305123456"
    ]);
    await capture("learned-restored-dark.png");
    await js(
      "document.querySelector('button[aria-label=\"What Koed knows\"]').click()"
    );
    await waitFor("Boolean(document.querySelector('.hq-knows'))");
    await js(
      "document.querySelectorAll('.hq-knows__tabs [role=\"tab\"]')[1].click()"
    );
    await js(
      "document.querySelector('[aria-label=\"Close memory panel\"]').click()"
    );
    await js("document.querySelector('.hq-project-sources__count').click()");
    await waitFor(
      "Boolean(document.querySelector('.hq-project-sources__panel'))"
    );
    const selectedText = await js(
      "document.querySelector('.hq-learned-today__detail b')?.textContent"
    );
    await js("document.querySelector('.hq-learned-today__detail').click()");
    await waitFor("Boolean(document.querySelector('.hq-knows__origin'))");
    assert.equal(
      await js("document.querySelector('.hq-project-sources__panel') === null"),
      true
    );
    assert.equal(
      await js("document.querySelector('.hq-knows h2')?.textContent"),
      selectedText
    );
    await capture("learned-detail-dark.png");
    await js("document.querySelector('.hq-knows__forget').click()");
    await waitFor(
      "document.querySelector('.hq-learned-today__heading')?.textContent.includes('Learned 1 thing today')"
    );
    await js("document.querySelector('.hq-knows__undo button').click()");
    await waitFor(
      "document.querySelector('.hq-learned-today__heading')?.textContent.includes('Learned 2 things today')"
    );
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          id: "HQ305.native",
          owner: "HQ-305",
          status: "pass",
          ticket: "HQ-305",
          proof: "Native HqApplication fixture",
          viewport: { width: 1280, height: 800 },
          checks: [
            "today-created scoped list",
            "old memory updated today excluded",
            "light and dark expanded rows",
            "exact Forget and Undo receipt",
            "existing memory detail opens",
            "Project detail opens after the memory panel last showed Me",
            "opening memory detail closes Sources",
            "panel Forget and Undo refresh the Learned today row"
          ],
          screenshots: [
            "learned-row-light.png",
            "learned-row-dark.png",
            "learned-expanded-light.png",
            "learned-expanded-dark.png",
            "learned-forgotten-dark.png",
            "learned-restored-dark.png",
            "learned-detail-dark.png"
          ]
        },
        null,
        2
      )
    );
    console.log(
      `HQ-305 native HqApplication proof passed; screenshots: ${output}`
    );
  } finally {
    window?.destroy();
    app.quit();
  }
}

run().catch((error) => {
  console.error(error);
  app.exit(1);
});
