import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { KoedServerPaths } from "../paths.js";
import type { ControlPlaneAdmission } from "./admission.js";
import { readLegacyStopEvidence } from "./legacy-stop.js";
import { createControlStateStore, type ControlStateStore } from "./state.js";

export function hasRuntimeEvidence(paths: KoedServerPaths): boolean {
  for (const path of [
    paths.runtimeStatePath,
    paths.generationStatePath ??
      resolve(paths.runDir, "runtime-generation.json")
  ]) {
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}

/** Initialize only a genuinely missing state file while holding admission. */
export function ensureControlState(
  paths: KoedServerPaths,
  admission: ControlPlaneAdmission,
  options: {
    legacyStoppedConfirmed?: boolean;
    assumeStoppedIfNoEvidence?: boolean;
  } = {}
): ControlStateStore {
  const store = createControlStateStore(paths, admission);
  try {
    store.read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const home = realpathSync(paths.koedHome);
    lstatSync(resolve(home, "config"));
    let missing = false;
    try {
      lstatSync(resolve(home, "config/control-plane-state.json"));
    } catch (stateError) {
      if ((stateError as NodeJS.ErrnoException).code !== "ENOENT")
        throw stateError;
      missing = true;
    }
    if (!missing) throw error;
    const legacy = readLegacyStopEvidence(paths);
    if (legacy.kind === "valid" && !options.legacyStoppedConfirmed)
      throw new Error(
        "Stop the old Desktop and Agent before migration; explicit Operator confirmation is required",
        { cause: error }
      );
    // Practical fresh-start policy: absence of records is not proof all old children exited.
    store.initialize(legacy, {
      assumeStopped: Boolean(
        options.assumeStoppedIfNoEvidence && !hasRuntimeEvidence(paths)
      )
    });
  }
  return store;
}
