import {
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject
} from "node:crypto";
import type { PeerOnlinePublicIdentity } from "./peer-online-identity.js";

type MemberBinding = {
  deviceId: string;
  signingPublicKey: string;
  encryptionSpkiSha256: string;
  transportSpkiSha256: string;
};

function parseSpki(bytes: Buffer, algorithm?: string): KeyObject {
  if (bytes.length > 1024) throw new Error("Invalid peer identity key");
  const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
  const canonical = key.export({ format: "der", type: "spki" });
  if (
    !canonical.equals(bytes) ||
    (algorithm && key.asymmetricKeyType !== algorithm)
  ) {
    throw new Error("Invalid peer identity key");
  }
  return key;
}

function decodePublicKey(value: string, algorithm: string): KeyObject {
  if (typeof value !== "string" || value.length > 1400)
    throw new Error("Invalid peer identity key");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value)
    throw new Error("Invalid peer identity key");
  return parseSpki(bytes, algorithm);
}

function fingerprint(key: KeyObject): string {
  return createHash("sha256")
    .update(key.export({ format: "der", type: "spki" }))
    .digest("base64url");
}

/** Check a local identity and its transport key against a validated active member. */
export function assertPeerOnlineIdentityBinding(
  identity: PeerOnlinePublicIdentity,
  member: MemberBinding,
  transportSpki: Buffer
): void {
  try {
    const signing = decodePublicKey(identity.signingPublicKey, "ed25519");
    const encryption = decodePublicKey(identity.encryptionPublicKey, "x25519");
    // OpenSSL rejects X25519 inputs that yield an all-zero shared secret.
    diffieHellman({
      privateKey: generateKeyPairSync("x25519").privateKey,
      publicKey: encryption
    });
    const transport = parseSpki(transportSpki);
    const details = transport.asymmetricKeyDetails;
    const validTransport =
      transport.asymmetricKeyType === "ed25519" ||
      (transport.asymmetricKeyType === "rsa" &&
        (details?.modulusLength ?? 0) >= 2048) ||
      (transport.asymmetricKeyType === "ec" &&
        details?.namedCurve === "prime256v1");
    if (!validTransport) throw new Error("Invalid transport key");
    if (
      identity.deviceId !== member.deviceId ||
      signing.export({ format: "jwk" }).x !== member.signingPublicKey ||
      fingerprint(encryption) !== member.encryptionSpkiSha256 ||
      fingerprint(transport) !== member.transportSpkiSha256
    )
      throw new Error("mismatch");
  } catch {
    throw new Error("Peer identity does not match enrolled membership.");
  }
}
