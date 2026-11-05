import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  timingSafeEqual,
  verify,
  type KeyObject
} from "node:crypto";
import { isValidPeerEd25519PublicKey } from "@koed/shared";

export type PairingIdentity = {
  deviceId: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
  transportPin: string;
};

export type PairingTranscript = {
  groupId: string;
  genesisHash: string;
  expectedHead: string;
  attemptId: string;
  expiresAt: number;
  inviteHash: string;
  connectionBinding: string;
  approver: PairingIdentity;
  joiner: PairingIdentity;
  challengePublicKey: string;
};

export type PairingProof = { mac: string; signature: string };

function fixed(value: string, size: number): Buffer {
  if (typeof value !== "string" || value.length > 128)
    throw new Error("Invalid pairing value");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== size || bytes.toString("base64url") !== value)
    throw new Error("Invalid pairing value");
  return bytes;
}

function publicKey(value: string, algorithm: string): KeyObject {
  if (typeof value !== "string" || value.length > 128)
    throw new Error("Invalid pairing key");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value)
    throw new Error("Invalid pairing key");
  const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
  if (
    key.asymmetricKeyType !== algorithm ||
    !key.export({ format: "der", type: "spki" }).equals(bytes)
  )
    throw new Error("Invalid pairing key");
  return key;
}

function identity(value: PairingIdentity): string[] {
  if (
    !value ||
    typeof value.deviceId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(value.deviceId)
  )
    throw new Error("Invalid pairing identity");
  const signing = publicKey(value.signingPublicKey, "ed25519");
  const raw = signing.export({ format: "jwk" }).x;
  if (!raw || !isValidPeerEd25519PublicKey(raw))
    throw new Error("Invalid pairing signing key");
  publicKey(value.encryptionPublicKey, "x25519");
  fixed(value.transportPin, 32);
  return [
    value.deviceId,
    value.signingPublicKey,
    value.encryptionPublicKey,
    value.transportPin
  ];
}

/** Canonical, domain-separated bytes for an independently authenticated ceremony. */
export function encodePairingTranscript(transcript: PairingTranscript): Buffer {
  if (
    !transcript ||
    typeof transcript.groupId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(transcript.groupId) ||
    !Number.isSafeInteger(transcript.expiresAt) ||
    transcript.expiresAt <= 0
  )
    throw new Error("Invalid pairing transcript");
  for (const value of [
    transcript.genesisHash,
    transcript.expectedHead,
    transcript.attemptId,
    transcript.inviteHash,
    transcript.connectionBinding
  ])
    fixed(value, 32);
  const approver = identity(transcript.approver);
  const joiner = identity(transcript.joiner);
  if (approver[0] === joiner[0]) throw new Error("Invalid pairing identities");
  publicKey(transcript.challengePublicKey, "x25519");
  return Buffer.from(
    JSON.stringify([
      "koed/peer-online-pairing/v1/transcript",
      transcript.groupId,
      transcript.genesisHash,
      transcript.expectedHead,
      transcript.attemptId,
      transcript.expiresAt,
      transcript.inviteHash,
      transcript.connectionBinding,
      approver,
      joiner,
      transcript.challengePublicKey
    ]),
    "utf8"
  );
}

/**
 * Checks key possession only. This is not admission authorization: callers must
 * independently authenticate the invite, TLS channel, local approval and transcript,
 * enforce bounded attempts and expiry, and consume the attempt atomically. The
 * challenge private key must be freshly generated and retained by the verifier.
 */
export function verifyPairingProof(
  transcript: PairingTranscript,
  proof: PairingProof,
  challengePrivateKey: string,
  now: number
): boolean {
  try {
    const bytes = encodePairingTranscript(transcript);
    if (!Number.isSafeInteger(now) || now < 0 || now >= transcript.expiresAt)
      return false;
    if (
      typeof challengePrivateKey !== "string" ||
      challengePrivateKey.length > 128
    )
      return false;
    const encoded = Buffer.from(challengePrivateKey, "base64");
    if (encoded.toString("base64") !== challengePrivateKey) return false;
    const privateKey = createPrivateKey({
      key: encoded,
      format: "der",
      type: "pkcs8"
    });
    if (
      privateKey.asymmetricKeyType !== "x25519" ||
      !privateKey.export({ format: "der", type: "pkcs8" }).equals(encoded) ||
      createPublicKey(privateKey)
        .export({ format: "der", type: "spki" })
        .toString("base64") !== transcript.challengePublicKey
    )
      return false;
    const shared = diffieHellman({
      privateKey,
      publicKey: publicKey(transcript.joiner.encryptionPublicKey, "x25519")
    });
    const mac = fixed(proof.mac, 32);
    const expected = createHmac("sha256", shared)
      .update("koed/peer-online-pairing/v1/x25519\n")
      .update(bytes)
      .digest();
    shared.fill(0);
    if (!timingSafeEqual(mac, expected)) return false;
    return verify(
      null,
      Buffer.concat([
        Buffer.from("koed/peer-online-pairing/v1/signature\n"),
        bytes,
        mac
      ]),
      publicKey(transcript.joiner.signingPublicKey, "ed25519"),
      fixed(proof.signature, 64)
    );
  } catch {
    return false;
  }
}
