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
  store: PdsDesktopSecretStore,
  options?: {
    /** True when secret state from a pre-capability-pairing installation
     * exists outside this store. That state is never migrated (see ADR
     * 0044), so minting a new Authority key here would silently orphan an
     * existing Personal Device Group instead of failing visibly. */
    legacyStateDetected?: boolean;
  }
): Promise<void> => {
  const existing = await store.get(PDS_DESKTOP_AUTHORITY_SECRET_REFERENCE);
  if (existing) {
    if (!validAuthoritySecret(existing)) {
      throw new Error("Stored PDS Authority key is invalid.");
    }
    return;
  }
  if (options?.legacyStateDetected) {
    throw new Error(
      "Detected pre-upgrade PDS secret state with no Authority key in the " +
        "current store. Refusing to create a new Authority key automatically, " +
        "since that would leave an existing Personal Device Group unreachable. " +
        "See docs/configuration.md#personal-device-request-startup for the " +
        "explicit reset path."
    );
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
