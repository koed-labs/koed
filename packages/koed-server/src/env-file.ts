import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ParseEnvFileOptions {
  strict?: boolean;
  source?: string;
}

export const parseEnvFile = (
  content: string,
  options: ParseEnvFileOptions = {}
): Record<string, string> => {
  const values: Record<string, string> = {};
  const fail = (lineNumber: number, reason: string): never => {
    throw new Error(
      `${options.source ?? "Environment file"}:${lineNumber}: ${reason}`
    );
  };
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equals = trimmed.indexOf("=");
    if (equals <= 0) {
      if (options.strict) fail(index + 1, "expected KEY=VALUE");
      continue;
    }
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    const quoted = value.startsWith('"') || value.startsWith("'");
    if (quoted) {
      if (value.length < 2 || value.at(-1) !== value[0]) {
        if (options.strict)
          fail(index + 1, `unterminated quoted value for ${key}`);
      } else {
        value = value.slice(1, -1);
      }
    }
    if (options.strict && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      fail(index + 1, `invalid environment variable name ${key}`);
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
