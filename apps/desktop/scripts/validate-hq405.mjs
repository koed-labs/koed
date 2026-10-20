import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const images = resolve(scratch, "hq-405", "screenshots");
const profile = process.env.KOED_HQ405_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-405 profile under scratch.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

const run = async () => {
  let window;
  let failed = false;
  try {
    await app.whenReady();
    await mkdir(images, { recursive: true });
    const open = async (query) => {
      window = new BrowserWindow({ show: false, width: 1280, height: 800 });
      const errors = [];
      window.webContents.on("console-message", (_event, details) => {
        if (details.level === "error") errors.push(details.message);
      });
      await window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        { query }
      );
      const js = (source) => window.webContents.executeJavaScript(source);
      const waitFor = async (source) => {
        for (let attempt = 0; attempt < 180; attempt += 1) {
          if (await js(source)) return;
          await delay(50);
        }
        const diagnostics = await js(
          "JSON.stringify({trace:window.__hq405Trace,effect:document.documentElement.dataset.hq405MergeEffect,match:document.documentElement.dataset.hq405MergeMatch,alerts:Array.from(document.querySelectorAll('[role=\"alert\"]')).map(x=>x.textContent),needs:document.querySelector('[aria-label=\"Needs you\"]')?.textContent,done:document.querySelector('[aria-label=\"Done today\"]')?.textContent})"
        );
        throw new Error(
          `HQ-405 UI did not reach ${source}: ${errors.join(" | ")} ${diagnostics}`
        );
      };
      await waitFor(
        "Boolean(document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]'))"
      );
      await js(
        "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]').click()"
      );
      await waitFor(
        'document.querySelector(\'[aria-label="Needs you"]\')?.textContent.includes("Colleague\'s PR")'
      );
      return { js, waitFor, errors };
    };
    const capture = async (name) => {
      await delay(120);
      const client = window.webContents.debugger;
      if (!client.isAttached()) client.attach("1.3");
      await client.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false
      });
      const { data } = await client.sendCommand("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false
      });
      const png = Buffer.from(data, "base64");
      assert.equal(png.readUInt32BE(16), 1280);
      assert.equal(png.readUInt32BE(20), 800);
      await writeFile(resolve(images, name), png);
    };
    let { js, waitFor, errors } = await open({
      view: "hq",
      hq405Capture: "yes"
    });
    await js(
      "document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')"
    );
    assert.ok(
      await js(
        "document.querySelector('[aria-label=\"Needs you\"]').textContent.includes('Ship the release')"
      )
    );
    assert.ok(
      await js(
        "document.querySelector('[aria-label=\"In review\"]').textContent.includes('Open on GitLab')"
      )
    );
    assert.ok(
      await js(
        "!Array.from(document.querySelectorAll('[aria-label=\"In review\"] button')).some((button) => button.textContent === 'Merge')"
      )
    );
    await capture("pr-ready-light.png");
    await js(
      "document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark')"
    );
    assert.ok(
      await js(
        "(() => { const button = Array.from(document.querySelectorAll('.hq-project-prs__actions button')).find(x=>x.textContent.trim()==='Merge'); if(!button)return false; const style=getComputedStyle(button); const box=button.getBoundingClientRect(); return box.width>=44 && box.height>=24 && style.color!==style.backgroundColor && style.borderRadius==='999px'; })()"
      )
    );
    await capture("pr-ready-dark.png");
    assert.equal(
      await js(
        "Array.from(Array.from(document.querySelectorAll('[aria-label=\"Needs you\"] .hq-project-view__work-item')).find((row) => row.textContent.includes('Ship the release')).querySelectorAll('button')).map((button) => button.textContent.trim()).join('|')"
      ),
      "Merge"
    );
    await js(
      "Array.from(Array.from(document.querySelectorAll('[aria-label=\"Needs you\"] .hq-project-view__work-item')).find((row) => row.textContent.includes('Ship the release')).querySelectorAll('button')).find((button) => button.textContent.trim() === 'Merge').click()"
    );
    await waitFor(
      "document.querySelector('[aria-label=\"Done today\"]')?.textContent.includes('Ship the release')"
    );
    assert.ok(
      await js(
        "!document.querySelector('[aria-label=\"In review\"]')?.textContent.includes('Ship the release')"
      )
    );
    assert.equal(await js("window.__hq405Trace.mergeRequests"), 1);
    assert.ok((await js("window.__hq405Trace.reconcileReads")) > 0);
    await capture("pr-merged-dark.png");
    assert.equal(errors.length, 0, errors.join(" | "));
    ({ js, waitFor, errors } = await open({
      view: "hq",
      hq405Capture: "yes",
      hq405Proposal: "yes",
      hq405Declined: "yes"
    }));
    await js("document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')");
    await waitFor(
      "document.body.textContent.includes('Merge review declined')"
    );
    assert.equal(await js("window.__hq405Trace.mergeRequests"), 1);
    assert.ok(
      await js(
        "document.querySelector('[aria-label=\"Needs you\"]')?.textContent.includes('Ship the release')"
      )
    );
    assert.equal(await js("document.documentElement.classList.contains('light')"), true);
    await capture("proposal-declined-light.png");
    assert.equal(errors.length, 0, errors.join(" | "));
    await writeFile(
      resolve(scratch, "hq-405", "browser-report.json"),
      JSON.stringify(
        {
          id: "HQ405.native",
          owner: "HQ-405",
          status: "pass",
          checks: [
            "ticket and ticketless PRs",
            "checks and unsupported-provider link",
            "merge request through managedProject IPC",
            "provider-verified Work Item update fixture",
            "proposal denial remains In review",
            "light and dark HQ presentation"
          ],
          screenshots: [
            "pr-ready-light.png",
            "pr-ready-dark.png",
            "pr-merged-dark.png",
            "proposal-declined-light.png"
          ],
          nativeBoundaryProof:
            "source-control-merge-native-client.test.ts and API reconciliation tests"
        },
        null,
        2
      )
    );
    process.stdout.write(`HQ-405 native validation: ${images}\n`);
  } catch (error) {
    failed = true;
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`
    );
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    app.exit(failed ? 1 : 0);
  }
};
void run();
