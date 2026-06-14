import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface KoedServerPaths {
  koedHome: string;
  configDir: string;
  logsDir: string;
  runDir: string;
  dataDir: string;
  runtimeStatePath: string;
  lastVerificationPath: string;
  serverConfigPath: string;
  explorerTokenPath: string;
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

  // dist/ -> package root -> packages/koed-server -> repo root
  return resolve(packageDir, "..", "..");
};

export const resolveKoedHome = (
  environment: NodeJS.ProcessEnv = process.env
): string => resolve(environment.KOED_HOME?.trim() || `${homedir()}/.koed`);

export const resolveKoedServerPaths = (
  environment: NodeJS.ProcessEnv = process.env
): KoedServerPaths => {
  const koedHome = resolveKoedHome(environment);
  const repoRoot = resolveRepoRoot(environment);
  return {
    koedHome,
    configDir: resolve(koedHome, "config"),
    logsDir: resolve(koedHome, "logs"),
    runDir: resolve(koedHome, "run"),
    dataDir: resolve(koedHome, "data"),
    runtimeStatePath: resolve(koedHome, "run", "koed-server.json"),
    lastVerificationPath: resolve(koedHome, "run", "last-verification.json"),
    serverConfigPath: resolve(koedHome, "config", "server.json"),
    explorerTokenPath: resolve(koedHome, "config", "explorer-token.json"),
    repoRoot
  };
};

export const ensureKoedHome = (paths: KoedServerPaths): void => {
  for (const dir of [
    paths.koedHome,
    paths.configDir,
    paths.logsDir,
    paths.runDir,
    paths.dataDir
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
};
