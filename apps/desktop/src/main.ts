import {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  net,
  protocol,
  shell
} from "electron";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installPdsDesktopSecretResolver } from "@koed/api/personal-device-sync/secure-runtime";
import { registerDesktopCommandHandlers } from "./ipc/commands.js";
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
import { createPdsDesktopSecretResolver } from "./pds-secure-provider.js";
import { resolveDevServerUrl } from "./window/dev-server-url.js";
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
  desktopManagedLocal: app.isPackaged,
  packagedResourcesPath: process.resourcesPath
});
const desktopIconPath = resolve(repoRoot, "apps/desktop/assets/koed-icon.png");

app.setName(appName);

protocol.registerSchemesAsPrivileged([
  {
    scheme: KOED_APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true }
  }
]);

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
  openExternal: (url) => shell.openExternal(url),
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
      existsSync(desktopIconPath) ? desktopIconPath : undefined
    )
  );
  window.once("ready-to-show", () => window.show());

  const devServerUrl = resolveDevServerUrl({
    appIsPackaged: app.isPackaged,
    devServerUrl: process.env.VITE_DEV_SERVER_URL
  });
  if (devServerUrl) {
    await window.loadURL(devServerUrl);
  } else {
    await window.loadURL(`${KOED_APP_SCHEME}://app/`);
  }
};

const bootstrap = async () => {
  await app.whenReady();
  const pdsResolver = createPdsDesktopSecretResolver({
    userDataPath: app.getPath("userData"),
    platform: process.platform
  });
  if (pdsResolver) installPdsDesktopSecretResolver(pdsResolver);
  const desktopIcon = getDesktopIcon();
  if (desktopIcon && process.platform === "darwin") {
    app.dock?.setIcon(desktopIcon);
  }
  registerAppProtocol();
  registerDesktopCommandHandlers(ipcMain, koedServer.handlers);
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
