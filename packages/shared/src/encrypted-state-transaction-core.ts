import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync
} from "node:crypto";
import {
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
import { dirname } from "node:path";

/** Internal custody domains. This module is deliberately not re-exported publicly. */
export type EncryptedStateDomain =
  | "upstream_credential"
  | "desktop_credential"
  | "local_edge_client_credential"
  | "pending_team_send"
  | "action_grant";

export interface EncryptedStateEnvelope {
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
  createdAt: string;
  updatedAt: string;
}

export interface EncryptedStateTransactionDeps {
  existsSync?: typeof existsSync;
  readFileSync?: typeof readFileSync;
  writeFileSync?: typeof writeFileSync;
  renameSync?: typeof renameSync;
  randomBytes?: typeof randomBytes;
  now?: () => Date;
  lockNowMs?: () => number;
  sleepSync?: (milliseconds: number) => void;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  beforeStoreCommit?: () => void;
}

export type ResolvedEncryptedStateTransactionDeps =
  Required<EncryptedStateTransactionDeps>;

export interface EncryptedStateMutationResult<Result> {
  result: Result;
  changed: boolean;
}

interface CoreOptions<State, ParseOptions> {
  storePath: string;
  keyPath: string;
  keySalt: string;
  createEmpty: (now: string) => State;
  parse: (raw: unknown, options?: ParseOptions) => State;
  serialize?: (state: State) => string;
  deps?: EncryptedStateTransactionDeps;
}

interface StoreLockMetadata {
  version: 1;
  ownerToken: string;
  pid: number;
  createdAtEpochMs: number;
}

interface StoreLock {
  path: string;
  ownerToken: string;
}

interface LockSnapshot {
  contents: string | null;
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

const defaultLockTimeoutMs = 5_000;
const defaultStaleLockMs = 30_000;
const maximumLockTimeoutMs = 30_000;
const maximumStaleLockMs = 10 * 60_000;
const lockTokenPattern = /^[A-Za-z0-9_-]{43}$/;

const sleepSync = (milliseconds: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

export const resolveEncryptedStateTransactionDeps = (
  deps: EncryptedStateTransactionDeps = {}
): ResolvedEncryptedStateTransactionDeps => {
  const lockTimeoutMs = deps.lockTimeoutMs ?? defaultLockTimeoutMs;
  const staleLockMs = deps.staleLockMs ?? defaultStaleLockMs;
  if (
    !Number.isFinite(lockTimeoutMs) ||
    lockTimeoutMs < 0 ||
    lockTimeoutMs > maximumLockTimeoutMs ||
    !Number.isFinite(staleLockMs) ||
    staleLockMs < 1_000 ||
    staleLockMs > maximumStaleLockMs
  ) {
    throw new Error("Local secret store lock bounds are invalid.");
  }
  return {
    existsSync: deps.existsSync ?? existsSync,
    readFileSync: deps.readFileSync ?? readFileSync,
    writeFileSync: deps.writeFileSync ?? writeFileSync,
    renameSync: deps.renameSync ?? renameSync,
    randomBytes: deps.randomBytes ?? randomBytes,
    now: deps.now ?? (() => new Date()),
    lockNowMs: deps.lockNowMs ?? Date.now,
    sleepSync: deps.sleepSync ?? sleepSync,
    lockTimeoutMs,
    staleLockMs,
    beforeStoreCommit: deps.beforeStoreCommit ?? (() => undefined)
  };
};

const errorCode = (error: unknown): string | null =>
  error && typeof error === "object" && "code" in error
    ? String(error.code)
    : null;

const syncDirectory = (path: string): void => {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (
      !["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(
        errorCode(error) ?? ""
      )
    ) {
      throw error;
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
};

const unlinkIfPresent = (path: string): void => {
  try {
    unlinkSync(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
};

const atomicWriteFile = (
  targetPath: string,
  contents: string,
  uniqueToken: string,
  deps: ResolvedEncryptedStateTransactionDeps
): void => {
  const parentPath = dirname(targetPath);
  mkdirSync(parentPath, { recursive: true, mode: 0o700 });
  const tempPath = `${targetPath}.${process.pid}.${uniqueToken}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(tempPath, "wx", 0o600);
    deps.writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    deps.renameSync(tempPath, targetPath);
    syncDirectory(parentPath);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    unlinkIfPresent(tempPath);
  }
};

const parseLockMetadata = (
  contents: string | null
): StoreLockMetadata | null => {
  if (contents === null) return null;
  try {
    const candidate = JSON.parse(contents) as Record<string, unknown>;
    if (
      !candidate ||
      Array.isArray(candidate) ||
      Object.keys(candidate).length !== 4 ||
      candidate.version !== 1 ||
      typeof candidate.ownerToken !== "string" ||
      !lockTokenPattern.test(candidate.ownerToken) ||
      !Number.isInteger(candidate.pid) ||
      (candidate.pid as number) <= 0 ||
      !Number.isSafeInteger(candidate.createdAtEpochMs) ||
      (candidate.createdAtEpochMs as number) < 0
    ) {
      return null;
    }
    return candidate as unknown as StoreLockMetadata;
  } catch {
    return null;
  }
};

const readLockSnapshot = (path: string): LockSnapshot | null => {
  try {
    const stats = lstatSync(path);
    let contents: string | null = null;
    if (stats.isFile() && stats.size <= 1_024) {
      try {
        contents = String(readFileSync(path, "utf8"));
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        return null;
      }
    }
    return {
      contents,
      dev: stats.dev,
      ino: stats.ino,
      mode: stats.mode,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
};

const sameLockSnapshot = (left: LockSnapshot, right: LockSnapshot): boolean =>
  left.contents === right.contents &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const recoverStaleLock = (
  path: string,
  deps: ResolvedEncryptedStateTransactionDeps
): boolean => {
  const snapshot = readLockSnapshot(path);
  if (!snapshot) return true;
  const now = deps.lockNowMs();
  if (now - snapshot.mtimeMs < deps.staleLockMs) return false;
  const metadata = parseLockMetadata(snapshot.contents);
  if (metadata && now - metadata.createdAtEpochMs < deps.staleLockMs) {
    return false;
  }
  const confirmed = readLockSnapshot(path);
  if (!confirmed || !sameLockSnapshot(snapshot, confirmed)) return false;
  try {
    unlinkSync(path);
    syncDirectory(dirname(path));
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
};

const acquireStoreLock = (
  path: string,
  deps: ResolvedEncryptedStateTransactionDeps
): StoreLock => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const ownerToken = deps.randomBytes(32).toString("base64url");
  const metadata: StoreLockMetadata = {
    version: 1,
    ownerToken,
    pid: process.pid,
    createdAtEpochMs: deps.lockNowMs()
  };
  const startedAt = deps.lockNowMs();
  let attempt = 0;
  for (;;) {
    let descriptor: number | null = null;
    let created = false;
    try {
      descriptor = openSync(path, "wx", 0o600);
      created = true;
      writeFileSync(descriptor, `${JSON.stringify(metadata)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      syncDirectory(dirname(path));
      return { path, ownerToken };
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      if (created) unlinkIfPresent(path);
      if (errorCode(error) !== "EEXIST") throw error;
    }
    if (recoverStaleLock(path, deps)) continue;
    const elapsed = deps.lockNowMs() - startedAt;
    if (elapsed >= deps.lockTimeoutMs) {
      throw new Error("Timed out acquiring the local secret store lock.");
    }
    const backoff = Math.min(10 * 2 ** Math.min(attempt, 4), 100);
    deps.sleepSync(Math.min(backoff, deps.lockTimeoutMs - elapsed));
    attempt += 1;
  }
};

const releaseStoreLock = (lock: StoreLock): void => {
  const snapshot = readLockSnapshot(lock.path);
  if (!snapshot) return;
  const metadata = parseLockMetadata(snapshot.contents);
  if (metadata?.ownerToken !== lock.ownerToken) return;
  const confirmed = readLockSnapshot(lock.path);
  if (!confirmed || !sameLockSnapshot(snapshot, confirmed)) return;
  unlinkIfPresent(lock.path);
  syncDirectory(dirname(lock.path));
};

const decodeBase64 = (value: string): Buffer => {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  ) {
    throw new Error("Encrypted local credential is malformed.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("Encrypted local credential is malformed.");
  }
  return decoded;
};

export const isEncryptedStateEnvelope = (
  candidate: unknown,
  isCanonicalTimestamp: (value: unknown) => boolean
): candidate is EncryptedStateEnvelope => {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const envelope = candidate as Record<string, unknown>;
  try {
    const iv = decodeBase64(String(envelope.iv));
    const tag = decodeBase64(String(envelope.tag));
    decodeBase64(String(envelope.ciphertext));
    return (
      Object.keys(envelope).length === 6 &&
      envelope.algorithm === "aes-256-gcm" &&
      iv.length === 12 &&
      tag.length === 16 &&
      isCanonicalTimestamp(envelope.createdAt) &&
      isCanonicalTimestamp(envelope.updatedAt) &&
      String(envelope.updatedAt) >= String(envelope.createdAt)
    );
  } catch {
    return false;
  }
};

export const encryptEncryptedStateValue = (
  key: Buffer,
  secret: string,
  now: string,
  deps: ResolvedEncryptedStateTransactionDeps,
  previous?: EncryptedStateEnvelope,
  aad?: string
): EncryptedStateEnvelope => {
  const iv = deps.randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final()
  ]);
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now
  };
};

export const decryptEncryptedStateValue = (
  key: Buffer,
  envelope: EncryptedStateEnvelope,
  aad?: string
): string => {
  const iv = decodeBase64(envelope.iv);
  const tag = decodeBase64(envelope.tag);
  const ciphertext = decodeBase64(envelope.ciphertext);
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error("Encrypted local credential is malformed.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]).toString("utf8");
};

export const createEncryptedStateTransactionCore = <
  State,
  ParseOptions = never
>(
  options: CoreOptions<State, ParseOptions>
) => {
  const deps = resolveEncryptedStateTransactionDeps(options.deps);
  const lockPath = `${options.storePath}.lock`;

  const read = (parseOptions?: ParseOptions): State => {
    if (!deps.existsSync(options.storePath)) {
      return options.createEmpty(deps.now().toISOString());
    }
    let raw: unknown;
    try {
      raw = JSON.parse(String(deps.readFileSync(options.storePath, "utf8")));
    } catch {
      throw new Error("Local secret store is malformed.");
    }
    return options.parse(raw, parseOptions);
  };

  const readKey = (): Buffer | null => {
    if (!deps.existsSync(options.keyPath)) return null;
    try {
      const keyMaterial = String(
        deps.readFileSync(options.keyPath, "utf8")
      ).trim();
      if (!/^[A-Za-z0-9+/]{43}=$/.test(keyMaterial)) return null;
      const decoded = Buffer.from(keyMaterial, "base64");
      if (decoded.length !== 32 || decoded.toString("base64") !== keyMaterial) {
        return null;
      }
      return scryptSync(keyMaterial, options.keySalt, 32);
    } catch {
      return null;
    }
  };

  const readOrCreateKey = (): Buffer => {
    mkdirSync(dirname(options.keyPath), { recursive: true, mode: 0o700 });
    if (!deps.existsSync(options.keyPath)) {
      if (deps.existsSync(options.storePath)) {
        throw new Error("Local secret store key is missing or invalid.");
      }
      atomicWriteFile(
        options.keyPath,
        `${deps.randomBytes(32).toString("base64")}\n`,
        deps.randomBytes(32).toString("base64url"),
        deps
      );
    }
    const key = readKey();
    if (!key) throw new Error("Local secret store key is missing or invalid.");
    return key;
  };

  const encrypt = (
    key: Buffer,
    secret: string,
    now: string,
    previous?: EncryptedStateEnvelope,
    aad?: string
  ): EncryptedStateEnvelope =>
    encryptEncryptedStateValue(key, secret, now, deps, previous, aad);

  const decrypt = (
    key: Buffer,
    envelope: EncryptedStateEnvelope,
    aad?: string
  ): string => decryptEncryptedStateValue(key, envelope, aad);

  const mutate = <Result>(input: {
    /** Exact domains whose invariants may change in this atomic replacement. */
    domains: readonly [EncryptedStateDomain, ...EncryptedStateDomain[]];
    apply: (state: State) => EncryptedStateMutationResult<Result>;
    parseOptions?: ParseOptions;
  }): Result => {
    // Force callers to declare domain edges and reject accidental duplicates.
    if (new Set(input.domains).size !== input.domains.length) {
      throw new Error("Encrypted-state transaction domains must be unique.");
    }
    const lock = acquireStoreLock(lockPath, deps);
    try {
      const state = read(input.parseOptions);
      const outcome = input.apply(state);
      if (outcome.changed) {
        deps.beforeStoreCommit();
        atomicWriteFile(
          options.storePath,
          `${options.serialize ? options.serialize(state) : JSON.stringify(state, null, 2)}\n`,
          lock.ownerToken,
          deps
        );
      }
      return outcome.result;
    } finally {
      releaseStoreLock(lock);
    }
  };

  return {
    deps,
    read,
    readFailClosed: (parseOptions?: ParseOptions): State | null => {
      try {
        return read(parseOptions);
      } catch {
        return null;
      }
    },
    readKey,
    readOrCreateKey,
    encrypt,
    decrypt,
    mutate
  };
};
