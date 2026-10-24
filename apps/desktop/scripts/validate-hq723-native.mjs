import process from "node:process";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const output = resolve(root, "scratch/hq-723");
const profile = process.env.KOED_HQ723_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-723 Electron profile.");
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
      await js(`document.fonts.ready.then(() => Promise.all(document.getAnimations({subtree:true})
        .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().iterations ?? Infinity))
        .map(animation => animation.finished.catch(() => undefined))))
        .then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
      const image = await window.webContents.capturePage();
      await writeFile(resolve(output, name), image.toPNG());
    };
    const section = (name) =>
      `([...document.querySelectorAll('.hq-sharing section')].find(x=>x.querySelector('h2')?.textContent.startsWith(${JSON.stringify(name)})))`;
    await window.loadFile(
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      { query: { view: "hq", hq723Capture: "yes", hq704Capture: "yes" } }
    );
    await waitFor(
      "document.documentElement.dataset.hqFixtureReady==='true' && window.__koedHq723Sharing?.id==='hq-sharing-fixture-v1' && !!document.querySelector('.hq-sidebar__action--sharing')",
      "real HQ shell and separate sharing data"
    );
    window.show();
    await click(
      "document.querySelector('.hq-sidebar__action--sharing')",
      "sidebar Sharing icon"
    );
    await waitFor(
      "document.querySelector('.hq-sharing h1')?.textContent==='Sharing'",
      "Sharing page"
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-sidebar__action--sharing')?.getAttribute('aria-current')"
      ),
      "page"
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-sidebar__action--now')?.getAttribute('aria-current')"
      ),
      null
    );
    const initial = await js(
      `(() => {const page=document.querySelector('.hq-sharing');return {description:page.querySelector('header p')?.textContent,stats:page.querySelector('.hq-sharing__stats')?.textContent,unavailable:page.querySelector('.hq-sharing__unavailable')?.textContent,segments:[...page.querySelectorAll('.hq-sharing__seg button')].map(x=>x.textContent),youCards:${section("You share")}?.querySelectorAll('.hq-sharing__card').length,theirCards:${section("Shared with you")}?.querySelectorAll('.hq-sharing__card').length};})()`
    );
    assert.match(initial.description, /Who sees your work/);
    assert.deepEqual(initial.segments, ["By person", "By project"]);
    assert.match(initial.stats, /at least 9 people see your work/);
    assert.match(initial.stats, /at least 3 projects shared/);
    assert.match(initial.stats, /at least 1 shared by Cooper/);
    assert.match(initial.unavailable, /Couldn.t reach Studio Team/);
    assert.equal(
      await js(
        "document.querySelector('.hq-sharing__agent-flag')?.textContent.includes('Cooper shared this 40m ago')"
      ),
      true
    );
    assert.equal(initial.youCards, 6);
    assert.equal(initial.theirCards, 6);
    assert.match(
      await js(`${section("Workspace and Team access")}?.textContent`),
      /Nora[\s\S]*Design[\s\S]*Pat[\s\S]*not accepted yet/
    );
    await click(
      "[...document.querySelectorAll('.hq-sharing__detail-toggle')].find(x=>x.textContent.includes('Sam'))",
      "Sam recent detail"
    );
    await waitFor(
      "document.querySelector('.hq-sharing__detail')?.textContent.includes('what the Project remembers (2 things)')",
      "read-model detail counts"
    );
    const detail = await js(
      "document.querySelector('.hq-sharing__detail')?.textContent"
    );
    assert.match(detail, /1 source, 2 to-dos, 1 chat \(summary\)/);
    assert.match(detail, /Plan next week/);
    assert.match(detail, /Full access was on/);
    const themeColors = () =>
      js(`(() => {
      const page=document.querySelector('.hq-sharing');
      const card=page.querySelector('.hq-sharing__card');
      return {page:getComputedStyle(page).color,card:getComputedStyle(card).backgroundColor};
    })()`);
    const lightColors = await themeColors();
    assert.notEqual(lightColors.page, "rgba(0, 0, 0, 0)");
    assert.notEqual(lightColors.card, "rgba(0, 0, 0, 0)");
    await capture("sharing-light.png");
    await js("document.documentElement.classList.add('dark')");
    const darkColors = await themeColors();
    assert.notDeepEqual(darkColors, lightColors);
    await capture("sharing-dark.png");
    await js("document.documentElement.classList.remove('dark')");
    await js("window.__koedHq723Sharing.toggleRecent()");
    await waitFor(
      "document.querySelector('.hq-sharing__empty')?.textContent.includes('Nothing shared in the last 24 hours')",
      "recent empty state"
    );
    await js("window.__koedHq723Sharing.toggleRecent()");
    await js("window.__koedHq723Sharing.invitePriya()");
    await waitFor(
      "document.querySelector('.hq-sharing')?.textContent.includes('invited Priya')",
      "live invitation on top"
    );
    await click(
      `${section("You share")}?.querySelector('.hq-sharing__more')`,
      "Show more people"
    );
    assert.equal(
      await js(
        `${section("You share")}?.querySelectorAll('.hq-sharing__card').length`
      ),
      10
    );
    await click(
      `${section("Shared with you")}?.querySelector('.hq-sharing__more')`,
      "Show more shared Projects"
    );
    assert.equal(
      await js(
        `${section("Shared with you")}?.querySelectorAll('.hq-sharing__card').length`
      ),
      8
    );
    await click(
      `${section("Shared with you")}?.querySelector('.hq-sharing__more')`,
      "Show less shared Projects"
    );
    assert.equal(
      await js(
        `${section("You share")}?.querySelectorAll('.hq-sharing__card').length`
      ),
      10,
      "each section keeps its own expansion"
    );
    await click(
      `${section("You share")}?.querySelector('.hq-sharing__more')`,
      "Show less people"
    );

    assert.equal(
      await js(
        `${section("Shared with you")}?.querySelectorAll('.hq-sharing__card').length`
      ),
      6
    );
    await js(
      "(() => {const input=document.querySelector('input[aria-label=\"Filter by person or project\"]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'mar');input.dispatchEvent(new Event('input',{bubbles:true}));})()"
    );
    await waitFor(
      `${section("You share")}?.textContent.includes('Mark') && !${section("You share")}?.textContent.includes('Omar')`,
      "word-start filter"
    );
    assert.equal(
      await js(
        `${section("Shared with you")}?.querySelectorAll('.hq-sharing__card').length`
      ),
      0
    );
    await js(
      "document.querySelector('input[aria-label=\"Filter by person or project\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    await waitFor(
      "document.querySelector('input[aria-label=\"Filter by person or project\"]')?.value===''",
      "Escape clears filter"
    );
    await js(
      "(() => {const input=document.querySelector('input[aria-label=\"Filter by person or project\"]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'Ana');input.dispatchEvent(new Event('input',{bubbles:true}));})()"
    );
    await click(
      "document.querySelector('button[aria-label=\"Clear the filter\"]')",
      "clear filter"
    );
    await click(
      "document.querySelector('.hq-account')",
      "Settings account entry"
    );
    await click(
      "[...document.querySelectorAll('nav[aria-label=\"Settings sections\"] button')].find(x=>x.textContent==='Teams')",
      "Settings Teams"
    );
    await click(
      "[...document.querySelectorAll('.hq-settings__content button')].find(x=>x.textContent==='Open Sharing')",
      "Settings Sharing row"
    );
    await waitFor(
      "!document.querySelector('.hq-settings') && !!document.querySelector('.hq-sharing h1')",
      "Settings opens Sharing page"
    );
    await click(
      "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]')",
      "Investor deck Project"
    );
    await waitFor(
      "!!document.querySelector('button[aria-label=\"View who is in this shared Project\"]')",
      "Project share entry"
    );
    await click(
      "document.querySelector('button[aria-label=\"View who is in this shared Project\"]')",
      "Project share sheet"
    );
    await waitFor(
      "!![...document.querySelectorAll('.hq-share-sheet button')].find(x=>x.textContent==='Everything you share')",
      "share sheet Sharing link"
    );
    await click(
      "[...document.querySelectorAll('.hq-share-sheet button')].find(x=>x.textContent==='Everything you share')",
      "share sheet opens Sharing"
    );
    await waitFor(
      "!!document.querySelector('.hq-sharing h1')",
      "Sharing from share sheet"
    );
    await click(
      "[...document.querySelectorAll('[data-hq-chat-row]')].find(x=>x.textContent.includes('Plan next week'))",
      "shared Conversation"
    );
    await waitFor(
      '!!document.querySelector(\'[data-hq-route="conversation"][data-hq-project-id="00000000-0000-4000-8000-000000002038"][data-hq-session-id="00000000-0000-4000-8000-000000002045"]\')',
      "exact local Conversation route"
    );
    await waitFor(
      "window.__koedHqVisibilityReads?.logicalMemoryId==='00000000-0000-4000-8000-000000007118'",
      "exact shared logical memory read"
    );
    await waitFor(
      "document.querySelector('.hq-composer__visibility')?.textContent.includes('Visible to Koed team (summaries)') && !!document.querySelector('.hq-composer__visibility .vis-m')",
      "shared visibility Manage"
    );
    await click(
      "document.querySelector('.hq-composer__visibility .vis-m')",
      "visibility Manage"
    );
    await waitFor(
      "document.querySelector('.hq-sharing__chip')?.textContent.includes('Investor deck')",
      "Project-filtered Sharing"
    );
    await click(
      "document.querySelector('button[aria-label=\"Show everything\"]')",
      "clear Project chip"
    );
    await js("window.__koedHq723Sharing.toggleBackend()");
    await waitFor(
      "!document.querySelector('.hq-sharing__unavailable')",
      "Team backend recovered"
    );
    assert.doesNotMatch(
      await js("document.querySelector('.hq-sharing__stats')?.textContent"),
      /at least/
    );
    await click(
      `${section("Shared with you")}?.querySelector('.hq-sharing__actions button:last-child')`,
      "Decline invitation through existing review"
    );
    await waitFor(
      "window.__koedHq703Trace?.decisions.includes('decline') && window.__koedHq703Trace.joins===0",
      "reviewed invitation declined without joining"
    );
    await js("window.__koedHq723Sharing.restoreInvitation()");
    await waitFor(
      `${section("Shared with you")}?.textContent.includes('Accept')`,
      "second invitation visible"
    );
    await click(
      `${section("Shared with you")}?.querySelector('.hq-sharing__actions button')`,
      "Accept invitation through existing review"
    );
    await waitFor(
      "window.__koedHq703Trace?.decisions.includes('accept') && window.__koedHq703Trace.joins===1",
      "reviewed invitation accepted and joined"
    );
    await click(
      "document.querySelector('.hq-sidebar__action--sharing')",
      "return to Sharing after join"
    );
    await waitFor(
      `${section("Shared with you")}?.textContent.includes('landing-site') && !!${section("Shared with you")}?.querySelector('button')`,
      "joined Project appears with Leave"
    );
    await click(
      `${section("Shared with you")}?.querySelector('button')`,
      "Leave opens existing Project lifecycle review"
    );
    await waitFor(
      "document.querySelector('[role=dialog][aria-label=\"Project access\"]')?.textContent.includes('Leave landing-site?')",
      "Project lifecycle review"
    );
    await click(
      "[...document.querySelectorAll('[role=dialog][aria-label=\"Project access\"] button')].find(x=>x.textContent==='Cancel')",
      "cancel Leave review"
    );
    assert.deepEqual(await js("window.__koedHq704Trace?.actions"), []);
    assert.deepEqual(errors, []);
    const report = {
      id: "HQ723.native",
      owner: "HQ-723",
      status: "pass",
      assertions: ["S1", "S2.display", "S3", "S7", "S8", "S9", "N27"],
      screenshots: ["sharing-light.png", "sharing-dark.png"]
    };
    await writeFile(
      resolve(output, "HQ723.native.json"),
      JSON.stringify(report, null, 2) + "\n"
    );
    process.stdout.write("PASS HQ-723 native Sharing in real HQ shell.\n");
  } finally {
    window?.close();
    app.quit();
  }
}
run().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  app.exit(1);
});
