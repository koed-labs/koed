import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const images = resolve(scratch, "hq-407", "screenshots");
const profile = process.env.KOED_HQ407_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-407 profile under scratch.");
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
      {
        query: { view: "hq", hq407Capture: "yes" }
      }
    );
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 160; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      const state = await js(
        `({ location: location.href, tabs:[...document.querySelectorAll('.hq-project-context-tabs [role=tab]')].map(t=>({text:t.textContent,selected:t.getAttribute('aria-selected')})), labels: [...document.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label')).filter((label) => ['Now', 'Needs you', 'To do', 'Work brief'].includes(label)), content: document.querySelector('.hq-main__content')?.textContent.slice(0, 500) })`
      );
      throw new Error(
        `HQ-407 UI did not reach ${source}: ${JSON.stringify(state)} ${errors.join(" | ")}`
      );
    };
    await waitFor(
      "document.querySelector('[aria-label=\"Needs you\"] .hq-now__due-row')?.textContent.includes('Finish overdue reading')"
    );
    assert.deepEqual(
      await js(`({
      rows: [...document.querySelectorAll('[aria-label="Needs you"] .hq-now__due-row')].map((row) => row.textContent.trim()),
      week: document.querySelector('[aria-label="Due this week"]')?.textContent
    })`),
      {
        rows: [
          "Finish overdue readingOverdue 1d · New empty Project›",
          "Review release notesDue today · New empty Project›",
          "Prepare tomorrow's notesDue tomorrow · New empty Project›"
        ],
        week: "Due this week: Check the launch copy · Study Friday examples"
      }
    );
    await mkdir(images, { recursive: true });
    const capture = async (name) => {
      await delay(100);
      const { data } = await debuggerClient.sendCommand(
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: false
        }
      );
      await writeFile(resolve(images, name), Buffer.from(data, "base64"));
    };
    await capture("now-deadlines-light.png");
    await js(
      "document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark')"
    );
    await capture("now-deadlines-dark.png");
    await js(
      "document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')"
    );
    await js(
      "document.querySelector('[aria-label=\"Due this week\"] .hq-now__due-week-head').click()"
    );
    assert.ok(
      await js(
        "document.querySelector('[aria-label=\"Due this week\"] .hq-now__due-week-list')?.textContent.includes('Study Friday examples')"
      )
    );
    await js(
      "document.querySelector('[aria-label=\"Needs you\"] .hq-now__due-row').click()"
    );
    await waitFor(
      "document.querySelector('[aria-label=\"Needs you\"]')?.textContent.includes('Finish overdue reading')"
    );
    await waitFor(
      "document.querySelector('.hq-project-view__brief')?.textContent.includes('Finish overdue reading')"
    );
    assert.ok(
      await js(
        "[...document.querySelectorAll('[aria-label=\"Working now\"] .hq-project-view__work-item')].some((item) => item.textContent.includes('Check the launch copy') && item.textContent.includes('Due Fri'))"
      )
    );
    assert.ok(
      await js(
        "[...document.querySelectorAll('[aria-label=\"To do\"] .hq-project-view__work-item')].some((item) => item.textContent.includes('Study Friday examples') && item.textContent.includes('Due Fri'))"
      )
    );
    assert.equal(
      await js(
        'document.querySelector(\'[aria-label="To do"]\')?.textContent.includes("Prepare tomorrow\'s notes")'
      ),
      false
    );
    await capture("project-due-light.png");
    await js(
      "document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark')"
    );
    await capture("project-due-dark.png");
    await js(
      "document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')"
    );
    await js(
      `{ const row = [...document.querySelectorAll('[aria-label="To do"] .hq-project-view__work-item')].find((item) => item.textContent.includes('Study Friday examples')); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); }`
    );
    await waitFor(
      'document.querySelector(\'[role="menu"][aria-label="Due date for Study Friday examples"]\')'
    );
    assert.deepEqual(
      await js(
        '[...document.querySelectorAll(\'[role="menu"][aria-label="Due date for Study Friday examples"] [role="menuitem"]\')].map((item) => item.textContent)'
      ),
      [
        "Today",
        "Tomorrow",
        "Friday",
        "Next week",
        "No date",
        "Send to an Agent"
      ]
    );
    await capture("project-due-menu-light.png");
    await js(
      '[...document.querySelectorAll(\'[role="menu"][aria-label="Due date for Study Friday examples"] [role="menuitem"]\')].find((item) => item.textContent === \'Tomorrow\').click()'
    );
    await waitFor(
      "[...document.querySelectorAll('[aria-label=\"Needs you\"] .hq-project-view__work-item')].find((item) => item.textContent.includes('Study Friday examples'))?.textContent.includes('Due tomorrow')"
    );
    await js(
      `{ const field = document.querySelector('[aria-label="To do"] input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(field, 'Book a study room by Friday'); field.dispatchEvent(new Event('input', { bubbles: true })); }`
    );
    await waitFor(
      "!document.querySelector('[aria-label=\"To do\"] button[type=submit]').disabled"
    );
    await js(
      "document.querySelector('[aria-label=\"To do\"] button[type=submit]').click()"
    );
    await waitFor(
      "[...document.querySelectorAll('[aria-label=\"To do\"] .hq-project-view__work-item')].some((item) => item.textContent.includes('Book a study room') && item.textContent.includes('Due Fri'))"
    );

    await window.loadFile(
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      {
        query: { view: "hq", hq407Capture: "yes", hq712Capture: "yes" }
      }
    );
    await waitFor(
      "[...document.querySelectorAll('[aria-label=\"Needs you\"] .hq-now__due-row')].some((row) => row.textContent.includes('Finish shared overdue reading'))"
    );
    assert.equal(
      await js(
        "[...document.querySelectorAll('[aria-label=\"Needs you\"] .hq-now__due-row')].some((row) => row.textContent.includes('Finish overdue reading') && !row.textContent.includes('shared'))"
      ),
      false
    );
    assert.ok(
      await js(
        "document.querySelector('[aria-label=\"Due this week\"]')?.textContent.includes('Study shared Friday examples')"
      )
    );
    await capture("shared-now-deadlines-light.png");
    await js(
      "document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark')"
    );
    await capture("shared-now-deadlines-dark.png");
    await js(
      "document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')"
    );
    await js(
      "[...document.querySelectorAll('[aria-label=\"Needs you\"] .hq-now__due-row')].find((row) => row.textContent.includes('Finish shared overdue reading')).click()"
    );
    await waitFor(
      "document.activeElement?.dataset.sharedWorkItemId === '00000000-0000-4000-8000-000000004074'"
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-project-view__brief')?.textContent.includes('Finish shared overdue reading') ?? false"
      ),
      false
    );
    await capture("shared-project-due-light.png");
    await js(
      "document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark')"
    );
    await capture("shared-project-due-dark.png");
    await js(
      "document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')"
    );
    await js(
      `{ const row = document.querySelector('[data-shared-work-item-id="00000000-0000-4000-8000-000000004074"]'); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); }`
    );
    await waitFor(
      'document.querySelector(\'[role="menu"][aria-label="Due date for Finish shared overdue reading"]\')'
    );
    assert.deepEqual(
      await js(
        '[...document.querySelectorAll(\'[role="menu"][aria-label="Due date for Finish shared overdue reading"] [role="menuitem"]\')].map((item) => item.textContent)'
      ),
      ["Today", "Tomorrow", "Friday", "Next week", "No date"]
    );
    await capture("shared-project-due-menu-light.png");
    await js(
      '[...document.querySelectorAll(\'[role="menu"][aria-label="Due date for Finish shared overdue reading"] [role="menuitem"]\')].find((item) => item.textContent === \'Tomorrow\').click()'
    );
    await waitFor(
      "document.querySelector('[data-shared-work-item-id=\"00000000-0000-4000-8000-000000004074\"]')?.textContent.includes('Due tomorrow')"
    );
    assert.ok(await js("window.__koedHq712Trace.writes >= 1"));
    await js(
      "window.__koedHq712Trace.setOffline(true); document.querySelector('[aria-label=\"Refresh shared Project\"]').click()"
    );
    await waitFor(
      "document.querySelector('.hq-shared-project__notice')?.textContent.includes('Offline. Shared changes are paused.')"
    );
    assert.equal(
      await js(
        "document.querySelector('[data-shared-work-item-id=\"00000000-0000-4000-8000-000000004074\"] .hq-due__trigger')?.disabled"
      ),
      true
    );
    await window.loadFile(
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      {
        query: {
          view: "hq",
          hq407Capture: "yes",
          hq711Capture: "yes",
          hq701Linked: "yes",
          hq705Capture: "yes"
        }
      }
    );
    await waitFor("document.documentElement.dataset.hqFixtureReady === 'true'");
    await js(
      "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]')?.click()"
    );
    await waitFor(
      "document.querySelector('.hq-project-context-tabs [role=tab][aria-selected=true]')?.textContent.includes('Just me')"
    );
    const existingSyllabusTodoCount = await js(
      "[...document.querySelectorAll('.hq-shared-project__row')].filter(row => row.textContent.includes('Study Friday examples')).length"
    );
    assert.equal(existingSyllabusTodoCount, 1);
    assert.ok(
      await js(
        "document.querySelector('.hq-project-view__sources')?.textContent.includes('Syllabus.pdf') ?? document.body.textContent.includes('Syllabus.pdf')"
      )
    );
    await js(`(() => {
      const input = document.querySelector('.hq-project-conversation textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, 'Turn Syllabus.pdf into to-dos');
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    })()`);
    await delay(40);
    await js(
      "document.querySelector('.hq-project-conversation form')?.requestSubmit()"
    );
    await waitFor(
      "window.__koedHq204Trace.firstPrompt === 'Turn Syllabus.pdf into to-dos' && document.querySelector('.hq-project-context-tabs__content:not([hidden])')?.textContent.includes('Syllabus.pdf already has a to-do')"
    );
    assert.equal(
      await js(
        "[...document.querySelectorAll('.hq-shared-project__row')].filter(row => row.textContent.includes('Study Friday examples')).length"
      ),
      existingSyllabusTodoCount
    );
    await js(
      "document.querySelector('.hq-project-context-tabs [role=tab]:last-child')?.click()"
    );
    await waitFor(
      "document.querySelector('.hq-project-context-tabs [role=tab]:last-child')?.getAttribute('aria-selected') === 'true'"
    );
    await waitFor(
      "document.querySelector('.hq-project-thread__people')?.textContent.includes('Lena') && document.querySelector('.hq-project-thread__people')?.textContent.includes('Omar')"
    );
    assert.equal(errors.length, 0, errors.join(" | "));
    await writeFile(
      resolve(scratch, "hq-407", "HQ407.native.json"),
      JSON.stringify(
        {
          id: "HQ407.native",
          owner: "HQ-407",
          status: "pass",
          checks: [
            "viewer-local overdue, today and tomorrow ordering in Now",
            "Due this week expansion beyond tomorrow",
            "exact Work Item navigation to Project brief",
            "Working now and To do retain due chips while tomorrow moves to Needs you",
            "right-click Due menu moves a Friday item to tomorrow's Needs you",
            "by-Friday entry creates a dated Work Item",
            "linked Team deadlines come from the paged shared service, focus exact Team rows, and keep private rows out of Now",
            "shared Due menu saves through Team item version and disables offline",
            "typed Syllabus.pdf prompt returns already-has-a-to-do without duplicate and Team tab shows Lena/Omar",
            "light and dark native Desktop captures"
          ],
          screenshots: [
            "now-deadlines-light.png",
            "now-deadlines-dark.png",
            "project-due-light.png",
            "project-due-dark.png",
            "project-due-menu-light.png",
            "shared-now-deadlines-light.png",
            "shared-now-deadlines-dark.png",
            "shared-project-due-light.png",
            "shared-project-due-dark.png",
            "shared-project-due-menu-light.png"
          ],
          proofIds: ["S21.1.syllabus-repeat-team-audience"]
        },
        null,
        2
      )
    );
    debuggerClient.detach();
    process.stdout.write(`HQ-407 native validation: ${images}\n`);
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
