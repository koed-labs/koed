import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const output = resolve(scratch, "hq-307", "screenshots");
const reportPath = resolve(scratch, "hq-307", "browser-report.json");
const profile = process.env.KOED_HQ307_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-307 Electron profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

const executionId = "00000000-0000-4000-8000-000000002044";
const forgottenActionId = "00000000-0000-4000-8000-000000003071";
const otherActionId = "00000000-0000-4000-8000-000000003072";
const sourceSessionId = "00000000-0000-4000-8000-000000002045";
const projectSelector =
  '[data-hq-project-link="00000000-0000-4000-8000-000000002038"]';

async function run() {
  let window;
  try {
    await rm(reportPath, { force: true });
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      useContentSize: true,
      webPreferences: { backgroundThrottling: false }
    });
    const debuggerClient = window.webContents.debugger;
    let debuggerAttached = false;
    const js = (source) => window.webContents.executeJavaScript(source);
    const until = async (source, description) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      assert.fail(`Timed out waiting for ${description}`);
    };
    const capture = async (name) => {
      await delay(100);
      const { data } = await debuggerClient.sendCommand(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false }
      );
      await writeFile(resolve(output, name), Buffer.from(data, "base64"));
    };
    const openProject = async () => {
      await until(
        `document.documentElement.dataset.hqFixtureReady === 'true' && Boolean(document.querySelector('${projectSelector}'))`,
        "real HQ fixture and Project"
      );
      await js(`document.querySelector('${projectSelector}').click()`);
      await until(
        `document.querySelectorAll('.hq-managed-memory-action').length === 5`,
        "managed memory actions in the HQ conversation"
      );
    };
    await mkdir(output, { recursive: true });
    for (const dark of [false, true]) {
      await window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        { query: { view: "hq", hq307Capture: "yes", hq305Capture: "yes" } }
      );
      await js("sessionStorage.removeItem('koed-hq307-validation-actions')");
      await openProject();
      if (!debuggerAttached) {
        debuggerClient.attach("1.3");
        debuggerAttached = true;
        await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 800,
          deviceScaleFactor: 1,
          mobile: false
        });
      }
      await js(
        `document.documentElement.classList.remove('light', 'dark'); document.documentElement.classList.add('${dark ? "dark" : "light"}')`
      );
      assert.equal(
        await js(
          `document.documentElement.classList.contains('${dark ? "dark" : "light"}')`
        ),
        true
      );
      const initial = await js(`(() => {
        const section = document.querySelector('.hq-managed-memory-actions');
        return {
          route: Boolean(document.querySelector('[data-hq-route="project"]')),
          messages: [...section.querySelectorAll('.hq-managed-memory-action p')].map((node) => node.textContent.trim()),
          undo: [...section.querySelectorAll('button')].filter((button) => button.textContent.trim() === 'Undo').length,
          offer: [...section.querySelectorAll('button')].filter((button) => button.textContent.trim() === 'Review chat Forget').length,
          lists: window.__koedHq307Trace?.lists ?? 0
        };
      })()`);
      assert.equal(initial.route, true);
      assert.equal(initial.messages.length, 5);
      assert.ok(
        initial.messages.some((message) =>
          message.includes("Forgot the outdated meeting preference")
        )
      );
      assert.ok(
        initial.messages.some((message) =>
          message.includes("Correction proposed")
        )
      );
      assert.ok(
        initial.messages.some((message) =>
          message.includes("belongs to a teammate")
        )
      );
      assert.ok(
        initial.messages.some((message) =>
          message.includes("more specific reference")
        )
      );
      assert.equal(initial.undo, 1);
      assert.equal(initial.offer, 1);
      assert.ok(initial.lists >= 1);
      assert.equal(
        await js(
          `window.koedDesktop.managedMemoryActions.list('${executionId}').then((actions) => actions.find((action) => action.id === '00000000-0000-4000-8000-000000003075')?.sourceSessionId)`
        ),
        sourceSessionId
      );
      await capture(`hq307-feedback-${dark ? "dark" : "light"}.png`);

      // S18.1: inspect the real scoped panel, including pagination and detail.
      await js(
        `document.querySelector('button[aria-label="What Koed knows"]').click()`
      );
      await until(
        `Boolean(document.querySelector('.hq-knows'))`,
        "Project memory panel"
      );
      await until(
        `[...document.querySelectorAll('.hq-knows__group h2')].some((heading) => heading.textContent.includes('Learned'))`,
        "first grouped Project memory page"
      );
      for (let page = 0; page < 4; page++) {
        if (
          await js(
            `[...document.querySelectorAll('.hq-knows__group h2')].some((heading) => heading.textContent.includes('Decisions'))`
          )
        )
          break;
        assert.equal(
          await js(`Boolean(document.querySelector('.hq-knows__load-more'))`),
          true,
          "Decision must be reachable through inventory pagination"
        );
        await js(`document.querySelector('.hq-knows__load-more').click()`);
        await until(
          `document.querySelectorAll('.hq-knows__row').length >= ${page + 2}`,
          "next Project memory page"
        );
      }
      const groups = await js(
        `[...document.querySelectorAll('.hq-knows__group h2')].map((heading) => heading.textContent.trim())`
      );
      assert.ok(
        groups.some((heading) => heading.startsWith("Decisions")),
        groups.join(" | ")
      );
      assert.ok(
        groups.some((heading) => heading.startsWith("Learned")),
        groups.join(" | ")
      );
      const decision = "Review the launch copy with users";
      assert.ok(
        await js(
          `Boolean([...document.querySelectorAll('.hq-knows__row[data-kind="decision"] .hq-knows__item')].find((item) => item.textContent.includes('${decision}')))`
        ),
        "Typed decision must appear in its kind group"
      );
      await capture(`hq307-memory-groups-${dark ? "dark" : "light"}.png`);
      await js(
        `([...document.querySelectorAll('.hq-knows__row[data-kind="decision"] .hq-knows__item')].find((item) => item.textContent.includes('${decision}'))).click()`
      );
      await until(
        `document.querySelector('.hq-knows__replaces')?.textContent.includes('Approve the launch copy without user review')`,
        "replacement detail"
      );
      assert.equal(
        await js(`document.querySelector('.hq-knows h2')?.textContent`),
        decision
      );
      assert.ok(
        await js(
          `document.querySelector('.hq-knows__forget')?.textContent.includes('Forget this')`
        )
      );
      await capture(`hq307-memory-detail-${dark ? "dark" : "light"}.png`);
      await js(
        `document.querySelector('[aria-label="Close memory panel"]').click()`
      );
      assert.equal(
        await js(`document.querySelector('.hq-knows') === null`),
        true
      );

      // The mock response is persisted across a real page reload, including its
      // exact receipt identity. This checks renderer behavior, not native storage.
      await new Promise((resolveReload) => {
        window.webContents.once("did-finish-load", resolveReload);
        window.webContents.reload();
      });
      await openProject();
      await js(
        `document.documentElement.classList.remove('light', 'dark'); document.documentElement.classList.add('${dark ? "dark" : "light"}')`
      );
      assert.equal(
        await js(
          `document.querySelector('.hq-managed-memory-actions button')?.textContent.trim()`
        ),
        "Undo"
      );
      assert.equal(
        await js(
          `window.koedDesktop.managedMemoryActions.undo('${executionId}', '${otherActionId}').then(() => false, () => true)`
        ),
        true,
        "Only the exact Forget action receipt may be undone"
      );
      await js(
        `document.querySelector('.hq-managed-memory-actions button').click()`
      );
      await until(
        `document.querySelector('.hq-managed-memory-actions')?.textContent.includes('Restored the meeting preference.')`,
        "exact action Undo result"
      );
      assert.deepEqual(await js("window.__koedHq307Trace.undos"), [
        forgottenActionId
      ]);
      assert.equal(
        await js(
          `Boolean([...document.querySelectorAll('.hq-managed-memory-actions button')].find((button) => button.textContent.trim() === 'Undo'))`
        ),
        false
      );
      await capture(`hq307-undone-${dark ? "dark" : "light"}.png`);

      await js(
        `([...document.querySelectorAll('.hq-managed-memory-actions button')].find((button) => button.textContent.trim() === 'Review chat Forget')).click()`
      );
      await until(
        `document.querySelector('.hq-chat-delete__dialog')?.textContent.includes('Forget this chat?')`,
        "existing HQ-106 chat Forget confirmation"
      );
      const confirmation = await js(`(() => ({
        title: document.querySelector('.hq-chat-delete__dialog h3')?.textContent.trim(),
        message: document.querySelector('.hq-chat-delete__dialog')?.textContent,
        writes: window.__koedHq307Trace.chatForgets
      }))()`);
      assert.equal(confirmation.title, "Forget this chat?");
      assert.ok(confirmation.message.includes("Plan next week"));
      assert.deepEqual(confirmation.writes, []);
      await capture(`hq307-chat-confirm-${dark ? "dark" : "light"}.png`);
      await js(
        `document.querySelector('.hq-chat-delete__dialog button').click()`
      );
      await until(
        `document.querySelector('.hq-chat-delete__dialog') === null`,
        "canceled confirmation"
      );
      assert.deepEqual(
        await js("window.__koedHq307Trace.chatForgets"),
        [],
        "Cancel must issue no chat Forget write"
      );
      assert.equal(
        await js(
          `window.koedDesktop.managedMemoryActions.list('${executionId}').then((actions) => actions.find((action) => action.id === '${forgottenActionId}')?.outcome)`
        ),
        "undone"
      );
      process.stdout.write(
        `${dark ? "dark" : "light"}: ${JSON.stringify(initial)}\n`
      );
    }
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          id: "HQ307.native",
          owner: "HQ-307",
          status: "pass",
          assertions: [{ id: "S18.1", owner: "HQ-307", status: "pass" }],
          checks: [
            "actual What Koed Knows Project inventory groups Decisions and Learned, pages to replacement detail, and shows Forget control",
            "real HQ Project conversation displays typed owner-facing action results",
            "Forget receipt and exact action Undo persist across window reload",
            "correction proposal, teammate Ask, and ambiguous-reference messages are visible",
            "owned source chat opens existing HQ-106 confirmation; Cancel writes none"
          ],
          screenshots: [
            "hq307-feedback-light.png",
            "hq307-feedback-dark.png",
            "hq307-memory-groups-light.png",
            "hq307-memory-groups-dark.png",
            "hq307-memory-detail-light.png",
            "hq307-memory-detail-dark.png",
            "hq307-undone-light.png",
            "hq307-undone-dark.png",
            "hq307-chat-confirm-light.png",
            "hq307-chat-confirm-dark.png"
          ]
        },
        null,
        2
      ) + "\n"
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
