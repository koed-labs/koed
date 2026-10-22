import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const profile = process.env.KOED_HQ901_WORK_TYPED_USER_DATA_DIR;
assert.ok(profile, "Supply an isolated HQ-901 typed merge profile.");
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
      { query: { view: "hq", hq901TypedMerge: "yes" } }
    );
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 180; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(`HQ901 typed merge did not reach: ${source}`);
    };
    await waitFor("document.documentElement.dataset.hqFixtureReady === 'true'");
    await js(
      "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]').click()"
    );
    await waitFor(
      'document.querySelector(".hq-project-conversation textarea") !== null'
    );
    assert.equal(await js("window.__hq405Trace.mergeRequests"), 0);
    await js(`(() => {
      const textarea = document.querySelector(".hq-project-conversation textarea");
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setValue.call(textarea, "Merge #212");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await waitFor(
      'document.querySelector(".hq-project-conversation form button[type=submit]")?.disabled === false'
    );
    await js(
      'document.querySelector(".hq-project-conversation form").requestSubmit()'
    );
    await waitFor('window.__koedHq204Trace.firstPrompt === "Merge #212"');
    await waitFor("window.__hq405Trace.mergeRequests === 1");
    await waitFor(
      'document.querySelector(\'[aria-label="Done today"]\')?.textContent.includes("Ship the release")'
    );
    assert.ok(await js("window.__hq405Trace.reconcileReads > 0"));
    const output = resolve(scratch, "hq-901-work-typed-merge");
    await mkdir(output, { recursive: true });
    await writeFile(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          id: "HQ901.work-typed-merge",
          status: "pass",
          proofIds: ["S05.2.typed-rendered-proposal-merge-done"],
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
