import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
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
  personalDevicePairingLinkChannel,
  personalMemoryEventChannel
} from "./ipc/protocol.js";
import {
  createKoedEnvironment,
  createKoedServerManager,
  type KoedServerManager
} from "./koed-server/manager.js";
import {
  createKoedServerCliInvocation,
  resolveKoedServerPaths
} from "./koed-server/runtime.js";
import {
  KOED_APP_SCHEME,
  resolveAppProtocolRequest
} from "./window/app-protocol.js";
import {
  createCachedPdsDesktopSecretStore,
  createPdsDesktopSecretStore
} from "./pds-secure-provider.js";
import {
  ensurePdsDesktopAuthority,
  PDS_DESKTOP_AUTHORITY_SECRET_REFERENCE
} from "./pds-authority.js";
import {
  startPdsSecretBridge,
  type PdsSecretBridge
} from "./pds-secret-bridge.js";
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
import { startDesktopWindowAndRuntime } from "./window/startup.js";
import { pairingLinkFromDeepLink } from "./personal-device-pairing-link.js";
import { createPersonalDevicePairingInbox } from "./personal-device-pairing-inbox.js";

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
let pdsSecretBridge: PdsSecretBridge | null = null;
let koedServer: KoedServerManager | null = null;
let mainWindow: BrowserWindow | null = null;
const pairingLinkInbox = createPersonalDevicePairingInbox();

const acceptPairingDeepLink = (value: string): void => {
  const pairingLink = pairingLinkFromDeepLink(value);
  if (!pairingLink) return;
  pairingLinkInbox.accept(pairingLink);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send(personalDevicePairingLinkChannel, pairingLink);
  }
};

if (process.defaultApp && process.argv[1]) {
  app.setAsDefaultProtocolClient("koed-pair", process.execPath, [
    resolve(process.argv[1])
  ]);
} else {
  app.setAsDefaultProtocolClient("koed-pair");
}

let ownsDesktopInstance = true;
if (process.env.KOED_ALLOW_MULTIPLE_INSTANCES !== "1") {
  const hasLock = app.requestSingleInstanceLock();
  if (!hasLock) {
    ownsDesktopInstance = false;
    app.quit();
  } else {
    app.on("second-instance", (_event, argv) => {
      const deepLink = argv.find((argument) =>
        argument.startsWith("koed-pair://")
      );
      if (deepLink) acceptPairingDeepLink(deepLink);
      else {
        mainWindow?.show();
        mainWindow?.focus();
      }
    });
  }
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  acceptPairingDeepLink(url);
});

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

const createServerManager = (): KoedServerManager =>
  createKoedServerManager({
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
    openPath: (path) => shell.openPath(path),
    selectRecoveryKitPath: async () => {
      const selected = await dialog.showSaveDialog({
        title: "Save Koed recovery kit",
        defaultPath: resolve(
          app.getPath("documents"),
          "koed-personal-recovery-kit.json"
        ),
        buttonLabel: "Save recovery kit",
        filters: [{ name: "Koed recovery kit", extensions: ["json"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"]
      });
      return selected.canceled ? null : (selected.filePath ?? null);
    }
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
  const server = koedServer;
  if (!server) throw new Error("Koed server manager is unavailable.");
  const window = new BrowserWindow(
    createMainWindowOptions(
      appDir,
      existsSync(desktopIconPath) ? desktopIconPath : undefined,
      desktopThemeChromeColor(nativeTheme.shouldUseDarkColors)
    )
  );
  mainWindow = window;
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
  window.once("closed", () => {
    personalMemoryController.abort();
    if (mainWindow === window) mainWindow = null;
  });
  void server
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
  const pdsInput = { userDataPath: app.getPath("userData") };
  const persistentPdsStore = createPdsDesktopSecretStore(pdsInput);
  koedEnvironment.PDS_DESKTOP_SECRET_STORAGE =
    persistentPdsStore?.providerKind ?? "unavailable";
  if (persistentPdsStore) {
    await ensurePdsDesktopAuthority(persistentPdsStore);
    const runtimeReference =
      koedEnvironment.PDS_RUNTIME_SECRET_REF?.trim() || "pds-runtime";
    const pdsStore = await createCachedPdsDesktopSecretStore(
      persistentPdsStore,
      [PDS_DESKTOP_AUTHORITY_SECRET_REFERENCE, runtimeReference]
    );
    pdsSecretBridge = await startPdsSecretBridge({
      koedHome: koedEnvironment.KOED_HOME ?? app.getPath("userData"),
      providerProgram: process.execPath,
      providerArgs: [resolve(appDir, "pds-secret-bridge-provider.js")],
      store: pdsStore
    });
    Object.assign(koedEnvironment, pdsSecretBridge.environment);
    koedEnvironment.PDS_AUTHORITY_SECRET_REF =
      PDS_DESKTOP_AUTHORITY_SECRET_REFERENCE;
    koedEnvironment.PDS_RUNTIME_SECRET_REF = runtimeReference;
  }
  koedServer = createServerManager();
  const server = koedServer;
  const desktopIcon = getDesktopIcon();
  if (desktopIcon && process.platform === "darwin") {
    app.dock?.setIcon(desktopIcon);
  }
  registerAppProtocol();
  registerDesktopCommandHandlers(ipcMain, server.handlers, {
    allowedRendererOrigins,
    personalMemory: server.personalMemory,
    managedConversation: server.managedConversation,
    consumePendingPersonalDevicePairingLink: (expectedLink) =>
      pairingLinkInbox.consume(expectedLink),
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
  await startDesktopWindowAndRuntime({
    createWindow,
    resumeRuntime: () => server.resume()
  });
};

if (ownsDesktopInstance) {
  for (const argument of process.argv) {
    if (argument.startsWith("koed-pair://")) {
      acceptPairingDeepLink(argument);
      break;
    }
  }
  void bootstrap();
}

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
    await koedServer?.stop();
    await pdsSecretBridge?.close();
    pdsSecretBridge = null;
    koedServerStoppedForQuit = true;
    app.quit();
  })();
});
