#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const required = [
  "DESKTOP_MACOS_CSC_LINK",
  "DESKTOP_MACOS_CSC_KEY_PASSWORD",
  "DESKTOP_MACOS_APPLE_API_KEY_P8_BASE64",
  "DESKTOP_MACOS_APPLE_API_KEY_ID",
  "DESKTOP_MACOS_APPLE_API_ISSUER",
  "DESKTOP_MACOS_APPLE_TEAM_ID",
  "RUNNER_TEMP",
  "GITHUB_OUTPUT"
];

export function prepareMacosSigning(env = process.env) {
  for (const key of required) {
    if (!env[key]?.trim())
      throw new Error(`Missing required signing setting: ${key}`);
  }
  const encoded = env.DESKTOP_MACOS_APPLE_API_KEY_P8_BASE64.trim();
  const decoded = Buffer.from(encoded, "base64");
  if (!decoded.length || decoded.toString("base64") !== encoded) {
    throw new Error("Invalid signing API key base64 encoding");
  }
  const appleApiKeyPath = resolve(env.RUNNER_TEMP, "koed-desktop-notary.p8");
  writeFileSync(appleApiKeyPath, decoded, { mode: 0o600, flag: "wx" });
  appendFileSync(env.GITHUB_OUTPUT, `apple-api-key-path=${appleApiKeyPath}\n`);
  return { appleApiKeyPath };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    prepareMacosSigning();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
