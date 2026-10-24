import assert from "node:assert/strict";
import process from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const output = resolve(root, "scratch/hq-724");
const profile = process.env.KOED_HQ724_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-724 Electron profile.");
app.setPath("userData", profile);

async function run() {
  let window;
  try {
    await app.whenReady();
    await mkdir(output, { recursive: true });
    window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      useContentSize: true,
      webPreferences: { backgroundThrottling: false }
    });
    const errors = [];
    window.webContents.on("console-message", (_event, details) => {
      if (details.level === "error") errors.push(details.message);
    });
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source, label) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      assert.fail(
        `Timed out: ${label}; ${await js("document.body.textContent.slice(0,900)")}; ${errors.join(" | ")}`
      );
    };
    const click = async (source, label) =>
      assert.equal(
        await js(
          `(() => {const node=${source};node?.click();return !!node;})()`
        ),
        true,
        label
      );
    const capture = async (name) => {
      await js(
        "document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))"
      );
      const image = await window.webContents.capturePage();
      await writeFile(resolve(output, name), image.toPNG());
    };
    await window.loadFile(
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      {
        query: {
          view: "hq",
          hq724Capture: "yes",
          hq723Capture: "yes",
          hq704Capture: "yes",
          hq704Owner: "yes",
          hq714Capture: "yes"
        }
      }
    );
    await waitFor(
      "document.documentElement.dataset.hqFixtureReady==='true' && window.__koedHq724Trace && document.querySelector('.hq-sidebar__action--sharing')",
      "HQ-724 fixture ready"
    );
    window.show();
    await js(
      "document.documentElement.classList.remove('dark');document.documentElement.classList.add('light')"
    );
    await click(
      "document.querySelector('.hq-sidebar__action--sharing')",
      "open Sharing"
    );
    await waitFor(
      "document.querySelector('.hq-sharing h1')?.textContent==='Sharing'",
      "Sharing page"
    );
    const removeSam =
      "[...document.querySelectorAll('.hq-sharing section')].find(section=>section.querySelector('h2')?.textContent.startsWith('Recently shared'))?.querySelector('.hq-sharing__card button:not(.hq-sharing__detail-toggle)')";
    await click(removeSam, "Remove access in recent share");
    await waitFor(
      "document.querySelector('.hq-sharing__removal-status')?.textContent.includes('Removing Sam from Investor deck')",
      "Undo toast"
    );
    assert.equal(
      await js("window.__koedHq724Trace.sent"),
      0,
      "No mutation before the Undo window closes"
    );
    await capture("removing-pending-light.png");
    await js("document.documentElement.classList.replace('light','dark')");
    await capture("removing-pending-dark.png");
    await click(
      "document.querySelector('.hq-sharing__removal-status button')",
      "Undo pending removal"
    );
    await waitFor(
      "document.querySelector('.hq-sharing__removal-status')?.textContent.includes('not attempted')",
      "Undo result"
    );
    assert.equal(
      await js("window.__koedHq724Trace.sent"),
      0,
      "Undo sends no removal"
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-sharing')?.textContent.includes('Sam')"
      ),
      true
    );
    await click(removeSam, "review removal again");
    await waitFor(
      "document.querySelector('.hq-sharing__removal-status')?.textContent.includes('Removing Sam from Investor deck')",
      "second Undo window"
    );
    await waitFor(
      "window.__koedHq724Trace.sent===1",
      "removal dispatch after five seconds"
    );
    await waitFor(
      "document.querySelector('.hq-sharing__removal-status')?.textContent.includes('Sam no longer has access')",
      "completion toast"
    );
    await capture("removal-complete-dark.png");
    await js("document.documentElement.classList.replace('dark','light')");
    await capture("removal-complete-light.png");
    assert.equal(
      await js(
        "document.querySelector('.hq-sharing')?.textContent.includes('Sam')"
      ),
      false,
      "Removed person is gone from Sharing"
    );
    assert.deepEqual(errors, [], "Native renderer console errors");
    await writeFile(
      resolve(output, "HQ724.native.json"),
      JSON.stringify(
        {
          id: "HQ724.native",
          owner: "HQ-724",
          status: "pass",
          scope: "renderer-fixture",
          assertions: ["S2.removal.ui", "S4.ui", "N25.ui"],
          realStepUpProof: "I724.1–I724.3 in the separate real-service suite",
          screenshots: [
            "removing-pending-light.png",
            "removing-pending-dark.png",
            "removal-complete-dark.png",
            "removal-complete-light.png"
          ]
        },
        null,
        2
      )
    );
    process.stdout.write(
      "PASS HQ-724 Native HQ pending-removal Undo and dispatch.\n"
    );
  } finally {
    window?.destroy();
    app.quit();
  }
}

void run().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
  app.quit();
});
