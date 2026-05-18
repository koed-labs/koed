#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env");
const examplePath = resolve(process.cwd(), ".env.example");

if (existsSync(envPath)) {
  console.log(".env already exists; leaving it unchanged.");
  process.exit(0);
}

if (!existsSync(examplePath)) {
  console.error(".env.example not found. Run this command from the repo root.");
  process.exit(1);
}

const replacements = new Map([
  [
    "DATA_ENCRYPTION_KEY",
    randomBytes(32).toString("base64")
  ],
  [
    "API_TOKEN_PEPPER",
    randomBytes(48).toString("base64url")
  ]
]);

const rendered = readFileSync(examplePath, "utf8")
  .split(/\r?\n/)
  .map((line) => {
    for (const [key, value] of replacements) {
      if (line.startsWith(`${key}=`)) {
        return `${key}=${value}`;
      }
    }
    return line;
  })
  .join("\n");

writeFileSync(envPath, rendered, { mode: 0o600 });
console.log("Created .env with generated DATA_ENCRYPTION_KEY and API_TOKEN_PEPPER.");
