import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type PresentationPreferences = {
  graphicsAcceleration: boolean;
  showMenuBar: boolean;
};
export const defaultPresentationPreferences: PresentationPreferences = {
  graphicsAcceleration: true,
  showMenuBar: true
};
export function readPresentationPreferences(
  path: string
): PresentationPreferences {
  try {
    const value = JSON.parse(
      readFileSync(path, "utf8")
    ) as Partial<PresentationPreferences>;
    return {
      graphicsAcceleration:
        typeof value.graphicsAcceleration === "boolean"
          ? value.graphicsAcceleration
          : true,
      showMenuBar:
        typeof value.showMenuBar === "boolean" ? value.showMenuBar : true
    };
  } catch {
    return { ...defaultPresentationPreferences };
  }
}
export function writePresentationPreferences(
  path: string,
  value: PresentationPreferences
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
