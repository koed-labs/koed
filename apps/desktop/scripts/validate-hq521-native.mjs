import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const profile = process.env.KOED_HQ521_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-521 Electron profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);
const output = resolve(scratch, "hq-521", "screenshots");

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
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source, label) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      assert.fail(
        `HQ-521 timed out waiting for ${label}: ${await js("document.body.textContent.slice(0,900)")}`
      );
    };
    const click = async (source, label) => {
      assert.equal(await js(source), true, label);
      await delay(50);
    };
    const capture = async (name) => {
      await js(
        `Promise.all(document.getAnimations({subtree:true})
          .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().iterations ?? Infinity))
          .map(animation => animation.finished.catch(() => undefined)))
          .then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`
      );
      const image = await window.webContents.capturePage();
      await writeFile(resolve(output, name), image.toPNG());
    };
    await window.loadFile(
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      { query: { view: "hq", hq521Capture: "yes" } }
    );
    await waitFor(
      "document.documentElement.dataset.hqFixtureReady === 'true' && !!window.__koedHq521Usage",
      "HQ usage fixture"
    );
    window.show();
    await js(
      "document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')"
    );
    await click(
      "(() => {const button=document.querySelector('button[aria-label=\"New chat\"]');button?.click();return !!button;})()",
      "new HQ Conversation"
    );
    await waitFor(
      "!!document.querySelector('[aria-label^=\"Model and reasoning:\"]')",
      "v50 composer model control"
    );
    await click(
      "(() => {const button=document.querySelector('[aria-label^=\"Model and reasoning:\"]');button?.click();return !!button;})()",
      "model menu"
    );
    await click(
      "(() => {const button=document.querySelector('[aria-label=\"Choose AI Client and model\"]');button?.click();return !!button;})()",
      "AI Client model list"
    );
    await waitFor(
      "document.querySelectorAll('.hq-conversation-menu__usage').length === 3 && document.body.textContent.includes('Codex: 4% of this week left')",
      "usage lines under three AI Clients"
    );
    assert.equal(
      await js("document.body.textContent.includes('Pi: Not shared by Pi')"),
      true
    );
    assert.equal(
      await js(
        "[...document.querySelectorAll('.hq-conversation-menu__usage')].some(node=>node.textContent?.startsWith('Codex:') && node.classList.contains('hq-conversation-menu__usage--low'))"
      ),
      true
    );
    await capture("model-menu-light.png");
    await click(
      "(() => {const item=[...document.querySelectorAll('[role=menuitem]')].find(node=>node.textContent?.includes('See usage'));item?.click();return !!item;})()",
      "See usage"
    );
    await waitFor(
      "!!document.querySelector('.hq-settings [aria-label=\"AI Client usage\"]')",
      "Settings Agents usage table"
    );
    const table = await js(`(() => {
      const settings=document.querySelector('.hq-settings'); const usage=settings?.querySelector('.hq-usage'); const connections=settings?.querySelector('[aria-label="AI Client integrations"]');
      return {section:settings?.querySelector('nav [aria-current="page"]')?.textContent?.trim(), before:!!usage&&!!connections&&usage.compareDocumentPosition(connections)&Node.DOCUMENT_POSITION_FOLLOWING, rows:usage?.querySelectorAll('.hq-usage__row').length, text:usage?.textContent, legacy:!!document.querySelector('.koed-preferences,.desktop-preferences')};
    })()`);
    assert.equal(table.section, "Agents");
    assert.ok(table.before, "Usage must precede Connections");
    assert.equal(table.rows, 4);
    assert.match(table.text, /12%/);
    assert.match(table.text, /96%/);
    assert.match(table.text, /Claude[\s\S]*OK/);
    assert.match(table.text, /as of 25m ago/);
    assert.match(table.text, /Not shared by Pi/);
    assert.equal(table.legacy, false);
    assert.equal(
      await js("!!document.querySelector('.hq-usage__cell--low')"),
      true
    );
    assert.equal(
      await js(
        `!!document.querySelector('.hq-usage [title*="free resets left"][title*="Codex"]')`
      ),
      true
    );
    await capture("settings-usage-light.png");
    await js("document.documentElement.classList.replace('light','dark')");
    await capture("settings-usage-dark.png");
    await js(
      "window.__koedHq521Usage.setVariant('claudeNear'); window.__koedHq521Usage.emit()"
    );
    await waitFor(
      "document.querySelector('.hq-usage__row:nth-child(3)')?.textContent.includes('Opus 91%')",
      "Claude Opus weekly reading"
    );
    await js("window.__koedHq521Usage.setOutcome('failed')");
    await click(
      "(() => {const button=document.querySelector('.hq-usage button[aria-label=\"Check usage now\"]');button?.click();return !!button;})()",
      "failed usage refresh"
    );
    await waitFor(
      "document.querySelector('.hq-usage [role=status]')?.textContent.includes(\"Couldn't check Codex\")",
      "failed refresh message"
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-usage [role=status]')?.textContent.includes('Checked Codex just now.')"
      ),
      false
    );
    await js("window.__koedHq521Usage.setOutcome('unsupported')");
    await click(
      "(() => {const button=document.querySelector('.hq-usage button[aria-label=\"Check usage now\"]');button?.click();return !!button;})()",
      "unsupported usage refresh"
    );
    await waitFor(
      "document.querySelector('.hq-usage [role=status]')?.textContent.includes(\"doesn't share usage\")",
      "unsupported refresh message"
    );
    await js("window.__koedHq521Usage.setOutcome('checked')");
    await click(
      "(() => {const button=document.querySelector('.hq-usage button[aria-label=\"Check usage now\"]');button?.click();return !!button;})()",
      "checked usage refresh"
    );
    await waitFor(
      "document.querySelector('.hq-usage [role=status]')?.textContent.includes('Checked Codex just now.')",
      "checked refresh message"
    );
    await js(
      "window.__koedHq521Usage.setVariant('allFine'); window.__koedHq521Usage.emit()"
    );
    await waitFor(
      "document.querySelector('.hq-usage')?.textContent.includes('32%')",
      "completion subscription re-read"
    );
    await js(
      "window.__koedHq521Usage.setVariant('codexRestriction'); window.__koedHq521Usage.emit()"
    );
    await waitFor(
      "document.querySelector('.hq-usage__row:nth-child(2)')?.textContent.includes('Limited')",
      "reported Codex restriction"
    );
    await js(
      "window.__koedHq521Usage.setVariant('unknown'); window.__koedHq521Usage.emit()"
    );
    await waitFor(
      "document.querySelector('.hq-usage__row:nth-child(2) .hq-usage__cell')?.getAttribute('title') === 'Unknown provider reading'",
      "unknown Codex reading"
    );
    await js(
      "window.__koedHq521Usage.setVariant('passedReset'); window.__koedHq521Usage.emit()"
    );
    await waitFor(
      "document.querySelector('.hq-usage__row:nth-child(2) .hq-usage__cell')?.getAttribute('title')?.includes('not checked since')",
      "passed reset is unknown"
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-usage__row:nth-child(2) .hq-usage__cell')?.textContent.includes('0%')"
      ),
      false
    );
    await capture("settings-passed-reset-dark.png");
    const subscribed = await js("window.__koedHq521Usage.activeSubscribers()");
    assert.ok(subscribed >= 1);
    await click(
      "(() => {const button=document.querySelector('.hq-settings [aria-label=\"Close Settings\"]');button?.click();return !!button;})()",
      "close Settings"
    );
    await waitFor(
      "window.__koedHq521Usage.activeSubscribers() === 0",
      "usage listener unsubscribe"
    );
    const trace = await js("window.__koedHq521Usage.trace");
    assert.ok(
      trace.refreshes >= 3 && trace.reads >= 4 && trace.unsubscribes >= 2
    );
    const report = {
      id: "HQ521.native",
      owner: "HQ-521",
      status: "pass",
      assertions: ["U1", "U2", "U3", "N19", "N24", "N34", "N35"],
      screenshots: [
        "model-menu-light.png",
        "settings-usage-light.png",
        "settings-usage-dark.png",
        "settings-passed-reset-dark.png"
      ],
      trace
    };
    await writeFile(
      resolve(scratch, "hq-521", "HQ521.native.json"),
      JSON.stringify(report, null, 2)
    );
    process.stdout.write(
      "PASS HQ-521 native HQ usage table, model menu, refresh, completion and cleanup.\n"
    );
  } finally {
    window?.close();
    app.quit();
  }
}
run().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  app.exit(1);
});
