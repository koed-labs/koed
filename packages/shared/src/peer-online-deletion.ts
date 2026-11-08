import {
  createHash,
  createPublicKey,
  sign,
  verify,
  type KeyObject
} from "node:crypto";
import { z } from "zod";
import {
  canonicalizePdsJson,
  parseCanonicalPdsJson
} from "./personal-device-sync-jcs.js";

const BINDING = "koed/peer-online-session-binding/v1";
const DELETION = "koed/peer-online-deletion/v1";
const SESSION_KEY = "koed/peer-online-session-key/v1";
const MAX_BYTES = 16384;
const id = z.string().regex(/^[\x21-\x7e]{1,240}$/);
const encoded = (size: number) =>
  z.string().refine((value) => {
    if (value.length !== Math.ceil((size * 4) / 3)) return false;
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === size && bytes.toString("base64url") === value;
  });
const tupleSchema = z
  .object({ groupId: id, originDeviceId: id, originSessionId: encoded(32) })
  .strict();
const tupleFields = tupleSchema.shape;
const bindingSchema = z
  .object({
    unsigned: z
      .object({
        protocol: z.literal(BINDING),
        ...tupleFields,
        sessionKey: encoded(32),
        sourceIdentityCommitment: encoded(32)
      })
      .strict(),
    signature: encoded(64)
  })
  .strict();
const deletionSchema = z
  .object({
    unsigned: z
      .object({
        protocol: z.literal(DELETION),
        ...tupleFields,
        sessionKey: encoded(32),
        authorDeviceId: id,
        membershipHeadHash: encoded(32),
        eventId: encoded(32)
      })
      .strict(),
    signature: encoded(64)
  })
  .strict();
export type PeerSessionIdentity = z.infer<typeof tupleSchema>;
/** Stable identity of a group-wide deletion, independent of its author, head and signature. */
export type PeerDeletionIdentity = PeerSessionIdentity & {
  sessionKey: string;
  eventId: string;
};

/**
 * Parses the identity of a structurally valid deletion record without verifying
 * its signature. Callers must only use it on records already validated or stored
 * as a verified floor.
 */
export function peerOnlineDeletionIdentity(
  deletionJson: string
): PeerDeletionIdentity | undefined {
  if (
    typeof deletionJson !== "string" ||
    Buffer.byteLength(deletionJson) > MAX_BYTES
  )
    return undefined;
  try {
    const d = deletionSchema.parse(
      parseCanonicalPdsJson(deletionJson)
    ).unsigned;
    return {
      groupId: d.groupId,
      originDeviceId: d.originDeviceId,
      originSessionId: d.originSessionId,
      sessionKey: d.sessionKey,
      eventId: d.eventId
    };
  } catch {
    return undefined;
  }
}

export function samePeerOnlineDeletionIdentity(
  left: PeerDeletionIdentity,
  right: PeerDeletionIdentity
): boolean {
  return (
    left.groupId === right.groupId &&
    left.originDeviceId === right.originDeviceId &&
    left.originSessionId === right.originSessionId &&
    left.sessionKey === right.sessionKey &&
    left.eventId === right.eventId
  );
}
/** Trusted integration boundary; both lookups must be backed by authenticated identity and membership state. */
export type PeerDeletionAuthorization = {
  /** Return the authenticated origin identity key, including for a revoked origin. */
  historicalOriginKey: (
    groupId: string,
    deviceId: string
  ) => string | undefined;
  /** Return a key only for an active author at the verified, unconflicted current head. */
  currentAuthorKey: (
    groupId: string,
    membershipHeadHash: string,
    deviceId: string
  ) => string | undefined;
};

export function derivePeerSessionKey(identity: PeerSessionIdentity): string {
  const tuple = tupleSchema.parse(identity);
  return createHash("sha256")
    .update(`${SESSION_KEY}\n${canonicalizePdsJson(tuple)}`)
    .digest("base64url");
}

// Require canonical non-identity Edwards points in the prime-order subgroup.
const P = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const mod = (n: bigint) => ((n % P) + P) % P;
function power(a: bigint, n: bigint): bigint {
  let result = 1n;
  for (a = mod(a); n > 0n; n >>= 1n, a = mod(a * a))
    if (n & 1n) result = mod(result * a);
  return result;
}
const D = mod(-121665n * power(121666n, P - 2n));
type Point = [bigint, bigint, bigint, bigint];
function add([x1, y1, z1, t1]: Point, [x2, y2, z2, t2]: Point): Point {
  const a = mod((y1 - x1) * (y2 - x2)),
    b = mod((y1 + x1) * (y2 + x2));
  const c = mod(2n * D * t1 * t2),
    d = mod(2n * z1 * z2);
  const e = mod(b - a),
    f = mod(d - c),
    g = mod(d + c),
    h = mod(b + a);
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}
function validKey(value: string): boolean {
  if (!encoded(32).safeParse(value).success) return false;
  const bytes = Buffer.from(value, "base64url");
  const signBit = bytes[31]! >> 7;
  bytes[31] = bytes[31]! & 127;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]!);
  if (y >= P) return false;
  const y2 = mod(y * y),
    x2 = mod((y2 - 1n) * power(mod(D * y2 + 1n), P - 2n));
  let x = power(x2, (P + 3n) / 8n);
  if (mod(x * x - x2) !== 0n) x = mod(x * power(2n, (P - 1n) / 4n));
  if (mod(x * x - x2) !== 0n || (x === 0n && signBit === 1)) return false;
  if (Number(x & 1n) !== signBit) x = P - x;
  if (x === 0n && y === 1n) return false;
  let point: Point = [x, y, 1n, mod(x * y)],
    result: Point = [0n, 1n, 1n, 0n];
  for (let n = L; n > 0n; n >>= 1n) {
    if (n & 1n) result = add(result, point);
    point = add(point, point);
  }
  return result[0] === 0n && mod(result[1] - result[2]) === 0n;
}
function verifyRecord(
  domain: string,
  record: { unsigned: object; signature: string },
  key: string | undefined
): boolean {
  if (typeof key !== "string" || !validKey(key)) return false;
  try {
    return verify(
      null,
      Buffer.from(`${domain}\n${canonicalizePdsJson(record.unsigned)}`),
      createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: key },
        format: "jwk"
      }),
      Buffer.from(record.signature, "base64url")
    );
  } catch {
    return false;
  }
}

export function validatePeerOnlineBinding(
  json: string,
  historicalOriginKey: (groupId: string, deviceId: string) => string | undefined
):
  | {
      identity: PeerSessionIdentity;
      sessionKey: string;
      bindingHash: string;
      sourceIdentityCommitment: string;
    }
  | undefined {
  try {
    if (typeof json !== "string" || Buffer.byteLength(json) > MAX_BYTES)
      return undefined;
    const binding = bindingSchema.parse(parseCanonicalPdsJson(json));
    const { groupId, originDeviceId, originSessionId, sessionKey } =
      binding.unsigned;
    const identity = { groupId, originDeviceId, originSessionId };
    if (
      derivePeerSessionKey(identity) !== sessionKey ||
      !verifyRecord(
        BINDING,
        binding,
        historicalOriginKey(groupId, originDeviceId)
      )
    )
      return undefined;
    return {
      identity,
      sessionKey,
      sourceIdentityCommitment: binding.unsigned.sourceIdentityCommitment,
      bindingHash: createHash("sha256")
        .update(`${BINDING}/record\n${json}`)
        .digest("base64url")
    };
  } catch {
    return undefined;
  }
}

/**
 * This validator does not establish historical authorization, signing time,
 * ordering, persistence, or deletion. A historical origin key authenticates
 * identity only. Callers must atomically retain and compare binding hashes on
 * first acceptance and every checkpoint or deletion, and revalidate membership
 * under their transaction lock. Bound and rate-limit untrusted requests: key
 * subgroup validation performs synchronous curve arithmetic.
 */
export function validatePeerOnlineDeletion(
  bindingJson: string,
  deletionJson: string,
  membership: PeerDeletionAuthorization,
  expectedBindingHash?: string
):
  | {
      status: "accepted";
      sessionKey: string;
      eventHash: string;
      bindingHash: string;
      identity: PeerDeletionIdentity;
    }
  | { status: "invalid" } {
  const invalid = { status: "invalid" } as const;
  if (
    typeof bindingJson !== "string" ||
    typeof deletionJson !== "string" ||
    Buffer.byteLength(bindingJson) > MAX_BYTES ||
    Buffer.byteLength(deletionJson) > MAX_BYTES ||
    !membership ||
    typeof membership.historicalOriginKey !== "function" ||
    typeof membership.currentAuthorKey !== "function"
  )
    return invalid;
  try {
    const binding = bindingSchema.parse(parseCanonicalPdsJson(bindingJson));
    const deletion = deletionSchema.parse(parseCanonicalPdsJson(deletionJson));
    const b = binding.unsigned,
      d = deletion.unsigned;
    const identity = {
      groupId: d.groupId,
      originDeviceId: d.originDeviceId,
      originSessionId: d.originSessionId
    };
    if (
      b.groupId !== d.groupId ||
      b.originDeviceId !== d.originDeviceId ||
      b.originSessionId !== d.originSessionId ||
      b.sessionKey !== d.sessionKey ||
      derivePeerSessionKey(identity) !== d.sessionKey
    )
      return invalid;
    if (
      !verifyRecord(
        BINDING,
        binding,
        membership.historicalOriginKey(d.groupId, d.originDeviceId)
      ) ||
      !verifyRecord(
        DELETION,
        deletion,
        membership.currentAuthorKey(
          d.groupId,
          d.membershipHeadHash,
          d.authorDeviceId
        )
      )
    )
      return invalid;
    const bindingHash = createHash("sha256")
      .update(`${BINDING}/record\n${bindingJson}`)
      .digest("base64url");
    if (
      expectedBindingHash !== undefined &&
      expectedBindingHash !== bindingHash
    )
      return invalid;
    const eventHash = createHash("sha256")
      .update(`${DELETION}/record\n${deletionJson}`)
      .digest("base64url");
    return {
      status: "accepted",
      sessionKey: d.sessionKey,
      eventHash,
      bindingHash,
      identity: { ...identity, sessionKey: d.sessionKey, eventId: d.eventId }
    };
  } catch {
    return invalid;
  }
}

const DELETION_ACK = "koed/peer-online-deletion-ack/v1";
const ackSchema = z
  .object({
    unsigned: z
      .object({
        protocol: z.literal(DELETION_ACK),
        ...tupleFields,
        sessionKey: encoded(32),
        eventId: encoded(32),
        recipientDeviceId: id,
        appliedFloorHash: encoded(32),
        membershipHeadHash: encoded(32)
      })
      .strict(),
    signature: encoded(64)
  })
  .strict();
export type PeerDeletionAckFields = {
  identity: PeerDeletionIdentity;
  recipientDeviceId: string;
  appliedFloorHash: string;
  membershipHeadHash: string;
};

/** Signs a deletion acknowledgement. Emit only after the floor and hiding committed. */
export function signPeerOnlineDeletionAck(
  fields: PeerDeletionAckFields,
  privateKey: KeyObject
): { ack: string; ackHash: string } {
  const unsigned = ackSchema.shape.unsigned.parse({
    protocol: DELETION_ACK,
    ...fields.identity,
    recipientDeviceId: fields.recipientDeviceId,
    appliedFloorHash: fields.appliedFloorHash,
    membershipHeadHash: fields.membershipHeadHash
  });
  const ack = canonicalizePdsJson({
    unsigned,
    signature: sign(
      null,
      Buffer.from(`${DELETION_ACK}\n${canonicalizePdsJson(unsigned)}`),
      privateKey
    ).toString("base64url")
  });
  return { ack, ackHash: ackHash(ack) };
}

const ackHash = (json: string) =>
  createHash("sha256")
    .update(`${DELETION_ACK}/record\n${json}`)
    .digest("base64url");

/**
 * Verifies a deletion acknowledgement against the recipient's historical
 * signing key, so evidence signed before revocation stays valid. It does not
 * check roster membership, persistence or that the recipient still holds data.
 */
export function validatePeerOnlineDeletionAck(
  json: string,
  historicalRecipientKey: (
    groupId: string,
    deviceId: string
  ) => string | undefined
):
  | ({ status: "accepted"; ackHash: string } & PeerDeletionAckFields)
  | {
      status: "invalid";
    } {
  const invalid = { status: "invalid" } as const;
  if (
    typeof json !== "string" ||
    Buffer.byteLength(json) > MAX_BYTES ||
    typeof historicalRecipientKey !== "function"
  )
    return invalid;
  try {
    const record = ackSchema.parse(parseCanonicalPdsJson(json));
    const a = record.unsigned;
    const identity = {
      groupId: a.groupId,
      originDeviceId: a.originDeviceId,
      originSessionId: a.originSessionId
    };
    if (
      derivePeerSessionKey(identity) !== a.sessionKey ||
      !verifyRecord(
        DELETION_ACK,
        record,
        historicalRecipientKey(a.groupId, a.recipientDeviceId)
      )
    )
      return invalid;
    return {
      status: "accepted",
      ackHash: ackHash(json),
      identity: { ...identity, sessionKey: a.sessionKey, eventId: a.eventId },
      recipientDeviceId: a.recipientDeviceId,
      appliedFloorHash: a.appliedFloorHash,
      membershipHeadHash: a.membershipHeadHash
    };
  } catch {
    return invalid;
  }
}

/**
 * Signs a deletion record for an existing deletion identity at the given head.
 * Any active member holding the floor may author it; validation still requires
 * the author to be active at the receiver's current head.
 */
export function signPeerOnlineDeletion(
  fields: {
    identity: PeerDeletionIdentity;
    authorDeviceId: string;
    membershipHeadHash: string;
  },
  privateKey: KeyObject
): string {
  const unsigned = deletionSchema.shape.unsigned.parse({
    protocol: DELETION,
    ...fields.identity,
    authorDeviceId: fields.authorDeviceId,
    membershipHeadHash: fields.membershipHeadHash
  });
  return canonicalizePdsJson({
    unsigned,
    signature: sign(
      null,
      Buffer.from(`${DELETION}\n${canonicalizePdsJson(unsigned)}`),
      privateKey
    ).toString("base64url")
  });
}
