import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";

const repoRoot = resolve(import.meta.dirname, "../../..");
const scratch = resolve(repoRoot, "scratch");
const images = resolve(scratch, "hq-204", "screenshots");
const projectId = "00000000-0000-4000-8000-000000002038";
const profile = process.env.KOED_HQ204_USER_DATA_DIR;
assert.ok(profile, "Use run-hq-validation.mjs to create a private HQ profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

const run = async () => {
  let window;
  let failed = false;
  try {
    process.stdout.write("HQ-204 Electron: waiting for ready\n");
    await app.whenReady();
    process.stdout.write("HQ-204 Electron: ready\n");
    window = new BrowserWindow({ show: false, width: 1280, height: 800 });
    const errors = [];
    window.webContents.on("console-message", (_event, details) => {
      if (details.level === "error") errors.push(details.message);
    });
    await window.loadFile(
      resolve(repoRoot, "apps/desktop/dist/browser-validation.html"),
      {
        query: { view: "hq", hq204Capture: "yes" }
      }
    );
    process.stdout.write("HQ-204 Electron: fixture loaded\n");
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 160; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(
        `HQ-204 fixture did not reach ${source}; errors: ${errors.join(" | ")}; page: ${JSON.stringify(await js("document.body.textContent.slice(0, 1200)"))}`
      );
    };
    await waitFor(
      "document.documentElement.dataset.hqFixtureReady === 'true' && Boolean(document.querySelector('[data-hq-project-link]'))"
    );
    process.stdout.write("HQ-204 Electron: fixture ready\n");
    assert.notEqual(
      process.env.KOED_HQ204_FORCE_FAILURE,
      "1",
      "HQ-204 failure probe"
    );
    process.stdout.write(
      `HQ-204 Electron: project links ${JSON.stringify(await js("[...document.querySelectorAll('[data-hq-project-link]')].map((node) => node.getAttribute('data-hq-project-link'))"))}\n`
    );
    process.stdout.write(
      `HQ-204 Electron: desktop api ${JSON.stringify(await js("({ hq: Boolean(window.koedDesktop?.projectHqConversation), agents: Boolean(window.koedDesktop?.agents) })"))}\n`
    );
    await js(
      `document.querySelector('[data-hq-project-link="${projectId}"]')?.click()`
    );
    await waitFor(
      "Boolean(document.querySelector('.hq-project-conversation textarea'))"
    );
    process.stdout.write("HQ-204 Electron: private pane ready\n");
    assert.equal(
      await js(
        "document.querySelectorAll('[data-hq-context][role=complementary]').length"
      ),
      1
    );
    assert.deepEqual(
      await js(
        `({ reserve: window.__koedHq204Trace.reserveByProject["${projectId}"], start: window.__koedHq204Trace.start })`
      ),
      { reserve: 1, start: 0 }
    );
    const ordinaryRowCount = await js(
      "document.querySelectorAll('[data-hq-chat-row]').length"
    );
    assert.ok(ordinaryRowCount > 0);
    const assertPrivateAbsentFromSidebar = async () => {
      assert.equal(
        await js(
          `document.querySelectorAll('[data-hq-chat-row][data-hq-chat-project="${projectId}"]').length`
        ),
        0
      );
      assert.equal(
        await js(
          "[...document.querySelectorAll('[data-hq-chat-row]')].some((row) => row.textContent.includes('HQ Conversation'))"
        ),
        false
      );
      assert.equal(
        await js("document.querySelectorAll('[data-hq-chat-row]').length"),
        ordinaryRowCount
      );
    };
    await assertPrivateAbsentFromSidebar();
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
        `document.documentElement.classList.toggle('dark', ${theme === "dark"}); document.documentElement.classList.toggle('light', ${theme === "light"})`
      );
      await delay(120);
      const { data } = await debuggerClient.sendCommand(
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: false
        }
      );
      await writeFile(resolve(images, name), Buffer.from(data, "base64"));
    };
    await capture("hq204-empty-light.png", "light");
    await capture("hq204-empty-dark.png", "dark");
    process.stdout.write("HQ-204 Electron: empty captures saved\n");
    await js(`(() => {
    const textarea = document.querySelector('.hq-project-conversation textarea');
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setValue.call(textarea, 'Plan my next study session');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
    await delay(40);
    await js(
      "document.querySelector('.hq-project-conversation form')?.requestSubmit()"
    );
    await waitFor(
      "Boolean(document.querySelector('.hq-project-conversation__active .hq-conversation'))"
    );
    process.stdout.write("HQ-204 Electron: active pane ready\n");
    await waitFor(
      "document.querySelector('.hq-project-conversation__active')?.textContent.includes('Plan my next study session')"
    );
    assert.deepEqual(
      await js(
        "({ start: window.__koedHq204Trace.start, firstPrompt: window.__koedHq204Trace.firstPrompt })"
      ),
      { start: 1, firstPrompt: "Plan my next study session" }
    );
    await capture("hq204-started-light.png", "light");
    await capture("hq204-started-dark.png", "dark");
    const inspectCount = await js("window.__koedHq204Trace.inspect");
    await delay(1_200);
    assert.equal(
      await js("window.__koedHq204Trace.inspect"),
      inspectCount,
      "Inspect must stop polling after HQ identity is ready"
    );
    await js(`(() => {
    const textarea = document.querySelector('.hq-project-conversation__active textarea');
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setValue.call(textarea, 'Make a short outline');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
    await delay(40);
    await js(
      "document.querySelector('.hq-project-conversation__active form')?.requestSubmit()"
    );
    await waitFor("window.__koedHq204Trace.send === 1");
    assert.equal(
      await js("window.__koedHq204Trace.nextPrompt"),
      "Make a short outline"
    );
    assert.equal(
      await js(
        "document.querySelectorAll('[data-hq-context][role=complementary]').length"
      ),
      1
    );
    await assertPrivateAbsentFromSidebar();
    await js(
      "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002031\"]')?.click()"
    );
    await waitFor(
      "window.__koedHq204Trace.reserveByProject['00000000-0000-4000-8000-000000002031'] === 1"
    );
    await js(
      `document.querySelector('[data-hq-project-link="${projectId}"]')?.click()`
    );
    await waitFor(
      "Boolean(document.querySelector('.hq-project-conversation__active'))"
    );
    await assertPrivateAbsentFromSidebar();
    assert.deepEqual(
      await js(
        `({ reserve: window.__koedHq204Trace.reserveByProject["${projectId}"], start: window.__koedHq204Trace.start })`
      ),
      { reserve: 2, start: 1 }
    );
    assert.equal(errors.length, 0, errors.join(" | "));
    process.stdout.write(`HQ-204 Electron captures: ${images}\n`);
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
