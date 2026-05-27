#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderSetupEnv } from "./setup-env-lib.mjs";

const envPath = resolve(process.cwd(), ".env");
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
const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";

const generatedValues = new Map([
  ["API_DATA_ENCRYPTION_KEY", randomBytes(32).toString("base64")],
  ["API_TOKEN_PEPPER", randomBytes(48).toString("base64url")],
  ["EMBEDDING_SERVICE_TOKEN", randomBytes(32).toString("base64url")]
]);

const rendered = renderSetupEnv({ example, existing, generatedValues });

writeFileSync(envPath, rendered, { mode: 0o600 });
chmodSync(envPath, 0o600);
console.log(
  existsSync(envPath) && existing
    ? "Updated .env with any missing current self-hosted variables."
    : "Created .env with generated API_DATA_ENCRYPTION_KEY, API_TOKEN_PEPPER, and EMBEDDING_SERVICE_TOKEN."
);
