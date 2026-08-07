import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const parseEnvFile = (content: string): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equals = trimmed.indexOf("=");
    if (equals <= 0) {
      continue;
    }
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
};

export const loadRepoEnv = (
  repoRoot: string,
  environment: NodeJS.ProcessEnv = process.env
): Record<string, string> => {
  const envPath = environment.KOED_ENV_PATH?.trim()
    ? resolve(environment.KOED_ENV_PATH)
    : resolve(repoRoot, ".env");
  if (!existsSync(envPath)) {
    return {};
  }
  return parseEnvFile(readFileSync(envPath, "utf8"));
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
