import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import type { KoedServerPaths } from "./paths.js";

export type UpstreamDisconnectCleanupPhase =
  | "remote_revocation_pending"
  | "local_cleanup_pending";

export interface UpstreamDisconnectCleanupRecord {
  schemaVersion: 1;
  backendId: string;
  phase: UpstreamDisconnectCleanupPhase;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  lastFailureCategory: "remote_unavailable" | "local_cleanup_failed" | null;
}

interface UpstreamDisconnectCleanupStore {
  schemaVersion: 1;
  updatedAt: string;
  records: UpstreamDisconnectCleanupRecord[];
}

export interface UpstreamDisconnectCleanupDeps {
  existsSync?: typeof existsSync;
  readFileSync?: typeof readFileSync;
  writeFileSync?: typeof writeFileSync;
  renameSync?: typeof renameSync;
  unlinkSync?: typeof unlinkSync;
  mkdirSync?: typeof mkdirSync;
  now?: () => Date;
}

const backendIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/;

const resolveDeps = (
  deps: UpstreamDisconnectCleanupDeps = {}
): Required<UpstreamDisconnectCleanupDeps> => ({
  existsSync: deps.existsSync ?? existsSync,
  readFileSync: deps.readFileSync ?? readFileSync,
  writeFileSync: deps.writeFileSync ?? writeFileSync,
  renameSync: deps.renameSync ?? renameSync,
  unlinkSync: deps.unlinkSync ?? unlinkSync,
  mkdirSync: deps.mkdirSync ?? mkdirSync,
  now: deps.now ?? (() => new Date())
});

const validateBackendId = (backendId: string): string => {
  const normalized = backendId.trim();
  if (!backendIdPattern.test(normalized)) {
    throw new Error("Upstream disconnect cleanup backend id is invalid.");
  }
  return normalized;
};

const canonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};

const emptyStore = (now: string): UpstreamDisconnectCleanupStore => ({
  schemaVersion: 1,
  updatedAt: now,
  records: []
});

const readStore = (
  paths: KoedServerPaths,
  deps: Required<UpstreamDisconnectCleanupDeps>
): UpstreamDisconnectCleanupStore => {
  const now = deps.now().toISOString();
  if (!deps.existsSync(paths.upstreamDisconnectCleanupPath)) {
    return emptyStore(now);
  }
  try {
    const parsed = JSON.parse(
      deps.readFileSync(paths.upstreamDisconnectCleanupPath, "utf8") as string
    ) as Partial<UpstreamDisconnectCleanupStore>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.records)) {
      throw new Error("invalid schema");
    }
    const records = parsed.records.map((value) => {
      const record = value as Partial<UpstreamDisconnectCleanupRecord>;
      if (
        record.schemaVersion !== 1 ||
        typeof record.backendId !== "string" ||
        !backendIdPattern.test(record.backendId) ||
        (record.phase !== "remote_revocation_pending" &&
          record.phase !== "local_cleanup_pending") ||
        !Number.isInteger(record.attemptCount) ||
        (record.attemptCount ?? 0) < 1 ||
        !canonicalTimestamp(record.createdAt) ||
        !canonicalTimestamp(record.updatedAt) ||
        (record.lastFailureCategory !== null &&
          record.lastFailureCategory !== "remote_unavailable" &&
          record.lastFailureCategory !== "local_cleanup_failed")
      ) {
        throw new Error("invalid record");
      }
      return record as UpstreamDisconnectCleanupRecord;
    });
    return {
      schemaVersion: 1,
      updatedAt: canonicalTimestamp(parsed.updatedAt) ? parsed.updatedAt : now,
      records
    };
  } catch (error) {
    throw new Error("Upstream disconnect cleanup journal is malformed.", {
      cause: error
    });
  }
};

const writeStore = (
  paths: KoedServerPaths,
  store: UpstreamDisconnectCleanupStore,
  deps: Required<UpstreamDisconnectCleanupDeps>
): void => {
  deps.mkdirSync(dirname(paths.upstreamDisconnectCleanupPath), {
    recursive: true,
    mode: 0o700
  });
  const temporaryPath = `${paths.upstreamDisconnectCleanupPath}.tmp`;
  deps.writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600
  });
  deps.renameSync(temporaryPath, paths.upstreamDisconnectCleanupPath);
};

export const listUpstreamDisconnectCleanupRecords = (
  paths: KoedServerPaths,
  depsInput: UpstreamDisconnectCleanupDeps = {}
): UpstreamDisconnectCleanupRecord[] =>
  readStore(paths, resolveDeps(depsInput)).records;

export const beginUpstreamDisconnectCleanup = (
  paths: KoedServerPaths,
  backendIdInput: string,
  depsInput: UpstreamDisconnectCleanupDeps = {}
): UpstreamDisconnectCleanupRecord => {
  const deps = resolveDeps(depsInput);
  const backendId = validateBackendId(backendIdInput);
  const store = readStore(paths, deps);
  const now = deps.now().toISOString();
  const previous = store.records.find(
    (record) => record.backendId === backendId
  );
  const record: UpstreamDisconnectCleanupRecord = {
    schemaVersion: 1,
    backendId,
    phase: previous?.phase ?? "remote_revocation_pending",
    attemptCount: (previous?.attemptCount ?? 0) + 1,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    lastFailureCategory: null
  };
  store.records = [
    ...store.records.filter((item) => item.backendId !== backendId),
    record
  ].sort((left, right) => left.backendId.localeCompare(right.backendId));
  store.updatedAt = now;
  writeStore(paths, store, deps);
  return record;
};

export const updateUpstreamDisconnectCleanup = (
  paths: KoedServerPaths,
  backendIdInput: string,
  update: Pick<
    UpstreamDisconnectCleanupRecord,
    "phase" | "lastFailureCategory"
  >,
  depsInput: UpstreamDisconnectCleanupDeps = {}
): UpstreamDisconnectCleanupRecord => {
  const deps = resolveDeps(depsInput);
  const backendId = validateBackendId(backendIdInput);
  const store = readStore(paths, deps);
  const previous = store.records.find(
    (record) => record.backendId === backendId
  );
  if (!previous) {
    throw new Error("Upstream disconnect cleanup journal entry is missing.");
  }
  const now = deps.now().toISOString();
  const record = { ...previous, ...update, updatedAt: now };
  store.records = store.records.map((item) =>
    item.backendId === backendId ? record : item
  );
  store.updatedAt = now;
  writeStore(paths, store, deps);
  return record;
};

export const completeUpstreamDisconnectCleanup = (
  paths: KoedServerPaths,
  backendIdInput: string,
  depsInput: UpstreamDisconnectCleanupDeps = {}
): boolean => {
  const deps = resolveDeps(depsInput);
  const backendId = validateBackendId(backendIdInput);
  const store = readStore(paths, deps);
  const records = store.records.filter(
    (record) => record.backendId !== backendId
  );
  if (records.length === store.records.length) return false;
  if (records.length === 0) {
    if (deps.existsSync(paths.upstreamDisconnectCleanupPath)) {
      deps.unlinkSync(paths.upstreamDisconnectCleanupPath);
    }
    return true;
  }
  const now = deps.now().toISOString();
  writeStore(paths, { ...store, updatedAt: now, records }, deps);
  return true;
};

export const upstreamDisconnectCleanupPending = (
  paths: KoedServerPaths,
  backendId?: string,
  depsInput: UpstreamDisconnectCleanupDeps = {}
): boolean => {
  const records = listUpstreamDisconnectCleanupRecords(paths, depsInput);
  return backendId
    ? records.some(
        (record) => record.backendId === validateBackendId(backendId)
      )
    : records.length > 0;
};
