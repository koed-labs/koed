import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { rm, writeFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const output = resolve(scratch, "hq-107", "screenshots");
const run = async () => {
  mkdirSync(output, { recursive: true });
  const profile = mkdtempSync(resolve(scratch, "hq107-electron-profile-"));
  app.setPath("userData", profile);
  let window;
  let failed = false;
  try {
    process.stderr.write("HQ-107: waiting for Electron\n");
    await app.whenReady();
    process.stderr.write("HQ-107: opening fixture\n");
    window = new BrowserWindow({ show: false, width: 1280, height: 800 });
    const errors = [];
    window.webContents.on("console-message", (_event, details) => {
      if (details.level === "error") errors.push(details.message);
    });
    await window.loadFile(
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      {
        query: { view: "hq107" }
      }
    );
    process.stderr.write("HQ-107: fixture loaded\n");
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 160; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(
        `HQ-107 UI did not reach ${source}: ${errors.join(" | ")}`
      );
    };
    await waitFor(
      "document.documentElement.dataset.hq107FixtureReady === 'true'"
    );
    await waitFor(
      "Boolean(document.querySelector('[data-hq-chat-row][draggable=true]'))"
    );
    await js(
      "document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light')"
    );
    const indentation = await js(`(() => {
      const groupIcon = document.querySelector('[data-hq-sidebar-group="just-me"] [data-hq-group-icon]');
      const project = [...document.querySelectorAll('#hq-group-just-me .hq-sidebar__project')]
        .find(row => row.querySelector('.hq-sidebar__project-conversations [data-hq-chat-title]'));
      const projectIcon = project?.querySelector('[data-hq-project-icon]');
      const projectName = project?.querySelector('.hq-sidebar__project-link span');
      const chatTitle = project?.querySelector('.hq-sidebar__project-conversations [data-hq-chat-title] span');
      if (!groupIcon || !projectIcon || !projectName || !chatTitle) return null;
      return {
        groupIcon: groupIcon.getBoundingClientRect().left,
        projectIcon: projectIcon.getBoundingClientRect().left,
        projectName: projectName.getBoundingClientRect().left,
        chatTitle: chatTitle.getBoundingClientRect().left
      };
    })()`);
    assert.ok(
      indentation,
      "A nested Project chat must be visible for indentation proof"
    );
    assert.ok(Math.abs(indentation.projectIcon - indentation.groupIcon) < 1);
    assert.ok(Math.abs(indentation.chatTitle - indentation.projectName) < 1);
    assert.ok(indentation.projectName > indentation.projectIcon);
    process.stderr.write("HQ-107: draggable chat ready\n");
    const debuggerClient = window.webContents.debugger;
    debuggerClient.attach("1.3");
    await debuggerClient.sendCommand("Page.enable");
    await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    });
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
    const drag = async (targetSelector, commit = true) => {
      await js(`(() => {
      const source = document.querySelector('[data-hq-chat-row][draggable=true]');
      const target = document.querySelector(${JSON.stringify(targetSelector)});
      if (!source || !target) throw new Error('Drag source or target missing');
      const transfer = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
      window.__hq107Transfer = transfer;
    })()`);
      await waitFor(
        "Boolean(document.querySelector('[data-hq-drag-source=true]'))"
      );
      await js(
        `document.querySelector(${JSON.stringify(targetSelector)}).dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__hq107Transfer }))`
      );
      await waitFor(
        `document.querySelector(${JSON.stringify(targetSelector)})?.dataset.hqDropActive === 'true'`
      );
      if (commit) {
        await js(`(() => {
        const target = document.querySelector(${JSON.stringify(targetSelector)});
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__hq107Transfer }));
      })()`);
      }
    };
    const first = "10000000-0000-4000-8000-000000000001";
    const second = "10000000-0000-4000-8000-000000000002";
    await capture("initial-light.png");
    const secondTarget = `.hq-sidebar__project:has([data-hq-project-link="${second}"])`;
    await drag(secondTarget, false);
    await capture("project-drop-highlight-light.png");
    await js(
      `document.querySelector(${JSON.stringify(secondTarget)}).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__hq107Transfer }))`
    );
    await waitFor(
      `Boolean(document.querySelector('[data-hq-chat-project="${second}"]'))`
    );
    await waitFor(
      "Boolean([...document.querySelectorAll('button')].find(x => x.textContent === 'Undo'))"
    );
    await capture("moved-to-project-light.png");
    assert.ok(
      await js("document.body.textContent.includes('Moved to Studio.')")
    );
    assert.deepEqual(
      await js(
        "[getComputedStyle(document.querySelector('.hq-chat-move__notice')).backgroundColor, getComputedStyle(document.querySelector('.hq-chat-move__notice')).color]"
      ),
      ["rgb(24, 24, 27)", "rgb(250, 250, 250)"]
    );
    await js(
      "[...document.querySelectorAll('button')].find(x => x.textContent === 'Undo').click()"
    );
    await waitFor(
      `Boolean(document.querySelector('[data-hq-chat-project="${first}"]'))`
    );
    await capture("undo-light.png");
    await drag(".hq-sidebar__loose-group", false);
    await capture("chats-drop-highlight-light.png");
    await js(
      `document.querySelector('.hq-sidebar__loose-group').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__hq107Transfer }))`
    );
    await waitFor(
      "Boolean(document.querySelector('[data-hq-chat-project=\"lp_chats\"]'))"
    );
    assert.ok(
      await js(
        "document.body.textContent.includes('Removed from the project.')"
      )
    );
    await capture("moved-to-chats-light.png");
    await js(
      "document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark')"
    );
    const firstTarget = `.hq-sidebar__project:has([data-hq-project-link="${first}"])`;
    await drag(firstTarget, false);
    await capture("project-drop-highlight-dark.png");
    await js(
      `document.querySelector(${JSON.stringify(firstTarget)}).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__hq107Transfer }))`
    );
    await waitFor(
      `Boolean(document.querySelector('[data-hq-chat-project="${first}"]'))`
    );
    await capture("moved-to-project-dark.png");
    assert.deepEqual(
      await js(
        "[getComputedStyle(document.querySelector('.hq-chat-move__notice')).backgroundColor, getComputedStyle(document.querySelector('.hq-chat-move__notice')).color]"
      ),
      ["rgb(244, 244, 245)", "rgb(11, 11, 14)"]
    );
    await drag(".hq-sidebar__loose-group", false);
    await capture("chats-drop-highlight-dark.png");
    await js(
      `document.querySelector('.hq-sidebar__loose-group').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__hq107Transfer }))`
    );
    await waitFor(
      "Boolean(document.querySelector('[data-hq-chat-project=\"lp_chats\"]'))"
    );
    await capture("moved-to-chats-dark.png");
    assert.deepEqual(errors, []);
    await writeFile(
      resolve(scratch, "hq-107", "browser-report.json"),
      JSON.stringify(
        {
          id: "HQ107.private-native",
          status: "pass",
          checks: [
            "Just me group icon aligns with Project icon; nested chat text aligns with Project name",
            "Project and Chats drag targets visibly highlight",
            "Project move uses target name and expands moved chat",
            "Undo restores the prior placement",
            "Chats drop removes the Project placement"
          ],
          compoundS15_1: {
            status: "skip",
            reason:
              "Shared destination confirmation and policy issuance belong to HQ-702"
          },
          assertions: [{ id: "S20.1.indentation", status: "pass" }],
          screenshots: [
            "initial-light.png",
            "project-drop-highlight-light.png",
            "moved-to-project-light.png",
            "undo-light.png",
            "chats-drop-highlight-light.png",
            "moved-to-chats-light.png",
            "project-drop-highlight-dark.png",
            "moved-to-project-dark.png",
            "chats-drop-highlight-dark.png",
            "moved-to-chats-dark.png"
          ]
        },
        null,
        2
      )
    );
    debuggerClient.detach();
    process.stdout.write(`HQ-107 native validation: ${output}\n`);
  } catch (error) {
    failed = true;
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`
    );
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    await rm(profile, { recursive: true, force: true });
    process.exitCode = failed ? 1 : 0;
    app.exit(failed ? 1 : 0);
  }
};
void run();
