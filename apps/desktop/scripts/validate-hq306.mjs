import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const output = resolve(scratch, "hq-306", "screenshots");
const profile = process.env.KOED_HQ306_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-306 Electron profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

async function run() {
  let window;
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      useContentSize: true,
      webPreferences: { backgroundThrottling: false }
    });
    const js = (source) => window.webContents.executeJavaScript(source);
    const capture = async (name) => {
      await delay(100);
      await writeFile(
        resolve(output, name),
        (await window.webContents.capturePage()).toPNG()
      );
    };
    await mkdir(output, { recursive: true });
    for (const dark of [false, true]) {
      await window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        { query: { view: "hq", hq306Capture: "yes" } }
      );
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          await js(
            "document.documentElement.dataset.hqFixtureReady === 'true' && Boolean(document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]'))"
          )
        )
          break;
        await delay(50);
      }
      await js(
        `document.documentElement.classList.toggle('dark', ${dark}); document.documentElement.classList.toggle('light', ${!dark}); document.querySelector('[data-hq-project-link="00000000-0000-4000-8000-000000002038"]').click()`
      );
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          await js(
            "document.querySelectorAll('.hq-citation-chip').length === 4"
          )
        )
          break;
        await delay(50);
      }
      const metrics = await js(`(() => {
        const chips = [...document.querySelectorAll('.hq-citation-chip')];
        return { count: chips.length, chips: chips.map((chip) => ({
          text: chip.textContent.trim(), width: chip.getBoundingClientRect().width,
          height: chip.getBoundingClientRect().height,
          background: getComputedStyle(chip).backgroundColor,
          color: getComputedStyle(chip).color
        })), fromMemory: document.querySelector('.hq-citation-sources')?.textContent.includes('From memory') };
      })()`);
      assert.equal(metrics.count, 4);
      assert.deepEqual(
        metrics.chips.map((chip) => chip.text),
        ["1", "2", "1", "2"]
      );
      assert.ok(
        metrics.chips.every((chip) => chip.width === 17 && chip.height === 17)
      );
      assert.ok(
        metrics.chips.every((chip) => chip.color === "rgb(255, 255, 255)")
      );
      assert.equal(metrics.fromMemory, true);
      assert.ok(
        await js("window.__koedHq306Trace?.aliasLookups >= 1"),
        "Captured history must reload citations by alias without transient output or provider-turn metadata"
      );
      await capture(`hq306-${dark ? "dark" : "light"}.png`);
      await js("document.querySelector('.hq-citation-chip').click()");
      const detail = await js(`(() => {
        const pane = document.querySelector('.hq-citation-detail');
        const chat = document.querySelector('.hq-conversation__scroll:not([hidden])');
        const composer = document.querySelector('.hq-conversation__dock');
        const paneRect = pane?.getBoundingClientRect();
        return { title: pane?.querySelector('h2')?.textContent,
          width: paneRect?.width, height: paneRect?.height,
          provenance: pane?.textContent.includes('WHERE IT CAME FROM'),
          besideReply: Boolean(paneRect && chat && paneRect.right <= chat.getBoundingClientRect().left),
          besideComposer: Boolean(paneRect && composer && paneRect.right <= composer.getBoundingClientRect().left) };
      })()`);
      assert.equal(detail.title, "Never book meetings before 9am.");
      assert.equal(detail.width, 397);
      assert.equal(detail.height, 800);
      assert.equal(detail.provenance, true);
      assert.equal(detail.besideReply, true);
      assert.equal(detail.besideComposer, true);
      assert.ok(await js("window.__koedHq306Trace?.detailOpens >= 1"));
      await capture(`hq306-detail-${dark ? "dark" : "light"}.png`);
      await js(
        "document.querySelector('[aria-label=\"Close memory source\"]').click()"
      );
      assert.equal(
        await js("document.querySelector('.hq-citation-detail') === null"),
        true
      );
      const ordinaryLink =
        '[data-hq-chat-project="00000000-0000-4000-8000-000000002038"][data-hq-chat-row]';
      assert.ok(
        await js(`Boolean(document.querySelector('${ordinaryLink}'))`),
        await js(
          "JSON.stringify({links:[...document.querySelectorAll('[data-hq-chat-project]')].map(x=>({project:x.dataset.hqChatProject,title:x.textContent})),projects:[...document.querySelectorAll('[data-hq-project-link]')].map(x=>({id:x.dataset.hqProjectLink,expanded:x.getAttribute('aria-expanded')}))})"
        )
      );
      await js(`document.querySelector('${ordinaryLink}').click()`);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          await js(
            "document.querySelector('[data-hq-route=\"conversation\"] .hq-citation-chip') !== null"
          )
        )
          break;
        await delay(50);
      }
      assert.ok(
        await js(
          "document.querySelector('[data-hq-route=\"conversation\"] .hq-citation-chip') !== null"
        ),
        "Ordinary Conversation must show persisted citation aliases"
      );
      const ordinaryBefore = await js(
        "document.querySelector('.hq-conversation__scroll').getBoundingClientRect().width"
      );
      await js("document.querySelector('.hq-citation-chip').click()");
      const ordinary = await js(`(() => {
        const pane = document.querySelector('.hq-citation-detail')?.getBoundingClientRect();
        const reply = document.querySelector('.hq-conversation__scroll')?.getBoundingClientRect();
        const composer = document.querySelector('.hq-conversation__dock')?.getBoundingClientRect();
        return { paneWidth: pane?.width, replyClear: Boolean(pane && reply && (pane.right <= reply.left || pane.left >= reply.right)),
          composerClear: Boolean(pane && composer && (pane.right <= composer.left || pane.left >= composer.right)),
          replyWidth: reply?.width };
      })()`);
      assert.equal(ordinary.paneWidth, 397);
      assert.equal(ordinary.replyClear, true);
      assert.equal(ordinary.composerClear, true);
      await capture(`hq306-ordinary-detail-${dark ? "dark" : "light"}.png`);
      await js(
        "document.querySelector('[aria-label=\"Close memory source\"]').click()"
      );
      const ordinaryRestored = await js(
        "document.querySelector('.hq-conversation__scroll').getBoundingClientRect().width"
      );
      assert.ok(
        ordinaryRestored > ordinary.replyWidth &&
          ordinaryRestored === ordinaryBefore
      );
      process.stdout.write(
        `${dark ? "dark" : "light"}: ${JSON.stringify({ metrics, detail, ordinary })}\n`
      );
    }
    await window.loadFile(
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      { query: { view: "hq", hq306Capture: "yes", hq306Race: "yes" } }
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        await js(
          "document.documentElement.dataset.hqFixtureReady === 'true' && Boolean(document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]'))"
        )
      )
        break;
      await delay(50);
    }
    await js(
      "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]').click()"
    );
    for (let attempt = 0; attempt < 120; attempt++) {
      if (
        await js(
          "window.__koedHq306Trace?.aliasLookups >= 2 && document.querySelectorAll('.hq-citation-chip').length === 4"
        )
      )
        break;
      await delay(50);
    }
    assert.ok(
      await js("window.__koedHq306Trace?.aliasLookups >= 2"),
      "A completed command must refetch an initially empty alias lookup"
    );
    assert.equal(
      await js("document.querySelectorAll('.hq-citation-chip').length"),
      4
    );
    process.stdout.write(
      "live command completion: empty alias lookup resolved on completion\n"
    );
  } finally {
    window?.destroy();
    app.quit();
  }
}

void run().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  app.exit(1);
});
