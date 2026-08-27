#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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

const generatedPostgresPassword = randomBytes(32).toString("base64url");
const postgresPassword = configuredOrExampleValue(
  "POSTGRES_PASSWORD",
  generatedPostgresPassword
);
const postgresDatabaseUrl =
  `postgres://${encodeURIComponent(configuredOrExampleValue("POSTGRES_USER", "koed"))}` +
  `:${encodeURIComponent(postgresPassword)}` +
  `@localhost:${configuredOrExampleValue("POSTGRES_HOST_PORT", "15432")}` +
  `/${encodeURIComponent(configuredOrExampleValue("POSTGRES_DB", "koed"))}`;

const generatedValues = new Map([
  ["POSTGRES_PASSWORD", generatedPostgresPassword],
  ["DATABASE_URL", postgresDatabaseUrl],
  ["API_DATA_ENCRYPTION_KEY", randomBytes(32).toString("base64")],
  [
    "OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY",
    randomBytes(32).toString("base64")
  ],
  ["API_TEAM_MEMORY_DATA_ENCRYPTION_KEY", randomBytes(32).toString("base64")],
  ["API_TOKEN_PEPPER", randomBytes(48).toString("base64url")],
  [
    "API_COLLABORATION_LOCAL_BROKER_SECRET",
    randomBytes(48).toString("base64url")
  ],
  [
    "API_COLLABORATION_REALTIME_CURSOR_SECRET",
    randomBytes(48).toString("base64url")
  ],
  ["EMBEDDING_SERVICE_TOKEN", randomBytes(32).toString("base64url")],
  ["PRIVACY_SERVICE_TOKEN", randomBytes(32).toString("base64url")],
  ["PRIVACY_RUNTIME_CONTROL_TOKEN", randomBytes(32).toString("base64url")],
  ["KOED_OPS_METRICS_TOKEN", randomBytes(32).toString("base64url")]
]);

const rendered = renderSetupEnv({ example, existing, generatedValues });

writeFileSync(envPath, rendered, { mode: 0o600 });
chmodSync(envPath, 0o600);
console.log(
  existsSync(envPath) && existing
    ? "Updated .env with any missing current Koed variables."
    : "Created .env with generated local service secrets."
);
