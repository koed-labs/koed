import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { KoedServerPaths } from "./paths.js";

export interface LocalAppCredential {
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
    environment.CODEX_MEMORY_API_TOKEN
  ]);
  if (envToken) {
    return { token: envToken, source: "environment" };
  }

  const repoToken = tokenFrom([
    repoEnv.MEMORY_API_TOKEN,
    repoEnv.CODEX_MEMORY_API_TOKEN
  ]);
  if (repoToken) {
    return { token: repoToken, source: "repo-env" };
  }

  return null;
};

export const writeLocalAppCredential = (
  paths: KoedServerPaths,
  credential: LocalAppCredential
): void => {
  writeFileSync(
    paths.localAppCredentialPath,
    `${JSON.stringify(credential, null, 2)}\n`,
    { mode: 0o600 }
  );
};

export const loadLocalAppCredential = (
  paths: KoedServerPaths
): LocalAppCredential | null => {
  if (!existsSync(paths.localAppCredentialPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      readFileSync(paths.localAppCredentialPath, "utf8")
    ) as Partial<LocalAppCredential> | null;
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
  source: "environment" | "repo-env" | "local-app-credential";
} | null => {
  const localAppCredential = loadLocalAppCredential(paths);
  if (environment.KOED_AUTO_PORTS === "1" && localAppCredential?.apiToken) {
    return {
      token: localAppCredential.apiToken,
      source: "local-app-credential"
    };
  }

  const localToken = resolveLocalApiToken(environment, repoEnv);
  if (localToken) {
    return localToken;
  }

  if (localAppCredential?.apiToken) {
    return {
      token: localAppCredential.apiToken,
      source: "local-app-credential"
    };
  }

  return null;
};
