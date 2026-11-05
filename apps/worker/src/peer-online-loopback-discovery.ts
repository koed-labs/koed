import { randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DiscoveryRecord,
  DiscoveryStore
} from "./peer-online-loopback-control.js";

// Other OS users are excluded by directory permissions; same-user processes are trusted.
const filename = "discovery.sqlite";
const schema =
  "CREATE TABLE discovery (id INTEGER PRIMARY KEY CHECK (id = 1), host TEXT NOT NULL, port INTEGER NOT NULL, capability TEXT NOT NULL)";

function valid(record: DiscoveryRecord): boolean {
  return (
    !!record &&
    record.host === "127.0.0.1" &&
    Number.isInteger(record.port) &&
    record.port >= 1 &&
    record.port <= 65535 &&
    typeof record.capability === "string" &&
    /^[a-f0-9]{64}$/.test(record.capability)
  );
}

function checkPrivate(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600) ||
    (!directory && stat.nlink !== 1) ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error("Unsafe discovery storage");
  }
}

function prepare(directory: string): string {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  checkPrivate(directory, true);
  return join(directory, filename);
}

function initialize(path: string): void {
  const temp = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  closeSync(fd);
  try {
    const db = new DatabaseSync(temp);
    try {
      db.exec(
        `PRAGMA application_id = 1263482180; PRAGMA user_version = 1; ${schema}`
      );
    } finally {
      db.close();
    }
    try {
      linkSync(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    unlinkSync(temp);
  }
}

function openStore(directory: string): DatabaseSync {
  const path = prepare(directory);
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    initialize(path);
  }
  // The initializing process briefly holds a second link while installing the database.
  for (let attempt = 0; ; attempt++) {
    const stat = lstatSync(path);
    if (stat.nlink !== 2 || attempt === 20) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  checkPrivate(path, false);
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try {
      checkPrivate(path + suffix, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const app = db.prepare("PRAGMA application_id").get();
    const version = db.prepare("PRAGMA user_version").get();
    const objects = db
      .prepare(
        "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'"
      )
      .all();
    if (
      app?.application_id !== 1263482180 ||
      version?.user_version !== 1 ||
      objects.length !== 1 ||
      objects[0]?.type !== "table" ||
      objects[0]?.name !== "discovery" ||
      objects[0]?.sql !== schema
    ) {
      throw new Error("Invalid discovery storage");
    }
  } finally {
    db.close();
  }
  const writable = new DatabaseSync(path);
  writable.exec("PRAGMA busy_timeout = 5000");
  return writable;
}

function get(db: DatabaseSync): DiscoveryRecord | undefined {
  const sizes = db
    .prepare(
      "SELECT length(CAST(host AS BLOB)) AS host, length(CAST(capability AS BLOB)) AS capability FROM discovery WHERE id = 1"
    )
    .get();
  if (sizes && (sizes.host !== 9 || sizes.capability !== 64))
    throw new Error("Invalid discovery record");
  const row = db
    .prepare("SELECT host, port, capability FROM discovery WHERE id = 1")
    .get();
  if (!row) return undefined;
  const record = row as DiscoveryRecord;
  if (!valid(record)) throw new Error("Invalid discovery record");
  return record;
}

export function createLoopbackDiscoveryStore(
  directory: string
): DiscoveryStore {
  const store = {
    read() {
      const db = openStore(directory);
      try {
        return get(db);
      } finally {
        db.close();
      }
    },
    publish(record: DiscoveryRecord, signal: AbortSignal) {
      if (!valid(record)) throw new Error("Invalid discovery record");
      if (signal.aborted) throw new Error("Discovery publication cancelled");
      const db = openStore(directory);
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          get(db);
          db.prepare(
            "INSERT OR REPLACE INTO discovery (id, host, port, capability) VALUES (1, ?, ?, ?)"
          ).run(record.host, record.port, record.capability);
          if (signal.aborted)
            throw new Error("Discovery publication cancelled");
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } finally {
        db.close();
      }
    },
    clear(record: DiscoveryRecord) {
      if (!valid(record)) throw new Error("Invalid discovery record");
      const db = openStore(directory);
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          get(db);
          db.prepare(
            "DELETE FROM discovery WHERE id = 1 AND host = ? AND port = ? AND capability = ?"
          ).run(record.host, record.port, record.capability);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } finally {
        db.close();
      }
    }
  };
  return {
    read: () => settle(() => store.read()),
    publish: (record, signal) => settle(() => store.publish(record, signal)),
    clear: (record) => settle(() => store.clear(record))
  };
}

function settle<T>(operation: () => T): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error))
    );
  }
}
