import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject
} from "node:crypto";
import { z } from "zod";
import {
  canonicalizePdsJson,
  parseCanonicalPdsJson,
  parsePdsUint64
} from "./personal-device-sync-jcs.js";
import {
  verifyPeerOnlineCheckpoint,
  type PeerOnlineCheckpointInput
} from "./peer-online-checkpoint.js";
import { validatePeerOnlineBinding } from "./peer-online-deletion.js";
import {
  inspectPeerMembership,
  lookupHistoricalPeerMember,
  type PeerMembershipState
} from "./peer-online-membership.js";

const PROTOCOL = "koed/peer-online-payload/v1";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PLAINTEXT = 5 * 1024 * 1024;
const id = z.string().regex(/^[\x21-\x7e]{1,240}$/);
const encoded = (size: number) =>
  z
    .string()
    .refine(
      (s) =>
        s.length === Math.ceil((size * 4) / 3) &&
        Buffer.from(s, "base64url").length === size &&
        Buffer.from(s, "base64url").toString("base64url") === s
    );
const data = z
  .string()
  .refine(
    (s) =>
      s.length <= Math.ceil((MAX_PLAINTEXT * 4) / 3) &&
      Buffer.from(s, "base64url").toString("base64url") === s
  );
const contextSchema = z
  .object({
    groupId: id,
    originDeviceId: id,
    originSessionId: encoded(32),
    membershipHeadHash: encoded(32),
    bindingHash: encoded(32),
    sequence: z.string().refine((s) => {
      try {
        if (s.length > 20) return false;
        parsePdsUint64(s);
        return true;
      } catch {
        return false;
      }
    }),
    predecessorHash: encoded(32).nullable()
  })
  .strict();
const memberSchema = z
  .object({ deviceId: id, encryptionSpkiSha256: encoded(32) })
  .strict();
const authoritySchema = z
  .object({
    groupId: id,
    head: encoded(32),
    members: z.array(memberSchema).min(1).max(128)
  })
  .strict();
const wrapSchema = z
  .object({
    deviceId: id,
    encryptionSpkiSha256: encoded(32),
    nonce: encoded(12),
    ciphertext: encoded(32),
    tag: encoded(16)
  })
  .strict();
const payloadSchema = z
  .object({
    protocol: z.literal(PROTOCOL),
    context: contextSchema,
    ephemeralKey: encoded(32),
    recipients: z.array(wrapSchema).min(1).max(128),
    nonce: encoded(12),
    ciphertext: data,
    tag: encoded(16)
  })
  .strict();
export type PeerOnlinePayloadAuthority = z.infer<typeof authoritySchema>;
export type PeerOnlinePayloadRecipient = {
  deviceId: string;
  publicKey: KeyObject;
};
const bytes = (value: unknown) => Buffer.from(canonicalizePdsJson(value));
const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64url");
const decode = (value: string) => Buffer.from(value, "base64url");
function fingerprint(key: KeyObject): string {
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("base64url");
}
function checkAuthority(
  context: PeerOnlineCheckpointInput,
  authority: PeerOnlinePayloadAuthority
) {
  const c = contextSchema.parse(context);
  const a = authoritySchema.parse(authority);
  if (
    c.groupId !== a.groupId ||
    c.membershipHeadHash !== a.head ||
    new Set(a.members.map((m) => m.deviceId)).size !== a.members.length ||
    new Set(a.members.map((m) => m.encryptionSpkiSha256)).size !==
      a.members.length
  )
    throw new TypeError("invalid membership authority");
  return { context: c, authority: a };
}
function seal(key: Uint8Array, plain: Uint8Array, aad: Uint8Array) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    nonce: b64(nonce),
    ciphertext: b64(ciphertext),
    tag: b64(cipher.getAuthTag())
  };
}
function open(
  key: Uint8Array,
  value: { nonce: string; ciphertext: string; tag: string },
  aad: Uint8Array
): Buffer {
  const cipher = createDecipheriv("aes-256-gcm", key, decode(value.nonce));
  cipher.setAAD(aad);
  cipher.setAuthTag(decode(value.tag));
  let first: Buffer | undefined;
  let last: Buffer | undefined;
  try {
    first = cipher.update(decode(value.ciphertext));
    last = cipher.final();
    return Buffer.concat([first, last]);
  } finally {
    first?.fill(0);
    last?.fill(0);
  }
}
function wrapKey(
  privateKey: KeyObject,
  publicKey: KeyObject,
  aad: Buffer
): Buffer {
  const secret = diffieHellman({ privateKey, publicKey });
  try {
    if (secret.every((byte) => byte === 0))
      throw new TypeError("invalid X25519 shared secret");
    return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), aad, 32));
  } finally {
    secret.fill(0);
  }
}
function header(
  context: PeerOnlineCheckpointInput,
  ephemeralKey: string,
  members: { deviceId: string; encryptionSpkiSha256: string }[]
) {
  return { protocol: PROTOCOL, context, ephemeralKey, members };
}
/** Authority must come from independently validated, current, conflict-free membership. No rotation or replay state is provided. */
export function encryptPeerOnlinePayload(
  context: PeerOnlineCheckpointInput,
  plaintext: Uint8Array,
  authority: PeerOnlinePayloadAuthority,
  recipients: PeerOnlinePayloadRecipient[]
): Buffer {
  const checked = checkAuthority(context, authority);
  if (
    !(plaintext instanceof Uint8Array) ||
    plaintext.buffer instanceof SharedArrayBuffer ||
    plaintext.byteLength > MAX_PLAINTEXT ||
    !Array.isArray(recipients) ||
    recipients.length !== checked.authority.members.length
  )
    throw new TypeError("invalid payload or recipients");
  const members = [...checked.authority.members].sort((a, b) =>
    a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0
  );
  const keys = new Map(recipients.map((r) => [r.deviceId, r.publicKey]));
  if (keys.size !== recipients.length)
    throw new TypeError("duplicate recipient");
  for (const member of members) {
    const key = keys.get(member.deviceId);
    if (
      !key ||
      key.type !== "public" ||
      key.asymmetricKeyType !== "x25519" ||
      fingerprint(key) !== member.encryptionSpkiSha256
    )
      throw new TypeError("invalid recipient key");
  }
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralKey = ephemeral.publicKey.export({ format: "jwk" }).x!;
  const base = header(checked.context, ephemeralKey, members);
  const contentKey = randomBytes(32);
  try {
    const wraps = members.map((member) => {
      const aad = bytes({ ...base, recipient: member.deviceId });
      const key = wrapKey(
        ephemeral.privateKey,
        keys.get(member.deviceId)!,
        aad
      );
      try {
        return { ...member, ...seal(key, contentKey, aad) };
      } finally {
        key.fill(0);
      }
    });
    const encrypted = seal(
      contentKey,
      plaintext,
      bytes({ ...base, recipients: wraps })
    );
    const result = bytes({
      protocol: PROTOCOL,
      context: checked.context,
      ephemeralKey,
      recipients: wraps,
      ...encrypted
    });
    if (result.length > MAX_BYTES) throw new TypeError("payload too large");
    return result;
  } finally {
    contentKey.fill(0);
  }
}
// Bound structural work before JSON.parse and canonicalization, including signed malicious inputs.
function boundedJson(raw: string): boolean {
  let depth = 0;
  let structure = 0;
  let quoted = false;
  let escaped = false;
  for (const char of raw) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      if (++depth > 8 || ++structure > 4096) return false;
    } else if (char === "}" || char === "]") {
      if (--depth < 0) return false;
    } else if (char === "," || char === ":") {
      if (++structure > 4096) return false;
    }
  }
  return !quoted && depth === 0;
}
/**
 * Verify signed checkpoint and payload hash before parsing ciphertext. The origin
 * membership state must be independently anchored, reconciled and current, and
 * expected binding hash must be independently retained. Caller must atomically
 * enforce replay, chain, current membership and deletion fences, and limit concurrent
 * requests. Secret wiping is best effort; JS and OpenSSL may retain copies.
 */
export function decryptPeerOnlinePayload(
  envelope: string,
  payload: Uint8Array,
  expected: PeerOnlineCheckpointInput,
  authority: PeerOnlinePayloadAuthority,
  deviceId: string,
  privateKey: KeyObject,
  bindingJson: string,
  membership: PeerMembershipState
): Buffer | undefined {
  try {
    const checked = checkAuthority(expected, authority);
    if (
      !(payload instanceof Uint8Array) ||
      payload.buffer instanceof SharedArrayBuffer ||
      payload.byteLength > MAX_BYTES ||
      !id.safeParse(deviceId).success ||
      !privateKey ||
      privateKey.type !== "private" ||
      privateKey.asymmetricKeyType !== "x25519"
    )
      return undefined;
    const { groupId, originDeviceId, originSessionId, bindingHash } =
      checked.context;
    const view = inspectPeerMembership(membership);
    if (
      view.head !== checked.context.membershipHeadHash ||
      view.conflict ||
      view.incomplete ||
      !view.records.length
    )
      return undefined;
    const genesis = JSON.parse(view.records[0]!.json) as {
      unsigned: { groupId: string };
    };
    if (genesis.unsigned.groupId !== groupId) return undefined;
    const active = view.members
      .map(({ deviceId, encryptionSpkiSha256 }) => ({
        deviceId,
        encryptionSpkiSha256
      }))
      .sort((a, b) =>
        a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0
      );
    const supplied = [...checked.authority.members].sort((a, b) =>
      a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0
    );
    if (canonicalizePdsJson(active) !== canonicalizePdsJson(supplied))
      return undefined;
    if (!view.members.some((member) => member.deviceId === originDeviceId))
      return undefined;
    const origin = lookupHistoricalPeerMember(membership, originDeviceId);
    if (origin.status !== "found") return undefined;
    const binding = validatePeerOnlineBinding(bindingJson, (group, device) =>
      group === groupId && device === originDeviceId
        ? origin.member.signingPublicKey
        : undefined
    );
    if (
      !binding ||
      binding.bindingHash !== bindingHash ||
      binding.identity.groupId !== groupId ||
      binding.identity.originDeviceId !== originDeviceId ||
      binding.identity.originSessionId !== originSessionId
    )
      return undefined;
    const originPublicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: origin.member.signingPublicKey },
      format: "jwk"
    });
    const verified = verifyPeerOnlineCheckpoint(
      envelope,
      payload,
      { groupId, originDeviceId, originSessionId, bindingHash },
      originPublicKey
    );
    if (!verified) return undefined;
    const u = verified.unsigned;
    if (
      u.membershipHeadHash !== checked.context.membershipHeadHash ||
      u.sequence !== checked.context.sequence ||
      u.predecessorHash !== checked.context.predecessorHash
    )
      return undefined;
    const snapshot = verified.payload;
    const raw = snapshot.toString("utf8");
    if (!Buffer.from(raw, "utf8").equals(snapshot) || !boundedJson(raw))
      return undefined;
    const value = payloadSchema.parse(parseCanonicalPdsJson(raw));
    if (
      canonicalizePdsJson(value.context) !==
      canonicalizePdsJson(checked.context)
    )
      return undefined;
    const members = [...checked.authority.members].sort((a, b) =>
      a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0
    );
    if (
      canonicalizePdsJson(
        value.recipients.map(({ deviceId, encryptionSpkiSha256 }) => ({
          deviceId,
          encryptionSpkiSha256
        }))
      ) !== canonicalizePdsJson(members)
    )
      return undefined;
    const member = members.find((m) => m.deviceId === deviceId);
    const wrap = value.recipients.find((r) => r.deviceId === deviceId);
    if (
      !member ||
      !wrap ||
      fingerprint(createPublicKey(privateKey)) !== member.encryptionSpkiSha256
    )
      return undefined;
    const ephemeral = createPublicKey({
      key: { kty: "OKP", crv: "X25519", x: value.ephemeralKey },
      format: "jwk"
    });
    const base = header(checked.context, value.ephemeralKey, members);
    const aad = bytes({ ...base, recipient: deviceId });
    const key = wrapKey(privateKey, ephemeral, aad);
    let contentKey: Buffer;
    try {
      contentKey = open(key, wrap, aad);
    } finally {
      key.fill(0);
    }
    try {
      return open(
        contentKey,
        value,
        bytes({ ...base, recipients: value.recipients })
      );
    } finally {
      contentKey.fill(0);
    }
  } catch {
    return undefined;
  }
}
