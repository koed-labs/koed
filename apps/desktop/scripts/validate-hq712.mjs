import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const output = resolve(scratch, "hq-712", "screenshots");
const profile = process.env.KOED_HQ712_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-712 Electron profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

async function run() {
  let window;
  try {
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
        { query: { view: "hq", hq712Capture: "yes", hq405Capture: "yes" } }
      );
      await waitFor(
        "document.documentElement.dataset.hqFixtureReady === 'true'",
        "HQ fixture"
      );
      await js(
        `document.documentElement.classList.remove('light','dark'); document.documentElement.classList.add('${theme}')`
      );
      await js(
        "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]').click()"
      );
      await waitFor(
        "document.querySelector('.hq-project-view__section--todo .hq-shared-project__row b')?.textContent === 'Review shared launch plan'",
        "shared Work Item"
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-project-view__shared')?.textContent.trim()"
        ),
        "HQ Shared"
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-project-sources__key')?.textContent.trim()"
        ),
        "Plan.md"
      );
      assert.equal(
        await js(
          "document.querySelector('[aria-label=\"Add shared to-do\"]') !== null && document.querySelector('.hq-project-view__work[hidden]') !== null"
        ),
        true
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-project-view__activity')?.textContent.includes('2 done this week')"
        ),
        true
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-project-view__section--todo .hq-shared-project__row')?.firstElementChild?.classList.contains('hq-project-view__tick')"
        ),
        true
      );
      await waitFor(
        "document.querySelector('.hq-shared-project .hq-project-prs__actions button')?.textContent === 'Merge'",
        "owner-bound Native merge control"
      );
      const privateControls = await js(`(() => {
        const rows = Array.from(document.querySelectorAll('.hq-shared-project__row'));
        const mine = rows.find(row => row.textContent.includes('Review my shared release'));
        const theirs = rows.find(row => row.textContent.includes("Teammate's private PR"));
        const button = mine?.querySelector('.hq-project-prs__actions button');
        const style = button && getComputedStyle(button);
        const needsStyle = mine && getComputedStyle(mine.closest(".hq-project-view__section--need"));
        return { mine: Boolean(button), theirs: Boolean(theirs?.querySelector('.hq-project-prs__actions button')),
          teammateLink: Boolean(theirs?.querySelector('a[href="https://github.com/acme/repo/pull/213"]')),
          background: style?.backgroundColor, color: style?.color,
          needsBackground: needsStyle?.backgroundColor, ownerAvatar: Boolean(mine?.querySelector(".hq-pixelkin")),
          inSubtitle: Boolean(button?.closest('.hq-project-view__work-item-text')) };
      })()`);
      assert.equal(privateControls.mine, true);
      assert.equal(privateControls.ownerAvatar, true);
      assert.notEqual(privateControls.needsBackground, "rgba(0, 0, 0, 0)");
      assert.equal(privateControls.theirs, false);
      assert.equal(privateControls.teammateLink, true);
      assert.equal(privateControls.inSubtitle, false);
      assert.notEqual(privateControls.background, "rgba(0, 0, 0, 0)");
      assert.notEqual(privateControls.background, privateControls.color);
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
      await capture(`shared-project-${theme}.png`);
      const readsBeforeEvent = await js("window.__koedHq712Trace.reads");
      await js("window.__koedHq712Trace.teammateEdit()");
      await waitFor(
        "document.querySelector('.hq-project-view__section--todo .hq-shared-project__row b')?.textContent === 'Teammate changed the plan'",
        "Team event refresh"
      );
      assert.ok(
        (await js("window.__koedHq712Trace.reads")) > readsBeforeEvent,
        "Team event should request the authoritative shared snapshot"
      );
      await js("document.querySelector('.hq-project-sources__count').click()");
      await waitFor(
        "document.querySelector('.hq-project-sources__panel .hq-project-sources__row b')?.textContent === 'Plan.md'",
        "shared Source detail panel"
      );
      await capture(`shared-project-sources-${theme}.png`);
      await js(
        "document.querySelector('[aria-label=\"Close Sources\"]').click()"
      );
      await js("window.__koedHq712Trace.setOffline(true)");
      await js(
        "document.querySelector('[aria-label=\"Refresh shared Project\"]').click()"
      );
      await waitFor(
        "document.querySelector('.hq-shared-project [role=\"status\"]')?.textContent.includes('Offline. Shared changes are paused.')",
        "offline notice"
      );
      assert.equal(
        await js(
          "document.querySelector('[aria-label=\"Tick off Teammate changed the plan\"]')?.disabled"
        ),
        true
      );
      await capture(`shared-project-offline-${theme}.png`);
    }
    await writeFile(
      resolve(scratch, "hq-712", "HQ712.native.json"),
      JSON.stringify(
        {
          id: "HQ712.native",
          owner: "HQ-712",
          status: "pass",
          proof: "Native HqApplication shared Project fixture",
          checks: [
            "authoritative Team Work Item and source metadata",
            "Team event-shaped notification refreshes the open Project",
            "Personal Work Item controls hidden in shared Project",
            "Sources opens in the existing artifact panel",
            "offline cached read-only notice",
            "owner-bound Native merge pill and teammate public link only",
            "light and dark themes"
          ],
          screenshots: [
            "shared-project-light.png",
            "shared-project-sources-light.png",
            "shared-project-offline-light.png",
            "shared-project-dark.png",
            "shared-project-sources-dark.png",
            "shared-project-offline-dark.png"
          ]
        },
        null,
        2
      )
    );
    process.stdout.write(
      `HQ-712 native proof passed; screenshots: ${output}\n`
    );
  } finally {
    window?.destroy();
    app.quit();
  }
}

void run().catch((error) => {
  process.stderr.write(`${error.stack ?? String(error)}\n`);
  app.exit(1);
});
