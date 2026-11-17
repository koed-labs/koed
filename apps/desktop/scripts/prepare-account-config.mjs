import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import console from "node:console";
import {
  publicAccountConfigSchema,
  resolveAccountConfig
} from "@koed-labs/shared/account";

const defaultAppDirectory = resolve(import.meta.dirname, "..");

export function parsePublicAccountConfig(text) {
  try {
    if (Buffer.byteLength(text, "utf8") > 4096) throw new Error();
    return publicAccountConfigSchema.parse(JSON.parse(text));
  } catch {
    // Do not echo input: a rejected extra field might contain a secret.
    throw new Error("Invalid public Desktop account configuration.");
  }
}

/** Release inputs are explicit; a local staging file is never a release default. */
export function desktopAccountBuildConfig({
  appDirectory = defaultAppDirectory,
  environment = process.env,
  release = false
} = {}) {
  const source = parsePublicAccountConfig(
    readFileSync(resolve(appDirectory, "account-config.json"), "utf8")
  );
  const enabled =
    environment.KOED_ACCOUNT_ENABLED ??
    (release ? undefined : String(source.enabled));
  if (enabled !== "true" && enabled !== "false")
    throw new Error(
      "KOED_ACCOUNT_ENABLED must be explicitly true or false for a release."
    );
  if (enabled === "false") return { enabled: false };
  const config = {
    enabled: true,
    clientId:
      environment.KOED_ACCOUNT_CLIENT_ID?.trim() ??
      (release ? undefined : source.clientId),
    environment:
      environment.KOED_ACCOUNT_ENVIRONMENT?.trim() ??
      (release ? undefined : source.environment),
    loginMode:
      environment.KOED_ACCOUNT_LOGIN_MODE?.trim() ??
      (release ? undefined : (source.loginMode ?? "direct"))
  };
  if (config.loginMode === "forwarder")
    config.forwarderUrl =
      environment.KOED_ACCOUNT_FORWARDER_URL?.trim() ??
      (release ? undefined : source.forwarderUrl);
  if (release && config.environment !== "production")
    throw new Error(
      "Account-enabled releases require KOED_ACCOUNT_ENVIRONMENT=production."
    );
  if (release && !config.loginMode)
    throw new Error(
      "Account-enabled releases require KOED_ACCOUNT_LOGIN_MODE."
    );
  const parsed = publicAccountConfigSchema.safeParse(config);
  if (
    !parsed.success ||
    !resolveAccountConfig({
      KOED_ACCOUNT_ENABLED: "true",
      KOED_ACCOUNT_CLIENT_ID: config.clientId,
      KOED_ACCOUNT_ENVIRONMENT: config.environment,
      KOED_ACCOUNT_LOGIN_MODE: config.loginMode,
      KOED_ACCOUNT_FORWARDER_URL: config.forwarderUrl
    })
  )
    throw new Error("Missing or unsupported public Desktop account settings.");
  return parsed.data;
}

export function prepareDesktopAccountConfig(options = {}) {
  const directory = resolve(
    options.appDirectory ?? defaultAppDirectory,
    ".account-build"
  );
  const target = resolve(directory, "account-config.json");
  // A failed preparation must not leave a previous enabled build config behind.
  rmSync(target, { force: true });
  const config = desktopAccountBuildConfig(options);
  mkdirSync(directory, { recursive: true });
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

export default function beforePack(context) {
  prepareDesktopAccountConfig({
    appDirectory: context.packager.projectDir,
    release: process.env.KOED_ACCOUNT_RELEASE === "true"
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== "--release")
    throw new Error(
      "Usage: node apps/desktop/scripts/prepare-account-config.mjs --release"
    );
  const config = prepareDesktopAccountConfig({ release: true });
  console.log(
    `Prepared ${config.enabled ? "production" : "disabled"} Desktop accounts.`
  );
}
