import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { KoedServerPaths } from "./paths.js";

export interface ExplorerCredential {
  apiToken: string;
  provisionedAt: string;
  source: "environment" | "repo-env";
}

export const resolveLocalApiToken = (
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>
): { token: string; source: "environment" | "repo-env" } | null => {
  const envToken =
    environment.MEMORY_API_TOKEN ??
    environment.CODEX_MEMORY_API_TOKEN ??
    environment.VITE_KOED_API_TOKEN;
  if (envToken?.trim() && !envToken.trim().startsWith("replace_with_")) {
    return { token: envToken.trim(), source: "environment" };
  }

  const repoToken =
    repoEnv.MEMORY_API_TOKEN ??
    repoEnv.CODEX_MEMORY_API_TOKEN ??
    repoEnv.VITE_KOED_API_TOKEN;
  if (repoToken?.trim() && !repoToken.trim().startsWith("replace_with_")) {
    return { token: repoToken.trim(), source: "repo-env" };
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
