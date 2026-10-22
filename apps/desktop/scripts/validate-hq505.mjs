import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { Buffer } from "node:buffer";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const profile = process.env.KOED_HQ505_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-505 Electron profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);
// Each theme has an isolated renderer partition. Keep Electron alive while
// replacing the first BrowserWindow with the second.
app.on("window-all-closed", () => undefined);
const output = resolve(scratch, "hq-505", "screenshots");
const reportPath = resolve(scratch, "hq-505", "HQ505.native.json");
const projectId = "00000000-0000-4000-8000-000000002038";
const html = resolve(root, "apps/desktop/dist/browser-validation.html");

async function run() {
  await app.whenReady();
  await mkdir(output, { recursive: true });
  await rm(reportPath, { force: true });
  const screenshots = [];
  const cases = [];
  for (const theme of ["light", "dark"]) {
    const window = new BrowserWindow({
      show: true,
      width: 1280,
      height: 800,
      useContentSize: true,
      webPreferences: { partition: `hq505-${process.pid}-${theme}` }
    });
    window.webContents.on("did-fail-load", (_event, code, description, url) => {
      console.error("HQ505 native load failure", { code, description, url });
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      console.error("HQ505 native renderer exited", details);
    });
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source, label, attempts = 160) => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      console.error(
        "HQ505 native wait state",
        label,
        await js(
          "({ visibility: document.visibilityState, selectedTab: document.querySelector('[role=tab][aria-selected=true]')?.textContent, teamPanel: document.querySelector('.hq-project-thread__messages')?.closest('[hidden],[inert],[aria-hidden=true]')?.outerHTML.slice(0,180), reads: window.__koedHq705Trace?.reads })"
        )
      );
      assert.fail(`Timed out waiting for ${label}`);
    };
    const load = async (query) => {
      console.log("HQ505 native loading", theme, query);
      await window.loadFile(html, { query: { view: "hq", ...query } });
      console.log("HQ505 native loaded", theme, query);
      await waitFor(
        "document.documentElement.dataset.hqFixtureReady === 'true'",
        "HQ fixture"
      );
      await js(
        `document.documentElement.classList.remove('light','dark'); document.documentElement.classList.add('${theme}')`
      );
      await waitFor(
        `Boolean(document.querySelector('[data-hq-project-link="${projectId}"]'))`,
        "Project link"
      );
      await js(
        `document.querySelector('[data-hq-project-link="${projectId}"]').click()`
      );
      await waitFor(
        "Boolean(document.querySelector('.hq-project-conversation'))",
        "real Project HQ Conversation"
      );
    };
    const client = window.webContents.debugger;
    const capture = async (name) => {
      if (!client.isAttached()) client.attach("1.3");
      await client.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false
      });
      await delay(100);
      const { data } = await client.sendCommand("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false
      });
      const png = Buffer.from(data, "base64");
      assert.equal(png.readUInt32BE(16), 1280);
      assert.equal(png.readUInt32BE(20), 800);
      await writeFile(resolve(output, name), png);
      screenshots.push(name);
    };
    try {
      await load({ hq505Capture: "yes" });
      await waitFor(
        "document.querySelector('.hq-project-conversation__catch-up')?.textContent.includes('Catching up on this Project')",
        "queued catch-up banner"
      );
      assert.equal(await js("window.__koedHq505Trace?.durableDispatches"), 1);
      assert.equal(await js("window.__koedHq204Trace?.start"), 0);
      assert.equal(await js("window.__koedHq204Trace?.send"), 0);
      await capture(`catch-up-waiting-${theme}.png`);
      await waitFor(
        "document.querySelector('.hq-project-conversation__catch-up')?.textContent.includes('Catch-up reply recovered')",
        "recovered terminal reply",
        200
      );
      await waitFor(
        "document.querySelectorAll('[data-message-id=" +
          '"hq505-retained-assistant"' +
          "]').length === 1",
        "one retained assistant row"
      );
      assert.equal(
        await js(
          "document.querySelector('[data-message-id=" +
            '"hq505-retained-assistant"' +
            "]')?.textContent.includes('Source: Owner Plan.md')"
        ),
        true
      );
      await waitFor(
        "document.querySelectorAll('.hq-citation-chip').length >= 2",
        "source and decision citation chips"
      );
      await js("document.querySelector('.hq-citation-chip')?.click()");
      await waitFor(
        "document.querySelector('.hq-citation-detail h2')?.textContent.includes('Owner Plan.md')",
        "clickable Owner Plan.md source citation"
      );
      await capture(`catch-up-citation-${theme}.png`);
      await js(
        "document.querySelector('[aria-label=" +
          '"Close memory source"' +
          "]')?.click()"
      );
      await js("document.querySelectorAll('.hq-citation-chip')[1]?.click()");
      await waitFor(
        "document.querySelector('.hq-citation-detail h2')?.textContent.includes('Ship the smaller launch first')",
        "clickable Project decision citation"
      );
      await js(
        "document.querySelector('[aria-label=" +
          '"Close memory source"' +
          "]')?.click()"
      );
      assert.equal(
        await js(
          "document.querySelector('[data-message-id=" +
            '"hq505-retained-assistant"' +
            "]')?.textContent.includes('I can outline 2 next steps')"
        ),
        true
      );
      assert.equal(
        await js(
          "document.querySelector('[data-message-id=" +
            '"hq505-retained-assistant"' +
            "]')?.textContent.includes('Can we review the launch plan')"
        ),
        false,
        "Team Chat text must not enter the assistant row"
      );
      assert.equal(await js("window.__koedHq204Trace?.start"), 0);
      assert.equal(await js("window.__koedHq204Trace?.send"), 0);
      await waitFor(
        "document.querySelector('.hq-project-context-tabs__unread')?.textContent.trim() === '1'",
        "unread Team tab"
      );
      await waitFor(
        "document.querySelector('.hq-project-conversation__team-unread button')?.textContent.trim() === '1 new message in Team'",
        "deterministic linked Team unread line"
      );
      assert.equal(
        await js(
          "Array.from(document.querySelectorAll('.hq-project-conversation__catch-up button')).some(button => button.textContent.trim() === 'Open Team')"
        ),
        true
      );
      await capture(`catch-up-recovered-${theme}.png`);
      const readsBeforeOpen = await js("window.__koedHq705Trace?.reads");
      assert.equal(readsBeforeOpen, 0);
      window.show();
      window.focus();
      await waitFor(
        "document.visibilityState === 'visible'",
        "owned Electron window visible before Team read"
      );
      await js(
        "document.querySelector('.hq-project-conversation__team-unread button')?.click()"
      );
      await waitFor(
        "document.querySelector('[role=tab][aria-selected=true]')?.textContent.includes('Team')",
        "Team tab selected by unread line"
      );
      await waitFor(
        "document.querySelector('.hq-project-thread__messages')?.textContent.includes('launch plan')",
        "human Team history"
      );
      await waitFor(
        `window.__koedHq705Trace?.reads > ${readsBeforeOpen}`,
        "visible Team read receipt"
      );
      await capture(`catch-up-open-team-${theme}.png`);

      await window.loadFile(html, {
        query: { view: "hq", hq505Capture: "yes" }
      });
      await waitFor(
        "document.documentElement.dataset.hqFixtureReady === 'true'",
        "reloaded HQ fixture"
      );
      await js(
        `document.documentElement.classList.remove('light','dark'); document.documentElement.classList.add('${theme}')`
      );
      await waitFor(
        `Boolean(document.querySelector('[data-hq-project-link="${projectId}"]'))`,
        "reloaded Project link"
      );
      await js(
        `document.querySelector('[data-hq-project-link="${projectId}"]').click()`
      );
      await waitFor(
        "document.querySelectorAll('[data-message-id=" +
          '"hq505-retained-assistant"' +
          "]').length === 1",
        "one retained assistant after reload"
      );
      await waitFor(
        "document.querySelectorAll('.hq-citation-chip').length >= 2",
        "retained source and decision citations after reload"
      );
      assert.equal(await js("window.__koedHq505Trace?.durableDispatches"), 1);
      assert.equal(await js("window.__koedHq505Trace?.promptDispatches"), 0);
      assert.equal(await js("window.__koedHq204Trace?.start"), 0);
      assert.equal(await js("window.__koedHq204Trace?.send"), 0);
      await capture(`catch-up-reloaded-${theme}.png`);

      // A linked Team Source is metadata for the shared Project. The existing
      // HQ406 document action is available only to an unlinked Personal Project.
      assert.equal(
        await js(
          "document.querySelector('[aria-label=" +
            '"Open 1 Personal documents"' +
            "]') !== null"
        ),
        false
      );
      await js(
        "Array.from(document.querySelectorAll('.hq-project-sources__key')).find(button => button.textContent.trim() === 'Plan.md')?.click()"
      );
      await waitFor(
        "document.querySelector('.hq-project-sources__panel')?.textContent.includes('Sources in this Project')",
        "Team Source panel"
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-project-sources__panel .hq-project-sources__ask') !== null"
        ),
        false,
        "a teammate Team Source cannot be a Personal document action target"
      );
      assert.equal(await js("window.__koedHq204Trace?.send"), 0);
      await capture(`linked-team-source-no-make-${theme}.png`);

      await load({ hq505Capture: "yes", hq505Outcome: "uncertain" });
      await waitFor(
        "document.querySelector('.hq-project-conversation__catch-up')?.textContent.includes('Catch-up delivery needs review')",
        "unknown outcome reconciliation"
      );
      assert.equal(
        await js(
          "Array.from(document.querySelectorAll('.hq-project-conversation__catch-up button')).some(button => button.textContent.trim() === 'Retry catch-up')"
        ),
        false
      );
      await js(
        "Array.from(document.querySelectorAll('.hq-project-conversation__catch-up button')).find(button => button.textContent.trim() === 'Check catch-up')?.click()"
      );
      await waitFor(
        "window.__koedHq505Trace?.catchUpCalls >= 2",
        "explicit reconciliation read"
      );
      assert.equal(await js("window.__koedHq505Trace?.retryCalls"), 0);
      assert.equal(await js("window.__koedHq204Trace?.start"), 0);
      assert.equal(await js("window.__koedHq204Trace?.send"), 0);
      await capture(`catch-up-reconcile-${theme}.png`);

      // HQ406's existing Personal Source action is a separate authority from
      // the linked Team Source. It demonstrates a deliberate user request.
      await window.loadFile(html, {
        query: { view: "hq", hq406Capture: "yes" }
      });
      await waitFor(
        "document.documentElement.dataset.hqFixtureReady === 'true'",
        "Personal Source fixture"
      );
      await js(
        `document.documentElement.classList.remove('light','dark'); document.documentElement.classList.add('${theme}')`
      );
      await waitFor(
        `Boolean(document.querySelector('[data-hq-project-link="${projectId}"]'))`,
        "Personal Project link"
      );
      await js(
        `document.querySelector('[data-hq-project-link="${projectId}"]').click()`
      );
      await waitFor(
        "Boolean(document.querySelector('[aria-label$=" +
          '"Project sources"' +
          "]'))",
        "Personal Source control"
      );
      await js(
        "document.querySelector('[aria-label$=" +
          '"Project sources"' +
          "]')?.click()"
      );
      await waitFor(
        "Array.from(document.querySelectorAll('.hq-project-sources__row')).some(row => row.textContent.includes('Plan.md'))",
        "Personal Plan.md Source"
      );
      await js(
        "Array.from(document.querySelectorAll('.hq-project-sources__row')).find(row => row.textContent.includes('Plan.md'))?.click()"
      );
      await waitFor(
        "Boolean(document.querySelector('.hq-project-sources__ask'))",
        "existing user document action"
      );
      assert.equal(await js("window.__koedHq204Trace?.start"), 0);
      await capture(`personal-source-action-${theme}.png`);
      await js("document.querySelector('.hq-project-sources__ask').click()");
      await waitFor(
        "window.__koedHq204Trace?.start === 1",
        "deliberate Source action"
      );
      assert.equal(
        await js("window.__koedHq204Trace?.firstPrompt"),
        "Turn Plan.md into tickets"
      );
      assert.equal(
        await js("window.__koedHq204Trace?.firstSelectedDocumentSourceId"),
        "00000000-0000-4000-8000-000000002053"
      );
      cases.push({ theme, catchUpDispatches: 1, recoveredRowsAfterReload: 1 });
    } finally {
      window.destroy();
    }
  }
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        id: "HQ505.native",
        owner: "HQ-505",
        status: "pass",
        proofIds: [
          "S01.4.no-team-text-in-retained-reply",
          "S01.4.deterministic-team-unread-line"
        ],
        evidence:
          "Electron renderer fixture; API, DB, and provider terminal proof run separately",
        assertions: [
          "Linked Project queues once, recovers a retained assistant row, and reloads without a second prompt",
          "Retained assistant row has clickable Source and decision citation chips; Team Chat text does not enter it",
          "The exact Team unread line opens the human tab and marks read only while visible",
          "Linked Team Source has no Make action or Personal document chip",
          "Unknown outcome offers Check catch-up without retry or a second prompt",
          "Separate Personal Project Source action dispatches only after a user click",
          "Desktop light and dark captures"
        ],
        cases,
        screenshots
      },
      null,
      2
    )
  );
  console.log(reportPath);
}

void run()
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
