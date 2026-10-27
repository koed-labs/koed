import console from "node:console";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";

export const browserValidationPagePath = fileURLToPath(
  new URL("../dist-validation/browser-validation.html", import.meta.url)
);

export function runBrowserValidation(
  { width, height, view, screenshotDirectory },
  verify
) {
  const run = async () => {
    const scratch = fileURLToPath(
      new URL("../../../scratch/", import.meta.url)
    );
    mkdirSync(scratch, { recursive: true });
    const profile = mkdtempSync(join(scratch, "browser-validation-"));
    app.setPath("userData", profile);
    await app.whenReady();
    const window = new BrowserWindow({
      show: true,
      opacity: 0,
      skipTaskbar: true,
      width,
      height
    });
    const errors = [];
    window.webContents.on("render-process-gone", (_event, detail) =>
      errors.push(JSON.stringify(detail))
    );
    window.webContents.on("console-message", (event) => {
      if (event.level === "error") errors.push(event.message);
    });
    const evaluate = (code) => window.webContents.executeJavaScript(code);
    const waitFor = async (code, label = code) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate(code)) return;
        await delay(50);
      }
      throw new Error(
        `Timed out: ${label} (${code}); errors: ${errors.join("; ")}; body: ${await evaluate("document.body.innerText.slice(0,2000)")}`
      );
    };
    const capture = async (name) => {
      await evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
      );
      const screenshot = screenshotDirectory
        ? join(
            screenshotDirectory,
            name.endsWith(".png") ? name : `${name}.png`
          )
        : process.env.KOED_BROWSER_VALIDATION_SCREENSHOT?.replace(
            /\.png$/i,
            `-${name}.png`
          );
      if (screenshot)
        await writeFile(
          screenshot,
          (await window.webContents.capturePage()).toPNG()
        );
    };
    const setViewport = async (viewportWidth, viewportHeight = height) => {
      if (!window.webContents.debugger.isAttached())
        window.webContents.debugger.attach("1.3");
      await window.webContents.debugger.sendCommand(
        "Emulation.setDeviceMetricsOverride",
        {
          width: viewportWidth,
          height: viewportHeight,
          deviceScaleFactor: 1,
          mobile: false
        }
      );
    };
    try {
      await window.loadFile(browserValidationPagePath, { query: { view } });
      await verify({ window, errors, evaluate, waitFor, capture, setViewport });
    } finally {
      if (window.webContents.debugger.isAttached())
        window.webContents.debugger.detach();
      window.destroy();
      rmSync(profile, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200
      });
      app.quit();
    }
  };
  run().catch((error) => {
    console.error(error);
    app.exit(1);
  });
}
