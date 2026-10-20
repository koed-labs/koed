import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const images = resolve(scratch, "hq-106", "screenshots");
const profile = process.env.KOED_HQ106_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-106 profile under scratch.");
assert.equal(dirname(resolve(profile)), scratch);
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
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      { query: { view: "hq", hq106Capture: "yes" } }
    );
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 160; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(
        `HQ-106 UI did not reach ${source}: ${errors.join(" | ")}; ${JSON.stringify(await js("({ ready: document.documentElement.dataset.hqFixtureReady, shell: Boolean(document.querySelector('[data-hq-shell]')), sidebar: Boolean(document.querySelector('.hq-sidebar')), rows: document.querySelectorAll('.hq-sidebar__conversation').length, body: document.body.textContent.slice(0, 500) })"))}`
      );
    };
    const debuggerClient = window.webContents.debugger;
    debuggerClient.attach("1.3");
    await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    });
    await mkdir(images, { recursive: true });
    const capture = async (name) => {
      await delay(100);
      const { data } = await debuggerClient.sendCommand(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false }
      );
      await writeFile(resolve(images, name), Buffer.from(data, "base64"));
    };
    await waitFor(
      "document.documentElement.dataset.hqFixtureReady === 'true' && Boolean(document.querySelector('.hq-sidebar__conversation-trash'))"
    );
    const title = await js(
      "document.querySelector('.hq-sidebar__conversation-link')?.textContent.trim()"
    );
    assert.ok(title);
    await js(
      "document.querySelector('.hq-sidebar__conversation-trash').click()"
    );
    await waitFor(
      "document.querySelector('[role=alertdialog]')?.textContent.includes('Delete this chat?') && Boolean(document.querySelector('[role=alertdialog] button:not(:disabled)'))"
    );
    assert.ok(
      await js(
        "document.querySelector('[role=alertdialog]')?.textContent.includes('Its memory stays available to Koed.')"
      )
    );
    await capture("delete-confirm-light.png");
    await js(
      "document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark')"
    );
    await capture("delete-confirm-dark.png");
    await js(
      "document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')"
    );
    await js(
      "[...document.querySelectorAll('[role=alertdialog] button')].find(button => button.textContent.trim() === 'Delete chat').click()"
    );
    await waitFor(
      "document.querySelector('.hq-chat-delete__notice')?.textContent.includes('Deletion pending')"
    );
    assert.ok(
      await js(
        "document.querySelector('.hq-sidebar__deletion-pending')?.textContent.includes('Deletion pending')"
      )
    );
    await capture("delete-pending-light.png");
    await js(
      "[...document.querySelectorAll('.hq-chat-delete__notice button')].find(button => button.textContent.trim() === 'Check status').click()"
    );
    await waitFor(
      "document.querySelector('.hq-chat-delete__notice')?.textContent.includes('moved to Deleted')"
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-sidebar__deletion-pending')?.textContent.includes('Deletion pending') ?? false"
      ),
      false
    );
    await js("document.querySelector('.hq-account').click()");
    await waitFor("Boolean(document.querySelector('.hq-settings'))");
    await js(
      "[...document.querySelectorAll('[aria-label=\"Settings sections\"] button')].find(button => button.textContent.trim() === 'Deleted').click()"
    );
    await waitFor(
      "document.querySelector('[aria-label=\"Deleted chats\"]')?.textContent.includes('Restore')"
    );
    await capture("deleted-settings-light.png");
    await js(
      "document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark')"
    );
    await capture("deleted-settings-dark.png");
    await js(
      "document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')"
    );
    await js(
      "document.querySelector('[aria-label=\"Deleted chats\"] button').click()"
    );
    await waitFor(
      "document.querySelector('[aria-label=\"Deleted chats\"]')?.textContent.includes('No deleted chats.')"
    );
    await waitFor(
      "!document.querySelector('.hq-chat-delete__notice')?.textContent.includes('Conversation moved to Deleted.')"
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-chat-delete__notice')?.textContent.includes('Conversation moved to Deleted.') ?? false"
      ),
      false
    );
    await js(
      "document.querySelector('[aria-label=\"Close Settings\"]').click()"
    );
    await waitFor(
      "Boolean(document.querySelector('.hq-sidebar__conversation-menu')) === false && Boolean(document.querySelector('.hq-sidebar__conversation-link'))"
    );
    await js(
      "document.querySelector('.hq-sidebar__conversation-link').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))"
    );
    await waitFor(
      "Boolean([...document.querySelectorAll('.hq-sidebar__conversation-menu button')].find(button => button.textContent.trim() === 'Forget this chat'))"
    );
    await js(
      "[...document.querySelectorAll('.hq-sidebar__conversation-menu button')].find(button => button.textContent.trim() === 'Forget this chat').click()"
    );
    await waitFor(
      "document.querySelector('[role=alertdialog]')?.textContent.includes('Forget this chat?')"
    );
    await capture("forget-confirm-light.png");
    await js(
      "document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark')"
    );
    await capture("forget-confirm-dark.png");
    await js(
      "document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')"
    );
    await js(
      "[...document.querySelectorAll('[role=alertdialog] button')].find(button => button.textContent.trim() === 'Forget chat').click()"
    );
    await waitFor(
      "document.querySelector('.hq-chat-delete__notice')?.textContent.includes('forgotten from Personal recall')"
    );
    assert.equal(
      await js(
        `[...document.querySelectorAll('.hq-sidebar__conversation-link')].some(button => button.textContent.trim() === ${JSON.stringify(title)})`
      ),
      false
    );
    await js(
      "[...document.querySelectorAll('.hq-chat-delete__notice button')].find(button => button.textContent.trim() === 'Undo').click()"
    );
    await waitFor(
      `!document.querySelector('.hq-chat-delete__notice') && [...document.querySelectorAll('.hq-sidebar__conversation-link')].some(button => button.textContent.trim() === ${JSON.stringify(title)})`
    );
    assert.equal(errors.length, 0, errors.join(" | "));
    await writeFile(
      resolve(scratch, "hq-106", "browser-report.json"),
      JSON.stringify(
        {
          id: "HQ106.native",
          status: "pass",
          checks: [
            "Delete confirmation and retained recall explanation",
            "offline deletion remains visibly pending until status reconciliation",
            "Deleted Settings exact-batch restore",
            "separate Forget confirmation and Undo",
            "light and dark native captures"
          ],
          screenshots: [
            "delete-confirm-light.png",
            "delete-confirm-dark.png",
            "delete-pending-light.png",
            "deleted-settings-light.png",
            "deleted-settings-dark.png",
            "forget-confirm-light.png",
            "forget-confirm-dark.png"
          ]
        },
        null,
        2
      )
    );
    debuggerClient.detach();
    process.stdout.write(`HQ-106 native validation: ${images}\n`);
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
