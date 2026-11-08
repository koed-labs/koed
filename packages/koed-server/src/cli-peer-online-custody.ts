import { lstatSync } from "node:fs";
import { join } from "node:path";
import { createPdsApplicationSecretStore } from "@koed/shared";
import { parsePeerOnlineIdentity } from "./peer-online-identity.js";

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function privatePath(path: string, directory: boolean, empty = false): void {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    (!directory && (stat.nlink !== 1 || (empty && stat.size !== 0)))
  ) {
    throw new Error("Unsafe custody path.");
  }
}

function readSecret(root: string, name: string, reference: string): string {
  const value = createPdsApplicationSecretStore({
    rootPath: root,
    storeFilename: `${name}.json`,
    keyFilename: `${name}.key`,
    readOnly: true
  }).get(reference);
  if (value === null) throw new Error("Incomplete custody.");
  return value;
}

function inspectIdentity(root: string): string | undefined {
  const marker = join(root, "peer-online-identity");
  const secrets = join(root, "secrets");
  const state = join(secrets, "peer-online-identity.json");
  const key = join(secrets, "peer-online-identity.key");
  const lock = join(root, "peer-online-identity-init.lock");
  const assertIdle = () => {
    if (exists(lock)) throw new Error("Identity custody is busy.");
  };
  assertIdle();
  const present = [marker, state, key].map(exists);
  if (present.every((item) => !item)) {
    // An initializer may have taken the lock after the first check but before
    // creating any artifact; recheck so "missing" is never reported mid-create.
    assertIdle();
    return undefined;
  }
  if (!present.every(Boolean)) throw new Error("Incomplete identity custody.");
  privatePath(marker, true);
  privatePath(secrets, true);
  privatePath(state, false);
  privatePath(key, false);
  const identity = parsePeerOnlineIdentity(
    readSecret(root, "peer-online-identity", "peer-online-device-identity")
  );
  assertIdle();
  return identity.publicIdentity.deviceId;
}

async function inspectCertificate(root: string): Promise<boolean> {
  const directory = join(root, "peer-online-certificate");
  if (!exists(directory)) return false;
  const secrets = join(directory, "secrets");
  const pending = join(directory, "pending");
  if (exists(pending)) throw new Error("Certificate custody is busy.");
  privatePath(directory, true);
  privatePath(secrets, true);
  privatePath(join(directory, "committed"), false, true);
  privatePath(join(secrets, "peer-online-certificate.json"), false);
  privatePath(join(secrets, "peer-online-certificate.key"), false);
  const value = readSecret(
    directory,
    "peer-online-certificate",
    "peer-online-certificate"
  );
  // Loaded on demand so ordinary CLI startup never requires X.509 support.
  const { loadPeerOnlineCertificate } =
    await import("./peer-online-certificate.js");
  await loadPeerOnlineCertificate({
    read: () => Promise.resolve(value),
    create: () => Promise.reject(new Error("Read-only inspection."))
  });
  if (exists(pending)) throw new Error("Certificate custody is busy.");
  return true;
}

export class UnsupportedPeerOnlinePlatformError extends Error {}

export async function inspectPeerOnlineCustody(
  root: string
): Promise<{ deviceId?: string; certificate: boolean }> {
  if (process.platform === "win32" || typeof process.getuid !== "function")
    throw new UnsupportedPeerOnlinePlatformError();
  if (!exists(root)) return { certificate: false };
  privatePath(root, true);
  return {
    deviceId: inspectIdentity(root),
    certificate: await inspectCertificate(root)
  };
}
