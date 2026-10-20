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
    width: 1100,
    height: 900
  });
  const errors = [];
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  const ev = (code) => window.webContents.executeJavaScript(code);
  const wait = async (code) => {
    for (let i = 0; i < 100; i++) {
      if (await ev(code)) return;
      await delay(50);
    }
    throw Error(`Timed out: ${code}; ${errors.join("; ")}`);
  };
  const click = (label) =>
    ev(
      `[...document.querySelectorAll('button')].find(node=>node.textContent===${JSON.stringify(label)}).click()`
    );
  const capture = async (name) => {
    await ev(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
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
  const layout = async () => {
    await ev(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))"
    );
    const result = await ev(
      `(()=>{const popup=document.querySelector('.personal-conversation-card'),r=popup.getBoundingClientRect(),footer=popup.querySelector('footer').getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,outerScroll:popup.scrollHeight>popup.clientHeight,center:Math.abs(r.x+r.width/2-innerWidth/2),top:r.y,bottom:r.bottom,footer:footer.bottom,height:innerHeight}})()`
    );
    assert.equal(result.overflow, false);
    assert.equal(result.outerScroll, false);
    assert.ok(result.center < 2);
    assert.ok(
      result.top >= 0 &&
        result.bottom <= result.height &&
        result.footer <= result.bottom
    );
  };
  try {
    await window.loadFile(
      fileURLToPath(
        new URL("../dist/browser-validation.html", import.meta.url)
      ),
      { query: { view: "conversation-cards" } }
    );
    await wait(
      "!![...document.querySelectorAll('button')].find(node=>node.textContent==='Add to Project')"
    );
    const menuStyles = await ev(
      `(()=>{const rows=[...document.querySelectorAll('[role=menu] > button')];return rows.map(row=>({border:getComputedStyle(row).borderTopWidth,align:getComputedStyle(row).justifyContent,icons:row.querySelectorAll('svg').length}))})()`
    );
    assert.equal(menuStyles.length, 3);
    for (const row of menuStyles) {
      assert.equal(row.border, menuStyles[0].border);
      assert.equal(row.align, menuStyles[0].align);
      assert.equal(row.icons, 1);
    }
    await capture("conversation-menu");
    window.webContents.debugger.attach("1.3");
    await click("Add to Project");
    await wait("document.querySelectorAll('input[type=checkbox]').length===16");
    for (const width of [1100, 620, 360]) {
      await window.webContents.debugger.sendCommand(
        "Emulation.setDeviceMetricsOverride",
        { width, height: 600, deviceScaleFactor: 1, mobile: false }
      );
      await layout();
      await capture(`checklist-${width}`);
    }
    await ev(
      "[...document.querySelectorAll('button')].find(node=>node.textContent==='Create Project…').scrollIntoView({block:'nearest'})"
    );
    assert.equal(
      await ev(
        "getComputedStyle([...document.querySelectorAll('button')].find(node=>node.textContent==='Create Project…')).borderTopWidth"
      ),
      "1px"
    );
    await capture("create-project-button");
    await click("Create Project…");
    await wait("document.querySelectorAll('[role=dialog]').length===2");
    await ev(
      "[...document.querySelectorAll('[role=dialog]')].at(-1).querySelector('button[type=button]').click()"
    );
    await wait("document.querySelectorAll('[role=dialog]').length===1");
    await ev(
      `document.querySelector('input[aria-label="Include in Project 3"]').click()`
    );
    assert.equal(
      await ev(
        `document.querySelector('input[aria-label="Include in Project 3"]').checked`
      ),
      true
    );
    await click("Cancel");
    await wait("!document.querySelector('[role=dialog]')");
    await click("Add to Project");
    await wait("document.querySelectorAll('input[type=checkbox]').length===16");
    assert.equal(
      await ev(
        `document.querySelector('input[aria-label="Include in Project 3"]').checked`
      ),
      false
    );
    await click("Cancel");
    await wait("!document.querySelector('[role=dialog]')");
    await click("Correct source context");
    await wait("!!document.querySelector('.personal-source-comparison')");
    for (const width of [1100, 620, 360]) {
      await window.webContents.debugger.sendCommand(
        "Emulation.setDeviceMetricsOverride",
        { width, height: 600, deviceScaleFactor: 1, mobile: false }
      );
      await layout();
      await capture(`compare-${width}`);
    }
    await click("Folder");
    await ev(
      `(()=>{const select=document.querySelector('select[aria-label=Correction]');select.value=[...select.options].find(option=>option.textContent.includes('/design')).value;select.dispatchEvent(new Event('change',{bubbles:true}))})()`
    );
    await click("Review changes");
    await wait("!!document.querySelector('.personal-source-impact')");
    await layout();
    await capture("compare-preview-360");
    await click("Cancel");
    await wait("!document.querySelector('[role=dialog]')");
    assert.equal(
      await ev("document.documentElement.dataset.sourceCorrectionApplied"),
      undefined
    );
    await click("Correct source context");
    await wait("!!document.querySelector('.personal-source-comparison')");
    assert.equal(await ev("document.querySelector('select').value"), "reset");
    await click("Review changes");
    await wait("!!document.querySelector('.personal-source-impact')");
    await click("Confirm");
    await wait("!document.querySelector('[role=dialog]')");
    assert.equal(
      await ev("document.documentElement.dataset.sourceCorrectionApplied"),
      "true"
    );
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log(
      "Passed: Checklist and Compare at three widths, constrained height, Cancel/reopen and reviewed Confirm."
    );
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
