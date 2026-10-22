import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const profile = process.env.KOED_HQ901_WORK_TICKET_LOOP_USER_DATA_DIR;
assert.ok(profile, "Supply an isolated HQ-901 ticket loop profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);
const itemId = "00000000-0000-4000-8000-000000004052";

const run = async () => {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { backgroundThrottling: false }
  });
  try {
    await window.loadFile(
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      { query: { view: "hq", hq901TicketLoop: "yes" } }
    );
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 220; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(
        `HQ901 ticket loop did not reach: ${source}: ${JSON.stringify(await js(`({ trace: window.__hq405Trace, alerts: [...document.querySelectorAll('[role="alert"]')].map(row => row.textContent), need: document.querySelector('[aria-label="Needs you"]')?.textContent.slice(0,600) })`))}`
      );
    };
    await waitFor("document.documentElement.dataset.hqFixtureReady === 'true'");
    await js(
      "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]').click()"
    );
    await waitFor(
      `document.querySelector('[aria-label="To do"] [data-work-send-id="${itemId}"]') !== null`
    );
    await js(
      `document.querySelector('[aria-label="To do"] [data-work-send-id="${itemId}"]').click()`
    );
    await waitFor(
      'document.querySelector(".hq-project-view__send-menu") !== null'
    );
    await js(`[...document.querySelectorAll('.hq-project-view__send-menu [role="menuitem"]')]
      .find(button => button.textContent.includes("Quinn")).click()`);
    await waitFor(
      `document.querySelector('[aria-label="Working now"] [data-work-send-id="${itemId}"]') !== null`
    );
    assert.ok(
      await js(
        'document.querySelector(\'[aria-label="Working now"]\')?.textContent.includes("Ship the release")'
      )
    );
    assert.equal(await js("window.__hq404ExecutionStarts"), 1);
    assert.equal(await js("window.__hq901TicketPrOpened()"), true);
    await waitFor(
      'document.querySelector(\'[aria-label="Needs you"]\')?.textContent.includes("Ship the release")'
    );
    await waitFor(
      '![...document.querySelectorAll(\'[aria-label="Needs you"] .hq-project-prs__row\')].some(row => row.textContent.includes("Ship the release"))'
    );
    assert.equal(
      await js(
        'document.querySelector(\'[aria-label="Done today"]\')?.textContent.includes("Ship the release") ?? false'
      ),
      false
    );
    await js(`(() => {
      const row = [...document.querySelectorAll('[aria-label="Needs you"] .hq-project-view__work-item')]
        .find(row => row.textContent.includes("Ship the release"));
      row.querySelector(".hq-project-view__merge").click();
    })()`);
    await waitFor("window.__hq405Trace.mergeRequests === 1");
    await waitFor(
      'document.querySelector(\'[aria-label="Done today"]\')?.textContent.includes("Ship the release")'
    );
    assert.ok(await js("window.__hq405Trace.reconcileReads > 0"));
    const output = resolve(scratch, "hq-901-work-ticket-loop");
    await mkdir(output, { recursive: true });
    await writeFile(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          id: "HQ901.work-ticket-loop",
          status: "pass",
          proofIds: [
            "S04.1.same-item-send-working-pr-needs-you",
            "S04.3.same-item-provider-result-before-done"
          ],
          scope: "new HQ Electron renderer with simulated IPC"
        },
        null,
        2
      ) + "\n"
    );
  } finally {
    window.destroy();
    app.quit();
  }
};

void run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`
  );
  app.exit(1);
});
