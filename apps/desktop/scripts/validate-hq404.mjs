import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const images = resolve(scratch, "hq-404", "screenshots");
const profile = process.env.KOED_HQ404_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-404 profile under scratch.");
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
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      {
        query: { view: "hq", hq404Capture: "yes" }
      }
    );
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 160; attempt += 1) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(
        `HQ-404 UI did not reach ${source}: ${errors.join(" | ")}`
      );
    };
    await waitFor(
      "Boolean(document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]'))"
    );
    await js(
      "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]').click()"
    );
    await waitFor(
      "Boolean(document.querySelector('[aria-label=\"To do\"] .hq-project-view__send:not(:disabled)'))"
    );
    await js(
      "document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light'); document.querySelector('[aria-label=\"To do\"] .hq-project-view__send').scrollIntoView({block:'center'})"
    );
    assert.equal(
      await js(
        "getComputedStyle(document.querySelector('.hq-project-view')).color"
      ),
      "rgb(24, 24, 27)"
    );
    await debuggerClient(window).sendCommand(
      "Emulation.setDeviceMetricsOverride",
      {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false
      }
    );
    await mkdir(images, { recursive: true });
    const capture = async (name) => {
      await delay(100);
      const { data } = await debuggerClient(window).sendCommand(
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: false
        }
      );
      await writeFile(resolve(images, name), Buffer.from(data, "base64"));
    };
    await capture("work-items-light.png");
    await js(
      "document.querySelector('[aria-label=\"To do\"] .hq-project-view__send').click()"
    );
    await waitFor(
      "Boolean(document.querySelector('.hq-project-view__send-menu [role=menuitem]'))"
    );
    assert.ok(
      await js(
        "document.querySelector('.hq-project-view__send-menu').textContent.includes('Quinn')"
      )
    );
    await capture("send-menu-light.png");
    await js(
      "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"
    );
    await waitFor("!document.querySelector('.hq-project-view__send-menu')");
    assert.ok(
      await js("document.activeElement?.matches('.hq-project-view__send')")
    );
    await js(
      "document.querySelector('[aria-label=\"To do\"] .hq-project-view__send').click()"
    );
    await waitFor(
      "Boolean(document.querySelector('.hq-project-view__send-menu'))"
    );
    await js(
      "document.querySelector('.hq-project-view__section-head').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))"
    );
    await waitFor("!document.querySelector('.hq-project-view__send-menu')");
    await js(
      "document.querySelector('[aria-label=\"To do\"] .hq-project-view__send').click()"
    );
    await waitFor(
      "Boolean(document.querySelector('.hq-project-view__send-menu'))"
    );
    await js(
      "document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark')"
    );
    assert.equal(
      await js(
        "getComputedStyle(document.querySelector('.hq-project-view')).color"
      ),
      "rgb(244, 244, 245)"
    );
    await capture("send-menu-dark.png");
    await js(
      "document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')"
    );
    await js(
      "Array.from(document.querySelectorAll('.hq-project-view__send-menu [role=menuitem]')).find((row) => row.textContent.includes('Quinn')).click()"
    );
    await waitFor(
      "Boolean(document.querySelector('[aria-label=\"Working now\"] .hq-project-view__work-item'))"
    );
    assert.ok(
      await js(
        "document.querySelector('[aria-label=\"Working now\"]').textContent.includes('Agent working')"
      )
    );
    await capture("work-started-light.png");
    await waitFor("Boolean(document.querySelector('.hq-project-view__brief'))");
    assert.ok(
      await js(
        "document.querySelector('.hq-project-view__brief .hq-project-view__brief-goal')?.textContent.includes('Tidy the Project brief')"
      )
    );
    assert.ok(
      await js(
        "document.querySelector('.hq-project-view__brief-state')?.textContent.includes('Working now') && document.querySelector('.hq-project-view__brief-state')?.textContent.includes('Quinn')"
      )
    );
    await waitFor(
      "document.querySelector('.hq-project-view__brief-log')?.textContent.includes('Read the Work Item goal and Project Sources')"
    );
    await capture("work-brief-light.png");
    await js(
      "document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark')"
    );
    await capture("work-brief-dark.png");
    await js(
      "document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')"
    );
    await js(
      "document.querySelector('[aria-label=\"Working now\"] .hq-project-view__send').click()"
    );
    await waitFor(
      "Boolean(document.querySelector('.hq-project-view__send-menu [role=menuitem]'))"
    );
    await js(
      "Array.from(document.querySelectorAll('.hq-project-view__send-menu [role=menuitem]')).find((row) => row.textContent.includes('Quinn')).click()"
    );
    await waitFor(
      "Boolean(document.querySelector('[data-hq-conversation]')) || !Boolean(document.querySelector('.hq-project-view'))"
    );
    assert.equal(await js("window.__hq404ExecutionStarts"), 1);
    assert.equal(errors.length, 0, errors.join(" | "));
    await writeFile(
      resolve(scratch, "hq-404", "browser-report.json"),
      JSON.stringify(
        {
          id: "HQ404.native",
          owner: "HQ-404",
          status: "pass",
          checks: [
            "Agent picker from Work Item arrow",
            "send starts Working now",
            "work brief shows goal, current Agent, and actual runtime fixture update",
            "repeat Send opens the linked captured Conversation",
            "computed light and dark theme colors"
          ],
          screenshots: [
            "work-items-light.png",
            "send-menu-light.png",
            "send-menu-dark.png",
            "work-started-light.png",
            "work-brief-light.png",
            "work-brief-dark.png"
          ]
        },
        null,
        2
      )
    );
    debuggerClient(window).detach();
    process.stdout.write(`HQ-404 native validation: ${images}\n`);
  } catch (error) {
    failed = true;
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`
    );
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    app.exit(failed ? 1 : 0);
  }
};

const debuggerClient = (window) => {
  const client = window.webContents.debugger;
  if (!client.isAttached()) client.attach("1.3");
  return client;
};

void run();
