import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

// Koed reads an AI Client's conversations only while the User has connected
// it. Only an explicit, verified setup or repair connects a client; removal
// disconnects it before its integration is changed. Status checks never
// connect a client. The Local AI Runtime starts and stops each client's
// Transcript Watcher and automatic history from this record.
//
// Every write happens under one per-KOED_HOME lock, so writers in different
// processes never lose each other's changes. Each client carries a revision
// that every change increments: a setup notes the revision before it changes
// the integration and may connect the client only if no change landed
// meanwhile, so a stale setup can never undo a later removal.
export type AiClientConnectionId = "codex" | "claude" | "pi";

export const AI_CLIENT_CONNECTION_IDS: readonly AiClientConnectionId[] = [
  "codex",
  "claude",
  "pi"
];

export interface AiClientConnectionEntry {
  connected: boolean;
  revision: number;
  updatedAt: string;
}

export interface AiClientConnectionsRecord {
  version: 2;
  updatedAt: string;
  clients: Partial<Record<AiClientConnectionId, AiClientConnectionEntry>>;
}

export const aiClientConnectionsPath = (koedHome: string): string =>
  path.join(koedHome, "state", "ai-client-connections.json");

type Parsed =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; record: AiClientConnectionsRecord };

const parseEntry = (value: unknown): AiClientConnectionEntry | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  return typeof entry.connected === "boolean" &&
    Number.isSafeInteger(entry.revision) &&
    (entry.revision as number) >= 0 &&
    typeof entry.updatedAt === "string"
    ? {
        connected: entry.connected,
        revision: entry.revision as number,
        updatedAt: entry.updatedAt
      }
    : null;
};

const parse = (koedHome: string): Parsed => {
  let text: string;
  try {
    text = readFileSync(aiClientConnectionsPath(koedHome), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "invalid" };
  }
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    // Earlier records (version 1) were written from status checks, which are
    // not consent. They are ignored, so those clients must be connected again.
    if (
      value.version !== 2 ||
      typeof value.updatedAt !== "string" ||
      !value.clients ||
      typeof value.clients !== "object" ||
      Array.isArray(value.clients)
    )
      return { kind: "invalid" };
    const clients: AiClientConnectionsRecord["clients"] = {};
    for (const id of AI_CLIENT_CONNECTION_IDS) {
      const raw = (value.clients as Record<string, unknown>)[id];
      if (raw === undefined) continue;
      const entry = parseEntry(raw);
      if (!entry) return { kind: "invalid" };
      clients[id] = entry;
    }
    return {
      kind: "valid",
      record: { version: 2, updatedAt: value.updatedAt, clients }
    };
  } catch {
    return { kind: "invalid" };
  }
};

/** Null when there is no usable record; nothing is then connected. */
export const readAiClientConnections = (
  koedHome: string
): AiClientConnectionsRecord | null => {
  const parsed = parse(koedHome);
  return parsed.kind === "valid" ? parsed.record : null;
};

export const isAiClientConnected = (
  record: AiClientConnectionsRecord | null,
  id: AiClientConnectionId
): boolean => record?.clients[id]?.connected === true;

/**
 * The revision a setup must note before it changes the client's integration.
 * Throws when the record cannot be read, so setup fails closed.
 */
export const aiClientConnectionRevision = (
  koedHome: string,
  id: AiClientConnectionId
): number => {
  const parsed = parse(koedHome);
  if (parsed.kind === "invalid")
    throw new Error(
      "The AI Client connection record could not be read; connect the AI Client again after Koed Server repairs it."
    );
  return parsed.kind === "valid"
    ? (parsed.record.clients[id]?.revision ?? 0)
    : 0;
};

const lockTimeoutMs = 5_000;

const withConnectionsLock = <T>(koedHome: string, operation: () => T): T => {
  const target = aiClientConnectionsPath(koedHome);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + lockTimeoutMs;
  let release: () => void;
  while (true) {
    try {
      release = lockfile.lockSync(target, { realpath: false, stale: 30_000 });
      break;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ELOCKED" ||
        Date.now() >= deadline
      )
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    release();
  }
};

const write = (koedHome: string, record: AiClientConnectionsRecord): void => {
  const target = aiClientConnectionsPath(koedHome);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, {
      mode: 0o600,
      flag: "wx"
    });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
};

const change = (
  koedHome: string,
  id: AiClientConnectionId,
  decide: (
    current: AiClientConnectionEntry | undefined,
    readable: boolean
  ) => boolean | null,
  now: Date
): boolean =>
  withConnectionsLock(koedHome, () => {
    const parsed = parse(koedHome);
    const record: AiClientConnectionsRecord =
      parsed.kind === "valid"
        ? parsed.record
        : { version: 2, updatedAt: now.toISOString(), clients: {} };
    const current = record.clients[id];
    const connected = decide(current, parsed.kind !== "invalid");
    if (connected === null) return false;
    const updatedAt = now.toISOString();
    write(koedHome, {
      version: 2,
      updatedAt,
      clients: {
        ...record.clients,
        [id]: {
          connected,
          revision: (current?.revision ?? 0) + 1,
          updatedAt
        }
      }
    });
    return true;
  });

/**
 * Connects a client after its setup was verified. Returns false, changing
 * nothing, when the client changed since `expectedRevision` was noted and is
 * not connected now (for example, it was removed while setup ran).
 */
export const grantAiClientConnection = (
  koedHome: string,
  id: AiClientConnectionId,
  expectedRevision: number,
  now: Date = new Date()
): boolean => {
  let granted = false;
  change(
    koedHome,
    id,
    (current, readable) => {
      if (!readable)
        throw new Error(
          "The AI Client connection record could not be read; the AI Client was not connected."
        );
      if (current?.connected === true) {
        granted = true;
        return null;
      }
      if ((current?.revision ?? 0) !== expectedRevision) return null;
      granted = true;
      return true;
    },
    now
  );
  return granted;
};

/**
 * Disconnects a client. Explicit removal always records a new revision, so a
 * setup that started earlier cannot connect it afterwards. With
 * `ifRevision`, it disconnects only when nothing changed since that revision
 * (a status check that saw the integration move to another KOED_HOME must not
 * undo a setup that finished meanwhile). An unreadable record is replaced,
 * which disconnects every client: revocation must never be blocked.
 */
export const revokeAiClientConnection = (
  koedHome: string,
  id: AiClientConnectionId,
  options: { ifRevision?: number; now?: Date } = {}
): boolean =>
  change(
    koedHome,
    id,
    (current) => {
      if (options.ifRevision === undefined) return false;
      if (current?.connected !== true) return null;
      return (current.revision ?? 0) === options.ifRevision ? false : null;
    },
    options.now ?? new Date()
  );
