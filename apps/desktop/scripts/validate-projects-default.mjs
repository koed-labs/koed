import console from "node:console";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  browserValidationPagePath,
  runBrowserValidation
} from "./browser-validation-runner.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const output = resolve(root, "scratch/pv-07/native-ui");
const newItem =
  "[...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent.trim() === 'New Conversation')";
mkdirSync(output, { recursive: true });
rmSync(resolve(output, "result.json"), { force: true });
runBrowserValidation(
  {
    width: 1380,
    height: 900,
    view: "projects-default",
    screenshotDirectory: output
  },
  async ({ window, evaluate, waitFor, errors: faults, capture }) => {
    try {
      await waitFor(
        "document.querySelectorAll('[data-session-id]').length === 4",
        "four distinct Project members"
      );
      assert.equal(
        await evaluate("document.querySelectorAll('[data-project-id]').length"),
        1
      );
      assert.equal(
        await evaluate(
          "document.querySelectorAll('.personal-project-sources,.personal-project-recall,.personal-source-browser-toggle,.personal-new-conversation').length"
        ),
        0
      );
      await capture("project.png");

      await evaluate(
        "document.querySelector('[aria-label=\"Project actions\"]').click()"
      );
      await waitFor(
        `Boolean(${newItem}) && ${newItem}.getAttribute('aria-disabled') !== 'true'`,
        "Project actions opens with New Conversation"
      );
      await window.webContents
        .executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))).then(async () => {
      const menu = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.trim() === 'New Conversation').closest('[role="menu"]');
      await Promise.all(menu.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
    })`);
      assert.equal(
        await evaluate(`(() => {
      const item = ${newItem};
      const menu = item.closest('[role="menu"]');
      return item.getBoundingClientRect().height > 0 && getComputedStyle(menu).visibility === 'visible' && Number(getComputedStyle(menu).opacity) > 0.9;
    })()`),
        true
      );
      await capture("project-menu.png");
      await evaluate(`${newItem}.click()`);
      const folderChip = '[aria-label^="Execution Folder:"]';
      await waitFor(
        `!!document.querySelector('${folderChip}')`,
        "local Folder toolbar chip"
      );
      assert.equal(
        await evaluate(
          `document.querySelector('${folderChip}').textContent.includes('Choose Folder') && !document.querySelector('.personal-execution-folder')`
        ),
        true
      );
      assert.equal(
        await evaluate(
          "document.querySelector('[aria-label=\"Start Conversation\"]').disabled"
        ),
        true
      );
      const draft = "Keep this draft when changing Folders.";
      await evaluate(`(() => {
      window.folderDraftInput = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(window.folderDraftInput, ${JSON.stringify(draft)});
      window.folderDraftInput.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
      for (const path of ["/local/koed", "/local/notes"]) {
        await evaluate(`document.querySelector('${folderChip}').click()`);
        const option = `[role="menuitemradio"][title="${path}"]`;
        await waitFor(
          `!!document.querySelector('${option}')`,
          "Folder menu opens"
        );
        await window.webContents
          .executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))).then(async () => {
        const menu = document.querySelector('${option}').closest('[role="menu"]');
        await Promise.all(menu.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
      })`);
        await capture("execution-folder-picker.png");
        await evaluate(`document.querySelector('${option}').click()`);
        await waitFor(
          `document.querySelector('${folderChip}').getAttribute('aria-label') === 'Execution Folder: ${path}'`,
          "selected Folder appears in toolbar"
        );
        await waitFor(
          `!document.querySelector('${option}')`,
          "Folder menu closes after choosing"
        );
        assert.equal(
          await evaluate(
            `document.querySelector('textarea') === window.folderDraftInput && window.folderDraftInput.value === ${JSON.stringify(draft)}`
          ),
          true
        );
      }
      await waitFor(
        "!document.querySelector('[aria-label=\"Start Conversation\"]').disabled",
        "selected Folder enables launch"
      );
      await capture("execution-folder.png");
      await evaluate(
        "document.querySelector('[aria-label=\"Start Conversation\"]').click()"
      );
      await waitFor(
        "window.projectsDefaultValidationTrace.some(item => item.type === 'start')",
        "New Conversation launch"
      );
      assert.equal(
        await evaluate(
          "window.projectsDefaultValidationTrace.find(item => item.type === 'start').input.projectId === window.projectsDefaultValidationIds.notesExecutionId"
        ),
        true
      );

      await window.loadFile(browserValidationPagePath, {
        query: { view: "projects-default", headers: "1" }
      });
      await waitFor(
        "document.querySelectorAll('[data-project-id]').length === 2 && document.querySelectorAll('.personal-project-header').length === 1",
        "managed Project headers"
      );
      const ids = await evaluate("window.projectsDefaultValidationIds");
      for (const [id, name] of [
        [ids.secondProjectId, "Second Project"],
        [ids.projectId, "Koed"],
        [ids.secondProjectId, "Second Project"],
        [ids.projectId, "Koed"]
      ]) {
        await evaluate(
          `document.querySelector('[data-project-id="${id}"]').click()`
        );
        await waitFor(
          `document.querySelector('.personal-project-header h2')?.textContent === ${JSON.stringify(name)}`,
          "selected Project replaces header"
        );
        assert.equal(
          await evaluate(
            "document.querySelectorAll('.personal-project-header').length"
          ),
          1
        );
        assert.equal(
          await evaluate(
            "document.querySelectorAll('.personal-project-sources,.personal-project-recall,.personal-source-browser-toggle,.personal-new-conversation').length"
          ),
          0
        );
      }
      await capture("project-switching.png");
      await evaluate(
        "document.querySelector('[aria-label=\"Project actions\"]').click()"
      );
      await waitFor(
        `Boolean(${newItem})`,
        "management menu includes New Conversation"
      );
      assert.equal(
        await evaluate(`${newItem}.getAttribute('aria-disabled') === 'true'`),
        false
      );
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await waitFor(`!(${newItem})`, "management menu closes");

      await evaluate(
        "document.querySelector('.personal-project-details-trigger').click()"
      );
      await waitFor(
        "!!document.querySelector('[aria-label=\"Select all folders\"]')",
        "Folder filter dropdown"
      );
      await evaluate(`(() => {
      const label = [...document.querySelectorAll('.personal-project-folder-checkbox')].find(item => item.textContent.includes('Show Conversations from /local/koed'));
      label.querySelector('input').click();
    })()`);
      await waitFor(
        "document.querySelectorAll('[data-session-id]').length === 2",
        "Folder checkbox filters named Project"
      );
      await evaluate(
        "document.querySelector('[aria-label=\"Select all folders\"]').click()"
      );
      await waitFor(
        "document.querySelectorAll('[data-session-id]').length === 4",
        "Select all restores Conversations"
      );
      await evaluate(
        "document.querySelector('[aria-label=\"Select all folders\"]').click()"
      );
      await waitFor(
        "document.querySelectorAll('[data-session-id]').length === 0",
        "deselect all Folders"
      );
      await capture("folder-dropdown.png");
      await evaluate(
        "document.querySelector('[aria-label=\"Select all folders\"]').click()"
      );
      await waitFor(
        "document.querySelectorAll('[data-session-id]').length === 4",
        "Folder dropdown restores full list"
      );
      await evaluate(
        "document.querySelector('[aria-label=\"Close Project details\"]').click()"
      );
      await window.loadFile(browserValidationPagePath, {
        query: { view: "projects-default", ask: "1" }
      });
      await waitFor(
        "!!document.querySelector('.personal-agent-start textarea')",
        "Ask input"
      );
      assert.equal(
        await evaluate(
          "document.querySelectorAll('.personal-agent-projects [data-project-id]').length === 1 && document.querySelector('.personal-agent-projects [data-project-id]').dataset.groupKind === 'project'"
        ),
        true
      );
      assert.equal(
        await evaluate(
          "document.querySelector('.conversation-folder-trigger').textContent.includes('Automatic Folder') && document.querySelector('.conversation-folder-trigger').disabled"
        ),
        true
      );
      await evaluate(
        "document.querySelector('.personal-agent-open-project').click()"
      );
      await waitFor(
        "!!document.querySelector('.personal-agent-project-option')",
        "Ask Project picker"
      );
      await window.webContents
        .executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))).then(async () => {
      const menu = document.querySelector('.personal-agent-project-option').closest('[role="menu"]');
      await Promise.all(menu.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
    })`);
      await capture("ask-project-picker.png");
      await evaluate(
        "document.querySelector('.personal-agent-project-option').click()"
      );
      await waitFor(
        "!document.querySelector('.personal-agent-project-option')",
        "Ask Project picker closes"
      );
      const askDraft = "Keep this Ask draft when changing Folders.";
      await evaluate(`(() => {
      window.askDraftInput = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(window.askDraftInput, ${JSON.stringify(askDraft)});
      window.askDraftInput.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
      for (const path of ["/local/koed", "/local/notes"]) {
        await evaluate(`document.querySelector('${folderChip}').click()`);
        const option = `[role="menuitemradio"][title="${path}"]`;
        await waitFor(
          `!!document.querySelector('${option}')`,
          "Ask Folder menu"
        );
        await evaluate(`document.querySelector('${option}').click()`);
        await waitFor(
          `!document.querySelector('${option}')`,
          "Ask Folder menu closes"
        );
        assert.equal(
          await evaluate(
            `document.querySelector('textarea') === window.askDraftInput && window.askDraftInput.value === ${JSON.stringify(askDraft)}`
          ),
          true
        );
      }
      await waitFor(
        "!document.querySelector('[aria-label=\"Start Conversation\"]').disabled",
        "Ask selected Folder enables launch"
      );
      await capture("ask-folder-chip.png");
      window.setSize(620, 900);
      await waitFor("window.innerWidth === 620", "narrow Ask viewport");
      await evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
      );
      assert.equal(
        await evaluate(`(() => {
        const input = document.querySelector('.conversation-input').getBoundingClientRect();
        const send = document.querySelector('[aria-label="Start Conversation"]').getBoundingClientRect();
        return document.documentElement.scrollWidth <= window.innerWidth && send.right <= input.right && send.bottom <= input.bottom;
      })()`),
        true
      );
      await capture("ask-folder-chip-narrow.png");
      window.setSize(1380, 900);

      await evaluate(
        "document.querySelector('[aria-label=\"Start Conversation\"]').click()"
      );
      await waitFor(
        "window.askValidationTrace.sends.length === 1",
        "Ask first prompt"
      );
      assert.equal(
        await evaluate(
          `window.askValidationTrace.starts[0].projectId === window.projectsDefaultValidationIds.notesExecutionId && window.askValidationTrace.sends[0].prompt === ${JSON.stringify(askDraft)}`
        ),
        true
      );
      assert.deepEqual(faults, []);
      await writeFile(
        resolve(output, "result.json"),
        JSON.stringify(
          {
            status: "passed",
            automated: true,
            manual: false,
            fixture: "synthetic",
            checks: [
              "named-only Project list",
              "four logical members",
              "clean Project header",
              "New Conversation in Project actions",
              "Project actions menu opens",
              "explicit native Folder choice and launch",
              "Folder toolbar changes preserve the draft input",
              "Project switching replaces header",
              "Folder filter dropdown",
              "Ask named Projects and shared Folder chip",
              "Ask Folder changes retain the draft and selected execution target"
            ],
            faults
          },
          null,
          2
        )
      );
      console.log(
        `Projects navigation acceptance passed. Screenshots: ${output}`
      );
    } catch (error) {
      console.error(error);
      console.error(
        await evaluate(
          `({body:document.body.innerText, menus:[...document.querySelectorAll('[data-slot="dropdown-menu-popup"]')].map(menu=>({label:menu.getAttribute('aria-label'),opacity:getComputedStyle(menu).opacity,visibility:getComputedStyle(menu).visibility,rect:JSON.stringify(menu.getBoundingClientRect())}))})`
        )
      );
      await writeFile(
        resolve(output, "failure.png"),
        (await window.webContents.capturePage()).toPNG()
      );
      throw error;
    }
  }
);
