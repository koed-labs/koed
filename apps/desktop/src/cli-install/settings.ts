import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute } from "node:path";

export interface CliInstallSettings {
  destination?: string;
  pathDirectory?: string;
}

const validPath = (value: unknown): value is string =>
  typeof value === "string" &&
  isAbsolute(value) &&
  ![...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code < 0x20 || code === 0x7f;
  });

export const validateCliInstallSettings = (
  value: unknown
): CliInstallSettings => {
  if (!value || typeof value !== "object") return {};
  const settings = value as Record<string, unknown>;
  return {
    ...(validPath(settings.destination)
      ? { destination: settings.destination }
      : {}),
    ...(validPath(settings.pathDirectory)
      ? { pathDirectory: settings.pathDirectory }
      : {})
  };
};

export const readCliInstallSettings = (path: string): CliInstallSettings => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(descriptor).isFile())
      throw new Error("CLI settings must be a regular file.");
    return validateCliInstallSettings(
      JSON.parse(readFileSync(descriptor, "utf8"))
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
