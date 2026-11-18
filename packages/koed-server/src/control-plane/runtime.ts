import { StartupCancellationError, startKoedServer } from "../start.js";
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
  const done = Promise.resolve().then(
    async (): Promise<RuntimeCleanupOutcome> => {
      // A Stop before dispatch can skip startup entirely; no cleanup is needed.
      if (controller.signal.aborted) return { clean: true };
      let clean = false;
      try {
        await startKoedServer({
          admission: input.admission,
          environment: input.environment,
          desktopRuntimeCapability: input.capability,
          onReady: input.onReady,
          persistGenerationBeforeEffects: input.persistGenerationBeforeEffects,
          signal: controller.signal,
          onCleanupOutcome: (outcome) => {
            clean = outcome.clean;
          }
        });
        return { clean };
      } catch (error) {
        if (clean && error instanceof StartupCancellationError)
          return { clean };
        return {
          clean,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  );
  return { done, stop: () => controller.abort() };
}
