import assert from "node:assert/strict";
import console from "node:console";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const profile = process.env.KOED_HQ603_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-603 Electron profile under scratch.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);
app.on("window-all-closed", () => {});
const output = resolve(scratch, "hq-603", "screenshots");
const waitFor = async (js, condition, label) => {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await js(condition)) return;
    await delay(50);
  }
  assert.fail(`HQ-603 timed out waiting for ${label}`);
};

async function run() {
  await app.whenReady();
  await mkdir(output, { recursive: true });
  const results = [];
  for (const theme of ["light", "dark"]) {
    const window = new BrowserWindow({
      show: true,
      width: 1280,
      height: 800,
      useContentSize: true,
      webPreferences: { partition: `hq603-${theme}-${process.pid}` }
    });
    const errors = [];
    window.webContents.on("console-message", (_event, details) => {
      if (details?.level === "error") errors.push(details.message);
    });
    window.webContents.on("did-fail-load", (_event, code, description) =>
      errors.push(`${code}: ${description}`)
    );
    const js = (source) => window.webContents.executeJavaScript(source);
    const debuggerClient = window.webContents.debugger;
    let step = "load";
    try {
      await window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        { query: { view: "hq", hq603Capture: "yes" } }
      );
      await waitFor(
        js,
        "document.documentElement.dataset.hqFixtureReady === 'true'",
        "HQ fixture"
      );
      await js(
        `document.documentElement.classList.remove('light','dark'); document.documentElement.classList.add('${theme}'); document.documentElement.dataset.theme='${theme}'`
      );
      await waitFor(
        js,
        "document.querySelector('.hq-now__scheduled-toggle')?.textContent.includes('Next:')",
        "Scheduled summary"
      );
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
        return name;
      };
      step = "collapsed";
      const collapsed = await js(
        "document.querySelector('.hq-now__scheduled-toggle')?.textContent.trim()"
      );
      assert.match(collapsed, /Next: .+ · .+ · \+4/);
      assert.match(collapsed, /\+4/);
      await js(
        "document.querySelector('.hq-now__scheduled-toggle')?.scrollIntoView({block:'center'})"
      );
      const collapsedShot = await capture(`scheduled-collapsed-${theme}.png`);
      await js("document.querySelector('.hq-now__scheduled-toggle').click()");
      await waitFor(
        js,
        "document.querySelectorAll('.hq-now__scheduled-row').length === 5",
        "five Scheduled rows"
      );
      step = "expanded";
      assert.equal(
        await js("document.querySelector('.hq-now__more')?.textContent.trim()"),
        "Show 2 more"
      );
      await js("document.querySelector('.hq-now__more').click()");
      await waitFor(
        js,
        "document.querySelectorAll('.hq-now__scheduled-row').length === 7",
        "all Scheduled rows"
      );
      assert.match(
        await js(
          "document.querySelector('.hq-now__scheduled-row:last-of-type')?.textContent"
        ),
        /Paused recap/
      );
      await js(
        "document.querySelector('.hq-now__scheduled')?.scrollIntoView({block:'center'})"
      );
      const expandedShot = await capture(`scheduled-expanded-${theme}.png`);
      step = "needs";
      await waitFor(
        js,
        "document.querySelectorAll('.hq-now__job-need').length === 2",
        "failed and missed Needs you rows"
      );
      assert.equal(
        await js(
          "document.querySelectorAll('.hq-now__job-need button').length >= 5"
        ),
        true
      );
      await js(
        "document.querySelector('.hq-now__job-need').scrollIntoView({block:'center'})"
      );
      const needsShot = await capture(`scheduled-needs-${theme}.png`);
      await js(
        "document.querySelector('.hq-now__job-need button:last-child').click()"
      );
      await waitFor(js, "window.__koedHq603Trace?.skips === 1", "Skip effect");
      step = "sidebar";
      const rowSelector = ".hq-sidebar__conversation";
      assert.equal(
        await js(
          `(() => { const row=[...document.querySelectorAll('${rowSelector}')].find(el=>el.textContent?.includes('Conversation 21')); const button=row?.querySelector('.hq-sidebar__conversation-link'); return button?.firstElementChild?.matches('.hq-sidebar__job-clock') && button?.firstElementChild?.nextElementSibling?.textContent?.trim()==='Conversation 21'; })()`
        ),
        true
      );
      await js(
        `(() => { const row=[...document.querySelectorAll('${rowSelector}')].find(el=>el.textContent?.includes('Conversation 21')); if(row) row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})); })()`
      );
      await waitFor(
        js,
        "document.querySelector('.hq-sidebar__conversation-menu')?.textContent.includes('Pause job')",
        "Job context menu"
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-sidebar__conversation-menu')?.textContent.includes('Run now')"
        ),
        true
      );
      const sidebarShot = await capture(`scheduled-sidebar-${theme}.png`);
      await js(
        "[...document.querySelectorAll('.hq-sidebar__conversation-menu button')].find(el=>el.textContent?.includes('Pause job')).click()"
      );
      await waitFor(
        js,
        "window.__koedHq603Trace?.pauses === 1",
        "Pause effect"
      );
      await waitFor(
        js,
        "[...document.querySelectorAll('.hq-sidebar__conversation')].find(el=>el.textContent?.includes('Conversation 21'))?.querySelector('.hq-sidebar__job-clock')?.dataset.paused === 'true'",
        "dimmed paused Job icon"
      );
      await js(
        `(() => { const row=[...document.querySelectorAll('${rowSelector}')].find(el=>el.textContent?.includes('Conversation 22')); row?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})); })()`
      );
      await waitFor(
        js,
        "document.querySelector('.hq-sidebar__conversation-menu')?.textContent.includes('Run now')",
        "second Job context menu"
      );
      await js(
        "[...document.querySelectorAll('.hq-sidebar__conversation-menu button')].find(el=>el.textContent?.includes('Run now'))?.click()"
      );
      await waitFor(
        js,
        "window.__koedHq603Trace?.runNows === 1",
        "Run now effect"
      );
      step = "open";
      await js(
        "[...document.querySelectorAll('.hq-now__scheduled-row button')].find(el=>el.textContent?.includes('Morning brief'))?.click()"
      );
      await waitFor(
        js,
        "document.querySelector('[data-hq-route=conversation][data-hq-session-id=\"00000000-0000-4000-8000-000000000021\"]') !== null",
        "Job Conversation navigation"
      );
      const conversationShot = await capture(
        `scheduled-conversation-${theme}.png`
      );
      assert.deepEqual(errors, []);
      results.push({
        theme,
        collapsed,
        screenshots: [
          collapsedShot,
          expandedShot,
          needsShot,
          sidebarShot,
          conversationShot
        ],
        trace: await js("window.__koedHq603Trace")
      });
    } catch (error) {
      console.error(`HQ-603 ${theme} failed at ${step}:`, error);
      throw error;
    } finally {
      if (debuggerClient.isAttached()) debuggerClient.detach();
      window.destroy();
    }
  }
  const reviewWindow = new BrowserWindow({
    show: true,
    width: 1280,
    height: 800,
    useContentSize: true,
    webPreferences: { partition: `hq603-review-${process.pid}` }
  });
  try {
    await reviewWindow.loadFile(
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      {
        query: {
          view: "hq",
          hq204Capture: "yes",
          hq208Capture: "yes",
          hq504Capture: "yes",
          hq603ReviewCapture: "yes"
        }
      }
    );
    const js = (source) => reviewWindow.webContents.executeJavaScript(source);
    await waitFor(
      js,
      "document.documentElement.dataset.hqFixtureReady === 'true'",
      "review fixture"
    );
    await js(
      "document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light'); document.documentElement.dataset.theme='light'"
    );
    await js(
      "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]')?.click()"
    );
    await waitFor(
      js,
      "Boolean(document.querySelector('textarea'))",
      "review Project composer"
    );
    await js(
      `(() => { const field=document.querySelector('textarea'); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(field,'Schedule a morning brief'); field.dispatchEvent(new InputEvent('input',{bubbles:true,data:'Schedule a morning brief',inputType:'insertText'})); field.dispatchEvent(new Event('change',{bubbles:true})); })()`
    );
    await waitFor(
      js,
      "(() => { const button=document.querySelector('button[aria-label=\"Send message\"]'); if (!button || button.disabled) return false; button.click(); return true; })()",
      "review Conversation start"
    );
    await waitFor(
      js,
      "[...document.querySelectorAll('.hq-text-action')].some(el=>el.textContent?.includes('Every weekday at 08:00 (Europe/Oslo)'))",
      "Scheduled Job review card"
    );
    const reviewFacts = await js(
      "(() => { const card=[...document.querySelectorAll('.hq-text-action')].find(el=>el.textContent?.includes('Every weekday at 08:00 (Europe/Oslo)')); return card?.textContent; })()"
    );
    for (const fact of [
      "Morning brief",
      "Chief of Staff",
      "Brief me on AI news and include sources.",
      "Results",
      "this chat",
      "New empty Project",
      "Next",
      "Approve"
    ])
      assert.ok(
        reviewFacts.includes(fact),
        `Scheduled Job review missing ${fact}`
      );
    assert.ok(
      !reviewFacts.includes("00000000-"),
      "Review must not expose raw IDs"
    );
    await js(
      "[...document.querySelectorAll('.hq-text-action')].find(el=>el.textContent?.includes('Every weekday at 08:00 (Europe/Oslo)'))?.querySelector('button')?.scrollIntoView({block:'center'})"
    );
    await delay(150);
    const debuggerClient = reviewWindow.webContents.debugger;
    debuggerClient.attach("1.3");
    await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    });
    const { data } = await debuggerClient.sendCommand(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false }
    );
    await writeFile(
      resolve(output, "scheduled-review-light.png"),
      Buffer.from(data, "base64")
    );
    debuggerClient.detach();
    results.push({
      review: "exact Scheduled Job approval facts visible",
      screenshot: "scheduled-review-light.png"
    });
  } finally {
    reviewWindow.destroy();
  }
  await writeFile(
    resolve(scratch, "hq-603", "HQ603.native.json"),
    JSON.stringify(
      {
        id: "HQ603.native",
        owner: "HQ-603",
        status: "pass",
        assertions: [
          "next two Scheduled summary and bounded expansion with paused last",
          "failed and missed Needs you controls with Skip effect",
          "Job sidebar clock, context Pause and Run now, Conversation navigation",
          "exact Scheduled Job approval facts"
        ],
        screenshots: results.flatMap(
          (entry) => entry.screenshots ?? [entry.screenshot]
        ),
        results
      },
      null,
      2
    )
  );
  console.log("HQ-603 native Scheduled Jobs validation passed");
}

run().then(
  () => app.quit(),
  (error) => {
    console.error(error);
    app.exit(1);
  }
);
