import type { KoedServerPaths } from "../paths.js";
import { LifecycleLockedError } from "../generation-lifecycle.js";
import {
  acquireControlPlaneAdmission,
  releaseControlPlaneAdmission
} from "./admission.js";
import { readControlDiscovery } from "./discovery.js";
import { applyControlIntent } from "./state.js";
import { ensureControlState, hasRuntimeEvidence } from "./ensure-state.js";

/** Record intent only while no control-plane admission or discovery exists. */
export function recordOfflineStop(
  paths: KoedServerPaths,
  options: { tryReclaimLock?: (fd: number) => boolean } = {}
): { clean: boolean } | undefined {
  let admission;
  try {
    admission = acquireControlPlaneAdmission(paths, {
      requireAbsentLock: !options.tryReclaimLock,
      tryReclaimLock: options.tryReclaimLock
    });
  } catch (error) {
    if (error instanceof LifecycleLockedError) return undefined;
    throw error;
  }
  if (!admission) return undefined;
  try {
    const discovery = readControlDiscovery(paths);
    if (discovery) {
      try {
        process.kill(discovery.pid, 0);
        throw new Error("Control-plane discovery owner may still be running");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    const store = ensureControlState(paths, admission, {
      assumeStoppedIfNoEvidence: true
    });
    const current = store.read();
    const clean = current.runtimeClean && !hasRuntimeEvidence(paths);
    store.write(
      {
        ...applyControlIntent(current, { action: "stop", explicit: true }),
        runtimeClean: clean
      },
      current.revision
    );
    return { clean };
  } finally {
    releaseControlPlaneAdmission(admission);
  }
}
