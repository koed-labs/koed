import type { BrowserWindowConstructorOptions } from "electron";
import { resolve } from "node:path";

export const createMainWindowOptions = (
  appDir: string,
  iconPath?: string,
  backgroundColor = "#fbfbfa",
  hqEnabled = false
): BrowserWindowConstructorOptions => ({
  title: "Koed",
  width: 1320,
  height: 900,
  minWidth: hqEnabled ? 320 : 960,
  minHeight: 640,
  icon: iconPath,
  backgroundColor,
  show: false,
  webPreferences: {
    preload: resolve(appDir, "preload.cjs"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true
  }
});
