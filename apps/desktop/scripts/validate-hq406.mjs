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
const output = resolve(scratch, "hq-406");
const profile = process.env.KOED_HQ406_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-406 profile under scratch.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

const waitFor = async (run, expression) => {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (await run(expression)) return;
    await delay(50);
  }
  throw new Error(`HQ-406 UI did not reach ${expression}`);
};

const run = async () => {
  await app.whenReady();
  await mkdir(output, { recursive: true });
  const cases = [false, true];
  const results = [];
  for (const active of cases) {
    const window = new BrowserWindow({ show: false, width: 1280, height: 800 });
    const errors = [];
    window.webContents.on("console-message", (_event, details) => {
      if (details.level === "error") errors.push(details.message);
    });
    try {
      await window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        {
          query: {
            view: "hq",
            hq406Capture: "yes",
            ...(active ? { hq406Active: "yes" } : {})
          }
        }
      );
      const js = (source) => window.webContents.executeJavaScript(source);
      await waitFor(
        js,
        "Boolean(document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]'))"
      );
      await js(
        "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]').click()"
      );
      await waitFor(
        js,
        "Boolean(document.querySelector('[aria-label$=\"Project sources\"]'))"
      );
      await js(
        "document.querySelector('[aria-label$=\"Project sources\"]').click()"
      );
      await waitFor(
        js,
        'Array.from(document.querySelectorAll(".hq-project-sources__row")).some(x=>x.textContent.includes("Plan.md"))'
      );
      await js(
        'Array.from(document.querySelectorAll(".hq-project-sources__row")).find(x=>x.textContent.includes("Plan.md")).click()'
      );
      await waitFor(
        js,
        'Array.from(document.querySelectorAll("button")).some(x=>x.textContent.trim()==="Ask Chief of Staff to turn Plan.md into tickets")'
      );
      assert.ok(
        await js(
          'document.querySelector(".hq-project-sources__panel")?.textContent.includes("Readable document")'
        )
      );
      const client = window.webContents.debugger;
      if (!client.isAttached()) client.attach("1.3");
      await client.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false
      });
      for (const theme of ["light", "dark"]) {
        await js(
          `document.documentElement.classList.remove("light", "dark"); document.documentElement.classList.add("${theme}")`
        );
        assert.ok(
          await js(
            '(() => { const button=document.querySelector(".hq-project-sources__ask"); const box=button?.getBoundingClientRect(); const style=button&&getComputedStyle(button); return box?.width>=80 && box?.height>=16 && style?.color!==style?.backgroundColor && box.y<document.querySelector(".hq-project-sources__panel-body").getBoundingClientRect().y; })()'
          )
        );
        const { data } = await client.sendCommand("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false
        });
        const png = Buffer.from(data, "base64");
        assert.equal(png.readUInt32BE(16), 1280);
        assert.equal(png.readUInt32BE(20), 800);
        await writeFile(
          resolve(
            output,
            `document-action-${active ? "active" : "first"}-${theme}.png`
          ),
          png
        );
      }
      await js('document.querySelector(".hq-project-sources__ask").click()');
      const key = active ? "send" : "start";
      await waitFor(js, `window.__koedHq204Trace?.${key}===1`);
      const trace = await js("window.__koedHq204Trace");
      const prompt = active ? trace.nextPrompt : trace.firstPrompt;
      assert.equal(prompt, "Turn Plan.md into tickets");
      assert.equal(
        active
          ? trace.nextSelectedDocumentSourceId
          : trace.firstSelectedDocumentSourceId,
        "00000000-0000-4000-8000-000000002053"
      );
      assert.equal(trace.start, active ? 0 : 1);
      assert.equal(trace.send, active ? 1 : 0);
      assert.equal(errors.length, 0, errors.join(" | "));
      results.push({
        active,
        start: trace.start,
        send: trace.send,
        sourceId: "00000000-0000-4000-8000-000000002053"
      });
    } finally {
      window.close();
    }
  }
  await writeFile(
    resolve(output, "native-report.json"),
    JSON.stringify(
      {
        id: "HQ406.native",
        owner: "HQ-406",
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
    process.exitCode = 1;
    app.quit();
  }
);
