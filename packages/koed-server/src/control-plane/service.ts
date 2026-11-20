import { resolve } from "node:path";
import {
  deriveDesktopRuntimeOwner,
  type DesktopRuntimeCapability
} from "../desktop-runtime-capability.js";
import type { KoedServerPaths } from "../paths.js";
import type { ControlPlaneAdmission } from "./admission.js";
import { createControlPlaneHostCore, type HostCore } from "./host-core.js";
import { startControlPlaneHost } from "./host.js";
import { startControlPlaneRuntime } from "./runtime.js";
import { ensureControlState, hasRuntimeEvidence } from "./ensure-state.js";
import type { ControlTransport } from "./transport.js";

/** Assemble the host under admission without treating historical state as cleanup proof. */
export async function startControlPlaneService(input: {
  paths: KoedServerPaths;
  admission: ControlPlaneAdmission;
  capability: DesktopRuntimeCapability;
  environment: NodeJS.ProcessEnv;
  transport: ControlTransport;
  onFatal(error: Error): void;
  onRetired?(): void;
}): Promise<{
  core: HostCore;
  close(): Promise<void>;
  closeUncertain(): Promise<void>;
}> {
  const store = ensureControlState(input.paths, input.admission, {
    assumeStoppedIfNoEvidence: true
  });
  const initial = store.read();
  if (initial.runtimeClean && hasRuntimeEvidence(input.paths)) {
    store.write(
      { ...initial, revision: initial.revision + 1, runtimeClean: false },
      initial.revision
    );
  }
  const owner = deriveDesktopRuntimeOwner(
    input.admission.home,
    input.capability.installationPath
  );
  if (owner.kind !== "desktop") throw new Error("Desktop owner required");
  const core = createControlPlaneHostCore({
    instanceId: input.admission.instanceId,
    store,
    startRuntime: (callbacks) =>
      startControlPlaneRuntime({
        admission: input.admission,
        capability: input.capability,
        environment: input.environment,
        onReady: callbacks.onReady,
        persistGenerationBeforeEffects: callbacks.persistGenerationBeforeEffects
      })
  });
  const host = await startControlPlaneHost({
    paths: input.paths,
    admission: input.admission,
    core,
    transport: input.transport,
    socketPath: resolve(
      input.paths.runDir,
      `c-${input.admission.instanceId.replaceAll("-", "").slice(0, 12)}`
    ),
    installationId: owner.installationId,
    productVersion: input.capability.productVersion,
    onFatal: input.onFatal,
    retirement: input.onRetired && {
      onRetired: input.onRetired,
      isClean: () =>
        store.read().runtimeClean && !hasRuntimeEvidence(input.paths)
    }
  });
  return { core, ...host };
}
