import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveTeamCollaborationEnabled } from "@koed/shared";
import { resolveKoedServerConfig, type KoedServerConfig } from "./config.js";
import type { RuntimeRequirements } from "./component-contract.js";
import { parseEnvFile } from "./env-file.js";
import type { KoedServerPaths } from "./paths.js";

export interface EffectiveRuntimeConfig {
  config: KoedServerConfig;
  environment: NodeJS.ProcessEnv;
  teamEnabled: boolean;
}

export function resolveEffectiveRuntimeConfig(
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv,
  execution: "source" | "packaged"
): EffectiveRuntimeConfig {
  const envPath = environment.KOED_ENV_PATH?.trim()
    ? resolve(environment.KOED_ENV_PATH)
    : execution === "source"
      ? resolve(paths.repoRoot, ".env")
      : undefined;
  let fileEnvironment: Record<string, string> = {};
  if (envPath) {
    if (!existsSync(envPath)) {
      if (environment.KOED_ENV_PATH?.trim()) {
        throw new Error(`Explicit environment file does not exist: ${envPath}`);
      }
    } else {
      fileEnvironment = parseEnvFile(readFileSync(envPath, "utf8"), {
        strict: Boolean(environment.KOED_ENV_PATH?.trim()),
        source: envPath
      });
    }
  }
  const effectiveEnvironment = { ...fileEnvironment, ...environment };
  const config = resolveKoedServerConfig(paths, effectiveEnvironment, {
    strict:
      execution === "packaged" || Boolean(environment.KOED_ENV_PATH?.trim())
  });
  return {
    config,
    environment: effectiveEnvironment,
    teamEnabled: resolveTeamCollaborationEnabled(effectiveEnvironment)
  };
}

export function calculateRuntimeRequirements(
  effective: EffectiveRuntimeConfig
): RuntimeRequirements {
  const localPrivacy =
    effective.config.dependencyMode === "bundled-local" &&
    effective.teamEnabled;
  const components: RuntimeRequirements["components"][number][] = localPrivacy
    ? ["base", "privacy"]
    : ["base"];
  const processes: RuntimeRequirements["processes"][number][] = [
    "api",
    "worker"
  ];
  if (effective.config.runtimeMode !== "external")
    processes.push("local-ai-runtime");
  if (effective.config.dependencyMode === "bundled-local") {
    processes.push("postgres", "embedding-service");
    if (localPrivacy) processes.push("privacy-service");
  }
  const queueValue = effective.environment.WORK_QUEUE_BACKEND?.trim();
  if (queueValue && queueValue !== "local" && queueValue !== "bullmq") {
    throw new Error('WORK_QUEUE_BACKEND must be "local" or "bullmq"');
  }
  const queue: RuntimeRequirements["queue"] =
    queueValue === "local" || queueValue === "bullmq"
      ? queueValue
      : effective.config.dependencyMode === "bundled-local"
        ? "local"
        : "bullmq";
  const bundled = effective.config.dependencyMode === "bundled-local";
  return {
    components,
    processes,
    queue,
    native: bundled ? ["postgres", "llama-server"] : [],
    models: bundled
      ? localPrivacy
        ? ["embedding", "privacy"]
        : ["embedding"]
      : []
  };
}
