import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { app, BrowserWindow } from "electron";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(scriptDir, "../dist/browser-validation.html");

const inspectWorkspace = async (window) =>
  window.webContents.executeJavaScript(`(() => {
    const workspace = document.querySelector('.project-workspace');
    const master = document.querySelector('.project-master-pane');
    const detail = document.querySelector('.project-detail-column');
    const title = document.querySelector('.dense-session-heading strong');
    const preview = document.querySelector('.dense-session-copy small');
    const row = document.querySelector('[data-session-id="4b23de0b-7e46-4d1f-bb36-d9a70afe3b61"]');
    const list = document.querySelector('.dense-session-list');
    return {
      ready: document.documentElement.dataset.browserValidationReady === 'true',
      workspaceDisplay: workspace && getComputedStyle(workspace).display,
      masterDisplay: master && getComputedStyle(master).display,
      detailDisplay: detail && getComputedStyle(detail).display,
      titleOverflow: title && title.scrollWidth > title.clientWidth,
      previewOverflow: preview && preview.scrollWidth > preview.clientWidth,
      titleTextOverflow: title && getComputedStyle(title).textOverflow,
      previewTextOverflow: preview && getComputedStyle(preview).textOverflow,
      sourceAiClient: row?.textContent.includes('Codex CLI') ?? false,
      rawMetadataExposed: document.body.textContent.includes('untrusted metadata'),
      foreground: row && getComputedStyle(row).color,
      background: list && getComputedStyle(list).backgroundColor
    };
  })()`);

const contrastRatio = (foreground, background) => {
  const channels = (value) =>
    value
      .match(/\d+(?:\.\d+)?/g)
      ?.slice(0, 3)
      .map(Number);
  const luminance = (rgb) => {
    assert.ok(rgb?.length === 3, `Expected RGB color, received ${rgb}`);
    const normalized = rgb
      .map((channel) => channel / 255)
      .map((channel) =>
        channel <= 0.03928
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4
      );
    return (
      0.2126 * normalized[0] + 0.7152 * normalized[1] + 0.0722 * normalized[2]
    );
  };
  const [first, second] = [
    luminance(channels(foreground)),
    luminance(channels(background))
  ].sort((a, b) => b - a);
  return (first + 0.05) / (second + 0.05);
};

const waitForReady = async (window) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await inspectWorkspace(window)).ready) return;
    await delay(20);
  }
  throw new Error("Browser validation fixture did not render.");
};

const run = async () => {
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1440, height: 900 });
  try {
    await window.loadFile(pagePath);
    await waitForReady(window);

    const wide = await inspectWorkspace(window);
    assert.equal(wide.workspaceDisplay, "grid");
    assert.equal(wide.masterDisplay, "grid");
    assert.notEqual(wide.detailDisplay, "none");
    assert.equal(wide.titleOverflow, true);
    assert.equal(wide.previewOverflow, true);
    assert.equal(wide.titleTextOverflow, "ellipsis");
    assert.equal(wide.previewTextOverflow, "ellipsis");
    assert.equal(wide.sourceAiClient, true);
    assert.equal(wide.rawMetadataExposed, false);
    assert.ok(contrastRatio(wide.foreground, wide.background) >= 4.5);

    await window.setSize(620, 900);
    await delay(50);
    const narrow = await inspectWorkspace(window);
    assert.equal(narrow.workspaceDisplay, "block");
    assert.equal(narrow.masterDisplay, "none");

    await window.webContents.executeJavaScript(
      `document.querySelector('[data-back-to-projects]').click()`
    );
    await delay(50);
    const focus = await window.webContents.executeJavaScript(
      `document.activeElement?.getAttribute('data-route-focus')`
    );
    assert.equal(focus, "projects");
  } finally {
    window.destroy();
    app.quit();
  }
};

run().catch((error) => {
  app.exitCode = 1;
  app.quit();
  throw error;
});
