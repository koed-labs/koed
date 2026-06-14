import type { BrowserWindowConstructorOptions } from "electron";
import { resolve } from "node:path";

export const createMainWindowOptions = (
  appDir: string
): BrowserWindowConstructorOptions => ({
  width: 1320,
  height: 900,
  minWidth: 960,
  minHeight: 640,
  show: false,
  webPreferences: {
    preload: resolve(appDir, "preload.js"),
    contextIsolation: true,
    nodeIntegration: false
  }
});
