import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnvFile } from "@koed-labs/shared/env-file";

export {
  parseEnvFile,
  type ParseEnvFileOptions
} from "@koed-labs/shared/env-file";

/**
 * Resolves a relative `KOED_ENV_PATH` against the launching process's working
 * directory. Detached supervisors start in another directory, so the path must
 * be absolute before it crosses that spawn.
 */
export const withAbsoluteEnvPath = (
  environment: NodeJS.ProcessEnv,
  cwd: string = process.cwd()
): NodeJS.ProcessEnv => {
  const selectedPath = environment.KOED_ENV_PATH?.trim();
  return selectedPath
    ? { ...environment, KOED_ENV_PATH: resolve(cwd, selectedPath) }
    : environment;
};

export const loadRepoEnv = (
  repoRoot: string,
  environment: NodeJS.ProcessEnv = process.env
): Record<string, string> => {
  const explicitPath = environment.KOED_ENV_PATH?.trim();
  const envPath = explicitPath
    ? resolve(explicitPath)
    : resolve(repoRoot, ".env");
  if (!existsSync(envPath)) {
    return {};
  }
  // An explicitly selected profile uses the strict grammar everywhere, so
  // rereads match what the supervisor and services parsed at startup.
  return parseEnvFile(
    readFileSync(envPath, "utf8"),
    explicitPath ? { strict: true, source: envPath } : {}
  );
};

export const environmentWithRepoEnv = (
  repoRoot: string,
  environment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => ({
  ...loadRepoEnv(repoRoot, environment),
  ...environment
});

export const resolveApiUrl = (
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>
): string =>
  (
    (environment.KOED_AUTO_PORTS === "1" && environment.API_HOST_PORT
      ? `http://localhost:${environment.API_HOST_PORT}`
      : null) ??
    environment.MEMORY_API_URL ??
    (environment.API_HOST_PORT
      ? `http://localhost:${environment.API_HOST_PORT}`
      : null) ??
    repoEnv.MEMORY_API_URL ??
    (repoEnv.API_HOST_PORT
      ? `http://localhost:${repoEnv.API_HOST_PORT}`
      : null) ??
    environment.CODEX_MEMORY_BASE_URL ??
    repoEnv.CODEX_MEMORY_BASE_URL ??
    "http://localhost:3300"
  ).trim();
