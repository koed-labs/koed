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
import { updateManagedPathBlock } from "./shell-path.js";
import type {
  CliInstallManager,
  PrivacyInstallBridge,
  PrivacyInstallProgress,
  PrivacyInstallStatus
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
  expectedVersion: string;
  currentPath: string;
  homePath?: string;
  platform: NodeJS.Platform;
  probeHelper: HelperProbe;
}): DesktopCliInstallManager => {
  let progressListener: (progress: PrivacyInstallProgress) => void = () => {};
  let selectedOfflinePath: string | null = null;
  const defaultDestination = join(
    input.homePath ?? homedir(),
    ".local",
    "bin",
    "koed"
  );
  let activeDestination = defaultDestination;
  const launcherInput = (destination = activeDestination): LauncherInput => ({
    appPath: input.appPath,
    helperPath: input.helperPath,
    cliPath: input.cliPath,
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
    installPrivacy: async (consent, offlinePath) => {
      if (consent !== true)
        throw new Error(
          "Explicit consent is required to install Privacy Filter assets."
        );
      if (offlinePath && offlinePath !== selectedOfflinePath)
        throw new Error(
          "Choose offline model file through Desktop before importing it."
        );
      const selectedPath = selectedOfflinePath;
      selectedOfflinePath = null;
      return requireBridge().installPrivacy({
        consent: true,
        ...(selectedPath ? { offlinePath: selectedPath } : {}),
        onProgress: progressListener
      });
    },
    cancel: async () => requireBridge().cancel(),
    selectOffline: async () => {
      selectedOfflinePath = await requireBridge().selectOffline();
      return selectedOfflinePath;
    },
    launcher: async (operation, options = {}) => {
      if (input.platform === "win32")
        throw new Error("CLI launcher is unsupported on Windows.");
      const launcher = launcherInput(options.destination);
      if (operation === "inspect")
        return inspectLauncher({ ...launcher, probeHelper: input.probeHelper });
      if (operation === "install") {
        const status = await installLauncher({
          ...launcher,
          consent: options.consent === true,
          probeHelper: input.probeHelper
        });
        activeDestination = launcher.destination;
        return status;
      }
      const status = await removeLauncher({
        ...launcher,
        probeHelper: input.probeHelper
      });
      activeDestination = defaultDestination;
      return status;
    },
    updatePath: async (operation, consent) => {
      if (input.platform === "win32")
        throw new Error("Shell PATH management is unsupported on Windows.");
      const shell = process.env.SHELL?.endsWith("zsh") ? "zsh" : "bash";
      const rcPath = join(
        input.homePath ?? homedir(),
        shell === "zsh" ? ".zshrc" : ".bashrc"
      );
      await updateManagedPathBlock({
        rcPath: resolve(rcPath),
        shell,
        operation,
        consent,
        launcherDirectory: dirname(activeDestination)
      });
    }
  };
};
