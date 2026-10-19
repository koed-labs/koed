import {
  closeSync,
  fchmodSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  defaultHqLayoutPreferences,
  hqLayoutPreferencesSchema,
  type HqLayoutPreferences
} from "../ipc/hq-layout-preferences-protocol.js";

export const hqLayoutPreferencesPath = (userDataPath: string): string =>
  resolve(userDataPath, "hq-layout-preferences.json");

export const readHqLayoutPreferences = (path: string): HqLayoutPreferences => {
  try {
    return hqLayoutPreferencesSchema.parse(
      JSON.parse(readFileSync(path, "utf8"))
    );
  } catch {
    return { ...defaultHqLayoutPreferences };
  }
};

export const writeHqLayoutPreferences = (
  path: string,
  value: HqLayoutPreferences
): HqLayoutPreferences => {
  const preferences = hqLayoutPreferencesSchema.parse(value);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    // Exclusive creation avoids reusing a stale temporary file with a looser
    // mode. Synchronous filesystem calls also serialize IPC writes in main.
    descriptor = openSync(temporary, "wx", 0o600);
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(preferences)}\n`, {
      encoding: "utf8"
    });
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
  return { ...preferences };
};
