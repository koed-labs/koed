import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  shell
} from "electron";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerDesktopCommandHandlers } from "./ipc/commands.js";
import {
  desktopRendererOrigin,
  personalMemoryEventChannel
} from "./ipc/protocol.js";
import {
  createKoedEnvironment,
  createKoedServerManager
} from "./koed-server/manager.js";
import {
  createKoedServerCliInvocation,
  resolveKoedServerPaths
} from "./koed-server/runtime.js";
import {
  KOED_APP_SCHEME,
  resolveAppProtocolRequest
} from "./window/app-protocol.js";
import { resolveDevServerUrl } from "./window/dev-server-url.js";
import { createExternalUrlOpener } from "./window/external-url-opener.js";
import { desktopThemeChromeColor } from "./window/theme-colors.js";
import {
  desktopThemePreferencePath,
  readDesktopThemePreference,
  writeDesktopThemePreference,
  type DesktopThemePreference
} from "./window/theme-preference.js";
import { createMainWindowOptions } from "./window/window-manager.js";

const appDir = dirname(fileURLToPath(import.meta.url));
const { repoRoot, cliPath: koedServerCli } = resolveKoedServerPaths({
  appDir,
  appIsPackaged: app.isPackaged,
  environment: process.env,
  resourcesPath: process.resourcesPath
});
const appName = "Koed";
const koedEnvironment = createKoedEnvironment(repoRoot, process.env, {
  desktopManagedLocal: true,
  packagedDesktop: app.isPackaged,
  packagedResourcesPath: process.resourcesPath
});
const desktopIconPath = resolve(repoRoot, "apps/desktop/assets/koed-icon.png");
const devServerUrl = resolveDevServerUrl({
  appIsPackaged: app.isPackaged,
  devServerUrl: process.env.VITE_DEV_SERVER_URL
});
const allowedRendererOrigins = new Set([
  `${KOED_APP_SCHEME}://app`,
  ...(devServerUrl ? [desktopRendererOrigin(devServerUrl)] : [])
]);

app.setName(appName);

let themePreference: DesktopThemePreference = "system";

protocol.registerSchemesAsPrivileged([
  {
    scheme: KOED_APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true }
  }
]);

const openExternal = createExternalUrlOpener({
  environment: process.env,
  existsSync,
  fallback: (url) => shell.openExternal(url),
  platform: process.platform,
  runProcess: (command, args, options) =>
    new Promise<void>((resolvePromise, rejectPromise) => {
      execFile(
        command,
        args,
        {
          cwd: options.cwd,
          timeout: options.timeout,
          windowsHide: true
        },
        (error) => {
          if (error) rejectPromise(error);
          else resolvePromise();
        }
      );
    })
});

const koedServer = createKoedServerManager({
  repoRoot,
  cliPath: koedServerCli,
  environment: koedEnvironment,
  createCliInvocation: (args) =>
    createKoedServerCliInvocation(koedServerCli, args, {
      appIsPackaged: app.isPackaged,
      electronExecPath: process.execPath,
      platform: process.platform,
      resourcesPath: process.resourcesPath,
      environment: koedEnvironment,
      existsSync
    }),
  existsSync,
  execFile,
  spawn,
  openExternal,
  openPath: (path) => shell.openPath(path)
});

const getAppDistDir = (): string =>
  app.isPackaged
    ? resolve(process.resourcesPath, "app-dist")
    : resolve(repoRoot, "apps/desktop/dist");

const getDesktopIcon = () => {
  if (!existsSync(desktopIconPath)) {
    return undefined;
  }
  return nativeImage.createFromPath(desktopIconPath);
};

const registerAppProtocol = (): void => {
  protocol.handle(KOED_APP_SCHEME, (request) => {
    const resolvedRequest = resolveAppProtocolRequest(
      getAppDistDir(),
      request.url
    );
    if (resolvedRequest.kind === "redirect") {
      return Response.redirect(
        resolvedRequest.redirectUrl!,
        resolvedRequest.status ?? 307
      );
    }
    if (resolvedRequest.kind === "not_found") {
      return new Response("Not found", {
        status: resolvedRequest.status ?? 404
      });
    }
    return net.fetch(resolvedRequest.fileUrl!);
  });
};

const createWindow = async () => {
  const window = new BrowserWindow(
    createMainWindowOptions(
      appDir,
      existsSync(desktopIconPath) ? desktopIconPath : undefined,
      desktopThemeChromeColor(nativeTheme.shouldUseDarkColors)
    )
  );
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void openExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    try {
      const origin = desktopRendererOrigin(url);
      if (!allowedRendererOrigins.has(origin)) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  window.once("ready-to-show", () => window.show());

  if (devServerUrl) {
    await window.loadURL(devServerUrl);
  } else {
    await window.loadURL(`${KOED_APP_SCHEME}://app/`);
  }
  const personalMemoryController = new AbortController();
  window.once("closed", () => personalMemoryController.abort());
  void koedServer
    .subscribePersonalMemory((change) => {
      if (!window.isDestroyed()) {
        window.webContents.send(personalMemoryEventChannel, change);
      }
    }, personalMemoryController.signal)
    .catch(() => undefined);
};

const bootstrap = async () => {
  await app.whenReady();
  const themePreferenceFile = desktopThemePreferencePath(
    app.getPath("userData")
  );
  themePreference = readDesktopThemePreference(themePreferenceFile);
  nativeTheme.themeSource = themePreference;
  const desktopIcon = getDesktopIcon();
  if (desktopIcon && process.platform === "darwin") {
    app.dock?.setIcon(desktopIcon);
  }
  registerAppProtocol();
  registerDesktopCommandHandlers(ipcMain, koedServer.handlers, {
    allowedRendererOrigins,
    personalMemory: koedServer.personalMemory,
    writeClipboard: (value) => clipboard.writeText(value),
    getThemePreference: () => themePreference,
    setThemePreference: (preference) => {
      themePreference = preference;
      nativeTheme.themeSource = preference;
      writeDesktopThemePreference(themePreferenceFile, preference);
      const backgroundColor = desktopThemeChromeColor(
        nativeTheme.shouldUseDarkColors
      );
      for (const window of BrowserWindow.getAllWindows()) {
        window.setBackgroundColor(backgroundColor);
      }
      return {
        preference,
        resolvedDark: nativeTheme.shouldUseDarkColors
      };
    }
  });
  await koedServer.resume();
  await createWindow();
};

void bootstrap();

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
let koedServerStoppedForQuit = false;
app.on("before-quit", (event) => {
  if (koedServerStoppedForQuit) {
    return;
  }
  event.preventDefault();
  void (async () => {
    await koedServer.stop();
    koedServerStoppedForQuit = true;
    app.quit();
  })();
});
