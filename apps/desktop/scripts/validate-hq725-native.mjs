import assert from "node:assert/strict";
import process from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const output = resolve(root, "scratch/hq-725");
const profile = process.env.KOED_HQ725_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-725 Electron profile.");
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
    window.webContents.on("console-message", (details) => {
      if (details.level === "error") errors.push(details.message);
    });
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source, label) => {
      for (let attempt = 0; attempt < 140; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      assert.fail(
        `Timed out: ${label}; ${await js("JSON.stringify({text:document.body.textContent.slice(-2200),action:document.querySelector('.hq-text-action')?.textContent,removal:document.querySelector('.hq-sharing__removal-status')?.textContent,trace:window.__koedHq725Trace,service:window.__koedHq724Trace})")}; ${errors.join(" | ")}`
      );
    };
    const click = async (source, label) => {
      assert.equal(
        await js(
          `(() => {const node=${source};node?.click();return !!node;})()`
        ),
        true,
        label
      );
    };
    const capture = async (name) => {
      await js(
        "document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))"
      );
      await writeFile(
        resolve(output, name),
        (await window.webContents.capturePage()).toPNG()
      );
    };
    const load = async (mode) => {
      await window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        {
          query: {
            view: "hq",
            hq725Capture: "yes",
            hq725Mode: mode,
            hq204Capture: "yes",
            hq723Capture: "yes",
            hq724Capture: "yes",
            hq704Capture: "yes",
            hq704Owner: "yes",
            hq714Capture: "yes"
          }
        }
      );
      await waitFor(
        "document.documentElement.dataset.hqFixtureReady==='true' && window.__koedHq725Trace && window.__koedHq724Trace",
        "fixture ready"
      );
      window.show();
    };
    const openSharing = async () => {
      await click(
        "document.querySelector('.hq-sidebar__action--sharing')",
        "open Sharing"
      );
      await waitFor(
        "document.querySelector('.hq-sharing h1')?.textContent==='Sharing'",
        "Sharing page"
      );
    };
    const openConversation = async (submit = true) => {
      await click(
        "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]')",
        "open Project conversation"
      );
      if (!submit) return;
      await waitFor(
        "!!document.querySelector('.hq-project-conversation textarea')",
        "Project composer"
      );
      await js(`(() => { const input=document.querySelector('.hq-project-conversation textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Stop sharing Investor deck with Sam');
        input.dispatchEvent(new InputEvent('input',{bubbles:true})); })()`);
      await waitFor(
        "document.querySelector('.hq-project-conversation form button[type=submit]')?.disabled === false",
        "prompt ready"
      );
      await js(
        "document.querySelector('.hq-project-conversation form')?.requestSubmit()"
      );
      await waitFor(
        "!!document.querySelector('.hq-text-action')",
        "removal proposal"
      );
    };
    await load("ask_first");
    await openSharing();
    await waitFor(
      "document.querySelectorAll('[data-help-promise]').length===5",
      "five help promises"
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-sharing__stats').compareDocumentPosition(document.querySelector('.hq-sharing__help')) & Node.DOCUMENT_POSITION_FOLLOWING"
      ),
      4
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-sharing__help').compareDocumentPosition(document.querySelector('.hq-sharing__filter')) & Node.DOCUMENT_POSITION_FOLLOWING"
      ),
      4
    );
    assert.match(
      await js(
        "document.querySelector('.hq-sharing__unavailable')?.textContent"
      ),
      /aren.t shown/
    );
    await capture("help-first-visit-light.png");
    await js("document.documentElement.classList.replace('light','dark')");
    await capture("help-first-visit-dark.png");
    await js("document.documentElement.classList.replace('dark','light')");
    await click(
      "[...document.querySelectorAll('.hq-sharing__help-footer button')].find(b=>b.textContent==='Hide')",
      "hide help"
    );
    assert.equal(
      await js("!!document.querySelector('.hq-sharing__help')"),
      false
    );
    await click(
      "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]')",
      "leave Sharing"
    );
    await openSharing();
    assert.equal(
      await js("!!document.querySelector('.hq-sharing__help')"),
      false,
      "Hide is remembered"
    );
    await click(
      "document.querySelector('.hq-sharing__header button[aria-expanded=false]')",
      "show help"
    );
    assert.equal(
      await js("localStorage.getItem('koed-sharing-help-v1')"),
      "shown"
    );
    await click(
      "[...document.querySelectorAll('.hq-sharing__help-footer button')].find(b=>b.textContent?.includes('What do you know'))",
      "memory question"
    );
    await waitFor(
      "[...document.querySelectorAll('textarea')].some(t=>t.value==='What do you know about me?')",
      "memory question draft"
    );
    await openSharing();
    await click(
      "[...document.querySelectorAll('.hq-sharing__help-footer button')].find(b=>b.textContent?.startsWith('Ask '))",
      "Ask Chief"
    );
    await waitFor(
      "[...document.querySelectorAll('textarea')].some(t=>t.value==='How does sharing work?')",
      "sharing question draft"
    );
    await openConversation();
    assert.match(
      await js("document.querySelector('.hq-text-action')?.textContent"),
      /Remove sharing access.*Review 1 exact sharing target/
    );
    assert.equal(await js("window.__koedHq725Trace.claims"), 0);
    await click(
      "document.querySelector('.hq-text-action__button--primary')",
      "approve Ask first removal"
    );
    await waitFor(
      "window.__koedHq725Trace.reviews===1 && window.__koedHq725Trace.claims===1 && document.querySelector('.hq-sharing__removal-status')?.textContent.includes('Removing Sam')",
      "reviewed removal pending Undo"
    );
    assert.equal(await js("window.__koedHq724Trace.sent"), 0);
    await capture("ask-first-pending-light.png");
    await click(
      "document.querySelector('.hq-sharing__removal-status button')",
      "Undo removal"
    );
    await waitFor(
      "document.querySelector('.hq-sharing__removal-status')?.textContent.includes('not attempted')",
      "Undo result"
    );
    assert.equal(await js("window.__koedHq725Trace.completions"), 0);
    assert.equal(await js("window.__koedHq724Trace.sent"), 0);
    await waitFor(
      "[...document.querySelectorAll('.hq-text-action button')].some(b=>b.textContent?.trim()==='Check result' && !b.disabled)",
      "read-only reconciliation"
    );
    await click(
      "[...document.querySelectorAll('.hq-text-action button')].find(b=>b.textContent?.trim()==='Check result')",
      "check canceled result without redispatch"
    );
    assert.equal(await js("window.__koedHq725Trace.claims"), 1);
    assert.equal(await js("window.__koedHq724Trace.sent"), 0);

    await load("full_access");
    await openConversation();
    await waitFor(
      "window.__koedHq725Trace.claims===1 && document.querySelector('.hq-sharing__removal-status')?.textContent.includes('Removing Sam')",
      "Full access system review and pending Undo"
    );
    assert.equal(
      await js("window.__koedHq725Trace.reviews"),
      0,
      "Full access adds no second app confirmation"
    );
    assert.equal(await js("window.__koedHq724Trace.sent"), 0);
    await js("document.documentElement.classList.replace('light','dark')");
    await capture("full-access-pending-dark.png");
    await waitFor(
      "window.__koedHq724Trace.sent===1 && window.__koedHq725Trace.completions===1",
      "final removal receipt"
    );
    await openSharing();
    await waitFor(
      "!document.querySelector('.hq-sharing')?.textContent.includes('Sam')",
      "Sharing refreshed after removal"
    );
    await js("document.documentElement.classList.replace('dark','light')");
    await capture("removal-complete-light.png");
    await load("open");
    await openConversation(false);
    await waitFor(
      "document.querySelector('.hq-sharing h1')?.textContent==='Sharing' && window.__koedHq725Trace.completions===1",
      "Chief opens Sharing and settles action"
    );
    assert.deepEqual(errors, [], "Native renderer console errors");
    await writeFile(
      resolve(output, "HQ725.native.json"),
      JSON.stringify(
        {
          id: "HQ725.native",
          owner: "HQ-725",
          status: "pass",
          scope: "renderer-fixture",
          assertions: [
            "S10.help.ui",
            "S10.ask.ui",
            "S11.remove.ask.ui",
            "S11.remove.full.ui",
            "S11.open.ui",
            "N27.ui"
          ],
          screenshots: [
            "help-first-visit-light.png",
            "help-first-visit-dark.png",
            "ask-first-pending-light.png",
            "full-access-pending-dark.png",
            "removal-complete-light.png"
          ]
        },
        null,
        2
      )
    );
    process.stdout.write("PASS HQ-725 Native help and reviewed removal.\n");
  } finally {
    window?.destroy();
  }
}

void run().then(
  () => app.exit(0),
  (error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    app.exit(1);
  }
);
