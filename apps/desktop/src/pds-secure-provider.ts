import { safeStorage } from "electron";
import { chmodSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PdsSecretResolver } from "@koed/api/personal-device-sync/secure-runtime";

const isSafeSecretStore = (path: string): boolean => {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
};

/**
 * Main-process-only resolver. Secrets stay encrypted by macOS Keychain through
 * Electron safeStorage; resolver closure never crosses preload or renderer IPC.
 * Windows/Linux intentionally fail closed until equivalent audited provider lands.
 */
export const createPdsDesktopSecretResolver = (input: {
  userDataPath: string;
  platform: NodeJS.Platform;
}): PdsSecretResolver | null => {
  if (input.platform !== "darwin" || !safeStorage.isEncryptionAvailable()) {
    return null;
  }
  const storePath = resolve(input.userDataPath, "pds-secrets.json");
  return async (reference: string) => {
    if (!/^[A-Za-z0-9._-]{1,240}$/.test(reference) || !existsSync(storePath)) {
      return null;
    }
    if (!isSafeSecretStore(storePath)) return null;
    try {
      const encrypted = JSON.parse(readFileSync(storePath, "utf8")) as Record<
        string,
        unknown
      >;
      const value = encrypted[reference];
      if (typeof value !== "string" || value.length > 2_000_000) return null;
      // Reassert mode after opening; no secret material leaves this closure.
      chmodSync(storePath, 0o600);
      return safeStorage.decryptString(Buffer.from(value, "base64url"));
    } catch {
      return null;
    }
  };
};
