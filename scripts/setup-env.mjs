#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  migrateLegacyEmbeddingAccelerationDefaults,
  parseEnv,
  renderSetupEnv
} from "./setup-env-lib.mjs";

const envPath = process.env.KOED_ENV_PATH?.trim()
  ? resolve(process.env.KOED_ENV_PATH)
  : resolve(process.cwd(), ".env");
const examplePath = resolve(process.cwd(), ".env.example");

if (!existsSync(examplePath)) {
  console.error(".env.example not found. Run this command from the repo root.");
  process.exit(1);
}

const syncResult = spawnSync(
  process.execPath,
  [resolve(process.cwd(), "scripts/sync-app-env-examples.mjs")],
  { stdio: "inherit" }
);
if (syncResult.error) {
  console.error(syncResult.error.message);
  process.exit(1);
}
if (syncResult.status !== 0) {
  process.exit(syncResult.status ?? 1);
}

const example = readFileSync(examplePath, "utf8");
const existing = migrateLegacyEmbeddingAccelerationDefaults(
  existsSync(envPath) ? readFileSync(envPath, "utf8") : ""
);
const currentValues = parseEnv(existing);
const exampleValues = parseEnv(example);

const usableEnvValue = (value) =>
  value !== undefined &&
  value.trim() !== "" &&
  !value.trim().startsWith("replace_with_");

const configuredOrExampleValue = (key, fallback) => {
  const current = currentValues.get(key);
  if (usableEnvValue(current)) {
    return current;
  }
  const fromExample = exampleValues.get(key);
  return usableEnvValue(fromExample) ? fromExample : fallback;
};

const { values } = parseArgs({
  options: { "local-service-secrets": { type: "string" } }
});
const secretsPath = values["local-service-secrets"];
const managedSecrets = secretsPath
  ? JSON.parse(readFileSync(secretsPath, "utf8"))
  : undefined;
const secretEntry = (
  envName,
  size = 32,
  encoding = "base64url",
  name = envName
) => {
  if (managedSecrets === undefined) {
    return [envName, randomBytes(size).toString(encoding)];
  }
  const value = managedSecrets[name];
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    /[\r\n\0#]|^["'`]/.test(value)
  ) {
    throw new Error(`Invalid .env value for local service secret: ${name}`);
  }
  return [envName, value];
};

const generatedValues = new Map([
  secretEntry("POSTGRES_PASSWORD"),
  secretEntry("API_DATA_ENCRYPTION_KEY", 32, "base64"),
  secretEntry("OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY", 32, "base64"),
  secretEntry(
    "API_TEAM_MEMORY_DATA_ENCRYPTION_KEY",
    32,
    "base64",
    "TEAM_MEMORY_DATA_ENCRYPTION_KEY"
  ),
  secretEntry("API_TOKEN_PEPPER", 48),
  secretEntry(
    "API_COLLABORATION_LOCAL_BROKER_SECRET",
    48,
    "base64url",
    "COLLABORATION_LOCAL_BROKER_SECRET"
  ),
  secretEntry(
    "API_COLLABORATION_REALTIME_CURSOR_SECRET",
    48,
    "base64url",
    "COLLABORATION_REALTIME_CURSOR_SECRET"
  ),
  secretEntry("EMBEDDING_SERVICE_TOKEN"),
  secretEntry("PRIVACY_SERVICE_TOKEN"),
  secretEntry("PRIVACY_RUNTIME_CONTROL_TOKEN"),
  secretEntry("KOED_OPS_METRICS_TOKEN")
]);

const postgresPassword = configuredOrExampleValue(
  "POSTGRES_PASSWORD",
  generatedValues.get("POSTGRES_PASSWORD")
);
generatedValues.set(
  "DATABASE_URL",
  `postgres://${encodeURIComponent(configuredOrExampleValue("POSTGRES_USER", "koed"))}` +
    `:${encodeURIComponent(postgresPassword)}` +
    `@localhost:${configuredOrExampleValue("POSTGRES_HOST_PORT", "15432")}` +
    `/${encodeURIComponent(configuredOrExampleValue("POSTGRES_DB", "koed"))}`
);

const rendered = renderSetupEnv({ example, existing, generatedValues });

writeFileSync(envPath, rendered, { mode: 0o600 });
chmodSync(envPath, 0o600);
console.log(
  existsSync(envPath) && existing
    ? "Updated .env with any missing current Koed variables."
    : "Created .env with generated local service secrets."
);
