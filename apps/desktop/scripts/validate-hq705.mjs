import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const profile = process.env.KOED_HQ705_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-705 Electron profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);
const output = resolve(scratch, "hq-705", "screenshots");
const reportPath = resolve(scratch, "hq-705", "HQ705.native.json");

async function run() {
  const window = new BrowserWindow({
    show: true,
    width: 1280,
    height: 800,
    useContentSize: true,
    webPreferences: { partition: `hq705-${process.pid}` }
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
  await rm(reportPath, { force: true });
  const screenshots = [];
  try {
    for (const theme of ["light", "dark"]) {
      console.log(`HQ705 native: loading ${theme}`);
      await window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        { query: { view: "hq", hq705Capture: "yes" } }
      );
      console.log(`HQ705 native: loaded ${theme}`);
      await waitFor(
        "document.documentElement.dataset.hqFixtureReady === 'true'",
        "HQ fixture"
      );
      await js(
        `document.documentElement.classList.remove('light','dark'); document.documentElement.classList.add('${theme}')`
      );
      await js(
        "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]')?.click()"
      );
      await waitFor(
        "document.querySelector('[role=tablist][aria-label=\"Project conversation\"]') !== null",
        "Project tabs"
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
        screenshots.push(name);
      };
      assert.equal(
        await js(
          "document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim()"
        ),
        "Just me"
      );
      await waitFor(
        "document.querySelector('.hq-project-context-tabs__unread')?.textContent.trim() === '1'",
        "unread Team tab while Just me is open"
      );
      assert.equal(await js("window.__koedHq705Trace?.reads"), 0);
      await capture(`project-just-me-${theme}.png`);
      await js(
        "document.querySelector('.hq-project-context-tabs__tabs button:nth-child(2)')?.click()"
      );
      await waitFor(
        "document.querySelector('.hq-project-thread__messages')?.textContent.includes('launch plan')",
        "Team history"
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-project-thread__privacy')?.textContent.trim()"
        ),
        "Team messages stay between people. They aren't saved to memory or read by agents."
      );
      assert.equal(
        await js(
          "document.querySelectorAll('.hq-project-thread__people > span').length"
        ),
        2
      );
      assert.equal(await js("window.__koedHq705Trace?.reads > 0"), true);
      await capture(`project-team-${theme}.png`);
      await js(
        "document.querySelector('.hq-project-thread__mention-trigger')?.click()"
      );
      await js(
        "Array.from(document.querySelectorAll('.hq-project-thread__mentions button')).find(el => el.textContent?.includes('Maya'))?.click()"
      );
      await js(
        "const field=document.querySelector('#hq-project-thread-message'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'Ready to review together'); field.dispatchEvent(new Event('input',{bubbles:true}))"
      );
      await js("document.querySelector('.hq-project-thread__send')?.click()");
      await waitFor("window.__koedHq705Trace?.sends === 1", "Team send");
      assert.equal(await js("window.__koedHq705Trace?.mentions.length"), 1);
      assert.equal(
        await js(
          "document.querySelector('.hq-project-thread__messages')?.textContent.includes('Ready to review together')"
        ),
        true
      );
      await capture(`project-team-sent-${theme}.png`);
      await js(
        "document.querySelector('[aria-label=\"Hide project context\"]')?.click()"
      );
      await waitFor(
        "document.querySelector('[aria-label^=\"Open Team tab\"]') !== null",
        "hidden-column Team chip"
      );
      await capture(`project-team-chip-${theme}.png`);
      const readsBeforeHiddenUpdate = await js(
        "window.__koedHq705Trace?.reads"
      );
      await js("window.__koedHq705Trace?.publishIncoming()");
      await waitFor(
        "document.querySelector('[aria-label^=\"Open Team tab\"]')?.textContent.includes('1')",
        "hidden-column unread update"
      );
      assert.equal(
        await js("window.__koedHq705Trace?.reads"),
        readsBeforeHiddenUpdate,
        "hidden Team thread must stay unread"
      );
      await capture(`project-team-hidden-unread-${theme}.png`);
      await js(
        "document.querySelector('[aria-label^=\"Open Team tab\"]')?.click()"
      );
      await waitFor(
        "document.querySelector('.hq-project-thread__messages')?.textContent.includes('updated launch plan')",
        "reopened Team history"
      );
      await waitFor(
        `window.__koedHq705Trace?.reads > ${readsBeforeHiddenUpdate}`,
        "visible Team read state"
      );
    }
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          id: "HQ705.native",
          owner: "HQ-705",
          status: "pass",
          assertions: [
            "Just me keeps Team unread without reading",
            "Team human history, people-only mention and send",
            "Hidden-column realtime unread without read; reopening marks read",
            "Desktop light and dark captures"
          ],
          screenshots
        },
        null,
        2
      )
    );
  } finally {
    window.destroy();
  }
  console.log(reportPath);
}

console.log("HQ705 native: waiting for Electron ready");
void (async () => {
  await app.whenReady();
  try {
    await run();
  } finally {
    app.quit();
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
