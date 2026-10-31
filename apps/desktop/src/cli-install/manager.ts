import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  installLauncher,
  inspectLauncher,
  removeLauncher,
  type HelperProbe,
  type LauncherInput,
  type LauncherStatus
} from "./launcher.js";
import { hasManagedPathBlock, updateManagedPathBlock } from "./shell-path.js";
import {
  validateCliInstallSettings,
  type CliInstallSettings
} from "./settings.js";
import type {
  CliInstallManager,
  PrivacyInstallBridge,
  PrivacyInstallProgress,
  PrivacyInstallStatus,
  PrivacyOfflineSource
} from "./protocol.js";

export interface DesktopCliInstallManager extends CliInstallManager {
  launcher(
    operation: "inspect" | "install" | "remove",
    options?: { consent?: boolean; destination?: string }
  ): Promise<LauncherStatus>;
  updatePath(operation: "add" | "remove", consent: boolean): Promise<void>;
  setProgressListener(
    listener: (progress: PrivacyInstallProgress) => void
  ): void;
}

// Shell startup files that must carry the managed PATH block. Bash reads
// ~/.bashrc only for interactive non-login shells, while login shells (the
// macOS Terminal default) read the first of ~/.bash_profile, ~/.bash_login and
// ~/.profile that exists and may never source ~/.bashrc.
export const shellStartupFiles = (
  home: string,
  shell: string | undefined
): string[] => {
  if (shell?.endsWith("zsh")) return [join(home, ".zshrc")];
  const exists = (path: string) => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  };
  const login =
    [".bash_profile", ".bash_login", ".profile"]
      .map((name) => join(home, name))
      .find(exists) ?? join(home, ".bash_profile");
  return [join(home, ".bashrc"), login];
};

export const unavailablePrivacyStatus: PrivacyInstallStatus = {
  available: false,
  state: "unavailable",
  message:
    "Privacy Filter installer is unavailable. Update Koed Desktop and retry."
};

export const createDesktopCliInstallManager = (input: {
  bridge?: PrivacyInstallBridge;
  appPath: string;
  helperPath: string;
  cliPath: string;
  koedHome: string;
  legacyCliPath?: string;
  expectedVersion: string;
  currentPath: string;
  homePath?: string;
  platform: NodeJS.Platform;
  probeHelper: HelperProbe;
  settings?: CliInstallSettings;
  settingsError?: Error;
  saveSettings?: (settings: CliInstallSettings) => void;
}): DesktopCliInstallManager => {
  let progressListener: (progress: PrivacyInstallProgress) => void = () => {};
  let selectedOfflineSource: PrivacyOfflineSource | null = null;
  let offlineSelectionGeneration = 0;
  const defaultDestination = join(
    input.homePath ?? homedir(),
    ".local",
    "bin",
    "koed"
  );
  let settings = validateCliInstallSettings(input.settings);
  let activeDestination = settings.destination ?? defaultDestination;
  const persist = (next: CliInstallSettings): void => {
    input.saveSettings?.(next);
    settings = next;
  };
  const launcherInput = (destination = activeDestination): LauncherInput => ({
    appPath: input.appPath,
    helperPath: input.helperPath,
    cliPath: input.cliPath,
    koedHome: input.koedHome,
    ...(input.legacyCliPath ? { legacyCliPath: input.legacyCliPath } : {}),
    expectedVersion: input.expectedVersion,
    currentPath: input.currentPath,
    destination
  });
  const requireBridge = (): PrivacyInstallBridge => {
    if (!input.bridge) throw new Error(unavailablePrivacyStatus.message);
    return input.bridge;
  };
  return {
    setProgressListener: (listener) => {
      progressListener = listener;
    },
    getStatus: async () =>
      input.bridge ? input.bridge.getStatus() : unavailablePrivacyStatus,
    installPrivacy: async (consent, offlineSource) => {
      if (consent !== true)
        throw new Error(
          "Explicit consent is required to install Privacy Filter assets."
        );
      if (
        offlineSource &&
        JSON.stringify(offlineSource) !== JSON.stringify(selectedOfflineSource)
      )
        throw new Error(
          "Choose offline component files through Desktop before importing them."
        );
      const selectedSource = selectedOfflineSource;
      const status = await requireBridge().installPrivacy({
        consent: true,
        ...(selectedSource ? { offlineSource: selectedSource } : {}),
        onProgress: progressListener
      });
      if (status.state === "ready" && selectedOfflineSource === selectedSource)
        selectedOfflineSource = null;
      return status;
    },
    cancel: async () => {
      offlineSelectionGeneration++;
      selectedOfflineSource = null;
      return requireBridge().cancel();
    },
    selectOffline: async () => {
      const generation = ++offlineSelectionGeneration;
      selectedOfflineSource = null;
      const source = await requireBridge().selectOffline();
      if (generation !== offlineSelectionGeneration) return null;
      selectedOfflineSource = source;
      return selectedOfflineSource;
    },
    launcher: async (operation, options = {}) => {
      if (input.settingsError) throw input.settingsError;
      if (input.platform === "win32")
        throw new Error("CLI launcher is unsupported on Windows.");
      const launcher = launcherInput(options.destination);
      if (operation === "inspect")
        return {
          ...(await inspectLauncher({
            ...launcher,
            probeHelper: input.probeHelper
          })),
          pathConfigured:
            settings.pathDirectory === dirname(launcher.destination) &&
            shellStartupFiles(
              input.homePath ?? homedir(),
              process.env.SHELL
            ).every((rcPath) =>
              hasManagedPathBlock(rcPath, dirname(launcher.destination))
            )
        };
      if (operation === "install") {
        const status = await installLauncher({
          ...launcher,
          consent: options.consent === true,
          probeHelper: input.probeHelper
        });
        persist({ ...settings, destination: launcher.destination });
        activeDestination = launcher.destination;
        return status;
      }
      const status = await removeLauncher({
        ...launcher,
        probeHelper: input.probeHelper
      });
      return status;
    },
    updatePath: async (operation, consent) => {
      if (input.settingsError) throw input.settingsError;
      if (input.platform === "win32")
        throw new Error("Shell PATH management is unsupported on Windows.");
      const shell = process.env.SHELL?.endsWith("zsh") ? "zsh" : "bash";
      const directory =
        operation === "remove"
          ? (settings.pathDirectory ?? dirname(activeDestination))
          : dirname(activeDestination);
      // Each file update is idempotent, so a partial failure is repaired by
      // retrying; inspection reports PATH as configured only when all exist.
      for (const rcPath of shellStartupFiles(
        input.homePath ?? homedir(),
        process.env.SHELL
      ))
        await updateManagedPathBlock({
          rcPath: resolve(rcPath),
          shell,
          operation,
          consent,
          launcherDirectory: directory
        });
      const remaining = settings.destination
        ? { destination: settings.destination }
        : {};
      persist(
        operation === "add"
          ? { ...settings, pathDirectory: directory }
          : remaining
      );
    }
  };
};
