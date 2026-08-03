import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { PdsDesktopSecretStore } from "./pds-secure-provider.js";

export const PDS_DESKTOP_AUTHORITY_SECRET_REFERENCE = "pds-authority";

type AuthoritySecret = {
  version: 1;
  keyId: string;
  publicKey: string;
  privateSeed: string;
};

const validAuthoritySecret = (value: string): boolean => {
  try {
    const parsed = JSON.parse(value) as Partial<AuthoritySecret>;
    return (
      Object.keys(parsed).sort().join(",") ===
        "keyId,privateSeed,publicKey,version" &&
      parsed.version === 1 &&
      typeof parsed.keyId === "string" &&
      /^[0-9a-f-]{36}$/.test(parsed.keyId) &&
      typeof parsed.publicKey === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(parsed.publicKey) &&
      typeof parsed.privateSeed === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(parsed.privateSeed)
    );
  } catch {
    return false;
  }
};

export const ensurePdsDesktopAuthority = async (
  store: PdsDesktopSecretStore
): Promise<void> => {
  const existing = await store.get(PDS_DESKTOP_AUTHORITY_SECRET_REFERENCE);
  if (existing) {
    if (!validAuthoritySecret(existing)) {
      throw new Error("Stored PDS Authority key is invalid.");
    }
    return;
  }
  const key = generateKeyPairSync("ed25519").privateKey.export({
    format: "jwk"
  });
  if (typeof key.x !== "string" || typeof key.d !== "string") {
    throw new Error("Could not generate the PDS Authority key.");
  }
  const authority: AuthoritySecret = {
    version: 1,
    keyId: randomUUID(),
    publicKey: key.x,
    privateSeed: key.d
  };
  await store.put(
    PDS_DESKTOP_AUTHORITY_SECRET_REFERENCE,
    JSON.stringify(authority)
  );
  const verified = await store.get(PDS_DESKTOP_AUTHORITY_SECRET_REFERENCE);
  if (!verified || !validAuthoritySecret(verified)) {
    throw new Error("PDS Authority key verification failed.");
  }
};
