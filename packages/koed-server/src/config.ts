import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { KoedServerPaths } from "./paths.js";

export type KoedServerRuntimeMode = "local-personal" | "external" | "developer";
export type KoedDependencyMode = "bundled-local" | "external";
export type HardwareAccelerationPreference = "auto" | "cpu";

export interface KoedServerConfig {
  runtimeMode: KoedServerRuntimeMode;
  dependencyMode: KoedDependencyMode;
  codexTranscriptWatcherEnabled: boolean;
  claudeTranscriptWatcherEnabled: boolean;
  codexGlobalMemoryGuidanceEnabled: boolean;
  hardwareAcceleration: HardwareAccelerationPreference;
  external?: {
    databaseUrl?: string;
    redisUrl?: string;
    embeddingServiceUrl?: string;
    privacyServiceUrl?: string;
  };
}

export const defaultKoedServerConfig: KoedServerConfig = {
  runtimeMode: "developer",
  dependencyMode: "external",
  codexTranscriptWatcherEnabled: true,
  claudeTranscriptWatcherEnabled: true,
  codexGlobalMemoryGuidanceEnabled: true,
  hardwareAcceleration: "auto"
};

export interface KoedServerConfigDeps {
  existsSync?: typeof existsSync;
  readFileSync?: typeof readFileSync;
  writeFileSync?: typeof writeFileSync;
  renameSync?: typeof renameSync;
  rmSync?: typeof rmSync;
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

const claudeTranscriptWatcherSetting = codexTranscriptWatcherSetting;
const booleanSetting = codexTranscriptWatcherSetting;

const hardwareAccelerationPreference = (
  value: unknown,
  source: string
): HardwareAccelerationPreference | undefined =>
  value === undefined
    ? undefined
    : value === "auto" || value === "cpu"
      ? value
      : (() => {
          throw new Error(`${source} must be auto or cpu`);
        })();

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
  const resolvedTranscriptWatcherSetting =
    codexTranscriptWatcherSetting(
      environment.MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED
    ) ?? codexTranscriptWatcherSetting(file.codexTranscriptWatcherEnabled);
  const resolvedClaudeTranscriptWatcherSetting =
    claudeTranscriptWatcherSetting(
      environment.MEMORY_CLAUDE_TRANSCRIPT_WATCHER_ENABLED
    ) ?? claudeTranscriptWatcherSetting(file.claudeTranscriptWatcherEnabled);
  if (
    resolvedRuntimeMode === "external" &&
    (resolvedTranscriptWatcherSetting === true ||
      resolvedClaudeTranscriptWatcherSetting === true)
  ) {
    throw new Error(
      "Transcript Watchers cannot run in external runtime mode; run capture through a local-personal koed-server."
    );
  }
  return {
    runtimeMode: resolvedRuntimeMode,
    dependencyMode:
      dependencyMode(environment.KOED_DEPENDENCY_MODE) ??
      dependencyMode(file.dependencyMode) ??
      defaultKoedServerConfig.dependencyMode,
    codexTranscriptWatcherEnabled:
      resolvedTranscriptWatcherSetting ?? resolvedRuntimeMode !== "external",
    claudeTranscriptWatcherEnabled:
      resolvedClaudeTranscriptWatcherSetting ??
      resolvedRuntimeMode !== "external",
    codexGlobalMemoryGuidanceEnabled:
      booleanSetting(environment.KOED_CODEX_GLOBAL_MEMORY_GUIDANCE_ENABLED) ??
      booleanSetting(file.codexGlobalMemoryGuidanceEnabled) ??
      defaultKoedServerConfig.codexGlobalMemoryGuidanceEnabled,
    hardwareAcceleration:
      hardwareAccelerationPreference(
        environment.KOED_HARDWARE_ACCELERATION,
        "KOED_HARDWARE_ACCELERATION"
      ) ??
      hardwareAccelerationPreference(
        file.hardwareAcceleration,
        "server.json hardwareAcceleration"
      ) ??
      defaultKoedServerConfig.hardwareAcceleration,
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
        trim(file.external?.embeddingServiceUrl),
      privacyServiceUrl:
        trim(environment.KOED_EXTERNAL_PRIVACY_SERVICE_URL) ??
        trim(environment.PRIVACY_SERVICE_URL) ??
        trim(file.external?.privacyServiceUrl)
    }
  };
};

const writeServerConfigAtomically = (
  paths: KoedServerPaths,
  config: unknown,
  deps: Pick<
    KoedServerConfigDeps,
    "writeFileSync" | "renameSync" | "rmSync"
  > = {}
): void => {
  mkdirSync(dirname(paths.serverConfigPath), { recursive: true, mode: 0o700 });
  const temporary = `${paths.serverConfigPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    (deps.writeFileSync ?? writeFileSync)(
      temporary,
      `${JSON.stringify(config, null, 2)}\n`,
      { mode: 0o600 }
    );
    (deps.renameSync ?? renameSync)(temporary, paths.serverConfigPath);
  } catch (error) {
    (deps.rmSync ?? rmSync)(temporary, { force: true });
    throw error;
  }
};

export const writeKoedServerConfig = (
  paths: KoedServerPaths,
  config: KoedServerConfig,
  deps: Pick<
    KoedServerConfigDeps,
    "writeFileSync" | "renameSync" | "rmSync"
  > = {}
): void => {
  writeServerConfigAtomically(paths, config, deps);
};

export const writeCodexGlobalMemoryGuidancePreference = (
  paths: KoedServerPaths,
  enabled: boolean,
  deps: KoedServerConfigDeps = {}
): void => {
  const fileExists = deps.existsSync ?? existsSync;
  const read = deps.readFileSync ?? readFileSync;
  let existing: Record<string, unknown> = {};
  if (fileExists(paths.serverConfigPath)) {
    try {
      const parsed: unknown = JSON.parse(
        read(paths.serverConfigPath, "utf8") as string
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("expected a JSON object");
      }
      existing = parsed as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot update Codex memory guidance preference because ${paths.serverConfigPath} is malformed: ${message}.`,
        { cause: error }
      );
    }
  }
  writeServerConfigAtomically(
    paths,
    { ...existing, codexGlobalMemoryGuidanceEnabled: enabled },
    deps
  );
};
