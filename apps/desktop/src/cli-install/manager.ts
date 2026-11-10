import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assertLauncherPaths,
  cliTargetStatus,
  hasRecordedLauncher,
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
  type CliInstallSettings,
  type LauncherRecord
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
    operation: "inspect" | "install" | "remove" | "cancel-pending",
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
const bashLoginFiles = [".bash_profile", ".bash_login", ".profile"];
const lstatOrNull = (path: string) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};
export const shellStartupFiles = (
  home: string,
  shell: string | undefined
): string[] => {
  if (shell?.endsWith("zsh")) return [join(home, ".zshrc")];
  const login =
    bashLoginFiles
      .map((name) => join(home, name))
      .find((path) => lstatOrNull(path) !== null) ??
    join(home, ".bash_profile");
  return [join(home, ".bashrc"), login];
};

// The preferred login file can change after setup (for example when the User
// later creates .bash_profile), so removal checks every Bash login file that
// could hold the block. Unsafe file types fail closed rather than being
// skipped, except a symlink whose target holds no Koed block (see shell-path).
export const shellPathRemovalFiles = (
  home: string,
  shell: string | undefined
): string[] =>
  shell?.endsWith("zsh")
    ? [join(home, ".zshrc")]
    : [
        join(home, ".bashrc"),
        ...bashLoginFiles.map((name) => join(home, name))
      ];

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
  let activeDestination =
    settings.pendingDestination ?? settings.destination ?? defaultDestination;
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
  // One queue covers all state shared by launcher and PATH operations in this manager.
  let operationTail: Promise<void> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationTail.then(operation);
    operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
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
    launcher: (operation, options = {}) =>
      serialize(async () => {
        if (input.settingsError) throw input.settingsError;
        if (input.platform === "win32")
          throw new Error("CLI launcher is unsupported on Windows.");
        const launcher = launcherInput(options.destination);
        if (operation === "inspect") {
          const observed = await inspectLauncher({
            ...launcher,
            probeHelper: input.probeHelper
          });
          return {
            ...observed,
            destination: launcher.destination,
            pendingInstallation:
              settings.pendingDestination === launcher.destination,
            pendingCancellationAvailable:
              settings.pendingDestination === launcher.destination &&
              observed.ownership === "absent",
            pathConfigured:
              settings.pathDirectory === dirname(launcher.destination) &&
              shellStartupFiles(
                input.homePath ?? homedir(),
                process.env.SHELL
              ).every((rcPath) =>
                hasManagedPathBlock(rcPath, dirname(launcher.destination))
              )
          };
        }
        if (operation === "cancel-pending") {
          if (settings.pendingDestination !== launcher.destination)
            throw new Error("No pending launcher installation to cancel.");
          const observed = await inspectLauncher({
            ...launcher,
            probeHelper: input.probeHelper
          });
          if (observed.ownership !== "absent")
            throw new Error(
              "Pending launcher exists; retry installation or resolve it manually."
            );
          const {
            pendingDestination: _pending,
            pendingLauncher: _pendingLauncher,
            previousLaunchers: _previous,
            ...remainingSettings
          } = settings;
          persist(remainingSettings);
          activeDestination = settings.destination ?? defaultDestination;
          return observed;
        }
        if (operation === "install") {
          if (input.platform === "linux")
            throw new Error(
              "CLI launcher installation is disabled on Linux, including AppImage, until durable executable and CLI paths can be verified."
            );
          if (options.consent !== true)
            throw new Error("Launcher installation requires explicit consent.");
          if (
            settings.pendingDestination &&
            settings.pendingDestination !== launcher.destination
          )
            throw new Error(
              "Resolve the pending launcher installation before choosing another destination."
            );
          if (
            settings.installedLauncher &&
            settings.installedLauncher.destination !== launcher.destination &&
            lstatOrNull(settings.installedLauncher.destination)
          )
            throw new Error(
              `To change destinations, first recover the existing launcher at "${settings.installedLauncher.destination}" by retrying installation and choosing its existing location, then remove it using Remove command line. If recovery fails, inspect and resolve the file manually.`
            );
          assertLauncherPaths(launcher);
          if (
            !validateCliInstallSettings({
              pendingDestination: launcher.destination
            }).pendingDestination
          )
            throw new Error(
              "Launcher destination must be an absolute path without control characters."
            );
          const before = await inspectLauncher({
            ...launcher,
            probeHelper: input.probeHelper
          });
          if (before.helper !== "supported")
            throw new Error(
              "Desktop Node helper is unsupported; launcher disabled."
            );
          if (cliTargetStatus(launcher.cliPath) !== "valid")
            throw new Error(
              "Koed CLI target is missing or invalid; launcher disabled."
            );
          const savedRecords = [
            settings.installedLauncher,
            ...(settings.previousLaunchers ?? []),
            settings.pendingLauncher
          ].filter((record): record is LauncherRecord => !!record);
          const records = savedRecords.map((record) => ({
            ...launcher,
            destination: record.destination,
            helperPath: record.helperPath,
            cliPath: record.cliPath,
            koedHome: record.koedHome,
            expectedVersion: record.version
          }));
          if (
            before.ownership !== "absent" &&
            before.ownership !== "koed" &&
            !hasRecordedLauncher(launcher, records)
          )
            throw new Error(
              "Launcher destination conflict; preserve the existing file, inspect it and resolve it manually, or choose another path."
            );
          const pendingLauncher: LauncherRecord = {
            destination: launcher.destination,
            helperPath: launcher.helperPath,
            cliPath: launcher.cliPath,
            koedHome: launcher.koedHome,
            version: launcher.expectedVersion
          };
          const previousLaunchers = [
            ...new Map(
              savedRecords.map((record) => [JSON.stringify(record), record])
            ).values()
          ];
          if (previousLaunchers.length > 8)
            throw new Error(
              "Too many interrupted launcher records; manual recovery required."
            );
          persist({
            ...settings,
            pendingDestination: launcher.destination,
            pendingLauncher,
            previousLaunchers
          });
          activeDestination = launcher.destination;
          const status = await installLauncher({
            ...launcher,
            consent: true,
            previousLaunchers: records,
            probeHelper: input.probeHelper
          });
          const {
            pendingDestination: _pending,
            pendingLauncher: _pendingLauncher,
            previousLaunchers: _previous,
            ...remainingSettings
          } = settings;
          persist({
            ...remainingSettings,
            destination: launcher.destination,
            installedLauncher: pendingLauncher
          });
          return status;
        }
        const status = await removeLauncher({
          ...launcher,
          probeHelper: input.probeHelper
        });
        if (
          settings.pendingDestination === launcher.destination ||
          settings.installedLauncher?.destination === launcher.destination
        ) {
          const next = { ...settings };
          if (next.pendingDestination === launcher.destination) {
            delete next.pendingDestination;
            delete next.pendingLauncher;
            delete next.previousLaunchers;
          }
          if (next.installedLauncher?.destination === launcher.destination)
            delete next.installedLauncher;
          persist(next);
          activeDestination =
            settings.pendingDestination ??
            settings.destination ??
            defaultDestination;
        }
        return status;
      }),
    updatePath: (operation, consent) =>
      serialize(async () => {
        if (input.settingsError) throw input.settingsError;
        if (input.platform === "win32")
          throw new Error("Shell PATH management is unsupported on Windows.");
        if (!consent)
          throw new Error("PATH changes require separate explicit consent.");
        const shell = process.env.SHELL?.endsWith("zsh") ? "zsh" : "bash";
        if (
          operation === "add" &&
          settings.pathDirectory &&
          settings.pathDirectory !== dirname(activeDestination)
        ) {
          for (const rcPath of [
            ...shellPathRemovalFiles(input.homePath ?? homedir(), "/bin/bash"),
            ...shellPathRemovalFiles(input.homePath ?? homedir(), "/bin/zsh")
          ])
            await updateManagedPathBlock({
              rcPath: resolve(rcPath),
              shell,
              operation: "remove",
              consent,
              launcherDirectory: settings.pathDirectory
            });
        }
        const directory =
          operation === "remove"
            ? (settings.pathDirectory ?? dirname(activeDestination))
            : dirname(activeDestination);
        if (operation === "add")
          persist({ ...settings, pathDirectory: directory });
        // Each file update is idempotent, so a partial failure is repaired by
        // retrying; inspection reports PATH as configured only when all exist.
        const home = input.homePath ?? homedir();
        const rcPaths =
          operation === "remove"
            ? [
                ...shellPathRemovalFiles(home, "/bin/bash"),
                ...shellPathRemovalFiles(home, "/bin/zsh")
              ]
            : shellStartupFiles(home, process.env.SHELL);
        for (const rcPath of rcPaths)
          await updateManagedPathBlock({
            rcPath: resolve(rcPath),
            shell,
            operation,
            consent,
            launcherDirectory: directory
          });
        const { pathDirectory: _pathDirectory, ...remaining } = settings;
        if (operation === "remove") persist(remaining);
      })
  };
};
