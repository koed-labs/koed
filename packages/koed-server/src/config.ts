import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { KoedServerPaths } from "./paths.js";

export type KoedServerRuntimeMode = "local-personal" | "external" | "developer";
export type KoedDependencyMode = "bundled-local" | "external";

export interface KoedServerConfig {
  runtimeMode: KoedServerRuntimeMode;
  dependencyMode: KoedDependencyMode;
  codexTranscriptWatcherEnabled: boolean;
  external?: {
    databaseUrl?: string;
    redisUrl?: string;
    embeddingServiceUrl?: string;
  };
}

export const defaultKoedServerConfig: KoedServerConfig = {
  runtimeMode: "developer",
  dependencyMode: "external",
  codexTranscriptWatcherEnabled: true
};

export interface KoedServerConfigDeps {
  existsSync?: typeof existsSync;
  readFileSync?: typeof readFileSync;
  writeFileSync?: typeof writeFileSync;
}

const trim = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const runtimeMode = (
  value: string | undefined
): KoedServerRuntimeMode | undefined =>
  value === "local-personal" || value === "external" || value === "developer"
    ? value
    : undefined;

const dependencyMode = (
  value: string | undefined
): KoedDependencyMode | undefined =>
  value === "external" || value === "bundled-local" ? value : undefined;

const codexTranscriptWatcherSetting = (
  value: string | boolean | undefined
): boolean | undefined => {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
};

const readConfig = (
  paths: KoedServerPaths,
  deps: Required<Pick<KoedServerConfigDeps, "existsSync" | "readFileSync">>
): Partial<KoedServerConfig> => {
  if (!deps.existsSync(paths.serverConfigPath)) {
    return {};
  }
  try {
    return JSON.parse(
      deps.readFileSync(paths.serverConfigPath, "utf8") as string
    ) as Partial<KoedServerConfig>;
  } catch {
    return {};
  }
};

export const resolveKoedServerConfig = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  deps: KoedServerConfigDeps = {}
): KoedServerConfig => {
  const file = readConfig(paths, {
    existsSync: deps.existsSync ?? existsSync,
    readFileSync: deps.readFileSync ?? readFileSync
  });
  const resolvedRuntimeMode =
    runtimeMode(environment.KOED_RUNTIME_MODE) ??
    runtimeMode(file.runtimeMode) ??
    defaultKoedServerConfig.runtimeMode;
  return {
    runtimeMode: resolvedRuntimeMode,
    dependencyMode:
      dependencyMode(environment.KOED_DEPENDENCY_MODE) ??
      dependencyMode(file.dependencyMode) ??
      defaultKoedServerConfig.dependencyMode,
    codexTranscriptWatcherEnabled:
      codexTranscriptWatcherSetting(
        environment.MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED
      ) ??
      codexTranscriptWatcherSetting(file.codexTranscriptWatcherEnabled) ??
      resolvedRuntimeMode !== "external",
    external: {
      databaseUrl:
        trim(environment.KOED_EXTERNAL_DATABASE_URL) ??
        trim(environment.DATABASE_URL) ??
        trim(file.external?.databaseUrl),
      redisUrl:
        trim(environment.KOED_EXTERNAL_REDIS_URL) ??
        trim(environment.REDIS_URL) ??
        trim(file.external?.redisUrl),
      embeddingServiceUrl:
        trim(environment.KOED_EXTERNAL_EMBEDDING_SERVICE_URL) ??
        trim(environment.EMBEDDING_SERVICE_URL) ??
        trim(file.external?.embeddingServiceUrl)
    }
  };
};

export const writeKoedServerConfig = (
  paths: KoedServerPaths,
  config: KoedServerConfig,
  deps: Pick<KoedServerConfigDeps, "writeFileSync"> = {}
): void => {
  mkdirSync(dirname(paths.serverConfigPath), { recursive: true, mode: 0o700 });
  (deps.writeFileSync ?? writeFileSync)(
    paths.serverConfigPath,
    `${JSON.stringify(config, null, 2)}\n`,
    { mode: 0o600 }
  );
};
