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
  defaultHqSidebarPreferences,
  hqSidebarPreferencesSchema,
  type HqSidebarPreferences
} from "../ipc/hq-sidebar-preferences-protocol.js";

export const hqSidebarPreferencesPath = (userDataPath: string): string =>
  resolve(userDataPath, "hq-sidebar-preferences.json");

export const readHqSidebarPreferences = (
  path: string
): HqSidebarPreferences => {
  try {
    return hqSidebarPreferencesSchema.parse(
      JSON.parse(readFileSync(path, "utf8"))
    );
  } catch {
    return { foldedGroups: { ...defaultHqSidebarPreferences.foldedGroups } };
  }
};

export const writeHqSidebarPreferences = (
  path: string,
  value: HqSidebarPreferences
): HqSidebarPreferences => {
  const preferences = hqSidebarPreferencesSchema.parse(value);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
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
  return { foldedGroups: { ...preferences.foldedGroups } };
};
