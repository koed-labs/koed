import assert from "node:assert/strict";
import { app, BrowserWindow, ipcMain } from "electron";
import { build } from "esbuild";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { join } from "node:path";
import console from "node:console";

// Real Electron windows and the production main controller; native installation
// is a controlled barrier. This verifies observation lifetime, not GPU execution.
async function run() {
  const desktop = fileURLToPath(new URL("../", import.meta.url));
  const scratch = fileURLToPath(
    new URL("../../../scratch/acceleration-lifecycle/", import.meta.url)
  );
  await mkdir(scratch, { recursive: true });
  const profile = await mkdtemp(join(scratch, "profile-"));
  app.setPath("userData", profile);
  const bundle = join(profile, "controller.mjs");
  await build({
    stdin: {
      contents:
        'export { createAccelerationController } from "./src/koed-server/acceleration-controller.ts"; export { createOperationReceipt } from "./src/koed-server/operation-receipt.ts"; export { accelerationSnapshot } from "./src/renderer/v1/acceleration.fixture.ts";',
      resolveDir: desktop
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundle
  });
  const {
    createAccelerationController,
    createOperationReceipt,
    accelerationSnapshot
  } = await import(pathToFileURL(bundle).href);
  const preload = join(profile, "preload.cjs");
  await writeFile(
    preload,
    'const { contextBridge, ipcRenderer } = require("electron"); contextBridge.exposeInMainWorld("accelerationCheck", { inspect: () => ipcRenderer.invoke("acceleration-check", "inspect"), apply: choice => ipcRenderer.invoke("acceleration-check", "apply", choice) });'
  );
  await app.whenReady();
  // The default Electron launcher quits on the last window. Desktop keeps its
  // main-owned runtime alive; reproduce that lifetime in this isolated harness.
  app.removeAllListeners("window-all-closed");
  app.on("window-all-closed", () => {});
  const page = join(profile, "index.html");
  await writeFile(
    page,
    "<!doctype html><title>Acceleration lifecycle validation</title><p>Disposable controller validation</p>"
  );
  let snapshot = accelerationSnapshot();
  snapshot.preference = "cpu";
  let installs = 0;
  let saves = 0;
  let progress;
  let signal;
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const controller = createAccelerationController({
    receipt: createOperationReceipt(join(profile, "operation.json")),
    inspect: async () => snapshot,
    save: async (choice) => {
      saves++;
      snapshot = {
        ...snapshot,
        preference: choice.preference,
        effectivePolicy: choice.preference,
        revision: "b".repeat(64)
      };
      return snapshot;
    },
    install: async (_revision, abortSignal, emit) => {
      installs++;
      signal = abortSignal;
      progress = emit;
      emit({
        phase: "downloading",
        completedBytes: 1,
        totalBytes: 10,
        message: "Downloading test payload"
      });
      await gate;
      snapshot = {
        ...snapshot,
        revision: "c".repeat(64),
        cuda: { ...snapshot.cuda, state: "installed", validation: "inference" }
      };
      return { snapshot, validation: "inference", changed: true };
    },
    exclusive: (action) => action(),
    observe: () => ({ state: "stopped", epoch: snapshot.runtimeEpoch }),
    explicitStopGeneration: () => 0,
    stop: async () => {
      throw new Error("Stopped services must not stop again");
    },
    start: async () => {
      throw new Error("Stopped services must not start");
    },
    assertAvailable: () => {}
  });
  ipcMain.handle("acceleration-check", (_event, action, input) =>
    action === "apply" ? controller.apply(input) : controller.inspect()
  );
  const open = async () => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: { preload, contextIsolation: true, sandbox: true }
    });
    await window.loadFile(page);
    return window;
  };
  let window = await open();
  try {
    const choice = {
      preference: "auto",
      installCuda: true,
      expectedRevision: snapshot.revision
    };
    const first = await window.webContents.executeJavaScript(
      `window.accelerationCheck.apply(${JSON.stringify(choice)})`
    );
    assert.equal(installs, 1);
    const loaded = new Promise((resolve) =>
      window.webContents.once("did-finish-load", resolve)
    );
    window.reload();
    await loaded;
    const afterReload = await window.webContents.executeJavaScript(
      "window.accelerationCheck.inspect()"
    );
    assert.equal(afterReload.operation.id, first.operation.id);
    assert.equal(afterReload.operation.phase, "downloading");
    assert.ok(afterReload.operation.sequence >= first.operation.sequence);
    assert.equal(signal.aborted, false);
    await window.webContents.executeJavaScript(
      `window.accelerationCheck.apply(${JSON.stringify(choice)})`
    );
    assert.equal(installs, 1);
    progress({
      phase: "inference",
      completedBytes: null,
      totalBytes: null,
      message: "Verifying test model"
    });
    window.destroy();
    window = await open();
    const reopened = await window.webContents.executeJavaScript(
      "window.accelerationCheck.inspect()"
    );
    assert.equal(reopened.operation.id, first.operation.id);
    assert.equal(reopened.operation.phase, "inference");
    assert.ok(reopened.operation.sequence > afterReload.operation.sequence);
    assert.equal(signal.aborted, false);
    finish();
    await controller.wait();
    const complete = await window.webContents.executeJavaScript(
      "window.accelerationCheck.inspect()"
    );
    assert.equal(complete.operation.state, "complete");
    assert.equal(complete.snapshot.preference, "auto");
    assert.equal(installs, 1);
    assert.equal(saves, 1);
    await writeFile(
      join(scratch, "result.json"),
      JSON.stringify(
        {
          passed: true,
          reloadDuringDownload: true,
          reopenDuringVerification: true,
          retainedOperationId: complete.operation.id,
          installs,
          saves,
          nativeInstallation: "simulated"
        },
        null,
        2
      )
    );
    console.log(
      "Electron acceleration reload checks passed; native installation was simulated."
    );
  } finally {
    finish();
    window.destroy();
    ipcMain.removeHandler("acceleration-check");
  }
}
run().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  }
);
