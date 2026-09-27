/* eslint-disable @typescript-eslint/no-require-imports -- Electron entry point uses CommonJS. */
const { app, BrowserWindow, dialog, shell } = require("electron");
const { isGithubPullRequestUrl } = require("./external-links.cjs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.setName("Koed Studio Preview");
app.setPath(
  "userData",
  path.join(app.getPath("appData"), "Koed Studio Preview")
);

let window;
let gateway;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  app.whenReady().then(async () => {
    try {
      const { startStudioServer } = await import(
        pathToFileURL(path.join(__dirname, "../server/index.mjs")).href
      );
      gateway = await startStudioServer({ port: 0 });
      window = new BrowserWindow({
        title: "Koed Studio Preview",
        width: 1200,
        height: 800,
        titleBarStyle: "hiddenInset",
        minWidth: 400,
        minHeight: 600,
        backgroundColor: "#000000",
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true
        }
      });
      window.webContents.setWindowOpenHandler(({ url }) => {
        if (isGithubPullRequestUrl(url)) {
          void shell.openExternal(url).catch(() => undefined);
        }
        return { action: "deny" };
      });
      window.webContents.on("will-navigate", (event, target) => {
        if (new URL(target).origin !== new URL(gateway.url).origin) {
          event.preventDefault();
        }
      });
      window.webContents.session.setPermissionRequestHandler(
        (_webContents, _permission, callback) => callback(false)
      );
      window.once("ready-to-show", () => window.show());
      await window.loadURL(gateway.url);
    } catch {
      dialog.showErrorBox(
        "Koed Studio could not start",
        "Build the Studio app and check that its local preview server can start. Your Koed backend was not changed."
      );
      app.quit();
    }
  });
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => {
    gateway?.server.close();
  });
}
