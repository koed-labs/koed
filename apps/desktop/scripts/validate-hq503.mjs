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
const output = resolve(scratch, "hq-503");
const profile = process.env.KOED_HQ503_USER_DATA_DIR;
assert.ok(profile, "Use an isolated HQ-503 Electron profile under scratch.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

const waitFor = async (run, expression) => {
  for (let index = 0; index < 180; index += 1) {
    if (await run(expression)) return;
    await delay(50);
  }
  throw new Error(`HQ-503 UI did not reach ${expression}`);
};

const run = async () => {
  await app.whenReady();
  await mkdir(output, { recursive: true });
  const results = [];
  for (const mode of ["active", "cold"])
    for (const theme of ["light", "dark"]) {
      let step = "create";
      const window = new BrowserWindow({
        show: true,
        width: 1280,
        height: 800,
        webPreferences: { partition: `hq503-${theme}-${process.pid}` }
      });
      const errors = [];
      window.webContents.on("console-message", (_event, details) => {
        if (details.level === "error") errors.push(details.message);
      });
      try {
        step = "load";
        await window.loadFile(
          resolve(root, "apps/desktop/dist/browser-validation.html"),
          {
            query: {
              view: "hq",
              hq503Capture: "yes",
              hq503Cold: mode === "cold" ? "yes" : "no"
            }
          }
        );
        const js = (source) => window.webContents.executeJavaScript(source);
        step = "fixture";
        await waitFor(
          js,
          "document.documentElement.dataset.hqFixtureReady === 'true'"
        );
        step = "project";
        await js(
          `document.documentElement.classList.remove('light','dark'); document.documentElement.classList.add('${theme}')`
        );
        await js(
          "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]').click()"
        );
        step = "chief";
        await waitFor(
          js,
          "Boolean(document.querySelector('.hq-project-conversation__header .hq-pixelkin'))"
        );
        await waitFor(js, "Boolean(document.querySelector('textarea'))");
        step = "type";
        const typed =
          await js(`(() => { try { const field=document.querySelector('textarea');
        const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
        setter.call(field,'@Quinn fix lint errors in src/chat');
        field.dispatchEvent(new InputEvent('input',{bubbles:true,data:'@Quinn fix lint errors in src/chat',inputType:'insertText'}));
        field.dispatchEvent(new Event('change',{bubbles:true})); return 'ok'; } catch (error) { return String(error); } })()`);
        assert.equal(typed, "ok");
        step = "send";
        await waitFor(
          js,
          `(() => { const button=document.querySelector('button[aria-label="Send message"]');
        if (!button || button.disabled) return false; button.click(); return true; })()`
        );
        await waitFor(js, "window.__koedHq503Trace?.calls.length===1");
        step = "delegation";
        const trace = await js("window.__koedHq503Trace");
        assert.equal(
          trace.calls[0].agentId,
          "00000000-0000-4000-8000-000000004041"
        );
        assert.equal(trace.calls[0].prompt, "fix lint errors in src/chat");
        assert.equal(
          trace.calls[0].parentExecutionId,
          mode === "cold" ? null : "00000000-0000-4000-8000-000000002044"
        );
        assert.equal(
          trace.calls[0].executionGeneration,
          mode === "cold" ? null : 1
        );
        assert.equal(
          await js("window.__koedHq204Trace.send"),
          0,
          "The @mention must not become a Chief prompt"
        );
        if (mode === "cold")
          assert.equal(
            await js("window.__koedHq204Trace.start"),
            0,
            "A cold @mention must not start Chief first"
          );
        await waitFor(
          js,
          "document.querySelector('.hq-project-view__section--doing')?.textContent.includes('fix lint errors in src/chat')"
        );
        await js(
          `document.querySelector('.hq-project-view__section--doing .hq-project-view__work-item canvas[aria-label="Quinn Pixelkin"]')?.scrollIntoView({block:'center'})`
        );
        await waitFor(
          js,
          `(() => { const canvas=document.querySelector('.hq-project-view__section--doing .hq-project-view__work-item canvas[aria-label="Quinn Pixelkin"]');
        return Boolean(canvas && Array.from(canvas.getContext('2d').getImageData(0,0,64,64).data)
          .some((value,index)=>index%4===3 && value===255)); })()`
        );
        const row =
          await js(`(() => { const item=Array.from(document.querySelectorAll('.hq-project-view__section--doing .hq-project-view__work-item'))
        .find((element)=>element.textContent.includes('fix lint errors in src/chat'));
        const canvas=item?.querySelector('canvas[aria-label="Quinn Pixelkin"]');
        const pixels=canvas?.getContext('2d')?.getImageData(0,0,64,64).data;
        return { agent: canvas?.getAttribute('aria-label'),
          opaque: pixels ? Array.from(pixels).filter((value,index)=>index%4===3 && value===255).length : 0 } })()`);
        assert.equal(row.agent, "Quinn Pixelkin");
        assert.ok(
          row.opaque > 100,
          "The real Pixelkin must render in Working now"
        );
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
        await writeFile(resolve(output, `delegated-${mode}-${theme}.png`), png);
        assert.equal(errors.length, 0, errors.join(" | "));
        step = "open child";
        await waitFor(
          js,
          `(() => { const button=Array.from(document.querySelectorAll('.hq-project-view__section--doing button'))
        .find((candidate)=>candidate.getAttribute('aria-label')?.startsWith('Open Quinn task: fix lint errors'));
        if (!button || button.disabled) return false; button.click(); return true; })()`
        );
        await waitFor(
          js,
          `document.querySelector('[data-hq-chat-title][aria-current="page"]')?.textContent?.includes('Quinn helper task')`
        );
        assert.equal(await js("window.__koedHq204Trace.send"), 0);
        step = "owner switch";
        await js(
          "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]').click()"
        );
        await waitFor(
          js,
          "Boolean(document.querySelector('.hq-project-view__section--doing [aria-label^=\"Open Quinn task\"]'))"
        );
        await js("window.__koedHq503SwitchOwner()");
        await waitFor(
          js,
          "!document.querySelector('.hq-project-view__section--doing [aria-label^=\"Open Quinn task\"]')"
        );
        results.push({
          mode,
          theme,
          calls: trace.calls.length,
          visibleTask: true,
          openedCapturedChild: true,
          ownerSwitchHidChild: true
        });
      } catch (error) {
        console.error(
          `HQ503 ${mode} ${theme} failed at ${step}`,
          error,
          errors
        );
        throw error;
      } finally {
        window.close();
      }
    }
  await writeFile(
    resolve(output, "native-report.json"),
    JSON.stringify(
      {
        id: "HQ503.native",
        owner: "HQ-503",
        status: "pass",
        cases: results
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
