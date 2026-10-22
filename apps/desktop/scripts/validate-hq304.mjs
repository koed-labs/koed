import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const images = resolve(scratch, "hq-304", "screenshots");
const profile = process.env.KOED_HQ304_USER_DATA_DIR;
assert.ok(
  profile,
  "Set KOED_HQ304_USER_DATA_DIR to an isolated scratch profile."
);
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

const run = async () => {
  let window;
  try {
    await app.whenReady();
    window = new BrowserWindow({ show: false, width: 1280, height: 800 });
    const errors = [];
    window.webContents.on("console-message", (_event, details) => {
      if (details.level === "error") errors.push(details.message);
    });
    await window.loadFile(
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      { query: { view: "hq", hq304Capture: "yes" } }
    );
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(`HQ304 timed out: ${source}; ${errors.join(" | ")}`);
    };
    await waitFor("document.documentElement.dataset.hqFixtureReady === 'true'");
    await js(
      "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]').click()"
    );
    await waitFor(
      "Boolean(document.querySelector('button[aria-label=\"What Koed knows\"]'))"
    );
    await js(
      "document.querySelector('button[aria-label=\"What Koed knows\"]').click()"
    );
    await waitFor(
      "document.querySelector('.hq-knows__item strong')?.textContent === 'Ship the smaller launch first'"
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-project-conversation__inspector')?.hidden"
      ),
      false
    );
    assert.equal(
      await js(
        "Math.round(document.querySelector('.hq-knows').getBoundingClientRect().width)"
      ),
      397
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-knows__tabs [aria-selected=true]')?.textContent"
      ),
      "Project1"
    );
    assert.equal(
      await js(
        "Boolean(document.querySelector('.hq-project-conversation textarea:not(:disabled)'))"
      ),
      true
    );
    const debuggerClient = window.webContents.debugger;
    debuggerClient.attach("1.3");
    await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    });
    await mkdir(images, { recursive: true });
    const capture = async (name, theme) => {
      await js(
        `document.documentElement.classList.remove('light','dark'); document.documentElement.classList.add('${theme}')`
      );
      assert.equal(
        await js(`document.documentElement.classList.contains('${theme}')`),
        true
      );
      const expected =
        theme === "light" ? "rgb(251, 251, 252)" : "rgb(5, 5, 7)";
      assert.equal(
        await js(
          "getComputedStyle(document.querySelector('[data-hq-shell]')).getPropertyValue('--hq-bg').trim()"
        ),
        theme === "light" ? "#fbfbfc" : "#050507"
      );
      assert.equal(
        await js(
          "getComputedStyle(document.querySelector('[data-hq-shell]')).backgroundColor"
        ),
        expected
      );
      await delay(100);
      const { data } = await debuggerClient.sendCommand(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false }
      );
      await writeFile(resolve(images, name), Buffer.from(data, "base64"));
    };
    await capture("memory-project-light.png", "light");
    await capture("memory-project-dark.png", "dark");
    await js("document.querySelector('.hq-knows__item').click()");
    await waitFor("Boolean(document.querySelector('.hq-knows__replaces'))");
    assert.match(
      await js("document.querySelector('.hq-knows__replaces')?.textContent"),
      /Use the old launch plan/
    );
    await capture("memory-detail-light.png", "light");
    await js("document.querySelector('.hq-knows__back').click()");
    await js(
      "document.querySelector('.hq-knows__tabs button:nth-child(2)').click()"
    );
    await waitFor(
      "document.querySelector('.hq-knows__item strong')?.textContent === 'Prefer concise updates'"
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-knows__body')?.textContent.includes('Ship the smaller launch first')"
      ),
      false
    );
    assert.equal(
      await js("document.querySelector('.hq-knows__note')?.textContent.trim()"),
      "Only your agents see this in every Project. Nothing here is shared with your Team.",
      "S18.2: Me scope explains that it is not Team-shared"
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-knows__body')?.textContent.includes('The legacy note needs a home')"
      ),
      false,
      "S18.2: legacy unscoped memory stays outside Me"
    );
    await capture("memory-me-light.png", "light");
    await js("document.querySelector('.hq-knows__forget').click()");
    await waitFor("Boolean(document.querySelector('.hq-knows__undo button'))");
    assert.equal(
      await js("Boolean(document.querySelector('.hq-knows__item'))"),
      false
    );
    await js("document.querySelector('.hq-knows__undo button').click()");
    await waitFor(
      "document.querySelector('.hq-knows__item strong')?.textContent === 'Prefer concise updates'"
    );
    await js(
      "document.querySelector('.hq-knows__tabs button:nth-child(3)').click()"
    );
    await waitFor(
      "document.querySelector('.hq-knows__item strong')?.textContent === 'The legacy note needs a home'"
    );
    await js(
      "document.querySelector('.hq-knows__row select').value='me'; document.querySelector('.hq-knows__row select').dispatchEvent(new Event('change',{bubbles:true}))"
    );
    await waitFor("!document.querySelector('.hq-knows__item')");
    await js(
      "document.querySelector('.hq-knows__tabs button:nth-child(2)').click()"
    );
    await waitFor("document.querySelectorAll('.hq-knows__item').length === 2");
    assert.equal(errors.length, 0, errors.join(" | "));
    await writeFile(
      resolve(scratch, "hq-304", "browser-report.json"),
      JSON.stringify(
        {
          id: "HQ304.native",
          owner: "HQ-304",
          status: "pass",
          assertions: [
            {
              id: "S18.2",
              owner: "HQ-304",
              status: "pass",
              checks: [
                "Me-private-disclosure",
                "legacy-unscoped-excluded",
                "Forget-and-Undo"
              ]
            }
          ],
          checks: [
            "Project/Me/Other separation",
            "replacement detail",
            "Forget and token-bound Undo",
            "Move to Me",
            "composer remains available",
            "light and dark captures"
          ],
          screenshots: [
            "memory-project-light.png",
            "memory-project-dark.png",
            "memory-detail-light.png",
            "memory-me-light.png"
          ]
        },
        null,
        2
      )
    );
  } finally {
    window?.destroy();
    app.quit();
  }
};
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  app.quit();
});
