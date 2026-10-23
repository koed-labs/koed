import assert from "node:assert/strict";
import console from "node:console";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const output = resolve(scratch, "hq-504");
const profile = process.env.KOED_HQ504_USER_DATA_DIR;
assert.ok(profile, "Use an isolated HQ-504 Electron profile under scratch.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

const waitFor = async (run, expression) => {
  for (let index = 0; index < 180; index += 1) {
    if (await run(expression)) return;
    await delay(50);
  }
  throw new Error(`HQ-504 native fixture did not reach ${expression}`);
};

const run = async () => {
  await app.whenReady();
  await mkdir(output, { recursive: true });
  const results = [];
  for (const theme of ["light", "dark"]) {
    const window = new BrowserWindow({
      show: true,
      width: 1280,
      height: 800,
      webPreferences: { partition: `hq504-${theme}-${process.pid}` }
    });
    const errors = [];
    window.webContents.on("console-message", (event, details) => {
      const entry = details ?? event;
      if (entry.level === "error" || entry.level === 3)
        errors.push(entry.message);
    });
    window.webContents.on("did-fail-load", (_event, code, description) => {
      errors.push(`load ${code}: ${description}`);
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      errors.push(`renderer: ${details.reason}`);
    });
    let step = "load";
    try {
      await window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        {
          query: {
            view: "hq",
            hq204Capture: "yes",
            hq208Capture: "yes",
            hq504Capture: "yes"
          }
        }
      );
      const js = (source) => window.webContents.executeJavaScript(source);
      const focusFixture = async () => {
        window.show();
        app.focus({ steal: true });
        window.focus();
        await waitFor(
          js,
          "document.visibilityState === 'visible' && document.hasFocus()"
        );
      };
      await waitFor(
        js,
        "document.documentElement.dataset.hqFixtureReady === 'true'"
      );
      await focusFixture();
      await js(`document.documentElement.classList.remove('light','dark');
      document.documentElement.classList.add('${theme}')`);
      step = "project";
      await js(
        `document.querySelector('[data-hq-project-link="00000000-0000-4000-8000-000000002038"]').click()`
      );
      await waitFor(js, "Boolean(document.querySelector('textarea'))");
      step = "start";
      await js(`(() => { const field=document.querySelector('textarea');
      const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      setter.call(field,'Plan the launch');
      field.dispatchEvent(new InputEvent('input',{bubbles:true,data:'Plan the launch',inputType:'insertText'}));
      field.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      await waitFor(
        js,
        `(() => { const button=document.querySelector('button[aria-label="Send message"]');
      if (!button || button.disabled) return false; button.click(); return true; })()`
      );
      step = "cards";
      await focusFixture();
      await waitFor(
        js,
        `document.querySelectorAll('.hq-text-action').length===3`
      );
      const cardText = await js(
        `Array.from(document.querySelectorAll('.hq-text-action')).map((x)=>x.textContent)`
      );
      assert.ok(
        cardText.some(
          (value) =>
            value.includes("Launch planning") && value.includes("Approve")
        )
      );
      assert.ok(
        cardText.some(
          (value) =>
            value.includes("New empty Project") &&
            value.includes("Review exact effect")
        )
      );
      assert.ok(
        cardText.some(
          (value) =>
            value.includes("Planning chat: Chats → New empty Project") &&
            value.includes("Continue reviewed move")
        )
      );
      assert.ok(cardText.every((value) => !value.includes("00000000-")));
      step = "capture";
      const client = window.webContents.debugger;
      client.attach("1.3");
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
      await writeFile(resolve(output, `text-actions-${theme}.png`), png);
      step = "decline";
      await js(`Array.from(document.querySelectorAll('.hq-text-action button'))
      .find((button)=>button.textContent==='Not now').click()`);
      await waitFor(
        js,
        `document.querySelector('.hq-text-actions')?.textContent.includes('Not run')`
      );
      assert.equal(await js("window.__koedHq504Trace.claims"), 0);
      assert.equal(await js("window.__koedHq504Trace.applications"), 0);
      step = "native review";
      await js(`Array.from(document.querySelectorAll('.hq-text-action button'))
      .find((button)=>button.textContent==='Review exact effect').click()`);
      await waitFor(
        js,
        `document.querySelector('[role="dialog"][aria-label="Delete Project"]')?.textContent.includes('Delete New empty Project?')`
      );
      const { data: nativeData } = await client.sendCommand(
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: false
        }
      );
      await writeFile(
        resolve(output, `native-review-${theme}.png`),
        Buffer.from(nativeData, "base64")
      );
      assert.equal(errors.length, 0, errors.join(" | "));
      results.push({
        theme,
        cards: 3,
        declinedWithoutEffect: true,
        nativeReviewVisible: true,
        claimedRecoveryVisible: true
      });
    } catch (error) {
      console.error(`HQ-504 ${theme} failed at ${step}`, error, errors);
      console.error(
        await window.webContents
          .executeJavaScript(
            `({
      href: location.href,
      text: document.body?.innerText?.slice(0, 1200),
      ready: document.documentElement.dataset.hqFixtureReady,
      root: document.getElementById('root')?.innerHTML?.slice(0, 600),
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      actions: document.querySelectorAll('.hq-text-action').length,
      hasApi: Boolean(window.koedDesktop?.managedTextActions),
      hasConversation: Boolean(document.querySelector('.hq-conversation')),
      trace: window.__koedHq204Trace
    })`
          )
          .catch(String)
      );
      console.error(
        await window.webContents
          .executeJavaScript(
            `import(document.querySelector('script[type="module"]').src).then(()=>'module loaded', e=>e.stack)`
          )
          .catch(String)
      );
      throw error;
    } finally {
      window.close();
    }
  }
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        id: "HQ504.native",
        owner: "HQ-504",
        status: "pass",
        themes: results,
        coverage: {
          compactApprovalCards: true,
          askFirstDeclineHasNoEffect: true,
          claimedReadOnlyRecoveryVisible: true,
          nativeDeleteReviewVisible: true,
          durableMutationAuthority: "verified by separate real-Postgres tests",
          compoundS18AndN12: "pending later integration proof"
        }
      },
      null,
      2
    )
  );
};

run().then(
  () => app.quit(),
  (error) => {
    console.error(error);
    app.exit(1);
  }
);
