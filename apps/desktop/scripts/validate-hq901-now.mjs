import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";
import { validateHqNow } from "./validate-hq-now.mjs";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const profile = process.env.KOED_HQ901_NOW_USER_DATA_DIR;
assert.ok(profile && dirname(resolve(profile)) === scratch);
app.setPath("userData", profile);

const run = async () => {
  let window;
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: { backgroundThrottling: false }
    });
    const page = resolve(root, "apps/desktop/dist/browser-validation.html");
    await window.loadFile(page, { query: { view: "hq" } });
    for (let attempt = 0; attempt < 160; attempt++) {
      if (
        await window.webContents.executeJavaScript(
          "document.documentElement.dataset.hqFixtureReady === 'true'"
        )
      )
        break;
      await delay(50);
    }
    const output = resolve(scratch, "hq-901-now");
    await mkdir(output, { recursive: true });
    await validateHqNow(
      window,
      page,
      async (name) =>
        writeFile(
          resolve(output, name),
          (await window.webContents.capturePage()).toPNG()
        ),
      delay
    );
    await writeFile(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          id: "HQ901.now",
          status: "pass",
          proofIds: ["S12.1.now-cross-project-caps-folds-navigation"],
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

void run().then(
  () => app.exit(0),
  (error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`
    );
    app.exit(1);
  }
);
