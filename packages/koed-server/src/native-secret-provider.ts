import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const KOED_PDS_KEYCHAIN_SERVICE = "Koed Personal Device Sync";
const MAX_SECRET_BYTES = 2_000_000;

export interface NativeSecretStore {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(
    service: string,
    account: string,
    password: string
  ): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

const validReference = (reference: string): boolean =>
  /^[A-Za-z0-9._-]{1,240}$/.test(reference);

export const createNativeSecretStore = (
  store: NativeSecretStore
): NativeSecretStore => ({
  getPassword: async (service, account) =>
    await store.getPassword(service, account),
  setPassword: async (service, account, password) =>
    await store.setPassword(service, account, password),
  deletePassword: async (service, account) =>
    await store.deletePassword(service, account)
});

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

export const runNativeSecretProvider = async (
  operation: "get" | "put" | "delete",
  reference: string,
  value?: string,
  store?: NativeSecretStore
): Promise<{ ok: boolean; value: string | null }> => {
  if (!validReference(reference)) return { ok: false, value: null };
  if (
    operation === "put" &&
    (value === undefined || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES)
  ) {
    return { ok: false, value: null };
  }
  try {
    const nativeStore =
      store ?? createNativeSecretStore((await import("keytar")).default);
    if (operation === "get") {
      return {
        ok: true,
        value:
          (await nativeStore.getPassword(
            KOED_PDS_KEYCHAIN_SERVICE,
            reference
          )) ?? null
      };
    }
    if (operation === "put") {
      await nativeStore.setPassword(
        KOED_PDS_KEYCHAIN_SERVICE,
        reference,
        value as string
      );
      return { ok: true, value: null };
    }
    await nativeStore.deletePassword(KOED_PDS_KEYCHAIN_SERVICE, reference);
    return { ok: true, value: null };
  } catch {
    return { ok: false, value: null };
  }
};
