import assert from "node:assert/strict";
import console from "node:console";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const profile = process.env.KOED_HQ520_USER_DATA_DIR;
assert.ok(profile, "Supply an isolated HQ-520 Electron profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

const run = async () => {
  let window;
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        backgroundThrottling: false,
        preload: resolve(root, "apps/desktop/dist-electron/preload.cjs")
      }
    });
    await window.loadURL(
      "data:text/html,<html><body>HQ-520 typed IPC probe</body></html>"
    );
    const js = (source) => window.webContents.executeJavaScript(source);
    assert.equal(
      await js("typeof window.koedDesktop?.localAiClients?.usage"),
      "function"
    );
    assert.equal(
      await js("typeof window.koedDesktop?.localAiClients?.onUsageChanged"),
      "function"
    );
    await js(`window.__hq520Events = [];
      window.__hq520Unsubscribe = window.koedDesktop.localAiClients.onUsageChanged(
        change => window.__hq520Events.push(change)); true;`);
    const channel = "koed:local-ai-client:usage-changed";
    const valid = {
      kind: "completion",
      instanceId: "codex.fixture",
      completionId: "fixture-1",
      outcome: "checked",
      observedAt: "2026-10-23T12:00:00.000Z"
    };
    window.webContents.send(channel, {
      ...valid,
      accountIdentityHash: "private"
    });
    window.webContents.send(channel, valid);
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await js("window.__hq520Events.length === 1")) break;
      await delay(25);
    }
    assert.deepEqual(await js("window.__hq520Events"), [valid]);
    window.webContents.send(channel, { kind: "invalidated" });
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await js("window.__hq520Events.length === 2")) break;
      await delay(25);
    }
    assert.deepEqual(await js("window.__hq520Events"), [
      valid,
      { kind: "invalidated" }
    ]);
    await js("window.__hq520Unsubscribe()");
    window.webContents.send(channel, { ...valid, completionId: "fixture-2" });
    await delay(75);
    assert.equal(await js("window.__hq520Events.length"), 2);
    const report = {
      id: "HQ520.native",
      owner: "HQ-520",
      status: "pass",
      assertion: "S520.1",
      validCompletionDelivered: true,
      authorityInvalidationDelivered: true,
      privateFieldRejected: true,
      unsubscribeStoppedDelivery: true
    };
    const reportPath = resolve(scratch, "hq-520", "HQ520.native.json");
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    process.stdout.write(
      "PASS S520.1 [HQ-520]: typed native usage completion and unsubscribe.\n"
    );
  } finally {
    window?.close();
    app.quit();
  }
};
run().catch((error) => {
  console.error(error);
  app.exit(1);
});
