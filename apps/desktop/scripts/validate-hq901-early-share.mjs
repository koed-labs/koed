import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const profile = process.env.KOED_HQ901_EARLY_SHARE_USER_DATA_DIR;
assert.ok(profile, "Supply an isolated HQ-901 early-share profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

const run = async () => {
  let window;
  try {
    await app.whenReady();
    window = new BrowserWindow({ show: false, width: 1280, height: 800 });
    await window.loadFile(
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      { query: { view: "hq", hq701Capture: "yes" } }
    );
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 160; attempt += 1) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(`HQ901 early share timed out: ${source}`);
    };
    await waitFor("document.documentElement.dataset.hqFixtureReady === 'true'");
    await js(
      `document.querySelector('[data-hq-project-link="00000000-0000-4000-8000-000000002038"]')?.click()`
    );
    await waitFor(
      `document.querySelector('[aria-label="Share Project"]') !== null`
    );
    await js(`document.querySelector('[aria-label="Share Project"]')?.click()`);
    await waitFor(
      "document.querySelector('.hq-share-sheet__disclosure ul') !== null"
    );
    const details = await js(`(() => ({
      heading: document.querySelector('.hq-share-sheet__disclosure h3')?.textContent.trim(),
      rows: [...document.querySelectorAll('.hq-share-sheet__disclosure li')].map(row => row.textContent.trim().replace(/\\s+/g, ' ')),
      excluded: document.querySelector('.hq-share-sheet__disclosure p')?.textContent.trim().replace(/\\s+/g, ' ')
    }))()`);
    assert.equal(details.heading, "What the Team will see");
    assert.deepEqual(details.rows, [
      "Project name, to-dos, and Source titles and metadata",
      "Eligible captured chat summaries after your separate Native review",
      "Updates and safe Agent progress for shared to-dos"
    ]);
    assert.equal(
      details.excluded,
      "Original files, Note text, and private Agent chats do not go to the Team. Curated Memory needs its own review and approval."
    );
    const output = resolve(scratch, "hq-901-early-share");
    await mkdir(output, { recursive: true });
    await writeFile(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          id: "HQ901.early-share",
          status: "pass",
          proofIds: ["S14.1.share-sheet-contents"],
          scope: "simulated IPC renderer fixture"
        },
        null,
        2
      ) + "\n"
    );
  } finally {
    window?.destroy();
    app.quit();
  }
};

void run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`
  );
  app.exit(1);
});
