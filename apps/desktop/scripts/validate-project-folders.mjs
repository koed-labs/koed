import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { app, BrowserWindow } from "electron";

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: true,
    opacity: 0,
    skipTaskbar: true,
    width: 1440,
    height: 900
  });
  const errors = [];
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  const waitFor = async (code) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(code)) return;
      await delay(50);
    }
    throw new Error(`Timed out: ${code}`);
  };
  const click = (selector) =>
    evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const action = (text) =>
    evaluate(
      `[...document.querySelectorAll('.personal-project-details-card button')].find(button=>button.textContent.trim().startsWith(${JSON.stringify(text)})).click()`
    );
  const layout = () =>
    evaluate(`(() => {
    const card=document.querySelector('.personal-project-details-card'),rect=card.getBoundingClientRect();
    const header=document.querySelector('.personal-project-header'),move=header.querySelector('[aria-label="Move Project"]'),create=header.querySelector('.personal-new-conversation');
    return {width:innerWidth,headerHeight:header.getBoundingClientRect().height,retiredMoveVisible:!!move,newHeight:create.getBoundingClientRect().height,
      overflow:card.scrollWidth>card.clientWidth,pageOverflow:document.documentElement.scrollWidth>innerWidth,
      fits:rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight,
      folderSelector:!!card.querySelector('[aria-label="Repository checkout"]')};
  })()`);
  const layouts = [];
  const capture = async (name) => {
    await evaluate(
      `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
    );
    if (process.env.KOED_BROWSER_VALIDATION_SCREENSHOT)
      await writeFile(
        process.env.KOED_BROWSER_VALIDATION_SCREENSHOT.replace(
          /\.png$/i,
          `-${name}.png`
        ),
        (await window.webContents.capturePage()).toPNG()
      );
  };
  try {
    await window.loadFile(
      fileURLToPath(
        new URL("../dist/browser-validation.html", import.meta.url)
      ),
      { query: { view: "project-folders" } }
    );
    await waitFor(
      `document.documentElement.dataset.browserValidationReady==='true'`
    );
    await waitFor(`!!document.querySelector('.personal-project-header')`);
    window.webContents.debugger.attach("1.3");
    for (const width of [1440, 620, 360]) {
      await window.webContents.debugger.sendCommand(
        "Emulation.setDeviceMetricsOverride",
        { width, height: 900, deviceScaleFactor: 1, mobile: false }
      );
      await click(".personal-project-details-trigger");
      await waitFor(
        `!!document.querySelector('.personal-project-details-card')`
      );
      await waitFor(
        `document.querySelectorAll('.personal-session-row').length===2`
      );
      assert.equal(
        await evaluate(
          `document.querySelectorAll('.personal-project-folder-filter-row input').length`
        ),
        2
      );
      assert.equal(
        await evaluate(
          `document.querySelector('[aria-label="Select all folders"]').checked`
        ),
        true
      );
      await click(".personal-project-folder-filter-row input");
      await waitFor(
        `document.querySelectorAll('.personal-session-row').length===1`
      );
      assert.equal(
        await evaluate(
          `!!document.querySelector('.personal-project-details-card')`
        ),
        true
      );
      layouts.push(await layout());
      assert.equal(
        await evaluate(
          `document.querySelector('[aria-label="Select all folders"]').indeterminate`
        ),
        true
      );
      assert.equal(
        await evaluate(
          `document.querySelectorAll('.personal-project-folder-filter-row .lucide-folder, .personal-project-folder-count, [aria-label="Project folders"] h3').length`
        ),
        0
      );
      await capture(`filter-${width}`);
      await click('[aria-label="Select all folders"]');
      await waitFor(
        `document.querySelectorAll('.personal-session-row').length===2`
      );
      await click('[aria-label="Select all folders"]');
      await waitFor(
        `document.querySelectorAll('.personal-session-row').length===0`
      );
      assert.equal(
        await evaluate(
          `document.body.textContent.includes('No Conversations match the folder filter')`
        ),
        true
      );
      assert.equal(
        await evaluate(
          `(() => {const input=document.querySelector('[aria-label="Select all folders"]');return !input.checked&&!input.indeterminate;})()`
        ),
        true
      );
      await click('[aria-label="Select all folders"]');
      await waitFor(
        `document.querySelectorAll('.personal-session-row').length===2`
      );
      await click('[aria-label="Open /private/operator/koed-alt details"]');
      await delay(100);
      layouts.push(await layout());
      assert.equal(
        await evaluate(
          `document.querySelector('.personal-project-details-card').textContent.includes('Advanced')`
        ),
        true
      );
      await capture(`folder-${width}`);
      await click(
        '[aria-label="Reveal /private/operator/koed-alt in file browser"]'
      );
      await action("Repository anchor");
      await delay(100);
      layouts.push(await layout());
      await evaluate(
        `document.querySelectorAll('.personal-project-choice input')[1].click()`
      );
      assert.equal(
        await evaluate(
          `document.querySelector('[aria-label="Selected repository remote"]').value`
        ),
        "upstream"
      );
      await action("Save anchor");
      await click('[aria-label="Back to folder details"]');
      await action("Review previous assignments");
      await waitFor(
        `document.body.textContent.includes('No previous assignments need review')`
      );
      layouts.push(await layout());
      await click('[aria-label="Back to folder details"]');
      await action("Share anchor across devices");
      await waitFor(
        `!!document.querySelector('[aria-label="Available shared choice"]')`
      );
      await delay(100);
      layouts.push(await layout());
      await capture(`sharing-${width}`);
      await action("Share new");
      assert.equal(
        await evaluate(
          `document.querySelector('[aria-label="Repository remote"]').value`
        ),
        "upstream"
      );
      await action("Share and link");
      await waitFor(
        `document.body.textContent.includes('Updates apply to all linked folders.')`
      );
      await delay(100);
      layouts.push(await layout());
      await capture(`linked-${width}`);
      await action("Unlink this folder");
      await waitFor(
        `!!document.querySelector('[aria-label="Sharing action"]')`
      );
      await action("Use existing");
      await evaluate(
        `(() => {const select=document.querySelector('[aria-label="Available shared choice"]');select.value='fixture_association';select.dispatchEvent(new Event('change',{bubbles:true}));})()`
      );
      await action("Link folder");
      await waitFor(
        `document.body.textContent.includes('Updates apply to all linked folders.')`
      );
      await action("Unlink this folder");
      await waitFor(
        `!!document.querySelector('[aria-label="Available shared choice"]')`
      );
      await click('[aria-label="Back to folder details"]');
      await click('[aria-label="Back to Project details"]');
      await click('[aria-label="Open /private/operator/koed details"]');
      await action("Repository anchor");
      assert.equal(
        await evaluate(
          `document.querySelector('.personal-project-choice input').checked`
        ),
        true
      );
      await click('[aria-label="Close Project details"]');
      await waitFor(
        `!document.querySelector('.personal-project-details-card')`
      );
    }
    const trace = await evaluate(`window.projectFolderValidationTrace`);
    assert.ok(
      trace.some(
        (entry) =>
          entry.operation === "create" &&
          entry.localProjectId === `lp_${"2".repeat(32)}` &&
          entry.expectedCheckoutId === "checkout_2" &&
          entry.remoteName === "upstream"
      )
    );
    assert.ok(trace.some((entry) => entry.reveal === `lp_${"2".repeat(32)}`));
    assert.ok(
      layouts.every(
        (entry) =>
          entry.headerHeight === 96 &&
          !entry.retiredMoveVisible &&
          entry.newHeight > 0 &&
          !entry.overflow &&
          !entry.pageOverflow &&
          entry.fits &&
          !entry.folderSelector
      ),
      JSON.stringify(layouts)
    );
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: "passed", layouts }));
  } finally {
    if (window.webContents.debugger.isAttached())
      window.webContents.debugger.detach();
    window.destroy();
    app.quit();
  }
}
run().catch((error) => {
  console.error(error);
  app.exit(1);
});
