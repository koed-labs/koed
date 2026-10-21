import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const output = resolve(scratch, "hq-701", "screenshots");
const profile = process.env.KOED_HQ701_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-701 Electron profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

async function run() {
  let window;
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      useContentSize: true
    });
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source, label) => {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      assert.fail(`Timed out waiting for ${label}`);
    };
    const debuggerClient = window.webContents.debugger;
    await mkdir(output, { recursive: true });
    const capture = async (name) => {
      await delay(100);
      const { data } = await debuggerClient.sendCommand(
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: false
        }
      );
      await writeFile(resolve(output, name), Buffer.from(data, "base64"));
    };
    for (const theme of ["light", "dark"]) {
      for (const pending of [false, true]) {
        await window.loadFile(
          resolve(root, "apps/desktop/dist/browser-validation.html"),
          {
            query: {
              view: "hq",
              hq701Capture: "yes",
              ...(pending ? { hq701Pending: "yes" } : {})
            }
          }
        );
        await waitFor(
          "document.documentElement.dataset.hqFixtureReady === 'true'",
          "HQ fixture"
        );
        await js(
          `document.documentElement.classList.remove('light','dark'); document.documentElement.classList.add('${theme}')`
        );
        await js(
          "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]')?.click()"
        );
        await waitFor(
          "document.querySelector('[aria-label=\"Share Project\"]') !== null",
          "Share Project entry"
        );
        await js(
          "document.querySelector('[aria-label=\"Share Project\"]')?.click()"
        );
        await waitFor(
          "document.querySelector('.hq-share-sheet__disclosure') !== null",
          "Share disclosure"
        );
        if (!debuggerClient.isAttached()) debuggerClient.attach("1.3");
        await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 800,
          deviceScaleFactor: 1,
          mobile: false
        });
        assert.equal(
          await js(
            "document.querySelector('.hq-share-sheet__disclosure')?.textContent.includes('Original files, Note text, and private Agent chats do not go to the Team.')"
          ),
          true
        );
        assert.equal(
          await js(
            "document.querySelector('.hq-share-sheet__disclosure')?.textContent.includes('Curated Memory needs its own review')"
          ),
          true
        );
        if (pending) {
          await waitFor(
            "document.querySelector('.hq-share-sheet [role=\"status\"]')?.textContent.includes('interrupted share')",
            "pending recovery"
          );
          assert.equal(
            await js(
              "document.querySelector('.hq-share-sheet select')?.disabled"
            ),
            true
          );
          await capture(`share-pending-${theme}.png`);
          await js(
            "Array.from(document.querySelectorAll('.hq-share-sheet button')).find(button => button.textContent === 'Cancel pending share')?.click()"
          );
          await waitFor(
            "window.__koedHq701Trace?.cancellations === 1",
            "explicit cancellation"
          );
          assert.equal(
            await js(
              "document.querySelector('.hq-share-sheet select')?.disabled"
            ),
            false
          );
          await capture(`share-after-cancel-${theme}.png`);
        } else {
          assert.equal(
            await js(
              "document.querySelector('.hq-share-sheet__field select')?.value"
            ),
            "new_team"
          );
          await capture(`share-ready-${theme}.png`);
        }
      }
      await window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        { query: { view: "hq", hq701Capture: "yes", hq701Linked: "yes" } }
      );
      await waitFor(
        "document.documentElement.dataset.hqFixtureReady === 'true'",
        "linked HQ fixture"
      );
      await js(
        `document.documentElement.classList.remove('light','dark'); document.documentElement.classList.add('${theme}')`
      );
      await waitFor(
        "document.querySelector('[data-hq-sidebar-group=\"shared\"]') !== null",
        "Shared sidebar group"
      );
      await js(
        "document.querySelector('[data-hq-sidebar-group=\"shared\"]')?.scrollIntoView({block:'center'})"
      );
      await js(
        "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]')?.click()"
      );
      await waitFor(
        "document.querySelector('[aria-label=\"View who is in this shared Project\"]') !== null",
        "shared Project chip"
      );
      await js(
        "document.querySelector('[data-hq-sidebar-group=\"shared\"]')?.scrollIntoView({block:'center'})"
      );
      assert.equal(
        await js(
          `document.querySelector('[aria-label="2 people"] svg') !== null`
        ),
        true
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-project-view__shared')?.textContent.trim()"
        ),
        "HQ Shared"
      );
      await js(
        "document.querySelector('[aria-label=\"View who is in this shared Project\"]')?.click()"
      );
      await waitFor(
        "document.querySelector('.hq-share-sheet__body h3')?.textContent === 'Who’s in'",
        "exact Project roster"
      );
      await js(
        "(() => { const sidebar = document.querySelector('[data-hq-sidebar-scroll]'); if (sidebar) sidebar.scrollTop = sidebar.scrollHeight; })()"
      );
      assert.equal(
        await js(
          "document.querySelectorAll('.hq-share-sheet__body li').length"
        ),
        2
      );
      await capture(`share-people-${theme}.png`);
    }
    await writeFile(
      resolve(scratch, "hq-701", "HQ701.native.json"),
      JSON.stringify(
        {
          id: "HQ701.native",
          owner: "HQ-701",
          status: "pass",
          proof: "Native HQ Share sheet fixture; no live Team action",
          checks: [
            "light and dark at 1280x800",
            "exact disclosure",
            "ready cloud destination",
            "durable pending destination locked",
            "explicit cancellation control",
            "Shared sidebar group and exact Project roster"
          ],
          screenshots: [
            "share-ready-light.png",
            "share-pending-light.png",
            "share-after-cancel-light.png",
            "share-people-light.png",
            "share-ready-dark.png",
            "share-pending-dark.png",
            "share-after-cancel-dark.png",
            "share-people-dark.png"
          ]
        },
        null,
        2
      )
    );
    process.stdout.write(
      `HQ-701 native Share sheet proof passed; screenshots: ${output}\n`
    );
  } finally {
    window?.destroy();
    app.quit();
  }
}

void run().catch((error) => {
  process.stderr.write(`${error.stack ?? String(error)}\n`);
  app.exit(1);
});
