import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const profile = process.env.KOED_HQ522_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-522 Electron profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);
const output = resolve(scratch, "hq-522");

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
        `HQ-522 timed out waiting for ${label}: ${await js("document.body.textContent.slice(0,900)")}`
      );
    };
    const click = async (source, label) => {
      assert.equal(await js(source), true, label);
      await delay(50);
    };
    const setDraft = async (draft) => {
      assert.equal(
        await js(
          `(() => {const input=document.querySelector('.hq-composer textarea'); if(!input)return false; const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(input,${JSON.stringify(draft)}); input.dispatchEvent(new Event('input',{bubbles:true})); return true;})()`
        ),
        true
      );
    };
    const banner = () =>
      "(document.querySelector('.hq-usage-suggestion')?.textContent ?? '')";
    const select = (label) =>
      `(() => {const button=[...document.querySelectorAll('.hq-usage-suggestion button')].find(x=>x.textContent.trim()===${JSON.stringify(label)});button?.click();return !!button;})()`;
    const newChat = () =>
      "(() => {const button=document.querySelector('button[aria-label=\"New chat\"]');button?.click();return !!button;})()";
    const capture = async (name) => {
      await js(`document.fonts.ready.then(() => Promise.all(document.getAnimations({subtree:true})
        .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().iterations ?? Infinity))
        .map(animation => animation.finished.catch(() => undefined))))
        .then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
      const image = await window.webContents.capturePage();
      await writeFile(resolve(output, name), image.toPNG());
    };
    await window.loadFile(
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      { query: { view: "hq", hq522Capture: "yes", hq204Capture: "yes" } }
    );
    await waitFor(
      "document.documentElement.dataset.hqFixtureReady === 'true' && !!window.__koedHq522Usage",
      "HQ-522 fixture"
    );
    window.show();
    await js(
      "document.documentElement.classList.remove('dark');document.documentElement.classList.add('light')"
    );
    await click(newChat(), "new Conversation");
    await setDraft("Build the pantry app");
    await waitFor(
      `${banner()}.includes('4% of this week left') && ${banner()}.includes('Use Claude for this chat?')`,
      "Codex low suggestion"
    );
    assert.match(
      await js(
        "document.querySelector('[aria-label^=\"Model and reasoning:\"]')?.getAttribute('aria-label')"
      ),
      /AI Client: Codex/
    );
    await capture("codex-low-light.png");
    await js("document.documentElement.classList.replace('light','dark')");
    await capture("codex-low-dark.png");
    await click(select("Use Claude"), "accept Claude for new Conversation");
    await waitFor(
      "document.querySelector('[aria-label^=\"Model and reasoning:\"]')?.getAttribute('aria-label')?.includes('AI Client: Claude') && document.querySelector('.hq-usage-suggestion')?.textContent.includes('Undo')",
      "new Conversation selection with Undo"
    );
    assert.equal(
      await js("window.__koedHq522Usage.trace.settingsWrites"),
      0,
      "saved default unchanged"
    );
    await click(select("Undo"), "Undo selection");
    await waitFor(
      "document.querySelector('[aria-label^=\"Model and reasoning:\"]')?.getAttribute('aria-label')?.includes('AI Client: Codex')",
      "Codex restored"
    );
    await click(select("Keep Codex"), "dismiss warning");
    assert.equal(
      await js("!!document.querySelector('.hq-usage-suggestion')"),
      false
    );
    await click(newChat(), "remount blank Conversation");
    await setDraft("A second draft");
    await delay(100);
    assert.equal(
      await js("!!document.querySelector('.hq-usage-suggestion')"),
      false,
      "Keep persists across remount"
    );
    await js("window.__koedHq522Usage.accountChange()");
    await waitFor(
      "!!document.querySelector('.hq-usage-suggestion')",
      "warning after account scope changes"
    );
    await click(
      "(() => {const button=document.querySelector('.hq-composer__send[aria-label=\"Send message\"]');button?.click();return !!button;})()",
      "send Codex first turn"
    );
    await waitFor(
      "!!document.querySelector('.hq-conversation:not(.hq-conversation--blank) .hq-composer textarea')",
      "running Codex Conversation"
    );
    await setDraft("Exact carried draft");
    await waitFor(
      `${banner()}.includes('New chat with Claude')`,
      "running Conversation new-chat offer"
    );
    await click(select("New chat with Claude"), "open new Claude chat");
    await waitFor(
      "document.querySelector('.hq-conversation--blank .hq-composer textarea')?.value === 'Exact carried draft' && document.querySelector('[aria-label^=\"Model and reasoning:\"]')?.getAttribute('aria-label')?.includes('AI Client: Claude')",
      "new chat preserves exact draft and AI"
    );
    assert.equal(await js("window.__koedHq522Usage.trace.settingsWrites"), 0);
    await capture("new-chat-claude-dark.png");
    await js("window.__koedHq522Usage.setVariant('claudeLowCodexFine')");
    await waitFor(
      `${banner()}.includes('Use Codex')`,
      "Claude model-specific weekly limit"
    );
    await capture("claude-low-dark.png");
    await js("window.__koedHq522Usage.setVariant('noAlternative')");
    await click(newChat(), "new Codex chat for no-alternative case");
    await setDraft("No alternative");
    await waitFor(
      `${banner()}.includes('No other AI reports room right now.')`,
      "warning only"
    );
    assert.equal(
      await js("!!document.querySelector('.hq-usage-suggestion__primary')"),
      false
    );
    await capture("warning-only-dark.png");
    await js("window.__koedHq522Usage.setVariant('staleAlternative')");
    await waitFor(
      `${banner()}.includes('No other AI reports room right now.')`,
      "stale alternative rejected"
    );
    await js("window.__koedHq522Usage.setVariant('passedResetAlternative')");
    await waitFor(
      `${banner()}.includes('No other AI reports room right now.')`,
      "passed-reset alternative rejected"
    );
    await js("window.__koedHq522Usage.setVariant('allFine')");
    await waitFor(
      "!document.querySelector('.hq-usage-suggestion')",
      "all-fine no warning"
    );
    await js("window.__koedHq522Usage.setVariant('codexLowClaudeFine')");
    await click(
      "(() => {const link=document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]');link?.click();return !!link;})()",
      "open Project HQ"
    );
    await waitFor(
      "!!document.querySelector('.hq-project-conversation textarea')",
      "Project HQ composer"
    );
    await js(
      "(() => {const input=document.querySelector('.hq-project-conversation textarea');const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(input,'Project HQ low usage');input.dispatchEvent(new Event('input',{bubbles:true}));})()"
    );
    await waitFor(
      "!!document.querySelector('.hq-project-conversation .hq-usage-suggestion')",
      "Project HQ usage warning"
    );
    assert.equal(
      await js(
        "!!document.querySelector('.hq-project-conversation .hq-usage-suggestion__primary')"
      ),
      false,
      "Project HQ cannot offer an AI switch"
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-project-conversation .hq-usage-suggestion')?.textContent.includes('No other AI reports room right now.')"
      ),
      false,
      "Project HQ warning does not misstate alternative room"
    );
    await capture("project-hq-warning-dark.png");
    const report = {
      id: "HQ522.native",
      owner: "HQ-522",
      status: "pass",
      assertions: ["U4", "U5", "U6", "N20", "N24", "N29"],
      screenshots: [
        "codex-low-light.png",
        "codex-low-dark.png",
        "new-chat-claude-dark.png",
        "claude-low-dark.png",
        "warning-only-dark.png",
        "project-hq-warning-dark.png"
      ],
      trace: await js("window.__koedHq522Usage.trace")
    };
    await writeFile(
      resolve(output, "HQ522.native.json"),
      JSON.stringify(report, null, 2)
    );
    process.stdout.write("PASS HQ-522 native usage suggestion scenarios.\n");
  } finally {
    window?.close();
    app.quit();
  }
}
run().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  app.exit(1);
});
