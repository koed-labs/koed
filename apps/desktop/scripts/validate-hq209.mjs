import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";

const repoRoot = resolve(import.meta.dirname, "../../..");
const scratch = resolve(repoRoot, "scratch", "hq-209");
const projectId = "00000000-0000-4000-8000-000000002038";
const profile = process.env.KOED_HQ209_USER_DATA_DIR;
assert.ok(
  profile,
  "Use the HQ-209 native wrapper to create an isolated profile."
);
app.setPath("userData", profile);

const run = async () => {
  let window;
  let failed = false;
  try {
    await app.whenReady();
    window = new BrowserWindow({ show: false, width: 1280, height: 800 });
    const errors = [];
    window.webContents.on("console-message", (_event, details) => {
      if (details.level === "error") errors.push(details.message);
    });
    await window.loadFile(
      resolve(repoRoot, "apps/desktop/dist/browser-validation.html"),
      {
        query: { view: "hq", hq209Capture: "yes" }
      }
    );
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 160; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(
        `HQ-209 native fixture did not reach ${source}: ${errors.join(" | ")}`
      );
    };
    await waitFor(
      `document.documentElement.dataset.hqFixtureReady === 'true' && Boolean(document.querySelector('[data-hq-project-link="${projectId}"]'))`
    );
    await js(
      `document.querySelector('[data-hq-project-link="${projectId}"]').click()`
    );
    await waitFor(
      "Boolean(document.querySelector('.hq-project-sources__key')) && Boolean(document.querySelector('.hq-project-conversation textarea:not(:disabled)'))"
    );
    await js("document.querySelector('.hq-project-sources__key').click()");
    await waitFor(
      "document.querySelector('.hq-project-sources__document pre')?.textContent?.includes('Plan: review the Project goals')"
    );
    assert.equal(
      await js(
        "document.querySelectorAll('[data-hq-context][role=complementary]').length"
      ),
      1
    );
    assert.equal(
      await js(
        "Boolean(document.querySelector('.hq-project-conversation textarea:not(:disabled)'))"
      ),
      true
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-project-conversation__context')?.textContent.trim()"
      ),
      "About Plan.md"
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-project-sources__revision')?.textContent"
      ),
      "Personal document"
    );
    const debuggerClient = window.webContents.debugger;
    debuggerClient.attach("1.3");
    await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    });
    const images = resolve(scratch, "screenshots");
    await mkdir(images, { recursive: true });
    const capture = async (name) => {
      await delay(100);
      const { data } = await debuggerClient.sendCommand(
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: false
        }
      );
      await writeFile(resolve(images, name), Buffer.from(data, "base64"));
    };
    await capture("document-light.png");
    await js(
      "document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark')"
    );
    await capture("document-dark.png");
    await js(
      "document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')"
    );
    await js(
      "document.querySelector('.hq-project-sources__actions button:last-child').click()"
    );
    await waitFor(
      "Boolean([...document.querySelectorAll('.hq-project-sources__actions button')].find(button => button.textContent.includes('Add a doc')))"
    );
    await js(
      "[...document.querySelectorAll('.hq-project-sources__actions button')].find(button => button.textContent.includes('Add a doc')).click()"
    );
    await waitFor(
      "document.querySelector('.hq-project-sources__document pre')?.textContent?.includes('Field report: the review owner')"
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-project-conversation__context')?.textContent.trim()"
      ),
      "About Field report.txt"
    );
    await capture("uploaded-document-light.png");
    if (errors.length)
      throw new Error(`HQ-209 native console errors: ${errors.join(" | ")}`);
    process.stdout.write(
      "PASS HQ209.native: exact Source read, upload, inspector, context, composer and screenshots.\n"
    );
  } catch (error) {
    failed = true;
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`
    );
  } finally {
    window?.destroy();
    app.exit(failed ? 1 : 0);
  }
};
void run();
