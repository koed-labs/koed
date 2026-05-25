#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env");
const examplePath = resolve(process.cwd(), ".env.example");

if (!existsSync(examplePath)) {
  console.error(".env.example not found. Run this command from the repo root.");
  process.exit(1);
}

const splitEnvLine = (line) => {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
  return match ? { key: match[1], value: match[2] } : null;
};

const parseEnv = (contents) => {
  const values = new Map();
  for (const line of contents.split(/\r?\n/)) {
    const entry = splitEnvLine(line);
    if (entry) {
      values.set(entry.key, entry.value);
    }
  }
  return values;
};

const ensureOrigins = (value) => {
  const required = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174"
  ];
  const origins = new Set(
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
  for (const origin of required) {
    origins.add(origin);
  }
  return [...origins].join(",");
};

const example = readFileSync(examplePath, "utf8");
const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const currentValues = parseEnv(existing);
const exampleValues = parseEnv(example);

const generatedValues = new Map([
  ["API_DATA_ENCRYPTION_KEY", randomBytes(32).toString("base64")],
  ["API_TOKEN_PEPPER", randomBytes(48).toString("base64url")],
  ["EMBEDDING_SERVICE_TOKEN", randomBytes(32).toString("base64url")]
]);

const shouldGenerateValue = (key, value) =>
  generatedValues.has(key) &&
  (value === undefined ||
    value.trim() === "" ||
    value.trim().startsWith("replace_with_generated"));

const renamedValues = new Map([
  ["API_DATA_ENCRYPTION_KEY", currentValues.get("DATA_ENCRYPTION_KEY")],
  ["API_CORS_ORIGINS", currentValues.get("CORS_ORIGINS")],
  ["API_LOG_LEVEL", currentValues.get("LOG_LEVEL")],
  ["CONSOLE_HOST_PORT", currentValues.get("WEB_HOST_PORT")],
  ["CONSOLE_PORT", currentValues.get("WEB_PORT")]
]);

const valueForKey = (key) => {
  const current = currentValues.get(key);
  if (current !== undefined && !shouldGenerateValue(key, current)) {
    return key === "API_CORS_ORIGINS" ? ensureOrigins(current) : current;
  }
  const renamed = renamedValues.get(key);
  if (renamed !== undefined) {
    return key === "API_CORS_ORIGINS" ? ensureOrigins(renamed) : renamed;
  }
  const generated = generatedValues.get(key);
  if (generated !== undefined) {
    return generated;
  }
  return exampleValues.get(key) ?? "";
};

const rendered = example
  .split(/\r?\n/)
  .map((line) => {
    const entry = splitEnvLine(line);
    return entry ? `${entry.key}=${valueForKey(entry.key)}` : line;
  })
  .join("\n");

writeFileSync(envPath, rendered, { mode: 0o600 });
chmodSync(envPath, 0o600);
console.log(
  existsSync(envPath) && existing
    ? "Updated .env with any missing current self-hosted variables."
    : "Created .env with generated API_DATA_ENCRYPTION_KEY, API_TOKEN_PEPPER, and EMBEDDING_SERVICE_TOKEN."
);
