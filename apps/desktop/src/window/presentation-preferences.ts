import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  defaultPresentationPreferences,
  kinResolutions,
  type PresentationPreferences
} from "../ipc/presentation-preferences-protocol.js";

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
        typeof value.showMenuBar === "boolean" ? value.showMenuBar : true,
      floatingKin: value.floatingKin === true,
      kinResolution:
        kinResolutions.find(
          (resolution) => resolution === value.kinResolution
        ) ?? defaultPresentationPreferences.kinResolution
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
