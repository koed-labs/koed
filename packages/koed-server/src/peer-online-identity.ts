import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID
} from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createPdsApplicationSecretStore } from "@koed/shared";
import lockfile from "proper-lockfile";

export interface PeerOnlinePublicIdentity {
  deviceId: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
}

export interface PeerOnlineRuntimeKeys {
  signingPrivateKey: string;
  encryptionPrivateKey: string;
}

export interface PeerOnlineIdentity {
  publicIdentity: PeerOnlinePublicIdentity;
  getRuntimeKeys(): PeerOnlineRuntimeKeys;
}

type StoredIdentity = PeerOnlinePublicIdentity &
  PeerOnlineRuntimeKeys & { version: 1 };
const reference = "peer-online-device-identity";

// Check all existing ancestors before mkdir or lockfile can mutate the filesystem.
function validateAncestry(path: string): void {
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
      if (missing) {
        const uid = process.getuid?.();
        if (
          uid === undefined ||
          !stat.isDirectory() ||
          stat.uid !== uid ||
          (stat.mode & 0o022) !== 0
        ) {
          throw new Error(
            "Peer online identity creation requires a secure owned parent directory."
          );
        }
        missing = false;
      }
      if (stat.isSymbolicLink()) {
        if (stat.uid !== 0)
          throw new Error("Peer online identity path is unsafe.");
        validateAncestry(realpathSync(current));
      } else {
        const uid = process.getuid?.();
        if (
          !stat.isDirectory() ||
          (uid !== undefined && stat.uid !== uid && stat.uid !== 0) ||
          ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
        ) {
          throw new Error("Peer online identity path is unsafe.");
        }
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
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error("Peer online identity directory is not owner-private.");
  }
}

function directoryExists(path: string): boolean {
  try {
    privateDirectory(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function parsePeerOnlineIdentity(value: string): PeerOnlineIdentity {
  try {
    const data: unknown = JSON.parse(value);
    if (!data || typeof data !== "object") throw new Error();
    const record = data as Record<string, unknown>;
    const fields = [
      "deviceId",
      "signingPublicKey",
      "encryptionPublicKey",
      "signingPrivateKey",
      "encryptionPrivateKey"
    ] as const;
    if (
      record.version !== 1 ||
      Object.keys(record).length !== 6 ||
      fields.some((field) => typeof record[field] !== "string")
    )
      throw new Error();
    const stored = record as unknown as StoredIdentity;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        stored.deviceId
      )
    )
      throw new Error();
    for (const [privateKey, publicKey, algorithm] of [
      [stored.signingPrivateKey, stored.signingPublicKey, "ed25519"],
      [stored.encryptionPrivateKey, stored.encryptionPublicKey, "x25519"]
    ] as const) {
      const key = createPrivateKey({
        key: Buffer.from(privateKey, "base64"),
        format: "der",
        type: "pkcs8"
      });
      if (
        key.asymmetricKeyType !== algorithm ||
        key.export({ format: "der", type: "pkcs8" }).toString("base64") !==
          privateKey ||
        createPublicKey(key)
          .export({ format: "der", type: "spki" })
          .toString("base64") !== publicKey
      )
        throw new Error();
    }
    const publicIdentity = {
      deviceId: stored.deviceId,
      signingPublicKey: stored.signingPublicKey,
      encryptionPublicKey: stored.encryptionPublicKey
    };
    return {
      publicIdentity,
      getRuntimeKeys: () => ({
        signingPrivateKey: stored.signingPrivateKey,
        encryptionPrivateKey: stored.encryptionPrivateKey
      })
    };
  } catch {
    throw new Error("Peer online identity is corrupt or incomplete.");
  }
}

function generateIdentity(): StoredIdentity {
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  return {
    version: 1,
    deviceId: randomUUID(),
    signingPublicKey: signing.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    encryptionPublicKey: encryption.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    signingPrivateKey: signing.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    encryptionPrivateKey: encryption.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64")
  };
}

async function accessIdentity(
  rootPath: string,
  create: boolean
): Promise<PeerOnlineIdentity | null> {
  const root = resolve(rootPath);
  validateAncestry(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  privateDirectory(root);
  const store = createPdsApplicationSecretStore({
    rootPath: root,
    storeFilename: "peer-online-identity.json",
    keyFilename: "peer-online-identity.key"
  });
  // Validate the store's path ancestry before placing a lock in the home directory.
  store.get(reference);
  const release = await lockfile.lock(join(root, "peer-online-identity-init"), {
    realpath: false,
    stale: 30000,
    update: 10000,
    retries: { retries: 100, minTimeout: 20, maxTimeout: 100 }
  });
  try {
    const directory = join(root, "peer-online-identity");
    const exists = directoryExists(directory);
    const value = store.get(reference);
    if (!exists && value === null && !create) return null;
    if (exists || value !== null) {
      if (!exists || value === null)
        throw new Error("Peer online identity is corrupt or incomplete.");
      const identity = parsePeerOnlineIdentity(value);
      if (create) throw new Error("Peer online identity already exists.");
      return identity;
    }
    mkdirSync(directory, { mode: 0o700 });
    const identity = generateIdentity();
    store.put(reference, JSON.stringify(identity));
    return parsePeerOnlineIdentity(JSON.stringify(identity));
  } finally {
    await release();
  }
}

/**
 * The caller must establish fresh-install authorization independently of local
 * identity files. Storage loss and rollback cannot prove an installation fresh.
 * Before use, callers must bind the returned ID and public keys to trusted
 * enrollment/membership and transport credentials; this module does not do so.
 */
export async function createPeerOnlineIdentity(
  rootPath: string,
  authorizeFreshInstallation: () => Promise<boolean>
): Promise<PeerOnlineIdentity> {
  if (
    typeof authorizeFreshInstallation !== "function" ||
    (await authorizeFreshInstallation()) !== true
  ) {
    throw new Error("Fresh installation authorization required.");
  }
  const identity = await accessIdentity(rootPath, true);
  if (!identity) throw new Error("Peer online identity creation failed.");
  return identity;
}

/** Loaded identities must be checked against trusted enrollment before use. */
export async function loadPeerOnlineIdentity(
  rootPath: string
): Promise<PeerOnlineIdentity | null> {
  return accessIdentity(rootPath, false);
}
