import assert from "node:assert/strict";
import console from "node:console";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { app, BrowserWindow } from "electron";
import { validateHq711 } from "./validate-hq711-core.mjs";

const scratch = resolve(import.meta.dirname, "../../../scratch");
const profile = process.env.KOED_HQ711_USER_DATA_DIR;
assert.ok(profile, "Supply an isolated HQ-711 Electron profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

const run = async () => {
  let window;
  try {
    await app.whenReady();
    window = new BrowserWindow({ show: true, width: 1280, height: 800 });
    await validateHq711(window);
  } finally {
    window?.close();
    app.quit();
  }
};
run().catch((error) => {
  console.error(error);
  app.exit(1);
});
