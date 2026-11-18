// Throwaway mock of the floating Kin: a real frameless, always-on-top window.
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, ".userData"));
const W = 440, H = 800, MARGIN = 28;
let win;
app.whenReady().then(() => {
  app.dock?.hide();
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: W, height: H,
    x: workArea.x + workArea.width - W - MARGIN,
    y: workArea.y + workArea.height - H - MARGIN,
    transparent: true, frame: false, hasShadow: false, resizable: false,
    fullscreenable: false, skipTaskbar: true, show: false, backgroundColor: "#00000000",
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, "index.html"));
  win.once("ready-to-show", () => win.showInactive());
  if (process.env.KIN_SHOT_DIR) {
    const fs = require("node:fs"); const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    win.webContents.once("did-finish-load", async () => {
      await wait(1500);
      const steps = [["rest-full", "window.__mini(false);window.__go('rest')"], ["rest-mini", "window.__mini(true);window.__go('rest')"], ["answer-claude", "window.__mini(false);window.__sel(0);window.__go('answer')"], ["answer-codex", "window.__sel(1);window.__go('answer')"], ["idle-pi", "window.__sel(2);window.__go('idle')"]];
      for (const theme of ["light", "dark"]) {
        await win.webContents.executeJavaScript(`window.__theme(${JSON.stringify(theme)})`);
        for (const [name, js] of steps) {
          await win.webContents.executeJavaScript(js);
          await wait(1100);
          fs.writeFileSync(`${process.env.KIN_SHOT_DIR}/${theme}-${name}.png`, (await win.webContents.capturePage()).toPNG());
        }
      }
      app.quit();
    });
  }
  win.setIgnoreMouseEvents(true, { forward: true });
});
ipcMain.on("ignore", (_e, ignore) => win?.setIgnoreMouseEvents(ignore, { forward: true }));
ipcMain.on("move", (_e, dx, dy) => { const [x, y] = win.getPosition(); win.setPosition(x + dx, y + dy); });
ipcMain.on("quit", () => app.quit());
app.on("window-all-closed", () => app.quit());
