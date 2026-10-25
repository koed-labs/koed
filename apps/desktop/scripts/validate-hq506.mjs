import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const output = resolve(scratch, "hq-506", "screenshots");
const reportPath = resolve(scratch, "hq-506", "HQ506.native.json");
const profile = process.env.KOED_HQ506_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-506 Electron profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

async function run() {
  let window;
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: process.env.KOED_HQ506_SHOW_WINDOW === "1",
      width: 1280,
      height: 800,
      useContentSize: true
    });
    // Hidden windows need an initial document before CDP emulation commands.
    await window.loadURL("about:blank");
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source, label) => {
      for (let attempt = 0; attempt < 160; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      assert.fail(`Timed out waiting for ${label}`);
    };
    const click = async (label) => {
      const clicked = await js(`(() => {
        const button = [...document.querySelectorAll('.hq-onboarding button')]
          .find((item) => item.textContent.trim() === ${JSON.stringify(label)});
        if (!button || button.disabled) return false;
        button.click();
        return true;
      })()`);
      assert.ok(clicked, `Expected enabled onboarding button: ${label}`);
    };
    const commands = () => js("window.__koedHq506.commands");
    await mkdir(output, { recursive: true });
    const debuggerClient = window.webContents.debugger;
    debuggerClient.attach("1.3");
    const screenshots = [];
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
      const previousScroll = await js(`(() => {
        const body = document.querySelector('.hq-onboarding__scroll');
        if (!body) return null;
        const previous = body.scrollTop;
        body.scrollTop = 0;
        return previous;
      })()`);
      if (previousScroll !== null) {
        await delay(50);
        const topName = name.replace(/\.png$/, "-top.png");
        const top = await debuggerClient.sendCommand("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false
        });
        await writeFile(
          resolve(output, topName),
          Buffer.from(top.data, "base64")
        );
        screenshots.push(topName);
        await js(
          `document.querySelector('.hq-onboarding__scroll').scrollTop = ${previousScroll}`
        );
      }
    };
    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await js("localStorage.clear()");
      await window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        { query: { view: "hq", hq506Capture: "yes" } }
      );
      await waitFor(
        "document.documentElement.dataset.hqFixtureReady === 'true' && Boolean(document.querySelector('.hq-onboarding__maker'))",
        "agent maker"
      );
      await js(`document.documentElement.classList.remove('light','dark');
        document.documentElement.classList.add('${theme}')`);
      assert.ok(
        await js(
          "Boolean(document.querySelector('[data-hq-shell] .hq-onboarding__maker'))"
        )
      );
      assert.equal(
        await js("document.querySelectorAll('.hq-onboarding__step').length"),
        4
      );
      assert.equal(
        await js(
          "document.querySelectorAll('.hq-onboarding__colors button').length"
        ),
        8
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-onboarding__composer textarea')?.placeholder"
        ),
        "Type a name, or pick one above"
      );
      assert.deepEqual(
        await js(
          "[...document.querySelectorAll('.hq-onboarding__colors button')].map((button) => button.style.backgroundColor)"
        ),
        [
          "rgb(157, 147, 251)",
          "rgb(98, 174, 245)",
          "rgb(95, 214, 160)",
          "rgb(189, 224, 90)",
          "rgb(255, 197, 63)",
          "rgb(255, 130, 104)",
          "rgb(244, 118, 171)",
          "rgb(174, 179, 194)"
        ]
      );
      assert.ok(
        await js(
          "Boolean(document.querySelector('#hq-onboarding-progress .hq-onboarding__steps'))"
        )
      );
      assert.ok(
        await js("document.body.textContent.includes('Hi, welcome to Koed.')")
      );
      assert.ok(
        await js(
          "document.body.textContent.includes('But first, make me yours. What should I be called, and how should I look?')"
        )
      );
      assert.equal(
        await js(
          "document.body.textContent.includes('What will you mostly use Koed for?')"
        ),
        false
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-onboarding__connection') === null"
        ),
        true
      );
      assert.deepEqual(await commands(), [
        "hq_onboarding_identity",
        "hq_onboarding_status"
      ]);
      await capture(`agent-${theme}.png`);

      await click("Juno");
      await click("That’s me");
      await waitFor(
        "Boolean(document.querySelector('.hq-onboarding__maker-done')) && document.body.textContent.includes('Three quick things:')",
        "accepted agent exchange"
      );
      assert.ok(
        await js('document.body.textContent.includes("I\'ll call you Juno.")')
      );
      assert.ok(
        await js("document.body.textContent.includes('What is Koed?')")
      );
      assert.equal(
        await js(
          "document.querySelectorAll('.hq-onboarding__message-content ol li').length"
        ),
        3
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-onboarding__composer textarea')?.placeholder"
        ),
        "Type here, or tap a button"
      );
      assert.equal(
        await js(
          "document.body.textContent.includes('Can I look for them on this Mac?')"
        ),
        false
      );
      await capture(`accepted-${theme}.png`);
      await click("Let's go");
      await waitFor(
        "document.body.textContent.includes('Can I look for them on this Mac?')",
        "Your AI guidance"
      );
      assert.equal(
        await js(
          "window.__koedHq506.commands.includes('hq_onboarding_prepare_memory')"
        ),
        false
      );
      await capture(`ai-${theme}.png`);
      await click("Look for them");
      await waitFor(
        "document.body.textContent.includes('Found one:')",
        "explicit AI discovery"
      );
      await click("Connect it");
      await waitFor(
        "document.body.textContent.includes('How I’ll use them') && document.body.textContent.includes('Next, the part that makes Koed worth it.')",
        "explicit AI selection"
      );
      await capture(`ai-selected-${theme}.png`);
      assert.equal(
        await js(
          "window.__koedHq506.commands.includes('hq_onboarding_prepare_memory')"
        ),
        false
      );
      await click("Next: memory");
      await waitFor(
        "document.body.textContent.includes('Now the part your AI subscription can') && document.body.textContent.includes('Tell me one thing about how you work.')",
        "Memory preparation"
      );
      await waitFor(
        "window.__koedHq506.memoryPreparations === 1",
        "one Memory preparation"
      );
      assert.deepEqual(await js("window.__koedHq506.memoryNotes"), []);
      assert.equal(
        await js("document.body.textContent.includes('Set up local memory')"),
        false
      );
      await capture(`memory-${theme}.png`);
      assert.equal(await js("document.querySelector('progress')?.value"), 3);
      assert.equal(await js("document.querySelector('progress')?.max"), 8);
      assert.equal(
        await js("document.querySelector('.hq-onboarding textarea')?.disabled"),
        true
      );
      const acceptedName = await js(
        "document.querySelector('.hq-onboarding__maker-done strong')?.textContent"
      );
      await js("window.__koedHq506.failMemory()");
      await waitFor(
        "document.body.textContent.includes('Your selections are saved.')",
        "recoverable setup failure"
      );
      await capture(`memory-failed-${theme}.png`);
      await click("Retry");
      await waitFor(
        "window.__koedHq506.memoryPreparations === 2 && document.body.textContent.includes('Starting local Memory')",
        "explicit Memory retry"
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-onboarding__maker-done strong')?.textContent"
        ),
        acceptedName
      );
      assert.equal(
        await js("window.__koedHq506.status.clients[0].selected"),
        true
      );
      await capture(`memory-retry-${theme}.png`);
      await js("window.__koedHq506.completeMemory()");
      await waitFor(
        "[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Keep answers short' && !button.disabled)",
        "verified Memory readiness"
      );
      await click("Keep answers short");
      await waitFor(
        "document.body.textContent.includes('webhookRetryPolicy — a short name')",
        "real Memory example"
      );
      assert.deepEqual(await js("window.__koedHq506.memoryNotes"), [
        "Keep answers short"
      ]);
      assert.equal(await js("window.__koedHq506.memoryAsks.length"), 1);
      await capture(`memory-learned-${theme}.png`);
      await click("Next: working together");
      await waitFor(
        "document.body.textContent.includes('Solo, with agents') && document.body.textContent.includes('Work item')",
        "Working together"
      );
      assert.ok(
        await js("document.body.textContent.includes('With your co-workers')")
      );
      await capture(`working-${theme}.png`);
      await click("Solo: hire an agent");
      await click("Hire an agent to write tests for this Project");
      assert.ok(
        await js(
          "Boolean(document.querySelector('.hq-onboarding__hire-card input'))"
        )
      );
      await capture(`hire-${theme}.png`);
      await click("Now show me inviting people");
      await click("Invite Mark to this Project");
      assert.ok(
        await js(
          "Boolean(document.querySelector('.hq-onboarding__invite-card input[type=email]'))"
        )
      );
      assert.ok(
        await js(
          "document.querySelector('.hq-onboarding__invite-card footer button')?.disabled === true"
        )
      );
      await capture(`invite-${theme}.png`);
      await click("Finish setup");
      assert.ok(await js('document.body.textContent.includes("You\'re set.")'));
      await capture(`summary-${theme}.png`);
      await js(`window.__onboardingFlashedMaker = false;
        window.__onboardingCompletionObserver = new MutationObserver(() => {
          if (document.querySelector('.hq-onboarding__maker')) window.__onboardingFlashedMaker = true;
        });
        window.__onboardingCompletionObserver.observe(document.body, { childList: true, subtree: true });`);
      await click("Start using Koed");
      await waitFor(
        "!document.querySelector('.hq-onboarding') && Boolean(document.querySelector('[data-hq-shell]'))",
        "Chief completion"
      );
      assert.equal(await js("window.__onboardingFlashedMaker"), false);
      await js("window.__onboardingCompletionObserver.disconnect()");
      const result = await js(`({
        records: Object.keys(localStorage)
          .filter((key) => key.startsWith('koed.hq.onboarding.v1:'))
          .map((key) => ({ key, value: JSON.parse(localStorage.getItem(key)) })),
        trace: {
          commands: window.__koedHq506.commands,
          memoryPreparations: window.__koedHq506.memoryPreparations,
          chiefPatches: window.__koedHq506.chiefPatches,
          memoryNotes: window.__koedHq506.memoryNotes,
          memoryAsks: window.__koedHq506.memoryAsks
        },
        prompts: window.__koedHqFixture.summary().operations.prompts
      })`);
      assert.ok(
        result.records.some(
          ({ key, value }) =>
            key.includes("00000000-0000-4000-8000-000000000109") &&
            value.completed &&
            value.role === "other" &&
            value.chiefName === "Juno"
        )
      );
      assert.equal(result.trace.memoryPreparations, 2);
      assert.equal(result.trace.chiefPatches.length, 1);
      assert.deepEqual(result.trace.memoryNotes, ["Keep answers short"]);
      assert.equal(result.trace.memoryAsks.length, 1);
      assert.equal(result.trace.chiefPatches[0].name, "Juno");
      assert.ok(result.trace.chiefPatches[0].look?.pixelkin);
      assert.equal(
        result.trace.chiefPatches[0].aiClientInstanceId,
        "codex.fixture"
      );
      assert.deepEqual(
        result.prompts,
        [],
        "static setup text must not launch a User prompt"
      );
      await capture(`complete-${theme}.png`);

      await window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        { query: { view: "hq", hq506Capture: "yes" } }
      );
      await waitFor(
        "document.documentElement.dataset.hqFixtureReady === 'true' && Boolean(document.querySelector('[data-hq-shell]'))",
        "completed profile resume"
      );
      assert.equal(
        await js("Boolean(document.querySelector('.hq-onboarding'))"),
        false
      );
      assert.deepEqual(
        await js("window.__koedHq506.commands"),
        ["hq_onboarding_identity"],
        "completed profile must not replay onboarding"
      );
    }
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          id: "HQ506.native",
          owner: "HQ-506",
          status: "pass",
          screenshots
        },
        null,
        2
      )
    );
    process.stdout.write(`${reportPath}\n`);
  } catch (error) {
    if (window && !window.isDestroyed()) {
      await mkdir(output, { recursive: true });
      await writeFile(
        resolve(output, "failure.txt"),
        await window.webContents.executeJavaScript(
          "JSON.stringify({text:document.body.innerText, trace:window.__koedHq506},null,2)"
        )
      );
    }
    throw error;
  } finally {
    window?.destroy();
    app.quit();
  }
}

void run().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  app.exit(1);
});
