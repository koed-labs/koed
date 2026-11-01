import {
  PINNED_PRIVACY_MODEL_REVISION,
  PINNED_PRIVACY_MODEL_ID,
  PINNED_PRIVACY_CLASSIFIER_HASH
} from "@koed/shared";
import type { ComponentVariant } from "./component-contract.js";
import type { ComponentCommandContext } from "./component-commands.js";
import { runComponentStatus } from "./component-commands.js";
import {
  calculateRuntimeRequirements,
  resolveEffectiveRuntimeConfig
} from "./effective-runtime-config.js";
import { collectPrivacyModelStatus } from "./privacy-model-runtime.js";
import { localPrivacyEnv } from "./local-privacy-runtime.js";
import { resolveVerifiedPackagedRuntime } from "./service-runtime-selection.js";
import {
  readPrivacyInstallationRecord,
  type PrivacyInstallationRecord
} from "./privacy-installation-record.js";
import { readLocalServiceSecrets } from "./local-service-secrets.js";
import { applyPersistedLocalPorts } from "./ports.js";

export async function collectDesktopPrivacyInstallStatus(
  context: ComponentCommandContext
) {
  const components = await runComponentStatus(context);
  if (!components.required.includes("privacy"))
    return {
      ...components,
      running: context.isRunning,
      localRequired: false,
      downloadBytes: null
    };
  const config = resolveEffectiveRuntimeConfig(
    context.paths,
    context.environment ?? process.env,
    "packaged"
  );
  const environment = applyPersistedLocalPorts(
    context.paths,
    config.environment
  );
  const model = await collectPrivacyModelStatus(context.paths);
  let service: {
    state: string;
    message?: string;
    details?: Record<string, unknown>;
  } = { state: "stopped", message: "Privacy Filter service has not started." };
  let installation: PrivacyInstallationRecord | null = null;
  let variant: ComponentVariant | undefined;
  if (components.components.privacy === "active") {
    const runtime = await resolveVerifiedPackagedRuntime(
      context.paths,
      environment,
      calculateRuntimeRequirements(config),
      undefined,
      context.desktopRuntimeCapability
    );
    variant = runtime.privacyVariant;
    if (runtime.generationId && runtime.privacyManifestDigest)
      installation = readPrivacyInstallationRecord(
        context.paths,
        runtime.generationId,
        runtime.privacyManifestDigest
      );
    if (model.ok && context.isRunning) {
      const secrets = readLocalServiceSecrets(context.paths);
      const token =
        environment.PRIVACY_RUNTIME_CONTROL_TOKEN ??
        (secrets.state === "valid"
          ? secrets.secrets.PRIVACY_RUNTIME_CONTROL_TOKEN
          : undefined);
      if (!token)
        service = {
          state: "starting",
          message: "Privacy Filter service authority is not available yet."
        };
      else
        try {
          const origin = localPrivacyEnv(
            context.paths,
            environment,
            runtime
          ).PRIVACY_SERVICE_URL;
          const [healthResponse, statusResponse] = await Promise.all([
            fetch(`${origin}/health`, { signal: AbortSignal.timeout(5000) }),
            fetch(`${origin}/v1/runtime/status`, {
              headers: { "x-koed-privacy-token": token },
              signal: AbortSignal.timeout(5000)
            })
          ]);
          const health = (await healthResponse.json()) as {
            status?: string;
            classifier?: {
              modelId?: string;
              modelRevision?: string;
              classifierHash?: string;
            };
          };
          const current = (await statusResponse.json()) as Record<
            string,
            unknown
          >;
          const provider = current.activeProvider;
          const verified =
            typeof provider === "string" &&
            ["cpu", "cuda", "coreml", "dml"].includes(provider) &&
            Array.isArray(current.verifiedProviders) &&
            current.verifiedProviders.includes(provider);
          const healthy =
            healthResponse.ok &&
            statusResponse.ok &&
            health.status === "ok" &&
            health.classifier?.modelId === PINNED_PRIVACY_MODEL_ID &&
            health.classifier.modelRevision === PINNED_PRIVACY_MODEL_REVISION &&
            health.classifier.classifierHash ===
              PINNED_PRIVACY_CLASSIFIER_HASH &&
            verified;
          service = {
            state: healthy ? "healthy" : "starting",
            message: healthy
              ? "Privacy Filter service is ready."
              : "Privacy Filter service has not completed verification.",
            details: {
              activeProvider: provider,
              ...(typeof current.fallbackReason === "string"
                ? { fallbackReason: current.fallbackReason }
                : {})
            }
          };
        } catch {
          service = {
            state: "starting",
            message: "Privacy Filter service is not reachable yet."
          };
        }
    }
  }
  return {
    ...components,
    running: context.isRunning,
    localRequired: true,
    model: {
      ok: model.ok,
      state: model.state,
      message: model.message,
      revision: PINNED_PRIVACY_MODEL_REVISION
    },
    service,
    variant,
    compatibility: installation?.compatibility,
    verification: installation?.verification,
    downloadBytes: null
  };
}
