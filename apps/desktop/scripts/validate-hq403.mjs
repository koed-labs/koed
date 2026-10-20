import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const images = resolve(scratch, "hq-403", "screenshots");
const profile = process.env.KOED_HQ403_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-403 profile under scratch.");
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
    await window.loadURL("about:blank");
    const debuggerClient = window.webContents.debugger;
    debuggerClient.attach("1.3");
    await debuggerClient.sendCommand("Page.enable");
    await debuggerClient.sendCommand("Emulation.setTimezoneOverride", {
      timezoneId: "Europe/Oslo"
    });
    await debuggerClient.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const NativeDate = Date;
        const fixed = NativeDate.parse("2026-10-20T12:00:00.000Z");
        function FrozenDate(...args) {
          if (new.target) return new NativeDate(...(args.length ? args : [fixed]));
          return new NativeDate(fixed).toString();
        }
        Object.setPrototypeOf(FrozenDate, NativeDate);
        FrozenDate.prototype = NativeDate.prototype;
        FrozenDate.now = () => fixed;
        globalThis.Date = FrozenDate;
      })();`
    });
    await window.loadFile(
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      { query: { view: "hq", hq403Capture: "yes" } }
    );
    const js = (source) => window.webContents.executeJavaScript(source);
    assert.deepEqual(
      await js(
        `({ now: new Date().toISOString(), zone: Intl.DateTimeFormat().resolvedOptions().timeZone, parse: Date.parse("2026-10-20T12:00:00.000Z"), utc: Date.UTC(2026, 9, 20, 12) })`
      ),
      {
        now: "2026-10-20T12:00:00.000Z",
        zone: "Europe/Oslo",
        parse: 1792497600000,
        utc: 1792497600000
      }
    );
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 160; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(
        `HQ-403 UI did not reach ${source}: ${errors.join(" | ")}`
      );
    };
    await waitFor(
      "Boolean(document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]'))"
    );
    await js(
      "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]').click()"
    );
    await waitFor(
      "Boolean(document.querySelector('[aria-label=\"To do\"] input:not(:disabled)'))"
    );
    assert.deepEqual(
      await js(
        `({ todo: document.querySelector('[aria-label="To do"] .hq-project-view__section-head span')?.textContent, doing: document.querySelector('[aria-label="Working now"] .hq-project-view__section-head span')?.textContent, done: document.querySelector('[aria-label="Done today"] .hq-project-view__section-head span')?.textContent, blocked: document.querySelector('[aria-label="Needs you"]')?.textContent.includes('Fix the build failure') })`
      ),
      { todo: "6", doing: "6", done: "1", blocked: true }
    );
    assert.deepEqual(
      await js(
        `({ todoVisible: document.querySelectorAll('[aria-label="To do"] .hq-project-view__work-item').length, todoMore: document.querySelector('[aria-label="To do"] .hq-project-view__more')?.textContent.trim(), review: document.querySelector('[aria-label="In review"] .hq-project-view__section-head span')?.textContent, activityBars: document.querySelectorAll('.hq-project-view__spark i').length })`
      ),
      { todoVisible: 5, todoMore: "Show 1 more", review: "1", activityBars: 7 }
    );
    for (const label of [
      "Needs you",
      "Working now",
      "To do",
      "In review",
      "Done today"
    ]) {
      await js(
        `document.querySelector('[aria-label="${label}"] .hq-project-view__section-head').click()`
      );
      assert.equal(
        await js(
          `document.querySelector('[aria-label="${label}"] .hq-project-view__section-head').getAttribute('aria-expanded')`
        ),
        "false"
      );
      await js(
        `document.querySelector('[aria-label="${label}"] .hq-project-view__section-head').click()`
      );
    }
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
    await capture("project-work-items-light.png");
    await js(
      "document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark')"
    );
    await capture("project-work-items-dark.png");
    await js(
      "document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')"
    );
    await js("document.querySelector('.hq-main__content')?.scrollTo(0, 800)");
    await capture("project-work-items-sections-light.png");
    await js(
      "document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark')"
    );
    await capture("project-work-items-sections-dark.png");
    await js(
      "document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')"
    );
    await js(
      `{ const field = document.querySelector('[aria-label="To do"] input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(field, 'Send launch summary by Friday'); field.dispatchEvent(new Event('input', { bubbles: true })); }`
    );
    await waitFor(
      "!document.querySelector('[aria-label=\"To do\"] button[type=submit]').disabled"
    );
    await js(
      "document.querySelector('[aria-label=\"To do\"] button[type=submit]').click()"
    );
    await waitFor(
      "document.querySelector('[aria-label=\"To do\"]')?.textContent.includes('Send launch summary')"
    );
    assert.ok(
      await js(
        "document.querySelector('[aria-label=\"To do\"]')?.textContent.includes('Due Fri')"
      )
    );
    assert.equal(
      await js(
        "document.querySelector('[aria-label=\"To do\"] .hq-project-view__section-head span').textContent"
      ),
      "7"
    );
    await js(
      "document.querySelector('[aria-label=\"To do\"] .hq-project-view__tick').click()"
    );
    await waitFor(
      "document.querySelector('[aria-label=\"To do\"] .hq-project-view__section-head span').textContent === '6'"
    );
    assert.equal(
      await js(
        "document.querySelector('[aria-label=\"Done today\"] .hq-project-view__section-head span').textContent"
      ),
      "2"
    );
    assert.equal(errors.length, 0, errors.join(" | "));
    await writeFile(
      resolve(scratch, "hq-403", "browser-report.json"),
      JSON.stringify(
        {
          id: "HQ403.native",
          status: "pass",
          checks: [
            "Work Item Needs you, Working now, To do, In review and Done today sections",
            "five visible to-dos with Show 1 more",
            "five foldable section heads",
            "seven actual Project activity bars",
            "to-do creation with by-Friday due phrase",
            "versioned tick-off moves an item into Done today",
            "light and dark native captures of upper and lower Project HQ"
          ],
          screenshots: [
            "project-work-items-light.png",
            "project-work-items-dark.png",
            "project-work-items-sections-light.png",
            "project-work-items-sections-dark.png"
          ]
        },
        null,
        2
      )
    );
    debuggerClient.detach();
    process.stdout.write(`HQ-403 native validation: ${images}\n`);
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
void run();
