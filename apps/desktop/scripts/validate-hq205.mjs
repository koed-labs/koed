import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";

const repoRoot = resolve(import.meta.dirname, "../../..");
const scratch = resolve(repoRoot, "scratch");
const images = resolve(scratch, "hq-205", "screenshots");
const projectId = "00000000-0000-4000-8000-000000002031";
const profile = process.env.KOED_HQ205_USER_DATA_DIR;
assert.ok(profile, "Use a private HQ-205 Electron profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

const run = async () => {
  let window;
  let failed = false;
  try {
    await app.whenReady();
    window = new BrowserWindow({ show: false, width: 1280, height: 800 });
    const errors = [];
    window.webContents.on("console-message", (_event, details) => {
      if (details.level === "error") errors.push(details.message);
    });
    await window.loadFile(
      resolve(repoRoot, "apps/desktop/dist/browser-validation.html"),
      {
        query: { view: "hq", hq205Capture: "yes" }
      }
    );
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 160; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(
        `HQ-205 fixture did not reach ${source}; errors: ${errors.join(" | ")}`
      );
    };
    await waitFor(
      `document.documentElement.dataset.hqFixtureReady === 'true' && Boolean(document.querySelector('[data-hq-project-link="${projectId}"]'))`
    );
    await js(
      `document.querySelector('[data-hq-project-link="${projectId}"]').click()`
    );
    await waitFor(
      "Boolean(document.querySelector('.hq-project-conversation textarea')) && Boolean(document.querySelector('.hq-project-sources__count'))"
    );
    assert.deepEqual(
      await js(`({ count: document.querySelector('.hq-project-sources__count')?.textContent.trim(),
        key: document.querySelector('.hq-project-sources__key')?.textContent.trim() })`),
      { count: "3 sources", key: "Plan.md" }
    );
    assert.equal(
      await js(
        "document.querySelectorAll('[data-hq-context][role=complementary]').length"
      ),
      1
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
    const capture = async (name) => {
      await delay(100);
      const { data } = await debuggerClient.sendCommand(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false }
      );
      await writeFile(resolve(images, name), Buffer.from(data, "base64"));
    };
    await capture("hq205-overview-light.png");
    await js("document.querySelector('.hq-project-sources__count').click()");
    await waitFor(
      "Boolean(document.querySelector('.hq-context .hq-project-sources__panel'))"
    );
    assert.deepEqual(
      await js(`({ count: document.querySelectorAll('[data-hq-context][role=complementary]').length,
      inRightPane: Boolean(document.querySelector('.hq-context__body > .hq-project-sources__host > .hq-project-sources__panel')),
      chatHidden: document.querySelector('.hq-project-sources__conversation')?.hidden,
      nestedComplementary: document.querySelectorAll('.hq-context aside, .hq-context [role=complementary]').length,
      skillGroup: document.querySelector('.hq-project-sources__panel')?.textContent.includes('Skills used here') })`),
      {
        count: 1,
        inRightPane: true,
        chatHidden: true,
        nestedComplementary: 0,
        skillGroup: true
      }
    );
    await capture("hq205-sources-light.png");
    await js(
      `document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark')`
    );
    await capture("hq205-sources-dark.png");
    await js(
      `document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')`
    );
    await js(`([...document.querySelectorAll('.hq-project-sources__row')]
      .find((row) => row.textContent.includes('code-review')))?.click()`);
    await waitFor(
      "document.querySelector('.hq-project-sources__panel')?.textContent.includes('Listing it does not run the skill')"
    );
    await capture("hq205-skill-detail-light.png");
    await js(`document.querySelector('[aria-label="Close Sources"]').click()`);
    await waitFor(
      "!document.querySelector('.hq-project-sources__panel') && !document.querySelector('.hq-project-sources__conversation')?.hidden"
    );
    assert.ok(
      await js(
        "Boolean(document.querySelector('.hq-project-conversation textarea'))"
      )
    );
    await js("document.querySelector('.hq-project-sources__count').click()");
    await waitFor(
      "Boolean(document.querySelector('.hq-project-sources__panel'))"
    );
    await js(
      "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"
    );
    await waitFor(
      "!document.querySelector('.hq-project-sources__panel') && !document.querySelector('.hq-project-sources__conversation')?.hidden"
    );
    assert.equal(errors.length, 0, errors.join(" | "));
    await writeFile(
      resolve(scratch, "hq-205", "browser-report.json"),
      JSON.stringify(
        {
          id: "S09.1",
          owner: "HQ-205",
          status: "pass",
          assertion:
            "Skills listed with Project sources; skill addition explained",
          checks: [
            "three sources and top key chip",
            "skill group and explanation",
            "one right context pane",
            "close and Escape restore HQ"
          ],
          screenshots: [
            "hq205-overview-light.png",
            "hq205-sources-light.png",
            "hq205-sources-dark.png",
            "hq205-skill-detail-light.png"
          ]
        },
        null,
        2
      )
    );
    process.stdout.write(`HQ-205 Electron captures: ${images}\n`);
    debuggerClient.detach();
  } catch (cause) {
    failed = true;
    process.stderr.write(
      `${cause instanceof Error ? cause.stack : String(cause)}\n`
    );
  } finally {
    app.exit(failed ? 1 : 0);
  }
};

void run().catch((cause) => {
  process.stderr.write(
    `${cause instanceof Error ? cause.stack : String(cause)}\n`
  );
  app.exit(1);
});
