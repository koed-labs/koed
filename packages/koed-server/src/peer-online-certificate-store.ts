import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmdirSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createPdsApplicationSecretStore } from "@koed/shared";
import type { PeerOnlineCertificateStore } from "./peer-online-certificate.js";

const reference = "peer-online-certificate";
const incomplete = "Peer online certificate custody is incomplete or corrupt.";

function validateAncestry(path: string): void {
  if (process.platform === "win32" || typeof process.getuid !== "function")
    throw new Error("Peer online certificate store requires POSIX ownership.");
  let current = path;
  let missing = false;
  for (;;) {
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing = true;
    }
    if (stat) {
      if (
        missing &&
        (!stat.isDirectory() ||
          stat.uid !== process.getuid() ||
          (stat.mode & 0o022) !== 0)
      )
        throw new Error("Peer online certificate path has an unsafe parent.");
      missing = false;
      if (stat.isSymbolicLink()) {
        if (stat.uid !== 0)
          throw new Error("Peer online certificate path is unsafe.");
        validateAncestry(realpathSync(current));
      } else if (
        !stat.isDirectory() ||
        (stat.uid !== process.getuid() && stat.uid !== 0) ||
        ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
      ) {
        throw new Error("Peer online certificate path is unsafe.");
      }
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("Peer online certificate directory is unsafe.");
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

type StoreHooks = {
  afterMarkerCreated?: () => Promise<void>;
  beforeDirectorySync?: (path: string) => void;
};

function syncDirectory(path: string, hooks: StoreHooks): void {
  hooks.beforeDirectorySync?.(path);
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function prepareRoot(root: string, hooks: StoreHooks): void {
  validateAncestry(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  privateDirectory(root);
  // Other processes may observe newly created directories before their creator
  // has synced them, so each operation durably links the whole ancestry.
  let current = root;
  for (;;) {
    const parent = dirname(current);
    syncDirectory(parent, hooks);
    if (parent === current) break;
    current = parent;
  }
}

function assertPrivateFile(path: string, expectedSize?: number): void {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.nlink !== 1 ||
      (expectedSize !== undefined && stat.size !== expectedSize)
    )
      throw new Error(incomplete);
  } finally {
    closeSync(fd);
  }
}

function assertCustodyFiles(directory: string): void {
  privateDirectory(join(directory, "secrets"));
  assertPrivateFile(join(directory, "committed"), 0);
  assertPrivateFile(join(directory, "secrets", "peer-online-certificate.json"));
  assertPrivateFile(join(directory, "secrets", "peer-online-certificate.key"));
}

async function readCustody(
  root: string,
  hooks: StoreHooks
): Promise<string | null> {
  prepareRoot(root, hooks);
  const directory = join(root, "peer-online-certificate");
  if (!exists(directory)) return null;
  privateDirectory(directory);
  const ready = join(directory, "committed");
  const pending = join(directory, "pending");
  for (let i = 0; !exists(ready) || exists(pending); i++) {
    if (i >= 200) throw new Error(incomplete);
    await delay(10);
  }
  assertCustodyFiles(directory);
  // A writer may have removed pending before its final directory sync.
  syncDirectory(directory, hooks);
  const store = createPdsApplicationSecretStore({
    rootPath: directory,
    storeFilename: "peer-online-certificate.json",
    keyFilename: "peer-online-certificate.key"
  });
  const value = store.get(reference);
  assertCustodyFiles(directory);
  if (value === null) throw new Error(incomplete);
  return value;
}

/**
 * Complete deletion or rollback is indistinguishable from first use. The caller
 * must use independent fresh-install authorization and trusted enrollment.
 * Partial state is never removed automatically; recovery requires an operator
 * to investigate and restore custody from trusted backup or re-enroll.
 * Errors during publication have an ambiguous outcome; reload and verify.
 * Same-UID or privileged adversaries can race path checks, replace state, or
 * read keys and are outside this filesystem protection boundary.
 */
export function createPeerOnlineCertificateStore(
  rootPath: string,
  hooks: StoreHooks = {}
): PeerOnlineCertificateStore {
  const root = resolve(rootPath);
  return {
    read: () => readCustody(root, hooks),
    async create(value) {
      if (
        typeof value !== "string" ||
        Buffer.byteLength(value, "utf8") > 2_000_000
      )
        throw new Error("Certificate value is invalid or too large.");
      prepareRoot(root, hooks);
      const directory = join(root, "peer-online-certificate");
      try {
        mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await readCustody(root, hooks)) === null)
          throw new Error(incomplete, { cause: error });
        return false;
      }
      syncDirectory(root, hooks);
      privateDirectory(directory);
      const pending = join(directory, "pending");
      mkdirSync(pending, { mode: 0o700 });
      syncDirectory(directory, hooks);
      const store = createPdsApplicationSecretStore({
        rootPath: directory,
        storeFilename: "peer-online-certificate.json",
        keyFilename: "peer-online-certificate.key"
      });
      store.put(reference, value);
      // The shared store can suppress directory fsync errors; publication cannot.
      syncDirectory(join(directory, "secrets"), hooks);
      const ready = join(directory, "committed");
      const fd = openSync(ready, "wx", 0o600);
      try {
        writeFileSync(fd, "");
        await hooks.afterMarkerCreated?.();
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      syncDirectory(directory, hooks);
      assertCustodyFiles(directory);
      rmdirSync(pending);
      syncDirectory(directory, hooks);
      return true;
    }
  };
}
