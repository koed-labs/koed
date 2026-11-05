import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import {
  canonicalizePdsJson,
  parseCanonicalPdsJson
} from "./personal-device-sync-jcs.js";

/**
 * Separate from PDS V1. Fingerprints are SHA-256 of DER SubjectPublicKeyInfo;
 * callers must independently verify key algorithm, possession, endpoint binding,
 * and User-approved pairing before using these commitments. Key uniqueness is
 * enforced within each branch only: conflicting branches can reuse or substitute
 * identities and evidence must not be merged by device ID or fingerprint. This
 * validator does not implement transport, persistence, pairing, fencing, or sync.
 */
export const PEER_MEMBERSHIP_PROTOCOL = "koed/peer-online-membership/v1";
const MAX_RECORD_BYTES = 16384;
const MAX_RECORDS = 1024;
const MAX_MEMBERS = 128;
const identifier = z.string().regex(/^[\x21-\x7e]{1,240}$/);
const encoded = (length: number) =>
  z.string().refine((s) => {
    if (s.length !== Math.ceil((length * 4) / 3)) return false;
    const bytes = Buffer.from(s, "base64url");
    return bytes.length === length && bytes.toString("base64url") === s;
  });
const memberSchema = z
  .object({
    deviceId: identifier,
    signingPublicKey: encoded(32),
    encryptionSpkiSha256: encoded(32),
    transportSpkiSha256: encoded(32)
  })
  .strict();
const bodySchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("genesis"), initialMember: memberSchema })
    .strict(),
  z.object({ kind: z.literal("add"), target: memberSchema }).strict(),
  z.object({ kind: z.literal("revoke"), targetDeviceId: identifier }).strict()
]);
const recordSchema = z
  .object({
    unsigned: z
      .object({
        protocol: z.literal(PEER_MEMBERSHIP_PROTOCOL),
        groupId: identifier,
        parentHash: encoded(32).nullable(),
        authorDeviceId: identifier,
        body: bodySchema
      })
      .strict(),
    signature: encoded(64)
  })
  .strict();
type RecordValue = z.infer<typeof recordSchema>;
export type PeerMembershipMember = z.infer<typeof memberSchema>;
export type PeerMembershipAnchor = { groupId: string; genesisHash: string };
type Snapshot = {
  active: Map<string, PeerMembershipMember>;
  used: Map<string, PeerMembershipMember>;
};
type Data = {
  groupId: string;
  records: Map<string, string>;
  snapshots: Map<string, Snapshot>;
  children: Set<string>;
  head: string;
  conflict: boolean;
  incomplete: boolean;
  limitEvidence?: string;
};
declare const brand: unique symbol;
export type PeerMembershipState = { readonly [brand]: true };
const states = new WeakMap<PeerMembershipState, Data>();
function wrap(data: Data): PeerMembershipState {
  const state = Object.freeze({}) as PeerMembershipState;
  states.set(state, data);
  return state;
}
function dataFor(state: PeerMembershipState): Data {
  const data = states.get(state);
  if (!data) throw new TypeError("invalid membership state");
  return data;
}
type InitResult =
  | { status: "accepted"; state: PeerMembershipState }
  | { status: "invalid" | "limit"; reason: string };
export type PeerMembershipResult =
  | { status: "accepted" | "duplicate"; state: PeerMembershipState }
  | { status: "pending"; state: PeerMembershipState; missingParent: string }
  | { status: "invalid" | "limit"; state: PeerMembershipState; reason: string };
function parse(json: string): RecordValue | undefined {
  try {
    return recordSchema.parse(parseCanonicalPdsJson(json));
  } catch {
    return undefined;
  }
}
function hash(record: RecordValue): string {
  return createHash("sha256")
    .update(
      `${PEER_MEMBERSHIP_PROTOCOL}/record\n${canonicalizePdsJson(record.unsigned)}`
    )
    .digest("base64url");
}
// Decode canonical Edwards points and require the prime-order subgroup. OpenSSL's
// Ed25519 verifier alone accepts low-order keys and trivially forged signatures.
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
function addPoint([x1, y1, z1, t1]: Point, [x2, y2, z2, t2]: Point): Point {
  const a = mod((y1 - x1) * (y2 - x2));
  const b = mod((y1 + x1) * (y2 + x2));
  const c = mod(2n * D * t1 * t2);
  const d = mod(2n * z1 * z2);
  const e = mod(b - a);
  const f = mod(d - c);
  const g = mod(d + c);
  const h = mod(b + a);
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}
/** Require a canonical encoded, non-identity Ed25519 prime-subgroup point. */
export function isValidPeerEd25519PublicKey(value: string): boolean {
  if (typeof value !== "string" || value.length !== 43) return false;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value)
    return false;
  const signBit = bytes[31]! >> 7;
  bytes[31] = bytes[31]! & 127;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]!);
  if (y >= P) return false;
  const y2 = mod(y * y);
  const x2 = mod((y2 - 1n) * power(mod(D * y2 + 1n), P - 2n));
  let x = power(x2, (P + 3n) / 8n);
  if (mod(x * x - x2) !== 0n) x = mod(x * power(2n, (P - 1n) / 4n));
  if (mod(x * x - x2) !== 0n || (x === 0n && signBit === 1)) return false;
  if (Number(x & 1n) !== signBit) x = P - x;
  if (x === 0n && y === 1n) return false;
  let point: Point = [x, y, 1n, mod(x * y)];
  let result: Point = [0n, 1n, 1n, 0n];
  for (let n = L; n > 0n; n >>= 1n) {
    if (n & 1n) result = addPoint(result, point);
    point = addPoint(point, point);
  }
  return result[0] === 0n && mod(result[1] - result[2]) === 0n;
}
function memberFingerprints(member: PeerMembershipMember): string[] {
  const signingSpki = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: member.signingPublicKey },
    format: "jwk"
  }).export({ type: "spki", format: "der" });
  return [
    createHash("sha256").update(signingSpki).digest("base64url"),
    member.encryptionSpkiSha256,
    member.transportSpkiSha256
  ];
}
function validMember(
  member: PeerMembershipMember,
  used: Map<string, PeerMembershipMember>
): boolean {
  if (
    !isValidPeerEd25519PublicKey(member.signingPublicKey) ||
    used.has(member.deviceId)
  )
    return false;
  const fingerprints = memberFingerprints(member);
  if (new Set(fingerprints).size !== fingerprints.length) return false;
  return ![...used.values()].some((existing) =>
    memberFingerprints(existing).some((fingerprint) =>
      fingerprints.includes(fingerprint)
    )
  );
}
function validSignature(record: RecordValue, publicKey: string): boolean {
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: publicKey },
      format: "jwk"
    });
    return verify(
      null,
      Buffer.from(
        `${PEER_MEMBERSHIP_PROTOCOL}/decision\n${canonicalizePdsJson(record.unsigned)}`
      ),
      key,
      Buffer.from(record.signature, "base64url")
    );
  } catch {
    return false;
  }
}
/** Anchor must be obtained through an independently trusted channel. Input must be canonical JSON. */
export function initializePeerMembership(
  anchor: PeerMembershipAnchor,
  json: string
): InitResult {
  if (
    typeof json !== "string" ||
    json.length > MAX_RECORD_BYTES ||
    Buffer.byteLength(json) > MAX_RECORD_BYTES
  )
    return { status: "limit", reason: "record too large or not a string" };
  const parsed = parse(json);
  if (!parsed) return { status: "invalid", reason: "invalid canonical record" };
  const u = parsed.unsigned;
  if (
    !anchor ||
    u.groupId !== anchor.groupId ||
    hash(parsed) !== anchor.genesisHash ||
    u.parentHash !== null ||
    u.body.kind !== "genesis" ||
    u.authorDeviceId !== u.body.initialMember.deviceId ||
    !validMember(u.body.initialMember, new Map()) ||
    !validSignature(parsed, u.body.initialMember.signingPublicKey)
  )
    return { status: "invalid", reason: "invalid genesis or anchor" };
  const active = new Map([
    [u.body.initialMember.deviceId, u.body.initialMember]
  ]);
  return {
    status: "accepted",
    state: wrap({
      groupId: u.groupId,
      records: new Map([[anchor.genesisHash, json]]),
      snapshots: new Map([
        [anchor.genesisHash, { active, used: new Map(active) }]
      ]),
      children: new Set(),
      head: anchor.genesisHash,
      conflict: false,
      incomplete: false
    })
  };
}
function nextSnapshot(
  parent: Snapshot,
  record: RecordValue
): Snapshot | undefined {
  const active = new Map(parent.active);
  const used = new Map(parent.used);
  const body = record.unsigned.body;
  if (body.kind === "add") {
    if (!validMember(body.target, used)) return undefined;
    active.set(body.target.deviceId, body.target);
    used.set(body.target.deviceId, body.target);
  } else if (body.kind === "revoke") {
    if (
      !active.has(body.targetDeviceId) ||
      body.targetDeviceId === record.unsigned.authorDeviceId
    )
      return undefined;
    active.delete(body.targetDeviceId);
  } else return undefined;
  return { active, used };
}
/**
 * Pending is unauthenticated and leaves state unchanged. An independently authenticated
 * session must gate sync until catch-up completes; do not persist a group-wide pause
 * based on arbitrary pending packets. This module does not implement that gate.
 *
 * Limits: 16 KiB per record, 1024 accepted records, 128 lifetime identities per
 * branch including revoked members. Authenticated overflow makes state incomplete
 * and retains only the first overflow record; later evidence is not evaluated or
 * retained. No durable evidence store or recovery path is provided here.
 */
export function applyPeerMembership(
  state: PeerMembershipState,
  json: string
): PeerMembershipResult {
  const data = dataFor(state);
  const invalid = (reason: string): PeerMembershipResult => ({
    status: "invalid",
    state,
    reason
  });
  if (data.incomplete)
    return { status: "limit", state, reason: "history incomplete" };
  if (
    typeof json !== "string" ||
    json.length > MAX_RECORD_BYTES ||
    Buffer.byteLength(json) > MAX_RECORD_BYTES
  )
    return {
      status: "limit",
      state,
      reason: "record too large or not a string"
    };
  const parsed = parse(json);
  if (!parsed) return invalid("invalid canonical record");
  const u = parsed.unsigned;
  if (
    u.groupId !== data.groupId ||
    u.parentHash === null ||
    u.body.kind === "genesis"
  )
    return invalid("invalid group or record kind");
  const parent = data.snapshots.get(u.parentHash);
  if (!parent) return { status: "pending", state, missingParent: u.parentHash };
  const author = parent.active.get(u.authorDeviceId);
  if (!author || !validSignature(parsed, author.signingPublicKey))
    return invalid("unauthorized author or invalid signature");
  const digest = hash(parsed);
  if (data.records.has(digest)) return { status: "duplicate", state };
  const snapshot = nextSnapshot(parent, parsed);
  if (!snapshot) return invalid("invalid membership change or member limit");
  if (data.records.size >= MAX_RECORDS || snapshot.used.size > MAX_MEMBERS)
    return {
      status: "limit",
      state: wrap({ ...data, incomplete: true, limitEvidence: json }),
      reason: "authenticated history resource limit"
    };
  const conflict = data.conflict || data.children.has(u.parentHash);
  return {
    status: "accepted",
    state: wrap({
      ...data,
      records: new Map(data.records).set(digest, json),
      snapshots: new Map(data.snapshots).set(digest, snapshot),
      children: new Set(data.children).add(u.parentHash),
      head: digest,
      conflict
    })
  };
}
/**
 * Returns an authenticated lifetime identity for verification only, not current
 * membership or write authority. Callers must independently ensure authenticated
 * catch-up and freshness; this state cannot detect withheld history or rollback.
 */
export function lookupHistoricalPeerMember(
  state: PeerMembershipState,
  deviceId: string
):
  | { status: "found"; member: Readonly<PeerMembershipMember> }
  | { status: "not_found" | "unavailable" } {
  const data = dataFor(state);
  if (data.conflict || data.incomplete) return { status: "unavailable" };
  const member = data.snapshots.get(data.head)!.used.get(deviceId);
  return member
    ? { status: "found", member: Object.freeze({ ...member }) }
    : { status: "not_found" };
}

/** Returns copies, including canonical evidence; conflict always suppresses effective members. */
export function inspectPeerMembership(state: PeerMembershipState): {
  conflict: boolean;
  incomplete: boolean;
  head: string | null;
  members: PeerMembershipMember[];
  records: { hash: string; json: string }[];
  limitEvidence?: string;
} {
  const data = dataFor(state);
  return {
    conflict: data.conflict,
    incomplete: data.incomplete,
    head: data.conflict || data.incomplete ? null : data.head,
    members:
      data.conflict || data.incomplete
        ? []
        : [...data.snapshots.get(data.head)!.active.values()].map((member) => ({
            ...member
          })),
    records: [...data.records].map(([hash, json]) => ({ hash, json })),
    ...(data.limitEvidence ? { limitEvidence: data.limitEvidence } : {})
  };
}
