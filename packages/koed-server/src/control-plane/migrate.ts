import { ensureKoedHome, type KoedServerPaths } from "../paths.js";
import {
  acquireControlPlaneAdmission,
  releaseControlPlaneAdmission
} from "./admission.js";
import { readControlDiscovery } from "./discovery.js";
import { ensureControlState } from "./ensure-state.js";

/** Operator attests that the legacy Desktop and Agent are stopped. */
export function migrateStoppedLegacyAgent(
  paths: KoedServerPaths,
  confirmed: boolean
): void {
  if (!confirmed)
    throw new Error(
      "Operator confirmation that the old Desktop and Agent are stopped is required"
    );
  ensureKoedHome(paths);
  const admission = acquireControlPlaneAdmission(paths, {
    requireAbsentLock: true
  });
  if (!admission)
    throw new Error("Koed is still running; stop it before migration");
  try {
    if (readControlDiscovery(paths))
      throw new Error(
        "Control-plane discovery exists; stop Koed before migration"
      );
    ensureControlState(paths, admission, {
      legacyStoppedConfirmed: true,
      assumeStoppedIfNoEvidence: true
    });
  } finally {
    releaseControlPlaneAdmission(admission);
  }
}
