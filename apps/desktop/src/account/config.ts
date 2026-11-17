import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import {
  publicAccountConfigSchema,
  resolveAccountConfig,
  type AccountConfig
} from "@koed-labs/shared/account";
export type { AccountConfig } from "@koed-labs/shared/account";
export const accountConfig = resolveAccountConfig;

const desktopAccountKeys = {
  DESKTOP_ACCOUNT_ENABLED: "KOED_ACCOUNT_ENABLED",
  DESKTOP_ACCOUNT_CLIENT_ID: "KOED_ACCOUNT_CLIENT_ID",
  DESKTOP_ACCOUNT_ENVIRONMENT: "KOED_ACCOUNT_ENVIRONMENT",
  DESKTOP_ACCOUNT_LOGIN_MODE: "KOED_ACCOUNT_LOGIN_MODE",
  DESKTOP_ACCOUNT_FORWARDER_URL: "KOED_ACCOUNT_FORWARDER_URL"
} as const;

/** Source-only root settings; never copy unrelated .env values into Electron. */
export function desktopAccountEnvironment(input: {
  repoRoot: string;
  packaged: boolean;
  environment: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  if (input.packaged) return input.environment;
  let fileValues: NodeJS.ProcessEnv = {};
  try {
    const path = input.environment.KOED_ENV_PATH?.trim()
      ? resolve(input.environment.KOED_ENV_PATH)
      : resolve(input.repoRoot, ".env");
    fileValues = parseEnv(readFileSync(path, "utf8"));
  } catch {
    // Optional account configuration must not block local Personal Memory.
  }
  const result = { ...input.environment };
  for (const [rootKey, accountKey] of Object.entries(desktopAccountKeys)) {
    const value =
      input.environment[accountKey] ??
      input.environment[rootKey] ??
      fileValues[rootKey];
    if (value !== undefined) result[accountKey] = value;
  }
  return result;
}

/** Packaged public defaults support launching from Finder without shell variables. */
export function packagedAccountConfig(
  path: string,
  environment: NodeJS.ProcessEnv,
  { packaged = true }: { packaged?: boolean } = {}
): AccountConfig | null {
  let defaults: NodeJS.ProcessEnv = {};
  try {
    const text = readFileSync(path, "utf8");
    if (text.length > 4096)
      throw new Error("Account configuration is too large");
    const value = publicAccountConfigSchema.parse(JSON.parse(text));
    defaults = {
      KOED_ACCOUNT_ENABLED: String(value.enabled),
      KOED_ACCOUNT_CLIENT_ID: value.clientId,
      KOED_ACCOUNT_ENVIRONMENT: value.environment,
      KOED_ACCOUNT_LOGIN_MODE: value.loginMode,
      KOED_ACCOUNT_FORWARDER_URL: value.forwarderUrl
    };
  } catch {
    // Missing or invalid optional configuration never blocks local startup.
  }
  const resolved = { ...defaults, ...environment };
  // Packaged handoff destinations come only from the reviewed build artifact.
  if (packaged)
    resolved.KOED_ACCOUNT_FORWARDER_URL = defaults.KOED_ACCOUNT_FORWARDER_URL;
  return accountConfig(resolved);
}
