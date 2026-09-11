import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  createEncryptedStateTransactionCore,
  isEncryptedStateEnvelope,
  type EncryptedStateEnvelope,
  type EncryptedStateTransactionDeps
} from "./encrypted-state-transaction-core.js";

const MAX_SECRET_BYTES = 2_000_000;
const MAX_SECRET_STORE_BYTES = 32 * 1_024 * 1_024;
const MAX_SECRET_ENTRIES = 1_024;
const REFERENCE_PATTERN = /^[A-Za-z0-9._-]{1,240}$/;
const FILENAME_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;

export interface PdsApplicationSecretStorePaths {
  storePath: string;
  keyPath: string;
}

export interface PdsApplicationSecretStoreOptions {
  rootPath: string;
  storeDirectory?: string;
  storeFilename?: string;
  keyFilename?: string;
  dependencies?: EncryptedStateTransactionDeps;
}

export interface PdsApplicationSecretStore {
  get(reference: string): string | null;
  put(reference: string, value: string): void;
  delete(reference: string): void;
}

interface PdsSecretState {
  schemaVersion: 1;
  updatedAt: string;
  secrets: Record<string, EncryptedStateEnvelope>;
}

type PdsSecretEnvelope = PdsSecretState["secrets"][string];

const isCanonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validFilename = (value: string): boolean => FILENAME_PATTERN.test(value);

const validReference = (value: string): boolean =>
  REFERENCE_PATTERN.test(value);

const assertReference = (reference: string): void => {
  if (!validReference(reference)) {
    throw new Error("PDS secret reference is invalid.");
  }
};

const assertValue = (value: string): void => {
  if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
    throw new Error("PDS secret value is too large.");
  }
};

const currentUserId = (): number | null =>
  typeof process.getuid === "function" ? process.getuid() : null;

const assertSupportedPlatform = (): void => {
  if (process.platform === "win32") {
    throw new Error(
      "PDS secret store requires a POSIX filesystem with owner-only permissions."
    );
  }
};

const assertPrivatePathAncestry = (path: string): void => {
  let current = dirname(resolve(path));
  for (;;) {
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const parent = dirname(current);
        if (parent === current) return;
        current = parent;
        continue;
      }
      throw new Error("PDS secret store path is unsafe.", { cause: error });
    }
    if (stat.isSymbolicLink()) {
      const uid = currentUserId();
      if (uid === null || stat.uid !== 0) {
        throw new Error("PDS secret store path is unsafe.");
      }
      try {
        const target = realpathSync(current);
        const targetStat = lstatSync(target);
        if (!targetStat.isDirectory()) {
          throw new Error();
        }
        current = target;
      } catch (error) {
        throw new Error("PDS secret store path is unsafe.", { cause: error });
      }
      continue;
    }
    const uid = currentUserId();
    if (
      !stat.isDirectory() ||
      (uid !== null && stat.uid !== uid && stat.uid !== 0)
    ) {
      throw new Error("PDS secret store path is unsafe.");
    }
    const writableByOtherUsers = stat.mode & 0o022;
    const sticky = stat.mode & 0o1000;
    if (
      writableByOtherUsers !== 0 &&
      !(sticky !== 0 && (stat.mode & 0o020) === 0)
    ) {
      throw new Error("PDS secret store path is unsafe.");
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
};

const assertPrivateDirectory = (path: string): void => {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch {
    throw new Error("PDS secret store directory is unsafe.");
  }
  assertPrivatePathAncestry(path);
  const stat = lstatSync(path);
  const uid = currentUserId();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (uid !== null && stat.uid !== uid)
  ) {
    throw new Error("PDS secret store directory is unsafe.");
  }
};

const assertPrivateFile = (
  path: string,
  maximumBytes = MAX_SECRET_STORE_BYTES
): void => {
  try {
    assertPrivatePathAncestry(dirname(path));
    const stat = lstatSync(path);
    const uid = currentUserId();
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (uid !== null && stat.uid !== uid)
    ) {
      throw new Error("PDS secret store file is unsafe.");
    }
    if (stat.size > maximumBytes) {
      throw new Error("PDS secret store file is too large.");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "PDS secret store file is unsafe." ||
        error.message === "PDS secret store path is unsafe.")
    ) {
      throw new Error("PDS secret store file is unsafe.", { cause: error });
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

const assertSafePaths = (paths: PdsApplicationSecretStorePaths): void => {
  assertSupportedPlatform();
  assertPrivateDirectory(dirname(paths.storePath));
  assertPrivateDirectory(dirname(paths.keyPath));
  assertPrivateFile(paths.storePath, MAX_SECRET_STORE_BYTES);
  assertPrivateFile(paths.keyPath, 256);
  assertPrivateFile(`${paths.storePath}.lock`, 1_024);
};

const serializeState = (state: PdsSecretState): string => {
  const serialized = JSON.stringify(state, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SECRET_STORE_BYTES) {
    throw new Error("PDS secret store is too large.");
  }
  return serialized;
};

const pdsSecretAad = (reference: string): string =>
  `koed:pds-secret:v1\n${reference}`;

const parseState = (value: unknown): PdsSecretState => {
  if (!isRecord(value) || Object.keys(value).length !== 3) {
    throw new Error("PDS secret store is malformed.");
  }
  if (
    value.schemaVersion !== 1 ||
    !isCanonicalTimestamp(value.updatedAt) ||
    !isRecord(value.secrets) ||
    Object.keys(value.secrets).length > MAX_SECRET_ENTRIES
  ) {
    throw new Error("PDS secret store is malformed.");
  }
  for (const [reference, envelope] of Object.entries(value.secrets)) {
    if (
      !validReference(reference) ||
      !isEncryptedStateEnvelope(envelope, isCanonicalTimestamp)
    ) {
      throw new Error("PDS secret store is malformed.");
    }
  }
  return value as unknown as PdsSecretState;
};

const safePath = (
  rootPath: string,
  directory: string,
  filename: string
): string => {
  if (!validFilename(filename) || directory.includes("\0")) {
    throw new Error("PDS secret store path is invalid.");
  }
  const root = resolve(rootPath);
  const path = resolve(root, directory, filename);
  const pathRelativeToRoot = relative(root, path);
  if (
    pathRelativeToRoot.startsWith("..") ||
    resolve(root, pathRelativeToRoot) !== path
  ) {
    throw new Error("PDS secret store path is invalid.");
  }
  return path;
};

export const pdsApplicationSecretStorePaths = (
  input: Pick<
    PdsApplicationSecretStoreOptions,
    "rootPath" | "storeDirectory" | "storeFilename" | "keyFilename"
  >
): PdsApplicationSecretStorePaths => {
  const directory = input.storeDirectory ?? "secrets";
  const storeFilename = input.storeFilename ?? "pds-secrets.json";
  const keyFilename = input.keyFilename ?? "pds-secret-store.key";
  if (directory !== "." && !validFilename(directory)) {
    throw new Error("PDS secret store directory is invalid.");
  }
  if (storeFilename === keyFilename) {
    throw new Error("PDS secret store paths must be distinct.");
  }
  return {
    storePath: safePath(input.rootPath, directory, storeFilename),
    keyPath: safePath(input.rootPath, directory, keyFilename)
  };
};

export const createPdsApplicationSecretStore = (
  input: PdsApplicationSecretStoreOptions
): PdsApplicationSecretStore => {
  const paths = pdsApplicationSecretStorePaths(input);
  const transaction = createEncryptedStateTransactionCore<
    PdsSecretState,
    never
  >({
    storePath: paths.storePath,
    keyPath: paths.keyPath,
    keySalt: "koed-pds-application-secret-store-v1",
    createEmpty: (now) => ({ schemaVersion: 1, updatedAt: now, secrets: {} }),
    parse: parseState,
    serialize: serializeState,
    deps: input.dependencies
  });

  return {
    get(reference) {
      assertReference(reference);
      assertSafePaths(paths);
      const state = transaction.read();
      if (!Object.hasOwn(state.secrets, reference)) return null;
      const envelope = state.secrets[reference];
      if (!envelope) return null;
      const key = transaction.readKey();
      if (!key) throw new Error("PDS secret store key is missing or invalid.");
      try {
        const value = transaction.decrypt(
          key,
          envelope,
          pdsSecretAad(reference)
        );
        assertValue(value);
        return value;
      } catch {
        throw new Error("PDS secret store value is invalid.");
      }
    },
    put(reference, value) {
      assertReference(reference);
      assertValue(value);
      assertSafePaths(paths);
      transaction.mutate({
        domains: ["pds_secret"],
        apply: (state) => {
          const now = transaction.deps.now().toISOString();
          const key = transaction.readOrCreateKey();
          const previous = Object.hasOwn(state.secrets, reference)
            ? state.secrets[reference]
            : undefined;
          if (
            !previous &&
            Object.keys(state.secrets).length >= MAX_SECRET_ENTRIES
          ) {
            throw new Error("PDS secret store has too many entries.");
          }
          const envelope = transaction.encrypt(
            key,
            value,
            now,
            previous,
            pdsSecretAad(reference)
          ) as PdsSecretEnvelope;
          Object.defineProperty(state.secrets, reference, {
            configurable: true,
            enumerable: true,
            value: envelope,
            writable: true
          });
          state.updatedAt = now;
          return { result: undefined, changed: true };
        }
      });
    },
    delete(reference) {
      assertReference(reference);
      assertSafePaths(paths);
      transaction.mutate({
        domains: ["pds_secret"],
        apply: (state) => {
          if (!Object.hasOwn(state.secrets, reference)) {
            return { result: undefined, changed: false };
          }
          if (!transaction.readKey()) {
            throw new Error("PDS secret store key is missing or invalid.");
          }
          delete state.secrets[reference];
          state.updatedAt = transaction.deps.now().toISOString();
          return { result: undefined, changed: true };
        }
      });
    }
  };
};
