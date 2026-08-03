import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPackagedRuntimeMode,
  resolvePackagedResourcesPath
} from "./runtime-artifact-source.js";

export interface KoedServerPaths {
  koedHome: string;
  configDir: string;
  logsDir: string;
  runDir: string;
  dataDir: string;
  modelsDir: string;
  cacheDir: string;
  postgresDataDir: string;
  postgresRunDir: string;
  postgresLogPath: string;
  runtimeStatePath: string;
  lastVerificationPath: string;
  serverConfigPath: string;
  localPortsPath: string;
  explorerTokenPath: string;
  upstreamBackendsPath: string;
  projectMetadataPath: string;
  projectTeamWorkspaceLinksPath: string;
  upstreamEnrollmentsPath: string;
  upstreamDisconnectCleanupPath: string;
  repoRoot: string;
}

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const resolveRepoRoot = (
  environment: NodeJS.ProcessEnv = process.env
): string => {
  const fromEnv = environment.KOED_REPO_ROOT?.trim();
  if (fromEnv) {
    return resolve(fromEnv);
  }

  if (isPackagedRuntimeMode(environment)) {
    const resourcesPath = resolvePackagedResourcesPath(environment);
    if (resourcesPath) {
      return resourcesPath;
    }
  }

  // dist/ -> package root -> packages/koed-server -> repo root
  return resolve(packageDir, "..", "..");
};

const documentationPlaceholderPath = (value: string): boolean => {
  const normalized = resolve(value);
  return (
    normalized === "/path" ||
    normalized === "/path/to" ||
    normalized.startsWith("/path/to/")
  );
};

export const resolveKoedHome = (
  environment: NodeJS.ProcessEnv = process.env
): string => {
  const configured = environment.KOED_HOME?.trim();
  if (configured && documentationPlaceholderPath(configured)) {
    throw new Error(
      `KOED_HOME is set to the documentation placeholder ${configured}. Unset KOED_HOME or set it to a writable local state directory such as ${resolve(`${homedir()}/.koed`)}.`
    );
  }
  return resolve(configured || `${homedir()}/.koed`);
};

export const resolveKoedServerPaths = (
  environment: NodeJS.ProcessEnv = process.env
): KoedServerPaths => {
  const koedHome = resolveKoedHome(environment);
  const repoRoot = resolveRepoRoot(environment);
  const modelsDir = environment.KOED_MODELS_DIR?.trim()
    ? resolve(environment.KOED_MODELS_DIR)
    : resolve(koedHome, "models");
  return {
    koedHome,
    configDir: resolve(koedHome, "config"),
    logsDir: resolve(koedHome, "logs"),
    runDir: resolve(koedHome, "run"),
    dataDir: resolve(koedHome, "data"),
    modelsDir,
    cacheDir: resolve(koedHome, "cache"),
    postgresDataDir: resolve(koedHome, "data", "postgres"),
    postgresRunDir: resolve(koedHome, "run", "postgres"),
    postgresLogPath: resolve(koedHome, "logs", "postgres.log"),
    runtimeStatePath: resolve(koedHome, "run", "koed-server.json"),
    lastVerificationPath: resolve(koedHome, "run", "last-verification.json"),
    serverConfigPath: resolve(koedHome, "config", "server.json"),
    localPortsPath: resolve(koedHome, "config", "local-ports.json"),
    explorerTokenPath: resolve(koedHome, "config", "explorer-token.json"),
    upstreamBackendsPath: resolve(koedHome, "config", "upstream-backends.json"),
    projectMetadataPath: resolve(koedHome, "config", "projects.json"),
    projectTeamWorkspaceLinksPath: resolve(
      koedHome,
      "config",
      "project-team-workspaces.json"
    ),
    upstreamEnrollmentsPath: resolve(
      koedHome,
      "run",
      "upstream-enrollments.json"
    ),
    upstreamDisconnectCleanupPath: resolve(
      koedHome,
      "run",
      "upstream-disconnect-cleanup.json"
    ),
    repoRoot
  };
};

export const ensureKoedHome = (paths: KoedServerPaths): void => {
  for (const dir of [
    paths.koedHome,
    paths.configDir,
    paths.logsDir,
    paths.runDir,
    paths.dataDir,
    paths.modelsDir,
    paths.cacheDir,
    paths.postgresDataDir,
    paths.postgresRunDir
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
};
