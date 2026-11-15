import { startKoedServer } from "../start.js";
import type { DesktopRuntimeCapability } from "../desktop-runtime-capability.js";
import type { ControlPlaneAdmission } from "./admission.js";

export interface RuntimeCleanupOutcome {
  clean: boolean;
  error?: string;
}

export interface RuntimeSession {
  done: Promise<RuntimeCleanupOutcome>;
  stop(): void;
}

export function startControlPlaneRuntime(input: {
  admission: ControlPlaneAdmission;
  environment: NodeJS.ProcessEnv;
  capability: DesktopRuntimeCapability;
  onReady: (environment: NodeJS.ProcessEnv) => void;
  persistGenerationBeforeEffects: (generationId: string) => void;
}): RuntimeSession {
  const controller = new AbortController();
  let clean = false;
  const done = Promise.resolve()
    .then(() =>
      startKoedServer({
        admission: input.admission,
        environment: input.environment,
        desktopRuntimeCapability: input.capability,
        onReady: input.onReady,
        persistGenerationBeforeEffects: input.persistGenerationBeforeEffects,
        signal: controller.signal,
        onCleanupOutcome: (outcome) => {
          clean = outcome.clean;
        }
      })
    )
    .then(
      (): RuntimeCleanupOutcome => ({ clean }),
      (error: unknown): RuntimeCleanupOutcome => ({
        clean,
        error: error instanceof Error ? error.message : String(error)
      })
    );
  return { done, stop: () => controller.abort() };
}
