import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { resolve } from "node:path";
import type {
  LoginItemSettings,
  LoginItemSettingsOptions,
  Settings
} from "electron";
import type { DesktopLaunchAtStartupState } from "../types.js";

export const backgroundLaunchArgument = "--background";
export const linuxAutostartFilename = "ai.koed.desktop.desktop";
const linuxOwnershipMarker = "X-Koed-Autostart=true";

interface LaunchAtStartupFileSystem {
  chmod: typeof chmod;
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  rename: typeof rename;
  unlink: typeof unlink;
  writeFile: typeof writeFile;
}

interface LaunchAtStartupControllerInput {
  appDataPath: string;
  appIsPackaged: boolean;
  execPath: string;
  fileSystem?: LaunchAtStartupFileSystem;
  getLoginItemSettings?: (
    options?: LoginItemSettingsOptions
  ) => LoginItemSettings;
  platform: NodeJS.Platform;
  setLoginItemSettings?: (settings: Settings) => void;
  temporarySuffix?: () => string;
}

export interface LaunchAtStartupController {
  get: () => Promise<DesktopLaunchAtStartupState>;
  set: (enabled: boolean) => Promise<DesktopLaunchAtStartupState>;
  wasOpenedAtLogin: () => boolean;
}

const defaultFileSystem: LaunchAtStartupFileSystem = {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile
};

const unsupportedState = (): DesktopLaunchAtStartupState => ({
  enabled: false,
  status: "unsupported",
  supported: false
});

const disabledState = (): DesktopLaunchAtStartupState => ({
  enabled: false,
  status: "disabled",
  supported: true
});

const enabledState = (): DesktopLaunchAtStartupState => ({
  enabled: true,
  status: "enabled",
  supported: true
});

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const readOptionalFile = async (
  fileSystem: LaunchAtStartupFileSystem,
  path: string
): Promise<string | null> => {
  try {
    return await fileSystem.readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
};

const isKoedAutostartEntry = (value: string): boolean =>
  value.split(/\r?\n/u).some((line) => line.trim() === linuxOwnershipMarker);

const isAutostartEntryEnabled = (value: string): boolean => {
  const lines = value.split(/\r?\n/u).map((line) => line.trim());
  return (
    isKoedAutostartEntry(value) &&
    !lines.includes("Hidden=true") &&
    !lines.includes("X-GNOME-Autostart-enabled=false")
  );
};

const desktopExecPath = (value: string): string => {
  if (/[\0\r\n]/u.test(value)) {
    throw new Error("Koed executable path is not valid for XDG autostart.");
  }
  return value.replace(/["`$\\]/gu, "\\$&").replace(/%/gu, "%%");
};

export const linuxAutostartEntry = (execPath: string): string =>
  [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=Koed",
    "Comment=Start Koed in the background",
    `Exec="${desktopExecPath(execPath)}" ${backgroundLaunchArgument}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    linuxOwnershipMarker,
    ""
  ].join("\n");

const writeAtomically = async (
  fileSystem: LaunchAtStartupFileSystem,
  path: string,
  value: string,
  temporarySuffix: () => string
): Promise<void> => {
  const temporaryPath = `${path}.${temporarySuffix()}.tmp`;
  try {
    await fileSystem.writeFile(temporaryPath, value, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await fileSystem.rename(temporaryPath, path);
  } catch (error) {
    await fileSystem.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

const windowsLoginItemOptions = (
  execPath: string
): LoginItemSettingsOptions => ({
  args: [backgroundLaunchArgument],
  path: execPath
});

export const isBackgroundLaunch = (input: {
  argv: readonly string[];
  platform: NodeJS.Platform;
  wasOpenedAtLogin: boolean;
}): boolean =>
  input.platform === "darwin"
    ? input.wasOpenedAtLogin
    : (input.platform === "linux" || input.platform === "win32") &&
      input.argv.includes(backgroundLaunchArgument);

export const createLaunchAtStartupController = (
  input: LaunchAtStartupControllerInput
): LaunchAtStartupController => {
  const fileSystem = input.fileSystem ?? defaultFileSystem;
  const temporarySuffix = input.temporarySuffix ?? randomUUID;
  const supportedPlatform =
    input.platform === "darwin" ||
    input.platform === "linux" ||
    input.platform === "win32";
  const supported = input.appIsPackaged && supportedPlatform;
  const linuxAutostartPath = resolve(
    input.appDataPath,
    "autostart",
    linuxAutostartFilename
  );

  const get = async (): Promise<DesktopLaunchAtStartupState> => {
    if (!supported) return unsupportedState();

    if (input.platform === "linux") {
      const current = await readOptionalFile(fileSystem, linuxAutostartPath);
      return current && isAutostartEntryEnabled(current)
        ? enabledState()
        : disabledState();
    }

    if (!input.getLoginItemSettings) {
      throw new Error("Login item settings are unavailable.");
    }
    const settings = input.getLoginItemSettings(
      input.platform === "win32"
        ? windowsLoginItemOptions(input.execPath)
        : undefined
    );
    if (input.platform === "darwin") {
      if (settings.status === "requires-approval") {
        return {
          enabled: settings.openAtLogin,
          status: "requires-approval",
          supported: true
        };
      }
      return settings.openAtLogin &&
        (settings.status === undefined || settings.status === "enabled")
        ? enabledState()
        : disabledState();
    }
    return settings.openAtLogin && settings.executableWillLaunchAtLogin
      ? enabledState()
      : disabledState();
  };

  const set = async (
    enabled: boolean
  ): Promise<DesktopLaunchAtStartupState> => {
    if (!supported) return unsupportedState();

    if (input.platform === "linux") {
      const current = await readOptionalFile(fileSystem, linuxAutostartPath);
      if (enabled) {
        if (current !== null && !isKoedAutostartEntry(current)) {
          throw new Error("The existing autostart entry is not owned by Koed.");
        }
        const autostartDirectory = resolve(input.appDataPath, "autostart");
        await fileSystem.mkdir(autostartDirectory, {
          mode: 0o700,
          recursive: true
        });
        await fileSystem.chmod(autostartDirectory, 0o700);
        await writeAtomically(
          fileSystem,
          linuxAutostartPath,
          linuxAutostartEntry(input.execPath),
          temporarySuffix
        );
      } else if (current !== null && isKoedAutostartEntry(current)) {
        await fileSystem.unlink(linuxAutostartPath);
      }
      return get();
    }

    if (!input.setLoginItemSettings) {
      throw new Error("Login item settings are unavailable.");
    }
    input.setLoginItemSettings(
      input.platform === "win32"
        ? {
            ...windowsLoginItemOptions(input.execPath),
            enabled,
            name: "Koed",
            openAtLogin: enabled
          }
        : { openAtLogin: enabled }
    );
    return get();
  };

  return {
    get,
    set,
    wasOpenedAtLogin: () =>
      supported &&
      input.platform === "darwin" &&
      Boolean(input.getLoginItemSettings?.().wasOpenedAtLogin)
  };
};
