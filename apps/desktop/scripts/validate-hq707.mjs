import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const profile = process.env.KOED_HQ707_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-707 Electron profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);
const output = resolve(scratch, "hq-707", "screenshots");
const originalId = "00000000-0000-4000-8000-000000007052";

async function run() {
  const window = new BrowserWindow({
    show: true,
    width: 1280,
    height: 800,
    useContentSize: true,
    webPreferences: { partition: `hq707-${process.pid}` }
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
  const screenshots = [];
  await mkdir(output, { recursive: true });
  try {
    for (const theme of ["light", "dark"]) {
      await window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        { query: { view: "hq", hq705Capture: "yes" } }
      );
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
      await js(
        "document.querySelector('.hq-project-context-tabs__tabs button:nth-child(2)')?.click()"
      );
      await waitFor(
        "document.querySelector('.hq-project-thread__reply') !== null",
        "Team message"
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
          {
            format: "png",
            captureBeyondViewport: false
          }
        );
        await writeFile(resolve(output, name), Buffer.from(data, "base64"));
        screenshots.push(name);
      };
      await js("document.querySelector('.hq-project-thread__reply')?.click()");
      await waitFor(
        "document.querySelector('.hq-project-thread__reply-chip')?.textContent.includes('Replying to Maya')",
        "reply chip"
      );
      await capture(`reply-chip-${theme}.png`);
      await js(
        "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
      );
      await waitFor(
        "document.querySelector('.hq-project-thread__reply-chip') === null",
        "Escape dismissal"
      );
      await js("document.querySelector('.hq-project-thread__reply')?.click()");
      await js(
        "document.querySelector('.hq-project-thread__reply-chip button')?.click()"
      );
      await waitFor(
        "document.querySelector('.hq-project-thread__reply-chip') === null",
        "button dismissal"
      );
      await js("document.querySelector('.hq-project-thread__reply')?.click()");
      await js(
        "const field=document.querySelector('#hq-project-thread-message'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'I can review this afternoon'); field.dispatchEvent(new Event('input',{bubbles:true}))"
      );
      await js("document.querySelector('.hq-project-thread__send')?.click()");
      await waitFor(
        "document.querySelector('.hq-project-thread__quote') !== null",
        "quoted message"
      );
      assert.equal(
        await js("window.__koedHq705Trace?.lastReplyToMessageId"),
        originalId
      );
      assert.match(
        await js(
          "document.querySelector('.hq-project-thread__quote')?.textContent"
        ),
        /Maya.*launch plan/
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-project-thread__quote')?.closest('.hq-project-thread__messages .hq-project-thread__message') !== null && document.querySelectorAll('.hq-project-thread__messages').length === 1"
        ),
        true,
        "S23.1: quoted reply stays in the single Team message list"
      );
      await capture(`quoted-reply-${theme}.png`);
      await js("document.querySelector('.hq-project-thread__quote')?.click()");
      await waitFor(
        `document.activeElement?.dataset.messageId === '${originalId}'`,
        "jump to original"
      );
    }
    await writeFile(
      resolve(scratch, "hq-707", "HQ707.native.json"),
      JSON.stringify(
        {
          id: "HQ707.native",
          owner: "HQ-707",
          status: "pass",
          assertions: [
            {
              id: "S23.1",
              status: "pass",
              checks: [
                "reply-chip",
                "Escape-dismissal",
                "one-line-quote",
                "jump-to-original",
                "single-message-list"
              ]
            },
            "Reply chip and both dismissals",
            "Reply target sent through V2 contract",
            "One-line quote and jump",
            "Light and dark captures"
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
  console.log(resolve(scratch, "hq-707", "HQ707.native.json"));
}

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
