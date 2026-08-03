import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString("utf8"),
    getSelectedStorageBackend: () => "unknown"
  }
}));

import {
  createCachedPdsDesktopSecretStore,
  createPdsDesktopSecretStore
} from "./pds-secure-provider.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const secureStorage = () => ({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "libsecret",
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
  decryptString: (value: Buffer) =>
    value.toString("utf8").slice("encrypted:".length)
});

describe("PDS Desktop secret provider", () => {
  it("warms bounded secrets once and keeps mutations durable-first", async () => {
    const values = new Map([["pds-runtime", "runtime-secret"]]);
    const persistent = {
      providerKind: "native_os" as const,
      get: vi.fn(async (reference: string) => values.get(reference) ?? null),
      put: vi.fn(async (reference: string, value: string) => {
        values.set(reference, value);
      }),
      delete: vi.fn(async (reference: string) => {
        values.delete(reference);
      })
    };
    const store = await createCachedPdsDesktopSecretStore(persistent, [
      "pds-runtime"
    ]);

    await expect(store.get("pds-runtime")).resolves.toBe("runtime-secret");
    await expect(store.get("pds-runtime")).resolves.toBe("runtime-secret");
    expect(persistent.get).toHaveBeenCalledOnce();

    await store.put("pds-runtime", "rotated-secret");
    expect(persistent.put).toHaveBeenCalledWith(
      "pds-runtime",
      "rotated-secret"
    );
    await expect(store.get("pds-runtime")).resolves.toBe("rotated-secret");

    await store.delete("pds-runtime");
    expect(persistent.delete).toHaveBeenCalledWith("pds-runtime");
    await expect(store.get("pds-runtime")).resolves.toBeNull();
  });

  it("stores only encrypted values and supports lifecycle operations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "koed-pds-"));
    directories.push(directory);
    const store = createPdsDesktopSecretStore({
      userDataPath: directory,
      storage: secureStorage()
    });
    expect(store).not.toBeNull();
    await store?.put("pds-runtime", "secret-value");
    const persisted = readFileSync(join(directory, "pds-secrets.json"), "utf8");
    expect(persisted).not.toContain("secret-value");
    expect(lstatSync(join(directory, "pds-secrets.json")).mode & 0o077).toBe(0);
    expect(await store?.get("pds-runtime")).toBe("secret-value");
    await store?.delete("pds-runtime");
    expect(await store?.get("pds-runtime")).toBeNull();
  });

  it("rejects Electron basic_text storage", () => {
    const directory = mkdtempSync(join(tmpdir(), "koed-pds-"));
    directories.push(directory);
    expect(
      createPdsDesktopSecretStore({
        userDataPath: directory,
        storage: {
          ...secureStorage(),
          getSelectedStorageBackend: () => "basic_text"
        }
      })
    ).toBeNull();
  });

  it("uses the asynchronous provider and upgrades rotated ciphertext", async () => {
    const directory = mkdtempSync(join(tmpdir(), "koed-pds-"));
    directories.push(directory);
    let encryptions = 0;
    const store = createPdsDesktopSecretStore({
      userDataPath: directory,
      storage: {
        ...secureStorage(),
        encryptStringAsync: async (value) => {
          encryptions += 1;
          return Buffer.from(`async:${value}`);
        },
        decryptStringAsync: async (value) => ({
          result: value.toString("utf8").replace(/^async:/, ""),
          shouldReEncrypt: encryptions === 1
        })
      }
    });
    await store?.put("pds-runtime", "secret-value");
    expect(await store?.get("pds-runtime")).toBe("secret-value");
    expect(encryptions).toBe(2);
  });

  it("serializes concurrent native secret mutations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "koed-pds-"));
    directories.push(directory);
    const store = createPdsDesktopSecretStore({
      userDataPath: directory,
      storage: {
        ...secureStorage(),
        encryptStringAsync: async (value) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return Buffer.from(`encrypted:${value}`);
        }
      }
    });
    if (!store) throw new Error("Secure store was not created.");
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.put(`pds-runtime-${index}`, `secret-${index}`)
      )
    );
    await expect(
      Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          store.get(`pds-runtime-${index}`)
        )
      )
    ).resolves.toEqual(
      Array.from({ length: 12 }, (_, index) => `secret-${index}`)
    );
  });

  it.runIf(Boolean(process.env.WSL_DISTRO_NAME))(
    "uses the Windows DPAPI bridge under WSL when Linux has no keyring",
    async () => {
      const store = createPdsDesktopSecretStore({ userDataPath: tmpdir() });
      expect(store).not.toBeNull();
      const reference = `pds-test-${process.pid}`;
      try {
        await store?.put(reference, "dpapi-test-value");
        expect(await store?.get(reference)).toBe("dpapi-test-value");
      } finally {
        await store?.delete(reference);
      }
    }
  );
});
