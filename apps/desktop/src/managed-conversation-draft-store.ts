import { safeStorage } from "electron";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createPdsApplicationSecretStore,
  type PdsApplicationSecretStore
} from "@koed/shared";
import type { PdsDesktopSecretStore } from "./pds-secure-provider.js";

type SafeStorage = Pick<
  typeof safeStorage,
  "decryptString" | "encryptString" | "isEncryptionAvailable"
> & {
  getSelectedStorageBackend?: () => string;
  encryptStringAsync?: (value: string) => Promise<Buffer>;
  decryptStringAsync?: (
    value: Buffer
  ) => Promise<{ result: string; shouldReEncrypt: boolean }>;
};

const maximumValueBytes = 2_000_000;
const maximumStoreBytes = 32 * 1_024 * 1_024;
const referencePattern = /^[A-Za-z0-9._-]{1,240}$/;

const isSecureStorageAvailable = (storage: SafeStorage): boolean => {
  if (!storage.isEncryptionAvailable()) return false;
  const backend = storage.getSelectedStorageBackend?.();
  return backend !== "basic_text" && backend !== "unknown";
};

const readLegacyValues = (path: string): Record<string, string> => {
  if (!existsSync(path)) return {};
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > maximumStoreBytes
  ) {
    throw new Error("Managed conversation draft store is unsafe.");
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Managed conversation draft store is malformed.");
  }
  const entries = Object.entries(parsed);
  if (
    entries.some(
      ([reference, value]) =>
        !referencePattern.test(reference) ||
        typeof value !== "string" ||
        !/^[A-Za-z0-9_-]+$/.test(value) ||
        Buffer.byteLength(value, "utf8") > maximumValueBytes * 2
    )
  ) {
    throw new Error("Managed conversation draft store is malformed.");
  }
  return Object.fromEntries(entries) as Record<string, string>;
};

const writeLegacyValues = (
  path: string,
  values: Record<string, string>
): void => {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (directoryStat.mode & 0o077) !== 0
  ) {
    throw new Error("Managed conversation draft store is unsafe.");
  }
  const contents = `${JSON.stringify(values)}\n`;
  if (Buffer.byteLength(contents, "utf8") > maximumStoreBytes) {
    throw new Error("Managed conversation draft store is too large.");
  }
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Cleanup only.
    }
    throw error;
  }
};

const createLegacyDraftStore = (
  path: string,
  storage: SafeStorage
): PdsDesktopSecretStore => {
  let serialOperation = Promise.resolve();
  const serial = async <T>(operation: () => Promise<T>): Promise<T> => {
    const next = serialOperation.then(operation, operation);
    serialOperation = next.then(
      () => undefined,
      () => undefined
    );
    return await next;
  };
  return {
    async get(reference) {
      if (!referencePattern.test(reference)) return null;
      return await serial(async () => {
        try {
          const encrypted = readLegacyValues(path)[reference];
          if (!encrypted) return null;
          const buffer = Buffer.from(encrypted, "base64url");
          const decryptedResult = storage.decryptStringAsync
            ? await storage.decryptStringAsync(buffer)
            : null;
          const value =
            decryptedResult?.result ?? storage.decryptString(buffer);
          if (Buffer.byteLength(value, "utf8") > maximumValueBytes) return null;
          if (decryptedResult?.shouldReEncrypt) {
            const values = readLegacyValues(path);
            values[reference] = (
              storage.encryptStringAsync
                ? await storage.encryptStringAsync(value)
                : storage.encryptString(value)
            ).toString("base64url");
            writeLegacyValues(path, values);
          }
          return value;
        } catch (error) {
          if (
            error instanceof Error &&
            /unsafe|malformed|too large/i.test(error.message)
          ) {
            throw error;
          }
          return null;
        }
      });
    },
    async put(reference, value) {
      if (
        !referencePattern.test(reference) ||
        Buffer.byteLength(value, "utf8") > maximumValueBytes
      ) {
        throw new Error("Managed conversation draft is invalid.");
      }
      await serial(async () => {
        const values = readLegacyValues(path);
        values[reference] = (
          storage.encryptStringAsync
            ? await storage.encryptStringAsync(value)
            : storage.encryptString(value)
        ).toString("base64url");
        writeLegacyValues(path, values);
      });
    },
    async delete(reference) {
      if (!referencePattern.test(reference)) {
        throw new Error("Managed conversation draft reference is invalid.");
      }
      await serial(async () => {
        const values = readLegacyValues(path);
        if (!Object.hasOwn(values, reference)) return;
        delete values[reference];
        writeLegacyValues(path, values);
      });
    }
  };
};

const isApplicationManagedDraftState = (path: string): boolean => {
  if (!existsSync(path)) return false;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      schemaVersion?: unknown;
      secrets?: unknown;
    };
    return (
      parsed.schemaVersion === 1 &&
      Boolean(parsed.secrets) &&
      typeof parsed.secrets === "object" &&
      !Array.isArray(parsed.secrets)
    );
  } catch {
    return false;
  }
};

const asApplicationManagedStore = (rootPath: string): PdsDesktopSecretStore => {
  const store: PdsApplicationSecretStore = createPdsApplicationSecretStore({
    rootPath,
    storeDirectory: ".",
    storeFilename: "managed-conversation-drafts.json",
    keyFilename: "managed-conversation-drafts.key"
  });
  return {
    get: async (reference) => store.get(reference),
    put: async (reference, value) => store.put(reference, value),
    delete: async (reference) => store.delete(reference)
  };
};

/**
 * Keeps legacy Desktop draft files readable without routing PDS material
 * through Electron storage. New installs without a usable backend use the
 * shared application-managed format instead.
 */
export const createManagedConversationDraftStore = (input: {
  userDataPath: string;
}): PdsDesktopSecretStore | null => {
  const path = resolve(input.userDataPath, "managed-conversation-drafts.json");
  const storage = safeStorage as SafeStorage;
  if (isApplicationManagedDraftState(path)) {
    return asApplicationManagedStore(input.userDataPath);
  }
  if (isSecureStorageAvailable(storage)) {
    return createLegacyDraftStore(path, storage);
  }
  if (existsSync(path)) return null;
  return asApplicationManagedStore(input.userDataPath);
};
