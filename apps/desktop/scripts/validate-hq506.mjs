import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const output = resolve(scratch, "hq-506", "screenshots");
const reportPath = resolve(scratch, "hq-506", "HQ506.native.json");
const profile = process.env.KOED_HQ506_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-506 Electron profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

async function run() {
  let window;
  try {
    await app.whenReady();
    process.stdout.write("HQ506: Electron ready\n");
    window = new BrowserWindow({
      show: true,
      width: 1280,
      height: 800,
      useContentSize: true
    });
    process.stdout.write("HQ506: window created\n");
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
    debuggerClient.attach("1.3");
    process.stdout.write("HQ506: debugger attached\n");
    const screenshots = [];
    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await js("localStorage.clear()");
      process.stdout.write(`HQ506: load ${theme}\n`);
      await window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        {
          query: { view: "hq", hq506Capture: "yes" }
        }
      );
      await waitFor(
        "document.documentElement.dataset.hqFixtureReady === 'true' && Boolean(document.querySelector('#hq-onboarding-role-title'))",
        "onboarding role question"
      );
      assert.ok(
        await js(
          "Boolean(document.querySelector('[data-hq-shell] .hq-onboarding'))"
        )
      );
      process.stdout.write(`HQ506: role ${theme}\n`);
      await js(
        `document.documentElement.classList.remove('light','dark'); document.documentElement.classList.add('${theme}')`
      );
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
          {
            format: "png",
            captureBeyondViewport: false
          }
        );
        await writeFile(resolve(output, name), Buffer.from(data, "base64"));
        screenshots.push(name);
      };
      assert.equal(
        await js("document.querySelectorAll('.hq-onboarding__role').length"),
        3
      );
      assert.ok(
        await js(
          "document.querySelector('.hq-onboarding__skip')?.textContent.includes('Something else')"
        )
      );
      await capture(`role-${theme}.png`);
      await js("document.querySelector('.hq-onboarding__role').click()");
      await waitFor(
        "Boolean(document.querySelector('#hq-onboarding-chief-title'))",
        "Chief maker"
      );
      assert.ok(
        await js(
          "document.querySelector('.hq-onboarding__preview canvas')?.getAttribute('aria-label')?.includes('Pixelkin')"
        )
      );
      assert.ok(
        await js(
          "document.querySelector('.hq-onboarding__connection') === null"
        )
      );
      assert.ok(
        await js(
          "!document.querySelector('.hq-onboarding__remember input').checked"
        )
      );
      await capture(`chief-${theme}.png`);
      await js(
        "[...document.querySelectorAll('.hq-onboarding__suggestions button')].find((item) => item.textContent === 'Juno').click()"
      );
      await js(
        "[...document.querySelectorAll('button')].find((item) => item.textContent.includes('Continue to Koed')).click()"
      );
      await waitFor(
        "!document.querySelector('.hq-onboarding') && Boolean(document.querySelector('[data-hq-shell]'))",
        "Chief completion"
      );
      assert.equal(
        await js(
          "JSON.parse(localStorage.getItem(Object.keys(localStorage).find((key) => key.startsWith('koed.hq.onboarding.v1:')))).completed"
        ),
        true
      );
      assert.deepEqual(
        await js("window.__koedHqFixture.summary().operations.prompts"),
        [],
        "static setup text must not launch a User prompt"
      );
    }
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          id: "HQ506.native",
          owner: "HQ-506",
          status: "pass",
          screenshots
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
