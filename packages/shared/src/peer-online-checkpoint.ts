import { createHash, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { derivePeerSessionKey } from "./peer-online-deletion.js";
import {
  canonicalizePdsJson,
  parseCanonicalPdsJson,
  parsePdsUint64
} from "./personal-device-sync-jcs.js";

export const PEER_ONLINE_CHECKPOINT_PROTOCOL = "koed/peer-online-checkpoint/v1";
const MAX_ENVELOPE_BYTES = 16384;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const id = z.string().regex(/^[\x21-\x7e]{1,240}$/);
const encoded = (size: number) =>
  z.string().refine((value) => {
    if (value.length !== Math.ceil((size * 4) / 3)) return false;
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === size && bytes.toString("base64url") === value;
  });
const uint64 = z.string().refine((value) => {
  if (value.length > 20) return false;
  try {
    parsePdsUint64(value);
    return true;
  } catch {
    return false;
  }
});
const fields = {
  groupId: id,
  originDeviceId: id,
  originSessionId: encoded(32),
  membershipHeadHash: encoded(32),
  sequence: uint64,
  predecessorHash: encoded(32).nullable(),
  bindingHash: encoded(32)
};
const inputSchema = z.object(fields).strict();
const unsignedSchema = z
  .object({
    protocol: z.literal(PEER_ONLINE_CHECKPOINT_PROTOCOL),
    ...fields,
    sessionKey: encoded(32),
    payloadHash: encoded(32),
    payloadBytes: uint64
  })
  .strict();
const envelopeSchema = z
  .object({ unsigned: unsignedSchema, signature: encoded(64) })
  .strict();
export type PeerOnlineCheckpointInput = z.infer<typeof inputSchema>;
const expectedSchema = z
  .object({
    groupId: id,
    originDeviceId: id,
    originSessionId: encoded(32),
    bindingHash: encoded(32)
  })
  .strict();
export type PeerOnlineCheckpointExpected = z.infer<typeof expectedSchema>;
export type VerifiedPeerOnlineCheckpoint = {
  status: "accepted";
  unsigned: z.infer<typeof unsignedSchema>;
  payload: Buffer;
};
function sessionKey(value: PeerOnlineCheckpointInput): string {
  return derivePeerSessionKey({
    groupId: value.groupId,
    originDeviceId: value.originDeviceId,
    originSessionId: value.originSessionId
  });
}

function signingBytes(unsigned: z.infer<typeof unsignedSchema>): Buffer {
  return Buffer.from(
    `${PEER_ONLINE_CHECKPOINT_PROTOCOL}\n${canonicalizePdsJson(unsigned)}`
  );
}
function payloadHash(payload: Uint8Array): string {
  return createHash("sha256").update(payload).digest("base64url");
}
function validKey(key: KeyObject, type: "private" | "public"): boolean {
  return (
    key instanceof Object &&
    key.type === type &&
    key.asymmetricKeyType === "ed25519"
  );
}

/** Payload is already encrypted. Transmit the returned snapshot with the envelope. */
export function signPeerOnlineCheckpoint(
  input: PeerOnlineCheckpointInput,
  payload: Uint8Array,
  privateKey: KeyObject
): { envelope: string; payload: Buffer } {
  const fields = inputSchema.parse(input);
  if (
    !(payload instanceof Uint8Array) ||
    payload.byteLength > MAX_PAYLOAD_BYTES ||
    !validKey(privateKey, "private")
  )
    throw new TypeError("invalid checkpoint payload or signing key");
  const snapshot = Buffer.from(payload);
  const unsigned = unsignedSchema.parse({
    ...fields,
    protocol: PEER_ONLINE_CHECKPOINT_PROTOCOL,
    sessionKey: sessionKey(fields),
    payloadHash: payloadHash(snapshot),
    payloadBytes: String(snapshot.byteLength)
  });
  const signature = sign(null, signingBytes(unsigned), privateKey).toString(
    "base64url"
  );
  return {
    envelope: canonicalizePdsJson({ unsigned, signature }),
    payload: snapshot
  };
}

/**
 * Caller supplies a trusted, validated binding identity/hash and its independently
 * validated canonical non-identity prime-order origin Ed25519 public key. This
 * does not validate the binding itself. Apply the returned payload, not the input.
 * Atomic authorization, chain continuity, replay and deletion floors remain the
 * integration's responsibility.
 */
export function verifyPeerOnlineCheckpoint(
  json: string,
  payload: Uint8Array,
  expected: PeerOnlineCheckpointExpected,
  publicKey: KeyObject
): VerifiedPeerOnlineCheckpoint | undefined {
  try {
    if (
      typeof json !== "string" ||
      Buffer.byteLength(json) > MAX_ENVELOPE_BYTES ||
      !(payload instanceof Uint8Array) ||
      payload.byteLength > MAX_PAYLOAD_BYTES ||
      !expectedSchema.safeParse(expected).success ||
      !validKey(publicKey, "public")
    )
      return undefined;
    const snapshot = Buffer.from(payload);
    const envelope = envelopeSchema.parse(parseCanonicalPdsJson(json));
    const u = envelope.unsigned;
    if (
      u.groupId !== expected.groupId ||
      u.originDeviceId !== expected.originDeviceId ||
      u.originSessionId !== expected.originSessionId ||
      u.bindingHash !== expected.bindingHash ||
      u.sessionKey !== sessionKey(u) ||
      u.payloadBytes !== String(snapshot.byteLength) ||
      u.payloadHash !== payloadHash(snapshot) ||
      !verify(
        null,
        signingBytes(u),
        publicKey,
        Buffer.from(envelope.signature, "base64url")
      )
    )
      return undefined;
    return { status: "accepted", unsigned: u, payload: snapshot };
  } catch {
    return undefined;
  }
}
