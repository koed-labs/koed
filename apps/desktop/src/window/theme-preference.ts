import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type DesktopThemePreference = "light" | "dark" | "system";

const preferences = new Set<DesktopThemePreference>([
  "light",
  "dark",
  "system"
]);

export const isDesktopThemePreference = (
  value: unknown
): value is DesktopThemePreference =>
  typeof value === "string" && preferences.has(value as DesktopThemePreference);

export const desktopThemePreferencePath = (userDataPath: string): string =>
  resolve(userDataPath, "theme-preference.json");

export const readDesktopThemePreference = (
  path: string
): DesktopThemePreference => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isDesktopThemePreference(value) ? value : "system";
  } catch {
    return "system";
  }
};

export const writeDesktopThemePreference = (
  path: string,
  preference: DesktopThemePreference
): void => {
  if (!isDesktopThemePreference(preference)) {
    throw new TypeError("Invalid Desktop theme preference.");
  }
  const temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(preference)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
};
