import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPdsApplicationSecretStore,
  type PdsApplicationSecretStore
} from "@koed/shared";
import { resolveKoedHome } from "./paths.js";

export type PdsSecretProviderOperation = "get" | "put" | "delete";

const bundledCliPath = (): string => {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const sibling = resolve(moduleDirectory, "cli.js");
  if (existsSync(sibling)) return sibling;
  return resolve(moduleDirectory, "../dist/cli.js");
};

export const bundledPdsSecretProviderEnvironment = (
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  if (
    environment.PDS_SECRET_PROVIDER?.trim() ||
    environment.PDS_SECRET_PROVIDER_COMMAND?.trim()
  ) {
    return environment;
  }
  return {
    ...environment,
    PDS_SECRET_PROVIDER: "headless",
    PDS_SECRET_PROVIDER_COMMAND: process.execPath,
    PDS_SECRET_PROVIDER_COMMAND_ARGS_JSON: JSON.stringify([
      bundledCliPath(),
      "secret-provider"
    ])
  };
};

export const runApplicationSecretProvider = (
  operation: PdsSecretProviderOperation,
  reference: string,
  value?: string,
  environment: NodeJS.ProcessEnv = process.env,
  store?: PdsApplicationSecretStore
): Promise<{ ok: boolean; value: string | null }> => {
  try {
    const secretStore =
      store ??
      createPdsApplicationSecretStore({
        rootPath: resolveKoedHome(environment)
      });
    if (operation === "get") {
      return Promise.resolve({ ok: true, value: secretStore.get(reference) });
    }
    if (operation === "put") {
      if (value === undefined)
        return Promise.resolve({ ok: false, value: null });
      secretStore.put(reference, value);
    } else {
      secretStore.delete(reference);
    }
    return Promise.resolve({ ok: true, value: null });
  } catch {
    return Promise.resolve({ ok: false, value: null });
  }
};
