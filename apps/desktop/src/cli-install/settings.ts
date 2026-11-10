import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute } from "node:path";
import { readBoundedUtf8 } from "./bounded-read.js";

export interface LauncherRecord {
  destination: string;
  helperPath: string;
  cliPath: string;
  koedHome: string;
  version: string;
}

export interface CliInstallSettings {
  installedLauncher?: LauncherRecord;
  pendingLauncher?: LauncherRecord;
  previousLaunchers?: LauncherRecord[];
  destination?: string;
  pendingDestination?: string;
  pathDirectory?: string;
}

const validPath = (value: unknown): value is string =>
  typeof value === "string" &&
  isAbsolute(value) &&
  ![...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code < 0x20 || code === 0x7f;
  });

const validRecord = (value: unknown): value is LauncherRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    [
      record.destination,
      record.helperPath,
      record.cliPath,
      record.koedHome
    ].every(validPath) &&
    typeof record.version === "string" &&
    record.version.length <= 128 &&
    /^[0-9A-Za-z.+-]+$/u.test(record.version)
  );
};

export const validateCliInstallSettings = (
  value: unknown
): CliInstallSettings => {
  if (!value || typeof value !== "object") return {};
  const settings = value as Record<string, unknown>;
  return {
    ...(validRecord(settings.installedLauncher)
      ? { installedLauncher: settings.installedLauncher }
      : {}),
    ...(validRecord(settings.pendingLauncher)
      ? { pendingLauncher: settings.pendingLauncher }
      : {}),
    ...(Array.isArray(settings.previousLaunchers) &&
    settings.previousLaunchers.length <= 8 &&
    settings.previousLaunchers.every(validRecord)
      ? { previousLaunchers: settings.previousLaunchers }
      : {}),
    ...(validPath(settings.destination)
      ? { destination: settings.destination }
      : {}),
    ...(validPath(settings.pendingDestination)
      ? { pendingDestination: settings.pendingDestination }
      : {}),
    ...(validPath(settings.pathDirectory)
      ? { pathDirectory: settings.pathDirectory }
      : {})
  };
};

export const readCliInstallSettings = (path: string): CliInstallSettings => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("CLI settings must be a regular file.");
    if (stat.size > 1024 * 1024)
      throw new Error("CLI settings file is too large to inspect safely.");
    return validateCliInstallSettings(
      JSON.parse(readBoundedUtf8(descriptor, 1024 * 1024))
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

export const loadCliInstallSettingsForDesktop = (
  path: string,
  reportError: (error: Error) => void
): { settings: CliInstallSettings; settingsError?: Error } => {
  try {
    return { settings: readCliInstallSettings(path) };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const settingsError = new Error(
      `Cannot read Desktop CLI settings at "${path}": ${detail}. Launcher and shell PATH operations are disabled. Repair this file's JSON, permissions, or file type, then restart Koed Desktop.`,
      { cause }
    );
    reportError(settingsError);
    return { settings: {}, settingsError };
  }
};

export const writeCliInstallSettings = (
  path: string,
  settings: CliInstallSettings
): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(settings)}\n`, {
      mode: 0o600,
      flag: "wx"
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
};
