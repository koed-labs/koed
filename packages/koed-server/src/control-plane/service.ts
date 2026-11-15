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
import { createControlStateStore } from "./state.js";
import type { ControlTransport } from "./transport.js";

/** Assembles an admitted host without inferring that a missing or unclean state is safe. */
export async function startControlPlaneService(input: {
  paths: KoedServerPaths;
  admission: ControlPlaneAdmission;
  capability: DesktopRuntimeCapability;
  environment: NodeJS.ProcessEnv;
  transport: ControlTransport;
  onFatal(error: Error): void;
}): Promise<{ core: HostCore; close(): Promise<void> }> {
  const store = createControlStateStore(input.paths, input.admission);
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
    socketPath: resolve(input.paths.runDir, "control.sock"),
    installationId: owner.installationId,
    productVersion: input.capability.productVersion,
    onFatal: input.onFatal
  });
  return { core, close: () => host.close() };
}
