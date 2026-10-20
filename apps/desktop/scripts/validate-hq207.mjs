import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";

const repoRoot = resolve(import.meta.dirname, "../../..");
const scratch = resolve(repoRoot, "scratch");
const images = resolve(scratch, "hq-207", "screenshots");
const projectId = "00000000-0000-4000-8000-000000002038";
const profile = process.env.KOED_HQ207_USER_DATA_DIR;
assert.ok(
  profile,
  "Use run-hq-validation.mjs to create an isolated HQ-207 profile."
);
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
        query: { view: "hq", hq207Capture: "yes" }
      }
    );
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 160; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(
        `HQ-207 fixture did not reach ${source}; errors: ${errors.join(" | ")}`
      );
    };
    await waitFor(
      `document.documentElement.dataset.hqFixtureReady === 'true' && Boolean(document.querySelector('[data-hq-project-link="${projectId}"]'))`
    );
    await js(
      `document.querySelector('[data-hq-project-link="${projectId}"]').click()`
    );
    await waitFor(
      "Boolean(document.querySelector('.hq-project-view__activity')) && Boolean(document.querySelector('.hq-project-sources__key')) && Boolean(document.querySelector('.hq-project-conversation textarea:not(:disabled)'))"
    );
    assert.deepEqual(
      await js(`({ title: document.querySelector('.hq-project-view h1')?.textContent,
      folder: document.querySelector('.hq-project-view__identity > span')?.textContent,
      activity: document.querySelector('.hq-project-view__activity')?.textContent.trim(),
      sparkBars: document.querySelectorAll('.hq-project-view__spark i').length,
      sourceCount: document.querySelector('.hq-project-sources__count')?.textContent.trim(),
      key: document.querySelector('.hq-project-sources__key')?.textContent.trim(),
      need: document.querySelector('[aria-label="Needs you"] .hq-project-view__section-head span')?.textContent,
      doing: document.querySelector('[aria-label="Working now"] .hq-project-view__section-head span')?.textContent,
      rightPanes: document.querySelectorAll('[data-hq-context][role=complementary]').length })`),
      {
        title: "New empty Project",
        folder: "/fixtures/koed",
        activity: "3 done this week · 2 merged",
        sparkBars: 7,
        sourceCount: "3 sources",
        key: "Plan.md",
        need: "5",
        doing: "5",
        rightPanes: 1
      }
    );
    assert.deepEqual(
      await js(`({ needVisible: document.querySelectorAll('[aria-label="Needs you"] .hq-project-view__row').length,
      doingVisible: document.querySelectorAll('[aria-label="Working now"] .hq-project-view__row').length,
      needMore: document.querySelector('[aria-label="Needs you"] .hq-project-view__more')?.textContent,
      doingMore: document.querySelector('[aria-label="Working now"] .hq-project-view__more')?.textContent })`),
      {
        needVisible: 4,
        doingVisible: 4,
        needMore: "Show 1 more",
        doingMore: "Show 1 more"
      }
    );
    await js(
      `document.querySelector('[aria-label="Needs you"] .hq-project-view__more').click()`
    );
    assert.equal(
      await js(
        `document.querySelectorAll('[aria-label="Needs you"] .hq-project-view__row').length`
      ),
      5
    );
    await js(
      `document.querySelector('[aria-label="Needs you"] .hq-project-view__more').click()`
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-project-view__activity')?.textContent.includes('10')"
      ),
      false
    );
    assert.equal(
      await js(
        "/\\b3\\s*\\/\\s*5\\b/.test(document.querySelector('.hq-project-view')?.textContent ?? '')"
      ),
      false,
      "Project HQ must not present activity as a 3/5 ticket-progress counter."
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
    await capture("project-hq-light.png");
    await js(
      `document.querySelector('[aria-label="Needs you"] .hq-project-view__section-head').click()`
    );
    assert.equal(
      await js(
        `document.querySelector('[aria-label="Needs you"] .hq-project-view__section-head').getAttribute('aria-expanded')`
      ),
      "false"
    );
    await js(
      `document.querySelector('[aria-label="Needs you"] .hq-project-view__section-head').click()`
    );
    assert.equal(
      await js(
        `document.querySelector('[aria-label="Needs you"] .hq-project-view__section-head').getAttribute('aria-expanded')`
      ),
      "true"
    );
    await js("document.querySelector('.hq-project-sources__key').click()");
    await waitFor(
      "Boolean(document.querySelector('.hq-project-conversation__inspector > .hq-project-sources__panel')) && Boolean(document.querySelector('.hq-project-conversation__context'))"
    );
    assert.deepEqual(
      await js(`({ inspector: document.querySelector('.hq-project-sources__panel')?.getAttribute('aria-label'),
      context: document.querySelector('.hq-project-conversation__context')?.textContent.trim(),
      timelineHidden: document.querySelector('.hq-project-conversation .hq-conversation__scroll')?.hidden,
      headerHidden: document.querySelector('.hq-project-conversation__header')?.hidden,
      composerVisible: Boolean(document.querySelector('.hq-project-conversation textarea:not(:disabled)')),
      rightPanes: document.querySelectorAll('[data-hq-context][role=complementary]').length })`),
      {
        inspector: "Plan.md",
        context: "About Plan.md",
        timelineHidden: true,
        headerHidden: true,
        composerVisible: true,
        rightPanes: 1
      }
    );
    await capture("project-doc-light.png");
    await js(
      "document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark')"
    );
    await capture("project-doc-dark.png");
    await js(
      "document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')"
    );
    await js(
      "document.querySelector('.hq-project-conversation textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))"
    );
    await delay(100);
    assert.deepEqual(
      await js(`({ starts: window.__koedHq204Trace.start,
        inspector: Boolean(document.querySelector('.hq-project-sources__panel')),
        context: document.querySelector('.hq-project-conversation__context')?.textContent.trim() })`),
      { starts: 0, inspector: true, context: "About Plan.md" },
      "An empty composer must not send an About-only prompt or close context."
    );
    await js(`{ const field = document.querySelector('.hq-project-conversation textarea');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(field, 'What should we do next?'); field.dispatchEvent(new Event('input', { bubbles: true })); }`);
    await waitFor(
      "!document.querySelector('.hq-project-conversation [aria-label=\"Send message\"]').disabled"
    );
    await js(
      "document.querySelector('.hq-project-conversation [aria-label=\"Send message\"]').click()"
    );
    await waitFor(
      "window.__koedHq204Trace.firstPrompt === 'About Plan.md: What should we do next?' && !document.querySelector('.hq-project-sources__panel')"
    );
    await waitFor(
      "document.querySelector('.hq-project-conversation .hq-conversation__scroll')?.textContent?.includes('About Plan.md: What should we do next?') && document.querySelector('.hq-project-conversation .hq-conversation__scroll')?.textContent?.includes('For Plan.md, review the goals and choose the next task.')"
    );
    assert.equal(
      await js("document.querySelector('.hq-project-conversation__context')"),
      null
    );
    await js("document.querySelector('.hq-project-sources__key').click()");
    await waitFor(
      "Boolean(document.querySelector('.hq-project-sources__panel'))"
    );
    await js(
      "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"
    );
    await waitFor(
      "!document.querySelector('.hq-project-sources__panel') && !document.querySelector('.hq-project-conversation__context')"
    );
    await js("document.querySelector('.hq-project-sources__key').click()");
    await waitFor(
      "Boolean(document.querySelector('.hq-project-sources__panel'))"
    );
    await js(
      "document.querySelector('.hq-project-sources__panel [aria-label=\"Close Sources\"]').click()"
    );
    await waitFor(
      "!document.querySelector('.hq-project-sources__panel') && !document.querySelector('.hq-project-conversation__context')"
    );
    await js(
      "document.querySelector('[aria-label=\"Hide project context\"]').click()"
    );
    await waitFor(
      "Boolean(document.querySelector('[aria-label=\"Show project context\"]'))"
    );
    await js(
      "document.querySelector('[aria-label=\"Show project context\"]').click()"
    );
    await waitFor(
      "Boolean(document.querySelector('.hq-project-conversation textarea'))"
    );
    assert.equal(errors.length, 0, errors.join(" | "));
    await writeFile(
      resolve(scratch, "hq-207", "browser-report.json"),
      JSON.stringify(
        {
          id: "HQ207.native",
          owner: "HQ-207",
          status: "pass",
          assertions: [
            { id: "S01.1", owner: "HQ-207", status: "pass" },
            { id: "S11.1", owner: "HQ-207", status: "pass" }
          ],
          checks: [
            "honest seven-day activity",
            "source and key item",
            "Project-owned runtime sections",
            "fold",
            "single right context",
            "doc inspector with persistent private composer",
            "About question and fixture answer in private HQ timeline",
            "Escape",
            "X close",
            "hide/show chat"
          ],
          screenshots: [
            "project-hq-light.png",
            "project-doc-light.png",
            "project-doc-dark.png"
          ]
        },
        null,
        2
      )
    );
    debuggerClient.detach();
    process.stdout.write(`HQ-207 Electron captures: ${images}\n`);
  } catch (cause) {
    failed = true;
    process.stderr.write(
      `${cause instanceof Error ? cause.stack : String(cause)}\n`
    );
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    app.exit(failed ? 1 : 0);
  }
};
void run();
