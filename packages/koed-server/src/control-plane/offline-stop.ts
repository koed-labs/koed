import type { KoedServerPaths } from "../paths.js";
import {
  acquireControlPlaneAdmission,
  releaseControlPlaneAdmission
} from "./admission.js";
import { readControlDiscovery } from "./discovery.js";
import { applyControlIntent, createControlStateStore } from "./state.js";

/** Record intent only while no control-plane admission or discovery exists. */
export function recordOfflineStop(
  paths: KoedServerPaths
): { clean: boolean } | undefined {
  const admission = acquireControlPlaneAdmission(paths, {
    requireAbsentLock: true
  });
  if (!admission) return undefined;
  try {
    if (readControlDiscovery(paths))
      throw new Error("Control-plane discovery is present");
    const store = createControlStateStore(paths, admission);
    const current = store.read();
    store.write(
      applyControlIntent(current, { action: "stop", explicit: true }),
      current.revision
    );
    return { clean: current.runtimeClean };
  } finally {
    releaseControlPlaneAdmission(admission);
  }
}
