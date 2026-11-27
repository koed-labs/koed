import {
  desktopAccountEnvironment,
  packagedAccountConfig
} from "./account/config.js";
import { createAccountController } from "./account/controller.js";
import { createAccountRuntime } from "./account/runtime.js";
import { registerAccountIpc } from "./ipc/account.js";
import {
  readPresentationPreferences,
  writePresentationPreferences
} from "./window/presentation-preferences.js";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  MenuItem,
  type MessageBoxOptions,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  shell,
  Tray
} from "electron";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  registerDesktopCommandHandlers,
  scopeDesktopWindowIpc
} from "./ipc/commands.js";
import { registerFloatingKinIpc } from "./ipc/floating-kin.js";
import {
  floatingKinChannels,
  type KinPresentation
} from "./ipc/floating-kin-protocol.js";
import { resolveKinPlacement } from "./window/floating-kin-placement.js";
import { registerDesktopUpdateIpc } from "./ipc/update.js";
import {
  createUpdateDiscovery,
  officialInstallerDownload,
  supportsDesktopUpdates
} from "./main/update-discovery.js";
import { attachPackagedSmokeHarness } from "./packaged-smoke-harness.js";
import type { DesktopCommandName } from "./ipc/protocol.js";
import {
  desktopStatusChangedChannel,
  desktopRendererOrigin,
  personalDevicePairingLinkChannel,
  personalMemoryEventChannel
} from "./ipc/protocol.js";
import {
  createKoedEnvironment,
  createKoedServerManager,
  shouldRefreshLocalAiClientsAfterResume,
  type KoedServerManager
} from "./koed-server/manager.js";
import {
  createKoedServerCliInvocation,
  createNodeEntrypointInvocation,
  resolveKoedServerPaths
} from "./koed-server/runtime.js";
import {
  KOED_APP_SCHEME,
  resolveAppProtocolRequest
} from "./window/app-protocol.js";
import { createManagedConversationDraftStore } from "./managed-conversation-draft-store.js";
import { createV1State, v1OwnerScope } from "./v1-state.js";
import { createPdsDesktopSecretStore } from "./pds-secure-provider.js";
import { PDS_DESKTOP_AUTHORITY_SECRET_REFERENCE } from "./pds-authority.js";
import { resolveKoedHome as resolveApplicationKoedHome } from "@koed-labs/server";
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
import { createFloatingKinWindow } from "./window/floating-kin-window.js";
import {
  createFloatingKinLaunchState,
  createFloatingKinRuntime
} from "./koed-server/floating-kin.js";
import { createManagedPreviewController } from "./window/managed-preview-controller.js";
import { createDesktopCliInstallManager } from "./cli-install/manager.js";
import {
  createBackgroundAgentLaunchService,
  isBackgroundAgentLaunch,
  BACKGROUND_AGENT_SERVICE_NAME
} from "./background-agent/launch-service.js";
import { createBackgroundAgentControl } from "./background-agent/control-client.js";
import { createInstalledAgentCommand } from "./background-agent/installed-client.js";
import { startBackgroundAgent } from "./background-agent/runtime.js";
import { agentSettingsChoices } from "./background-agent/settings.js";
import {
  loadCliInstallSettingsForDesktop,
  writeCliInstallSettings
} from "./cli-install/settings.js";
import {
  registerCliInstallIpc,
  sendCliInstallProgress
} from "./cli-install/ipc.js";
import { startDesktopWindowAndRuntime } from "./window/startup.js";
import {
  createLaunchAtStartupController,
  isBackgroundLaunch
} from "./window/launch-at-startup.js";
import {
  consumeDesktopActivation,
  createDesktopWindowActivator,
  shouldQuitAfterAllWindowsClosed
} from "./window/lifecycle.js";
import { pairingLinkFromDeepLink } from "./personal-device-pairing-link.js";
import { createPersonalDevicePairingInbox } from "./personal-device-pairing-inbox.js";
import {
  createDesktopMenuBar,
  menuBarIconFilename,
  type DesktopMenuBar
} from "./tray/menu-bar.js";

const appDir = dirname(fileURLToPath(import.meta.url));
const {
  repoRoot,
  cliPath: genericKoedServerCli,
  desktopCliPath
} = resolveKoedServerPaths({
  appDir,
  appIsPackaged: app.isPackaged,
  environment: process.env,
  resourcesPath: process.resourcesPath
});
// Packaged Desktop and its launcher share one verified CLI entrypoint so every
// command manages Desktop's own instance with Desktop's runtime authority.
const koedServerCli = desktopCliPath ?? genericKoedServerCli;
const appName = "Koed";
const isAgent = isBackgroundAgentLaunch(process.argv);
const koedEnvironment = createKoedEnvironment(repoRoot, process.env, {
  desktopManagedLocal: true,
  packagedDesktop: app.isPackaged
});
const desktopIconPath = resolve(appDir, "../assets/koed-icon.png");
const devServerUrl = resolveDevServerUrl({
  appIsPackaged: app.isPackaged,
  devServerUrl: process.env.VITE_DEV_SERVER_URL
});
const allowedRendererOrigins = new Set([
  `${KOED_APP_SCHEME}://app`,
  ...(devServerUrl ? [desktopRendererOrigin(devServerUrl)] : [])
]);

app.setName(appName);
const presentationPreferencePath = resolve(
  app.getPath("userData"),
  "presentation-preferences.json"
);
let presentationPreferences = readPresentationPreferences(
  presentationPreferencePath
);
// Electron window rendering only; never change embedding/privacy runtime policy.
if (!presentationPreferences.graphicsAcceleration)
  app.disableHardwareAcceleration();

let themePreference: DesktopThemePreference = "system";
let koedServer: KoedServerManager | null = null;
let mainWindow: BrowserWindow | null = null;
let floatingKin: ReturnType<typeof createFloatingKinWindow> | null = null;
let clearKinRenderer = () => {};
let quitting = false;
let desktopMenuBar: DesktopMenuBar | null = null;
let disposeDesktopUpdateIpc: (() => void) | null = null;
let disposeDesktopUpdateDiscovery: (() => void) | null = null;
let backgroundLaunchPending = false;
let accountController: ReturnType<typeof createAccountController> | null = null;
const accountCallbackInbox: string[] = [];
const acceptAccountCallback = (url: string) => {
  if (
    !url.startsWith("ai.koed.desktop.auth://") &&
    !url.startsWith("ai.koed.desktop.auth.dev://")
  )
    return false;
  if (accountController) void accountController.callback(url);
  else if (accountCallbackInbox.length < 4) accountCallbackInbox.push(url);
  return true;
};
const pairingLinkInbox = createPersonalDevicePairingInbox();
const managedPreviewController = createManagedPreviewController();

const acceptPairingDeepLink = (value: string): string | null => {
  const pairingLink = pairingLinkFromDeepLink(value);
  if (!pairingLink) return null;
  pairingLinkInbox.accept(pairingLink);
  return pairingLink;
};

if (!isAgent && process.defaultApp && process.argv[1]) {
  app.setAsDefaultProtocolClient("koed-pair", process.execPath, [
    resolve(process.argv[1])
  ]);
} else if (!isAgent) {
  app.setAsDefaultProtocolClient("koed-pair");
}

let ownsDesktopInstance = !isAgent;
if (!isAgent && process.env.KOED_ALLOW_MULTIPLE_INSTANCES !== "1") {
  const hasLock = app.requestSingleInstanceLock();
  if (!hasLock) {
    ownsDesktopInstance = false;
    app.quit();
  } else {
    app.on("second-instance", (_event, argv) => {
      const authLink = argv.find((argument) =>
        argument.startsWith("ai.koed.desktop.auth")
      );
      if (authLink && acceptAccountCallback(authLink)) {
        void showDesktopWindow();
        return;
      }
      const deepLink = argv.find((argument) =>
        argument.startsWith("koed-pair://")
      );
      if (deepLink) void showPairingDeepLink(deepLink);
      else void showDesktopWindow();
    });
  }
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (!acceptAccountCallback(url)) void showPairingDeepLink(url);
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

const notifyDesktopStatusChanged = () => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && window !== floatingKin?.getWindow()) {
      window.webContents.send(desktopStatusChangedChannel);
    }
  }
};

const createServerManager = (
  managedConversationDraftStore?: ReturnType<
    typeof createPdsDesktopSecretStore
  > | null,
  personalDevicePairingStore?: ReturnType<
    typeof createPdsDesktopSecretStore
  > | null
): KoedServerManager =>
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
    persistentControlStatus: true,
    createControlCliInvocation:
      app.isPackaged && process.platform === "darwin"
        ? (args) => ({
            command: process.execPath,
            args: [
              resolve(
                process.resourcesPath,
                "app.asar/node_modules/@koed-labs/server/dist/desktop-cli-entrypoint.js"
              ),
              ...args
            ],
            env: { ...koedEnvironment, ELECTRON_RUN_AS_NODE: "1" }
          })
        : undefined,
    createSupervisorInvocation: app.isPackaged
      ? () =>
          createNodeEntrypointInvocation(
            resolve(dirname(koedServerCli), "desktop-supervisor-entrypoint.js"),
            [],
            {
              appIsPackaged: true,
              electronExecPath: process.execPath,
              platform: process.platform,
              resourcesPath: process.resourcesPath,
              environment: koedEnvironment,
              existsSync
            }
          )
      : undefined,
    packagedResourcesPath: app.isPackaged ? process.resourcesPath : undefined,
    productVersion: app.getVersion(),
    existsSync,
    execFile,
    spawn,
    onPersonalMemoryStartupReady: notifyDesktopStatusChanged,
    openExternal,
    openPath: (path) => shell.openPath(path),
    revealPath: (path) => shell.showItemInFolder(path),
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
    },
    ...(managedConversationDraftStore ? { managedConversationDraftStore } : {}),
    ...(personalDevicePairingStore ? { personalDevicePairingStore } : {}),
    confirmSourceControlMutation: async ({ operation }) => {
      const options: MessageBoxOptions = {
        type: "warning",
        title: "Confirm source-control action",
        message: "Allow this source-control change?",
        detail: `Koed will run the exact ${operation.replaceAll("_", " ")} action against the selected repository revision.`,
        buttons: ["Cancel", "Allow"],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      };
      const result = mainWindow
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
      return result.response === 1;
    }
  });

const getAppDistDir = (): string =>
  app.isPackaged
    ? resolve(process.resourcesPath, "app-dist")
    : resolve(repoRoot, "apps/desktop/dist");

const getMenuBarIcon = () => {
  const file = menuBarIconFilename(
    process.platform,
    nativeTheme.shouldUseDarkColors
  );
  if (!file) return null;
  const icon = nativeImage.createFromPath(resolve(appDir, "../assets", file));
  if (icon.isEmpty()) return null;
  if (process.platform !== "darwin")
    return icon.resize({ width: 24, height: 24 });
  icon.setTemplateImage(true);
  return icon;
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
  if (quitting) return;
  const server = koedServer;
  if (!server) throw new Error("Koed server manager is unavailable.");
  const window = new BrowserWindow(
    createMainWindowOptions(
      appDir,
      desktopIconPath,
      desktopThemeChromeColor(nativeTheme.shouldUseDarkColors)
    )
  );
  mainWindow = window;
  window.webContents.on("did-navigate", () => {
    if (window === mainWindow) clearKinRenderer();
  });
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
  window.webContents.on("render-process-gone", () => {
    if (window === mainWindow) clearKinRenderer();
  });
  const personalMemoryController = new AbortController();
  window.once("closed", () => {
    personalMemoryController.abort();
    if (mainWindow === window) {
      mainWindow = null;
      clearKinRenderer();
    }
  });
  await window.loadURL(devServerUrl ?? `${KOED_APP_SCHEME}://app/`);
  if (window.isDestroyed()) return;
  void server
    .subscribePersonalMemory((change) => {
      if (!window.isDestroyed()) {
        window.webContents.send(personalMemoryEventChannel, change);
      }
    }, personalMemoryController.signal)
    .catch(() => undefined);
};

const showDesktopWindow = createDesktopWindowActivator({
  beforeOpen: async () => {
    if (quitting) return;
    backgroundLaunchPending = false;
    if (process.platform === "darwin") await app.dock?.show();
  },
  createWindow,
  getWindow: () => (quitting ? null : mainWindow),
  waitForBootstrap: async () => {
    await bootstrapPromise;
  }
});

async function showPairingDeepLink(value: string): Promise<void> {
  const pairingLink = acceptPairingDeepLink(value);
  if (!pairingLink) return;
  await showDesktopWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(personalDevicePairingLinkChannel, pairingLink);
  }
}

const addFloatingKinMenuItem = (focus: () => void): MenuItem => {
  const item = new MenuItem({ label: "Focus Floating Kin", click: focus });
  const menu =
    Menu.getApplicationMenu() ??
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" }
    ]);
  const windowMenu = menu.items.find(
    (entry) => entry.role?.toLowerCase() === "windowmenu"
  );
  if (windowMenu?.submenu) {
    windowMenu.submenu.append(new MenuItem({ type: "separator" }));
    windowMenu.submenu.append(item);
  } else {
    const submenu = new Menu();
    submenu.append(item);
    menu.append(new MenuItem({ label: "Floating Kin", submenu }));
  }
  Menu.setApplicationMenu(menu);
  return item;
};

const configureFloatingKin = (
  server: KoedServerManager,
  account: ReturnType<typeof createAccountController>,
  launchPending: () => boolean
) => {
  const canFloat = process.platform === "darwin";
  const desktopUrl = new URL(devServerUrl ?? `${KOED_APP_SCHEME}://app/`).href;
  const target = new URL(desktopUrl);
  target.hash = "floating-kin";
  const url = target.href;
  let floatingEnabled = false;
  // A foreground launch has not handed off from the main window yet.
  let desktopAnchorAvailable = backgroundLaunchPending;
  let desktopReady = false;
  let aiModelsRequested = false;
  let conversationRequested: string | null = null;
  let dockWait: ReturnType<typeof setTimeout> | undefined;
  const clearDockWait = () => {
    clearTimeout(dockWait);
    dockWait = undefined;
  };
  let presentation: KinPresentation = { placement: "sidebar", revision: 0 };
  const overlay = createFloatingKinWindow({
    appDir,
    url,
    onDismiss: () => cancel(),
    onHidden: () => {
      if (!presentation.sidebarPending) return;
      presentation = { ...presentation, sidebarPending: false };
      publish();
    }
  });
  const menuItem = canFloat ? addFloatingKinMenuItem(overlay.focus) : null;
  const getWebContents = () => overlay.getWindow()?.webContents ?? null;
  const getDesktopContents = () =>
    mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  const showRequestedAiModels = () => {
    const contents = getDesktopContents();
    if (
      !aiModelsRequested ||
      !desktopReady ||
      !contents ||
      contents.isDestroyed() ||
      contents.getURL() !== desktopUrl
    )
      return;
    aiModelsRequested = false;
    contents.send(floatingKinChannels.showAiModels);
  };
  const showRequestedConversation = () => {
    const contents = getDesktopContents();
    if (
      !conversationRequested ||
      !desktopReady ||
      !contents ||
      contents.isDestroyed() ||
      contents.getURL() !== desktopUrl
    )
      return;
    const sessionId = conversationRequested;
    conversationRequested = null;
    contents.send(floatingKinChannels.showConversation, sessionId);
  };
  const revealDesktop = (
    request: { aiModels?: boolean; sessionId?: string } = {}
  ) => {
    if (!overlay.isShowing() || quitting) return;
    if (request.aiModels) aiModelsRequested = true;
    if (request.sessionId) conversationRequested = request.sessionId;
    void showDesktopWindow()
      .then(() => {
        showRequestedAiModels();
        showRequestedConversation();
      })
      .catch(() => {
        if (request.aiModels) aiModelsRequested = false;
        if (request.sessionId) conversationRequested = null;
        console.warn("Could not open Koed Desktop from Floating Kin.");
      });
  };
  const publish = () => {
    const contents = getDesktopContents();
    if (contents && !contents.isDestroyed() && contents.getURL() === desktopUrl)
      contents.send(floatingKinChannels.presentationChanged, presentation);
    const panel = getWebContents();
    if (panel && !panel.isDestroyed() && panel.getURL() === url)
      panel.send(floatingKinChannels.presentationChanged, presentation);
  };
  const reconcile = (mainFocused = mainWindow?.isFocused() ?? false) => {
    const placement = resolveKinPlacement({
      floatingEnabled: floatingEnabled && desktopAnchorAvailable,
      mainFocused
    });
    if (placement !== presentation.placement) {
      cancel("all");
      // Commit removal in Desktop before showing the native panel. On return,
      // reveal the sidebar Kin only after the native panel is actually hidden.
      clearDockWait();
      if (placement === "desktop" && desktopReady) {
        // A hung renderer may never acknowledge removing its dock.
        dockWait = setTimeout(() => {
          clearDockWait();
          reconcile();
        }, 750);
      }
      presentation = {
        placement,
        sidebarPending: placement === "sidebar" && overlay.isShowing(),
        revision: presentation.revision + 1
      };
      publish();
    }
    const showOverlay =
      placement === "desktop" && (!dockWait || overlay.isShowing());
    overlay.setVisible(showOverlay, presentation.revision);
    if (menuItem) menuItem.enabled = showOverlay;
  };
  clearKinRenderer = () => {
    desktopReady = false;
    clearDockWait();
    if (!mainWindow) desktopAnchorAvailable = true;
    cancel("desktop");
    reconcile();
  };
  const initialAccount = account.current();
  let accountKey = `${initialAccount.status}:${initialAccount.profile?.id ?? ""}`;
  const cancel = registerFloatingKinIpc({
    ipcMain,
    getWebContents,
    url,
    mainWindowFocused: () => mainWindow?.isFocused() ?? false,
    overlayVisible: overlay.isShowing,
    presentation: () => presentation,
    completeExit: overlay.completeExit,
    openDesktop: () => revealDesktop(),
    openAiModels: () => revealDesktop({ aiModels: true }),
    openConversation: (sessionId) => revealDesktop({ sessionId }),
    desktop: {
      getWebContents: getDesktopContents,
      url: desktopUrl,
      isShellVisible: () =>
        desktopReady &&
        Boolean(mainWindow?.isVisible() && !mainWindow.isMinimized()),
      setShellVisible: (visible) => {
        desktopReady = visible;
        if (visible) {
          showRequestedAiModels();
          showRequestedConversation();
        }
        if (!visible && dockWait) {
          clearDockWait();
          reconcile();
        }
      },
      confirmPresentation: () => {
        if (!dockWait || presentation.placement !== "desktop") return;
        clearDockWait();
        reconcile();
      }
    },
    runtime: createFloatingKinRuntime({
      koedHome: resolveApplicationKoedHome(koedEnvironment),
      // Cached observation only. Refresh notifies subscribers that may reconcile.
      lifecycle: () => server.lifecycle.current()?.state ?? "starting",
      launchPending,
      accountKey: () => accountKey
    }),
    interactive: overlay.setInteractive,
    resize: overlay.setSize,
    drag: overlay.drag
  });
  // Drop rendered evidence when the runtime or User changes.
  const invalidate = () => {
    cancel("all");
    overlay.reset();
    presentation = { ...presentation, revision: presentation.revision + 1 };
    publish();
  };
  const unsubscribeLifecycle = server.lifecycle.subscribe(invalidate);
  const unsubscribeAccount = account.subscribe((state) => {
    const next = `${state.status}:${state.profile?.id ?? ""}`;
    if (next === accountKey) return;
    accountKey = next;
    invalidate();
  });
  const publishFocus = (focused: boolean, window: BrowserWindow) => {
    if (window !== mainWindow) return;
    desktopAnchorAvailable = true;
    reconcile(focused);
    const contents = getWebContents();
    if (contents && !contents.isDestroyed() && contents.getURL() === url)
      contents.send(floatingKinChannels.mainWindowFocusChanged, focused);
  };
  const onMainFocus = (_event: unknown, window: BrowserWindow) =>
    publishFocus(true, window);
  const onMainBlur = (_event: unknown, window: BrowserWindow) =>
    publishFocus(false, window);
  app.on("browser-window-focus", onMainFocus);
  app.on("browser-window-blur", onMainBlur);
  app.once("will-quit", () => {
    app.off("browser-window-focus", onMainFocus);
    app.off("browser-window-blur", onMainBlur);
    clearDockWait();
    unsubscribeLifecycle();
    unsubscribeAccount();
  });
  floatingKin = overlay;
  reconcile();
  return (enabled: boolean) => {
    floatingEnabled = canFloat && enabled;
    if (!floatingEnabled) overlay.setEnabled(false);
    reconcile();
    if (floatingEnabled) overlay.setEnabled(true);
  };
};

const bootstrap = async () => {
  await app.whenReady();
  if (quitting) return;
  const config = packagedAccountConfig(
    resolve(app.getAppPath(), "account-config.json"),
    desktopAccountEnvironment({
      repoRoot,
      packaged: app.isPackaged,
      environment: process.env
    }),
    { packaged: app.isPackaged }
  );
  accountController = createAccountController({
    config,
    runtime: () => createAccountRuntime(config!, openExternal)
  });
  const disposeAccount = registerAccountIpc({
    ipcMain,
    getMainWindow: () => mainWindow,
    allowedRendererOrigins,
    controller: accountController
  });
  app.once("will-quit", disposeAccount);
  if (config) {
    const scheme = new URL(config.callbackUri).protocol.slice(0, -1);
    if (process.defaultApp && process.argv[1])
      app.setAsDefaultProtocolClient(scheme, process.execPath, [
        resolve(process.argv[1])
      ]);
    else app.setAsDefaultProtocolClient(scheme);
  }
  const controller = accountController;
  void controller.restore().then(() => {
    for (const url of [
      ...accountCallbackInbox,
      ...process.argv.filter((value) =>
        value.startsWith("ai.koed.desktop.auth")
      )
    ])
      void controller.callback(url);
    accountCallbackInbox.length = 0;
  });
  const updateDiscovery = createUpdateDiscovery({
    eligible:
      app.isPackaged &&
      supportsDesktopUpdates(process.platform, process.arch) &&
      !process.argv.includes("--koed-private-smoke"),
    installedVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch
  });
  disposeDesktopUpdateIpc = registerDesktopUpdateIpc({
    ipcMain,
    getMainWindow: () => mainWindow,
    allowedRendererOrigins,
    discovery: updateDiscovery,
    openRelease: async () => {
      const release = updateDiscovery.current().release;
      const download = release
        ? officialInstallerDownload(
            release.version,
            process.platform,
            process.arch
          )
        : null;
      if (download) await openExternal(download);
    }
  });
  const updateStartTimer = setTimeout(() => updateDiscovery.start(), 45_000);
  disposeDesktopUpdateDiscovery = () => {
    clearTimeout(updateStartTimer);
    updateDiscovery.dispose();
  };
  const launchAtStartup = createLaunchAtStartupController({
    appDataPath: app.getPath("appData"),
    appIsPackaged: app.isPackaged,
    execPath: process.execPath,
    getLoginItemSettings: (options) => app.getLoginItemSettings(options),
    platform: process.platform,
    setLoginItemSettings: (settings) => app.setLoginItemSettings(settings)
  });
  backgroundLaunchPending = isBackgroundLaunch({
    argv: process.argv,
    platform: process.platform,
    wasOpenedAtLogin: launchAtStartup.wasOpenedAtLogin()
  });
  if (backgroundLaunchPending && process.platform === "darwin") {
    app.dock?.hide();
  }
  const themePreferenceFile = desktopThemePreferencePath(
    app.getPath("userData")
  );
  themePreference = readDesktopThemePreference(themePreferenceFile);
  nativeTheme.themeSource = themePreference;
  const managedConversationDraftStore = createManagedConversationDraftStore({
    userDataPath: app.getPath("userData")
  });
  const personalDevicePairingStore = createPdsDesktopSecretStore({
    userDataPath: resolveApplicationKoedHome(koedEnvironment)
  });
  koedEnvironment.PDS_DESKTOP_SECRET_STORAGE = "unavailable";
  koedServer = createServerManager(
    managedConversationDraftStore,
    personalDevicePairingStore
  );
  const server = koedServer;
  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock?.setIcon(desktopIconPath);
  }
  registerAppProtocol();
  const kinLaunch = createFloatingKinLaunchState();
  const setFloatingKinEnabled = configureFloatingKin(
    server,
    controller,
    kinLaunch.pending
  );
  const desktopWindowIpc = scopeDesktopWindowIpc(ipcMain, () =>
    mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null
  );
  const privacyInstallBridge = server.privacyInstall;
  const selectPrivacyOfflineSource = async () => {
    const files: string[] = [];
    for (const [label, extensions] of [
      ["Privacy archive", ["tar.gz"]],
      ["Component manifest", ["json"]]
    ] as const) {
      const selected = mainWindow
        ? await dialog.showOpenDialog(mainWindow, {
            title: `Choose ${label}`,
            properties: ["openFile"],
            filters: [{ name: label, extensions: [...extensions] }]
          })
        : await dialog.showOpenDialog({
            title: `Choose ${label}`,
            properties: ["openFile"],
            filters: [{ name: label, extensions: [...extensions] }]
          });
      if (selected.canceled || !selected.filePaths[0]) return null;
      files.push(selected.filePaths[0]);
    }
    return { archivePath: files[0]!, manifestPath: files[1]! };
  };
  const cliInstallSettingsFile = resolve(
    app.getPath("userData"),
    "cli-install.json"
  );
  const cliInstallManager = createDesktopCliInstallManager({
    ...loadCliInstallSettingsForDesktop(cliInstallSettingsFile, (error) =>
      console.error(error)
    ),
    saveSettings: (settings) =>
      writeCliInstallSettings(cliInstallSettingsFile, settings),
    ...(privacyInstallBridge
      ? {
          bridge: {
            ...privacyInstallBridge,
            selectOffline: selectPrivacyOfflineSource
          }
        }
      : {}),
    appPath: app.getAppPath(),
    helperPath: process.execPath,
    cliPath: koedServerCli,
    koedHome: resolveApplicationKoedHome(koedEnvironment),
    ...(desktopCliPath ? { legacyCliPath: genericKoedServerCli } : {}),
    expectedVersion: app.getVersion(),
    currentPath: process.env.PATH ?? "",
    platform: process.platform,
    probeHelper: async () =>
      new Promise<boolean>((resolveProbe) => {
        const probe =
          "process.stdout.write(JSON.stringify({electron:process.versions.electron??null,modules:process.versions.modules??null,node:process.versions.node??null}))";
        execFile(
          process.execPath,
          ["-e", probe],
          {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            timeout: 5_000,
            windowsHide: true,
            maxBuffer: 1024
          },
          (error, stdout) => {
            if (error) return resolveProbe(false);
            try {
              const identity = JSON.parse(stdout) as {
                electron?: unknown;
                modules?: unknown;
                node?: unknown;
              };
              resolveProbe(
                identity.electron === process.versions.electron &&
                  identity.modules === process.versions.modules &&
                  identity.node === process.versions.node
              );
            } catch {
              resolveProbe(false);
            }
          }
        );
      })
  });
  registerCliInstallIpc({
    ipcMain: desktopWindowIpc,
    allowedRendererOrigins,
    manager: cliInstallManager,
    selectLauncherDestination: async (defaultPath) => {
      const options = {
        title:
          "Choose Koed CLI launcher location (use the current location to recover)",
        defaultPath,
        buttonLabel: "Install launcher"
      };
      const selected = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options);
      return selected.canceled ? null : (selected.filePath ?? null);
    }
  });
  sendCliInstallProgress(cliInstallManager, (channel, value) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send(channel, value);
  });
  const v1State = createV1State({
    userDataPath: app.getPath("userData"),
    ownerIdentity: async () => {
      const identity = await server.v1StateIdentity();
      return {
        ownerId: identity.ownerUserId,
        scopeKey: v1OwnerScope(identity.apiOrigin, identity.ownerUserId)
      };
    }
  });
  registerDesktopCommandHandlers(desktopWindowIpc, server.handlers, {
    v1State: v1State.request,
    allowedRendererOrigins,
    localAiClients: server.localAiClients,
    personalMemory: server.personalMemory,
    managedConversation: server.managedConversation,
    managedProject: server.managedProject,
    managedPreview: managedPreviewController,
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
        if (window !== floatingKin?.getWindow())
          window.setBackgroundColor(backgroundColor);
      }
      return {
        preference,
        resolvedDark: nativeTheme.shouldUseDarkColors
      };
    },
    getPresentationPreferences: () => ({ ...presentationPreferences }),
    setPresentationPreferences: (value) => {
      const previous = presentationPreferences;
      const next = { ...previous, ...value };
      writePresentationPreferences(presentationPreferencePath, next);
      presentationPreferences = next;
      if (next.floatingKin !== previous.floatingKin)
        setFloatingKinEnabled(next.floatingKin);
      if (next.showMenuBar !== previous.showMenuBar) configureMenuBar();
      return { ...next };
    },
    acceleration: server.acceleration,
    performance: server.performance,
    getHardwareAcceleration: () => server.hardwareAcceleration.get(),
    setHardwareAcceleration: (enabled) =>
      server.hardwareAcceleration.set(enabled),
    getLaunchAtStartup: () => launchAtStartup.get(),
    setLaunchAtStartup: (enabled) => launchAtStartup.set(enabled),
    selectProjectDirectory: async () => {
      const options = {
        buttonLabel: "Open",
        properties: ["openDirectory", "createDirectory"] as Array<
          "openDirectory" | "createDirectory"
        >,
        title: "Open a Project"
      };
      const selected = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      if (selected.canceled || !selected.filePaths[0]) {
        return { canceled: true };
      }
      const result = await server.discoverProject(selected.filePaths[0]);
      return { canceled: false, result };
    }
  });
  const configureMenuBar = () => {
    desktopMenuBar?.dispose();
    desktopMenuBar = null;
    if (!presentationPreferences.showMenuBar) return;
    const menuBarIcon = getMenuBarIcon();
    if (menuBarIcon) {
      const tray = new Tray(menuBarIcon);
      const updateTrayIcon = () => {
        const icon = getMenuBarIcon();
        if (icon) tray.setImage(icon);
      };
      if (process.platform !== "darwin")
        nativeTheme.on("updated", updateTrayIcon);
      desktopMenuBar = createDesktopMenuBar<Menu>({
        tray: {
          destroy: () => {
            nativeTheme.off("updated", updateTrayIcon);
            tray.destroy();
          },
          onClick: (listener) => {
            tray.on("click", listener);
          },
          ...(process.platform === "darwin"
            ? {
                onRightClick: (listener: () => void) => {
                  tray.on("right-click", listener);
                },
                popUpContextMenu: (menu: Menu) => tray.popUpContextMenu(menu)
              }
            : { setContextMenu: (menu: Menu) => tray.setContextMenu(menu) }),
          setToolTip: (tooltip) => tray.setToolTip(tooltip)
        },
        buildMenu: (template) => Menu.buildFromTemplate(template),
        getStatus: () => server.handlers.status(),
        openDesktop: showDesktopWindow,
        startKoed: () => {
          void Promise.resolve(server.handlers.start()).catch(() => undefined);
        },
        ...(app.isPackaged && process.platform === "darwin"
          ? {
              configureBackgroundAgent: () => {
                void (async () => {
                  try {
                    const { registration, control } =
                      await createAgentServices();
                    const state = await registration.get();
                    if (!state.supported || state.status === "unsupported")
                      throw new Error(
                        "Background Agent is not available for this installation"
                      );
                    const buttons = agentSettingsChoices(state.status);
                    const choice = await dialog.showMessageBox({
                      type: "question",
                      message: "Background Agent settings",
                      detail:
                        "Koed must be stopped to enable or reconcile the Agent. Disabling stops Koed first.",
                      buttons,
                      defaultId: buttons.length - 1,
                      cancelId: buttons.length - 1
                    });
                    const action = buttons[choice.response];
                    if (action === "Disable") await control.disable();
                    else if (action === "Enable" || action === "Reconcile")
                      await control.enable();
                  } catch (error) {
                    await dialog.showMessageBox({
                      type: "error",
                      message: "Background Agent could not be changed",
                      detail:
                        error instanceof Error ? error.message : String(error)
                    });
                  }
                })();
              }
            }
          : {}),
        quit: () => app.quit()
      });
    }
  };
  configureMenuBar();
  // One cheap local observer drives both the window and the tray, so an
  // external stop or start is reflected without waiting for full polling.
  server.lifecycle.subscribe(() => {
    void desktopMenuBar?.refresh();
    notifyDesktopStatusChanged();
  });
  server.lifecycle.start();
  setFloatingKinEnabled(presentationPreferences.floatingKin);
  let runtimeResumed = false;
  await startDesktopWindowAndRuntime({
    background: backgroundLaunchPending,
    createWindow,
    resumeRuntime: async () => {
      const persistentPdsStore = createPdsDesktopSecretStore({
        userDataPath: resolveApplicationKoedHome(koedEnvironment),
        environment: koedEnvironment
      });
      if (persistentPdsStore) {
        koedEnvironment.PDS_DESKTOP_SECRET_STORAGE =
          persistentPdsStore.providerKind;
        const runtimeReference =
          koedEnvironment.PDS_RUNTIME_SECRET_REF?.trim() || "pds-runtime";
        koedEnvironment.PDS_AUTHORITY_SECRET_REF =
          PDS_DESKTOP_AUTHORITY_SECRET_REFERENCE;
        koedEnvironment.PDS_RUNTIME_SECRET_REF = runtimeReference;
      } else {
        koedEnvironment.PDS_DESKTOP_SECRET_STORAGE = "unavailable";
        delete koedEnvironment.PDS_AUTHORITY_SECRET_REF;
        console.warn(
          "PDS local device storage provider is unavailable; Local Memory remains available."
        );
      }
      const result = await server.resume();
      runtimeResumed = shouldRefreshLocalAiClientsAfterResume(result);
      if (runtimeResumed) {
        void server
          .localAiClients({ operation: "refresh" })
          .catch(() => undefined);
      }
      void desktopMenuBar?.refresh();
      return result;
    },
    onRuntimeSettled: () => {
      kinLaunch.settle(runtimeResumed);
      attachPackagedSmokeHarness({
        packaged: app.isPackaged,
        argv: process.argv,
        channel: process,
        send: (message) => process.send?.(message),
        getUpdateNoticeState: () => updateDiscovery.current(),
        invoke: async (command) => {
          if (command === "acceleration_status")
            return server.acceleration.inspect(true);
          if (command === "acceleration_cancel") {
            const current = await server.acceleration.inspect();
            if (!current.operation)
              throw new Error("No processing operation to cancel.");
            return server.acceleration.cancel(current.operation.id);
          }
          if (
            command === "acceleration_cpu" ||
            command === "acceleration_auto" ||
            command === "acceleration_cuda"
          ) {
            const current = await server.acceleration.inspect(true);
            if (!current.snapshot)
              throw new Error("Acceleration inspection unavailable.");
            return server.acceleration.apply({
              preference: command === "acceleration_cpu" ? "cpu" : "auto",
              installCuda: command === "acceleration_cuda",
              expectedRevision: current.snapshot.revision
            });
          }
          if (command === "privacy_status")
            return server.privacyInstall.getStatus();
          if (command === "privacy_install") {
            const archivePath = process.env.KOED_PRIVATE_SMOKE_PRIVACY_ARCHIVE;
            const manifestPath =
              process.env.KOED_PRIVATE_SMOKE_PRIVACY_MANIFEST;
            if (!archivePath || !manifestPath) {
              throw new Error(
                "Private smoke Privacy installation requires an offline archive and manifest."
              );
            }
            const offlineSource = { archivePath, manifestPath };
            if (!server.privacyInstall) {
              throw new Error("Desktop Privacy installation is unavailable.");
            }
            return server.privacyInstall.installPrivacy({
              consent: true,
              offlineSource,
              onProgress: () => undefined
            });
          }
          if (command === "quit") return server.shutdown();
          // The observation that drives the window and tray, without a refresh.
          if (command === "lifecycle") return server.lifecycle.current();
          return server.handlers[command as DesktopCommandName]();
        },
        stop: () => server.shutdown(),
        quit: () => app.quit()
      });
      notifyDesktopStatusChanged();
    }
  });
};

const createAgentServices = async () => {
  if (!app.isPackaged || process.platform !== "darwin")
    throw new Error("Background Agent requires packaged macOS Koed");
  const entrypoint = resolve(
    process.resourcesPath,
    "app.asar/node_modules/@koed-labs/server/dist/desktop-cli-entrypoint.js"
  );
  const run = (executable: string, args: string[], env: NodeJS.ProcessEnv) =>
    new Promise<string>((resolvePromise, rejectPromise) => {
      execFile(
        executable,
        args,
        { cwd: repoRoot, env, timeout: 120_000 },
        (error, stdout, stderr) => {
          if (stdout.trim()) resolvePromise(stdout);
          else
            rejectPromise(
              new Error(
                stderr.trim() ||
                  error?.message ||
                  "Agent control returned no output"
              )
            );
        }
      );
    });
  const eligibility: unknown = JSON.parse(
    await run(
      process.execPath,
      [entrypoint, "__control-plane-agent-eligibility"],
      { ...koedEnvironment, ELECTRON_RUN_AS_NODE: "1" }
    )
  );
  if (
    !eligibility ||
    typeof eligibility !== "object" ||
    !("teamId" in eligibility) ||
    typeof eligibility.teamId !== "string"
  )
    throw new Error("Background Agent eligibility could not be verified");
  const registration = createBackgroundAgentLaunchService({
    appIsPackaged: app.isPackaged,
    platform: process.platform,
    nativeBridgeAvailable: true,
    teamId: eligibility.teamId,
    agentPlistPresent: existsSync(
      resolve(
        process.resourcesPath,
        "..",
        "Library",
        "LaunchAgents",
        BACKGROUND_AGENT_SERVICE_NAME
      )
    ),
    getLoginItemSettings: (options) => app.getLoginItemSettings(options),
    setLoginItemSettings: (settings) => app.setLoginItemSettings(settings)
  });
  const command = createInstalledAgentCommand({
    executable: process.execPath,
    entrypoint,
    environment: koedEnvironment,
    run
  });
  const control = createBackgroundAgentControl({
    registration,
    ensureStopped: async () => {
      const status = await command("agent-status");
      if (!status.ok || status.snapshot?.state !== "stopped")
        throw new Error("Stop Koed before enabling the Background Agent");
    },
    command
  });
  return { registration, command, control };
};

const bootstrapBackgroundAgent = async (): Promise<void> => {
  await app.whenReady();
  app.dock?.hide();
  const { control, command } = await createAgentServices();
  const reportError = (error: Error): void => {
    console.error("Background Agent:", error.message);
    void dialog.showMessageBox({
      type: "error",
      message: "Background Agent needs attention",
      detail: error.message
    });
  };
  const agent = startBackgroundAgent({
    control,
    command,
    onError: reportError,
    quit: () => app.quit()
  });
  const icon = getMenuBarIcon();
  if (!icon) throw new Error("Background Agent menu icon is unavailable");
  const tray = new Tray(icon);
  desktopMenuBar = createDesktopMenuBar<Menu>({
    tray: {
      destroy: () => tray.destroy(),
      onClick: (listener) => tray.on("click", listener),
      onRightClick: (listener) => tray.on("right-click", listener),
      popUpContextMenu: (menu) => tray.popUpContextMenu(menu),
      setToolTip: (tooltip) => tray.setToolTip(tooltip)
    },
    buildMenu: (template) => Menu.buildFromTemplate(template),
    getStatus: async () => {
      const status = await command("agent-status");
      if (!status.ok || !status.snapshot)
        throw new Error(status.error ?? "Agent status unavailable");
      return { lifecycle: { state: status.snapshot.state } };
    },
    openDesktop: async () => {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        execFile(
          "/usr/bin/open",
          ["-n", resolve(process.resourcesPath, "..", "..")],
          (error) => (error ? rejectPromise(error) : resolvePromise())
        );
      });
    },
    startKoed: () => {
      void agent.then((value) => value.start());
    },
    stopKoed: () => {
      void agent.then((value) => value.stop());
    },
    quit: () => {
      void agent.then((value) => value.quit());
    }
  });
};

if (ownsDesktopInstance) {
  for (const argument of process.argv) {
    if (argument.startsWith("koed-pair://")) {
      acceptPairingDeepLink(argument);
      break;
    }
  }
}
const bootstrapPromise = isAgent
  ? bootstrapBackgroundAgent().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Background Agent failed to start:", message);
      dialog.showErrorBox("Background Agent failed to start", message);
      app.exit(1);
    })
  : ownsDesktopInstance
    ? bootstrap()
    : Promise.resolve();

app.on("window-all-closed", () => {
  if (shouldQuitAfterAllWindowsClosed(process.platform)) {
    app.quit();
  }
});
app.on("activate", () => {
  if (isAgent || quitting) return;
  const activation = consumeDesktopActivation(backgroundLaunchPending);
  backgroundLaunchPending = activation.backgroundLaunchPending;
  if (!activation.openWindow) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    void showDesktopWindow();
  }
});
let koedServerStoppedForQuit = false;
app.on("before-quit", (event) => {
  if (isAgent || koedServerStoppedForQuit) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  floatingKin?.dispose();
  disposeDesktopUpdateDiscovery?.();
  disposeDesktopUpdateDiscovery = null;
  disposeDesktopUpdateIpc?.();
  disposeDesktopUpdateIpc = null;
  void (async () => {
    try {
      await managedPreviewController.close();
    } catch (error) {
      console.warn("Desktop preview shutdown failed.", error);
    }
    try {
      await koedServer?.shutdown();
    } catch (error) {
      console.warn("Desktop runtime shutdown failed.", error);
    } finally {
      try {
        desktopMenuBar?.dispose();
      } catch (error) {
        console.warn("Desktop menu bar shutdown failed.", error);
      } finally {
        desktopMenuBar = null;
        koedServerStoppedForQuit = true;
        app.quit();
      }
    }
  })();
});
