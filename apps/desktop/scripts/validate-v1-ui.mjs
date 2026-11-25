import assert from "node:assert/strict";
import { app, BrowserWindow } from "electron";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { join } from "node:path";
import console from "node:console";
import { setTimeout } from "node:timers";
const run = async () => {
  const scratch = fileURLToPath(
    new URL("../../../scratch/v1-ui-validation/", import.meta.url)
  );
  await mkdir(scratch, { recursive: true });
  const profile = await mkdtemp(join(scratch, "profile-"));
  app.setPath("userData", profile);
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1440,
    height: 1000,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  const errors = [];
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  const page = fileURLToPath(
    new URL("../dist-validation/v1-validation.html", import.meta.url)
  );
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  const paint = () =>
    evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))"
    );
  const click = async (selector, label) => {
    const clicked = await evaluate(`(() => {
      const button = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((candidate) => candidate.textContent.includes(${JSON.stringify(label)}));
      button?.click();
      return !!button;
    })()`);
    assert.ok(clicked, `${label} is present in ${selector}`);
    await paint();
  };
  const capture = async (name) => {
    await paint();
    await writeFile(
      join(scratch, name + ".png"),
      (await window.webContents.capturePage()).toPNG()
    );
  };
  try {
    await window.loadFile(page);
    await evaluate("document.fonts.ready");
    await paint();
    assert.equal(
      await evaluate("document.querySelectorAll('.v1-navigation').length"),
      1
    );
    assert.equal(
      await evaluate("document.documentElement.scrollWidth>innerWidth"),
      false
    );
    await capture("home-light");
    await evaluate("document.querySelector('.v1-mode-button').click()");
    await paint();
    assert.ok(
      await evaluate("document.body.innerText.includes('Example model')")
    );
    await capture("model-picker-light");
    await evaluate(
      "document.documentElement.classList.remove('light');document.documentElement.classList.add('dark')"
    );
    await capture("model-picker-dark");
    await window.loadFile(page, { query: { sidebar: "1" } });
    await paint();
    assert.equal(
      await evaluate("!!document.querySelector('.v1-nav-projects')"),
      true
    );
    assert.equal(
      await evaluate("!!document.querySelector('.v1-nav-conversations')"),
      false
    );
    await click(".v1-nav-anchors .v1-nav-heading-toggle", "Anchors");
    await click(".v1-nav-anchors .v1-nav-project", "No anchor");
    await click(".v1-nav-anchors .v1-nav-load-more", "Load More");
    await click(".v1-nav-anchors .v1-nav-conversation", "The second notebook");
    assert.equal(
      await evaluate(`document.querySelector('.v1-nav-anchors [aria-current="page"]')
      ?.textContent.includes('The second notebook')`),
      true
    );
    // Hovering a tracked row swaps its live marker for the Actions button in
    // the same place, as a row's time does.
    await window.loadFile(page, { query: { sidebar: "1", kin: "1" } });
    await paint();
    for (let attempt = 0; attempt < 50; attempt++) {
      if (
        await evaluate(
          "!!document.querySelector('.v1-nav-projects .fk-row-live')"
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const hoverState = async () =>
      evaluate(`(() => {
        const marker = document.querySelector('.v1-nav-projects .fk-row-live');
        const wrap = marker.closest('.v1-nav-conversation-wrap');
        const menu = wrap.querySelector('.v1-pm-row-menu');
        const m = marker.getBoundingClientRect();
        const b = menu.getBoundingClientRect();
        const row = wrap.getBoundingClientRect();
        return {
          marker: getComputedStyle(marker).visibility,
          menu: getComputedStyle(menu).opacity,
          sameSpot: Math.abs((m.left + m.right) / 2 - (b.left + b.right) / 2) < 16,
          x: Math.round(row.left + row.width / 3),
          y: Math.round(row.top + row.height / 2)
        };
      })()`);
    const resting = await hoverState();
    assert.equal(resting.marker, "visible", "marker shows at rest");
    assert.equal(resting.menu, "0", "Actions hidden at rest");
    assert.ok(resting.sameSpot, "marker sits where the Actions button appears");
    window.webContents.sendInputEvent({
      type: "mouseMove",
      x: resting.x,
      y: resting.y
    });
    await paint();
    const hovered = await hoverState();
    assert.equal(hovered.marker, "hidden", "marker gives way on hover");
    assert.equal(hovered.menu, "1", "Actions show on hover");
    await capture("kin-row-hover");
    window.webContents.sendInputEvent({ type: "mouseMove", x: 1400, y: 900 });
    await paint();

    // A Kin row's panel in the modal sidebar must take real pointer clicks:
    // click Summarize at its screen position, without scrolling it into view.
    // 640 CSS px wide matches a 960px window at 150% zoom.
    window.setContentSize(640, 640);
    await window.loadFile(page, { query: { sidebar: "1", kin: "1" } });
    await paint();
    const pointerClick = async (selector) => {
      const box = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        const { left, top, width, height } = element.getBoundingClientRect();
        const x = Math.round(left + width / 2);
        const y = Math.round(top + height / 2);
        const hit = document.elementFromPoint(x, y);
        return { x, y, hits: !!hit && (hit === element || element.contains(hit)) };
      })()`);
      assert.ok(box, `${selector} is rendered`);
      assert.ok(
        box.hits,
        `${selector} is the topmost element at its centre: ${JSON.stringify(box)}`
      );
      for (const type of ["mouseDown", "mouseUp"])
        window.webContents.sendInputEvent({
          type,
          x: box.x,
          y: box.y,
          button: "left",
          clickCount: 1
        });
      await paint();
    };
    await pointerClick('button[aria-label="Open navigation"]');
    const waitFor = async (code, label) => {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (await evaluate(code)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail(`timed out waiting for ${label}`);
    };
    await waitFor(
      `!!document.querySelector('[data-mobile="true"] .fk-row-live')`,
      "the Kin marker in the modal sidebar"
    );
    // The marker gives way to Actions under the pointer, so open its panel
    // with a direct click; the pointer check below is for Summarize.
    await evaluate(
      `document.querySelector('[data-mobile="true"] .fk-row-live').click()`
    );
    await paint();
    await waitFor(
      `[...document.querySelectorAll('[data-mobile="true"] [data-fk-placement="anchored"] button')].some((b) => b.textContent.includes('Summarize conversation'))`,
      "the Summarize button inside the modal sidebar"
    );
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('[data-fk-placement="anchored"] button')]
        .find((b) => b.textContent.includes('Summarize conversation'));
      button.setAttribute('data-validation-summarize', '');
    })()`);
    await capture("kin-panel-modal-sidebar");
    await pointerClick("[data-validation-summarize]");
    assert.equal(
      await evaluate("window.__kinSummaryRequests ?? 0"),
      1,
      "a pointer click on Summarize starts one summary"
    );
    window.setContentSize(1440, 1000);
    await window.loadFile(page, { query: { onboarding: "1" } });
    await paint();
    assert.ok(await evaluate("!!document.querySelector('.lp-workspace')"));
    assert.equal(
      await evaluate(
        "(()=>{const b=document.querySelector('.lp-primary-button');return getComputedStyle(b).color!==getComputedStyle(b).backgroundColor;})()"
      ),
      true
    );
    await capture("onboarding-ready");
    assert.deepEqual(errors, []);
    console.log("V1 Electron presentation checks passed; captures:", scratch);
  } finally {
    // Chromium can still write caches until process exit. Keep this isolated
    // scratch profile for inspection; deleting it here races those writes.
    window.destroy();
    app.quit();
  }
};
void run().catch((error) => {
  console.error(error);
  app.exit(1);
});
