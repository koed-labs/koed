import { ensureKoedHome, resolveKoedServerPaths } from "../paths.js";
import {
  validateDesktopRuntimeCapability,
  type DesktopRuntimeCapability
} from "../desktop-runtime-capability.js";
import {
  acquireControlPlaneAdmission,
  releaseControlPlaneAdmission
} from "./admission.js";
import { startControlPlaneService } from "./service.js";
import { ControlHostCleanupError } from "./host.js";
import type { HostCore } from "./host-core.js";
import type { ControlTransport } from "./transport.js";

export async function startControlPlaneProcess(input: {
  environment: NodeJS.ProcessEnv;
  capability: DesktopRuntimeCapability;
  transport: ControlTransport;
  onFatal(error: Error): void;
}): Promise<{ core: HostCore; close(): Promise<void> }> {
  if (!validateDesktopRuntimeCapability(input.capability))
    throw new Error("Verified Desktop runtime capability required");
  const paths = resolveKoedServerPaths(input.environment);
  ensureKoedHome(paths);
  const admission = acquireControlPlaneAdmission(paths);
  if (!admission)
    throw new Error("Another Koed Server Control Plane is already active");
  let service: Awaited<ReturnType<typeof startControlPlaneService>>;
  try {
    service = await startControlPlaneService({ ...input, paths, admission });
  } catch (error) {
    if (!(error instanceof ControlHostCleanupError))
      releaseControlPlaneAdmission(admission);
    throw error;
  }
  return {
    core: service.core,
    async close() {
      await service.close();
      releaseControlPlaneAdmission(admission);
    }
  };
}
