import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { KoedServerPaths } from "./paths.js";

const secretNames = [
  "POSTGRES_PASSWORD",
  "API_DATA_ENCRYPTION_KEY",
  "OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY",
  "TEAM_MEMORY_DATA_ENCRYPTION_KEY",
  "API_TOKEN_PEPPER",
  "COLLABORATION_LOCAL_BROKER_SECRET",
  "COLLABORATION_REALTIME_CURSOR_SECRET",
  "EMBEDDING_SERVICE_TOKEN",
  "PRIVACY_SERVICE_TOKEN",
  "PRIVACY_RUNTIME_CONTROL_TOKEN",
  "KOED_OPS_METRICS_TOKEN"
] as const;

type LocalServiceSecretName = (typeof secretNames)[number];
export type LocalServiceSecrets = Partial<
  Record<LocalServiceSecretName, string>
>;

export type LocalServiceSecretsReadResult =
  | { state: "absent"; path: string }
  | { state: "invalid"; path: string; error: string }
  | { state: "valid"; path: string; secrets: LocalServiceSecrets };

interface LocalServiceSecretsDependencies {
  existsSync?: typeof existsSync;
  readFileSync?: typeof readFileSync;
  writeFileSync?: typeof writeFileSync;
  randomBytes?: typeof randomBytes;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseLocalServiceSecrets = (
  value: unknown
): LocalServiceSecrets | string => {
  if (!isRecord(value)) return "expected a JSON object";
  const secrets: LocalServiceSecrets = {};
  for (const name of secretNames) {
    const secret = value[name];
    if (secret === undefined) continue;
    if (typeof secret !== "string" || !secret.trim()) {
      return `${name} must be a non-empty string`;
    }
    secrets[name] = secret;
  }
  return secrets;
};

export const localServiceSecretsPath = (paths: KoedServerPaths): string =>
  resolve(paths.configDir, "local-service-secrets.json");

export const readLocalServiceSecrets = (
  paths: KoedServerPaths,
  dependencies: LocalServiceSecretsDependencies = {}
): LocalServiceSecretsReadResult => {
  const path = localServiceSecretsPath(paths);
  const exists = dependencies.existsSync ?? existsSync;
  if (!exists(path)) return { state: "absent", path };
  try {
    const parsed = parseLocalServiceSecrets(
      JSON.parse(
        String((dependencies.readFileSync ?? readFileSync)(path, "utf8"))
      )
    );
    return typeof parsed === "string"
      ? { state: "invalid", path, error: parsed }
      : { state: "valid", path, secrets: parsed };
  } catch {
    return { state: "invalid", path, error: "expected valid JSON" };
  }
};

const generatedSecrets = (
  existing: LocalServiceSecrets,
  random: typeof randomBytes
): Required<LocalServiceSecrets> => ({
  POSTGRES_PASSWORD:
    existing.POSTGRES_PASSWORD ?? random(32).toString("base64url"),
  API_DATA_ENCRYPTION_KEY:
    existing.API_DATA_ENCRYPTION_KEY ?? random(32).toString("base64"),
  OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY:
    existing.OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY ??
    random(32).toString("base64"),
  TEAM_MEMORY_DATA_ENCRYPTION_KEY:
    existing.TEAM_MEMORY_DATA_ENCRYPTION_KEY ?? random(32).toString("base64"),
  API_TOKEN_PEPPER:
    existing.API_TOKEN_PEPPER ?? random(48).toString("base64url"),
  COLLABORATION_LOCAL_BROKER_SECRET:
    existing.COLLABORATION_LOCAL_BROKER_SECRET ??
    random(48).toString("base64url"),
  COLLABORATION_REALTIME_CURSOR_SECRET:
    existing.COLLABORATION_REALTIME_CURSOR_SECRET ??
    random(48).toString("base64url"),
  EMBEDDING_SERVICE_TOKEN:
    existing.EMBEDDING_SERVICE_TOKEN ?? random(32).toString("base64url"),
  PRIVACY_SERVICE_TOKEN:
    existing.PRIVACY_SERVICE_TOKEN ?? random(32).toString("base64url"),
  PRIVACY_RUNTIME_CONTROL_TOKEN:
    existing.PRIVACY_RUNTIME_CONTROL_TOKEN ?? random(32).toString("base64url"),
  KOED_OPS_METRICS_TOKEN:
    existing.KOED_OPS_METRICS_TOKEN ?? random(32).toString("base64url")
});

export const ensurePackagedLocalServiceSecrets = (
  paths: KoedServerPaths,
  packaged: boolean,
  environment: NodeJS.ProcessEnv,
  dependencies: LocalServiceSecretsDependencies = {}
): NodeJS.ProcessEnv => {
  if (!packaged) return environment;
  const readResult = readLocalServiceSecrets(paths, dependencies);
  const existing =
    readResult.state === "valid" ? readResult.secrets : ({} as const);
  const secrets = generatedSecrets(
    existing,
    dependencies.randomBytes ?? randomBytes
  );
  (dependencies.writeFileSync ?? writeFileSync)(
    localServiceSecretsPath(paths),
    `${JSON.stringify(secrets, null, 2)}\n`,
    { mode: 0o600 }
  );
  return { ...secrets, ...environment };
};
