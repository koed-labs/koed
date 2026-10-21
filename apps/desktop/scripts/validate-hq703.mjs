import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const output = resolve(scratch, "hq-703", "screenshots");
const profile = process.env.KOED_HQ703_USER_DATA_DIR;
assert.ok(
  profile && dirname(resolve(profile)) === scratch,
  "Use an isolated HQ-703 profile in scratch"
);
app.setPath("userData", profile);

const run = async () => {
  let window;
  try {
    await app.whenReady();
    window = new BrowserWindow({ show: true, width: 1280, height: 800 });
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let i = 0; i < 120; i++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(`HQ-703 fixture did not reach ${source}`);
    };
    await mkdir(output, { recursive: true });
    const capture = async (name, theme) => {
      const visible = await js(`(() => {
        const row = document.querySelector('.hq-now__invitation');
        row?.scrollIntoView({block:'center'});
        const rect = row?.getBoundingClientRect();
        return !!rect && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight &&
          document.documentElement.classList.contains(${JSON.stringify(theme)}) &&
          row.textContent.includes('landing-site') && row.textContent.includes('Launch Team') &&
          row.textContent.includes('Maya Chen') && row.textContent.includes('Maya’s Design Agent') &&
          row.textContent.includes('member') && row.textContent.includes('write access') &&
          row.textContent.includes('shared as summaries') && row.textContent.includes('Expires') &&
          row.querySelectorAll('button').length === 2;
      })()`);
      assert.equal(
        visible,
        true,
        `${name} must show the full invitation scope and theme`
      );
      await js(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
      );
      await delay(200);
      await window.webContents.capturePage();
      await writeFile(
        resolve(output, name),
        (await window.webContents.capturePage()).toPNG()
      );
    };
    for (const theme of ["light", "dark"]) {
      await window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        {
          query: { view: "hq", hq703Capture: "yes", hq701Linked: "yes" }
        }
      );
      await waitFor(
        "document.documentElement.dataset.hqFixtureReady === 'true' && !!document.querySelector('.hq-now__invitation')"
      );
      await js(
        `document.documentElement.classList.remove('light','dark'); document.documentElement.classList.add(${JSON.stringify(theme)})`
      );
      await capture(`invitation-${theme}.png`, theme);
      await js(
        "window.__koedHq703Trace.failNext = true; document.querySelector('.hq-now__invitation-actions button:last-child').click()"
      );
      await waitFor(
        "!!document.querySelector('.hq-now__invitation') && !!document.querySelector('.hq-now [role=alert]')"
      );
      assert.match(
        await js("document.querySelector('.hq-now [role=alert]').textContent"),
        /review was canceled/
      );
      await js(
        "document.querySelector('.hq-now__invitation-actions button:first-child').click()"
      );
      await waitFor("!document.querySelector('.hq-now__invitation')");
      assert.deepEqual(await js("window.__koedHq703Trace.decisions"), [
        "accept",
        "decline"
      ]);
    }
    const report = {
      id: "HQ703.ui.native",
      owner: "HQ-703",
      status: "pass",
      scope: "renderer-fixture",
      scenarioAssertions: [
        { id: "S13.1", detail: "pre-join summary-sharing disclosure" },
        {
          id: "S14.1",
          detail: "addressed invite scope and Native decision controls"
        }
      ],
      nativeGrantAuthorityProved: false,
      screenshots: ["invitation-light.png", "invitation-dark.png"]
    };
    await writeFile(
      resolve(scratch, "hq-703", "HQ703.native.json"),
      JSON.stringify(report, null, 2)
    );
    console.log(JSON.stringify(report));
  } finally {
    window?.destroy();
    app.quit();
  }
};

void run().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  }
);
