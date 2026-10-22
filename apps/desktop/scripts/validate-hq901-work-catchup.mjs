import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const profile = process.env.KOED_HQ901_WORK_CATCHUP_USER_DATA_DIR;
assert.ok(profile, "Supply an isolated HQ-901 catch-up profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

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
      { query: { view: "hq", hq901Catchup: "yes" } }
    );
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 220; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(
        `HQ901 catch-up did not reach: ${source}: ${JSON.stringify(await js(`({ need: document.querySelector('[aria-label="Needs you"]')?.textContent.slice(0,500), done: document.querySelector('[aria-label="Done today"]')?.textContent.slice(0,500), replies: [...document.querySelectorAll('[data-message-id]')].map(row => row.getAttribute('data-message-id')) })`))}`
      );
    };
    await waitFor("document.documentElement.dataset.hqFixtureReady === 'true'");
    await js(
      "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]').click()"
    );
    await waitFor(
      'document.querySelector(\'[aria-label="Needs you"]\')?.textContent.includes("Ship the release")'
    );
    await waitFor(
      'document.querySelector(\'[aria-label="Done today"]\')?.textContent.includes("Finished sentinel ticket")'
    );
    await waitFor(
      "document.querySelector('[data-message-id=\"hq505-retained-assistant\"]') !== null"
    );
    const reply = await js(
      "document.querySelector('[data-message-id=\"hq505-retained-assistant\"]')?.textContent"
    );
    assert.ok(reply.includes("Project catch-up:"));
    assert.ok(!reply.includes("Ship the release"));
    assert.ok(!reply.includes("Finished sentinel ticket"));
    const output = resolve(scratch, "hq-901-work-catchup");
    await mkdir(output, { recursive: true });
    await writeFile(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          id: "HQ901.work-catchup",
          status: "pass",
          proofIds: ["S05.1.rendered-catchup-excludes-pr-and-finished"],
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
