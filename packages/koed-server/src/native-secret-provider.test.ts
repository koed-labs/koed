import { describe, expect, it, vi } from "vitest";
import {
  bundledPdsSecretProviderEnvironment,
  KOED_PDS_KEYCHAIN_SERVICE,
  runNativeSecretProvider,
  type NativeSecretStore
} from "./native-secret-provider.js";

describe("native PDS secret provider", () => {
  it("uses the OS-backed store for opaque references", async () => {
    const values = new Map<string, string>();
    const store: NativeSecretStore = {
      getPassword: vi.fn(
        async (_service, account) => values.get(account) ?? null
      ),
      setPassword: vi.fn(async (_service, account, value) => {
        values.set(account, value);
      }),
      deletePassword: vi.fn(async (_service, account) => values.delete(account))
    };

    await expect(
      runNativeSecretProvider("put", "pds-runtime", "secret", store)
    ).resolves.toMatchObject({ ok: true });
    await expect(
      runNativeSecretProvider("get", "pds-runtime", undefined, store)
    ).resolves.toEqual({ ok: true, value: "secret" });
    await expect(
      runNativeSecretProvider("delete", "pds-runtime", undefined, store)
    ).resolves.toMatchObject({ ok: true });
    expect(store.setPassword).toHaveBeenCalledWith(
      KOED_PDS_KEYCHAIN_SERVICE,
      "pds-runtime",
      "secret"
    );
  });

  it("rejects malformed references and oversized values", async () => {
    const store: NativeSecretStore = {
      getPassword: vi.fn(),
      setPassword: vi.fn(),
      deletePassword: vi.fn()
    };
    await expect(
      runNativeSecretProvider("get", "not a reference", undefined, store)
    ).resolves.toEqual({ ok: false, value: null });
    await expect(
      runNativeSecretProvider(
        "put",
        "pds-runtime",
        "x".repeat(2_000_001),
        store
      )
    ).resolves.toEqual({ ok: false, value: null });
    expect(store.setPassword).not.toHaveBeenCalled();
  });

  it("configures the bundled provider when no provider is supplied", () => {
    const environment = bundledPdsSecretProviderEnvironment({
      PDS_CONTROL_URL: "http://127.0.0.1:3300"
    });
    expect(environment.PDS_SECRET_PROVIDER).toBe("headless");
    expect(environment.PDS_SECRET_PROVIDER_COMMAND).toBe(process.execPath);
    expect(environment.PDS_SECRET_PROVIDER_COMMAND_ARGS_JSON).toContain(
      "secret-provider"
    );
  });
});
