import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { KoedServerPaths } from "./paths.js";

export interface ExplorerCredential {
  apiToken: string;
  provisionedAt: string;
  source: "environment" | "repo-env";
}

const usableToken = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed && !trimmed.startsWith("replace_with_") ? trimmed : null;
};

const tokenFrom = (values: Array<string | undefined>): string | null => {
  for (const value of values) {
    const token = usableToken(value);
    if (token) {
      return token;
    }
  }
  return null;
};

export const resolveLocalApiToken = (
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>
): { token: string; source: "environment" | "repo-env" } | null => {
  const envToken = tokenFrom([
    environment.MEMORY_API_TOKEN,
    environment.CODEX_MEMORY_API_TOKEN,
    environment.VITE_KOED_API_TOKEN
  ]);
  if (envToken) {
    return { token: envToken, source: "environment" };
  }

  const repoToken = tokenFrom([
    repoEnv.MEMORY_API_TOKEN,
    repoEnv.CODEX_MEMORY_API_TOKEN,
    repoEnv.VITE_KOED_API_TOKEN
  ]);
  if (repoToken) {
    return { token: repoToken, source: "repo-env" };
  }

  return null;
};

export const writeExplorerCredential = (
  paths: KoedServerPaths,
  credential: ExplorerCredential
): void => {
  writeFileSync(
    paths.explorerTokenPath,
    `${JSON.stringify(credential, null, 2)}\n`,
    { mode: 0o600 }
  );
};

export const loadExplorerCredential = (
  paths: KoedServerPaths
): ExplorerCredential | null => {
  if (!existsSync(paths.explorerTokenPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      readFileSync(paths.explorerTokenPath, "utf8")
    ) as Partial<ExplorerCredential> | null;
    if (!parsed?.apiToken) {
      return null;
    }
    return {
      apiToken: parsed.apiToken,
      provisionedAt: parsed.provisionedAt ?? "unknown",
      source: parsed.source ?? "repo-env"
    };
  } catch {
    return null;
  }
};

export const resolveActiveIntegrationApiToken = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>
): {
  token: string;
  source: "environment" | "repo-env" | "explorer-credential";
} | null => {
  const explorerCredential = loadExplorerCredential(paths);
  if (environment.KOED_AUTO_PORTS === "1" && explorerCredential?.apiToken) {
    return {
      token: explorerCredential.apiToken,
      source: "explorer-credential"
    };
  }

  const localToken = resolveLocalApiToken(environment, repoEnv);
  if (localToken) {
    return localToken;
  }

  if (explorerCredential?.apiToken) {
    return {
      token: explorerCredential.apiToken,
      source: "explorer-credential"
    };
  }

  return null;
};
