import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  verify,
  type KeyObject
} from "node:crypto";
import {
  PDS_PROTOCOL,
  decodePdsBase64url,
  pdsEd25519PublicKey,
  signPdsRecord
} from "./personal-device-sync.js";
import {
  canonicalizePdsJson,
  parseCanonicalPdsJson,
  parsePdsUint64,
  pdsUint64be
} from "./personal-device-sync-jcs.js";

export const PDS_SESSION_PACKAGE_VERSION = "1" as const;
export const PDS_SESSION_PACKAGE_MAX_BYTES = 64 * 1024 * 1024;
export const PDS_SESSION_PACKAGE_MAX_CHUNK_BYTES = 512 * 1024;
export const PDS_SESSION_PACKAGE_MAX_CHUNKS = 128;
export const PDS_SESSION_PACKAGE_MAX_CONTROL_BYTES = 1024 * 1024;
export const PDS_SESSION_PACKAGE_MAX_JSON_BYTES =
  Math.ceil((PDS_SESSION_PACKAGE_MAX_BYTES * 4) / 3) +
  2 * PDS_SESSION_PACKAGE_MAX_CONTROL_BYTES;

const opaqueIdPattern = /^[\x21-\x7e]{1,240}$/;
const sourceMetadataKeys = new Set([
  "contentType",
  "sourceRole",
  "toolCallId",
  "toolName"
]);

type JsonRecord = Record<string, unknown>;
type Signature = { signerKeyId: string; signature: string };

export interface PdsConversationSourceItem {
  sourceNativeItemId: string;
  sequence: string;
  sourceTimestamp: string;
  observedAt: string;
  actor: string;
  type: string;
  content: string;
  metadata: Partial<
    Record<"contentType" | "sourceRole" | "toolCallId" | "toolName", string>
  >;
}

export interface PdsClosedSessionMetadata {
  closed: true;
  sourceAdapter: string;
  sourceAdapterVersion: string;
  captureMethod: "supported_capture_hook";
  sourceCreatedAt: string;
  sourceClosedAt: string;
  observedClosedAt: string;
}

export interface PdsProjectAliasManifest {
  version: "1";
  epoch: string;
  tokens: string[];
}

export interface PdsSessionManifest {
  protocol: typeof PDS_PROTOCOL;
  packageId: string;
  originDeploymentId: string;
  originDeviceId: string;
  sourceSequence: string;
  sourceType: "captured_session";
  sourceNativeSessionId: string;
  sourceFingerprint: string;
  logicalMemoryId: string;
  deletionFloorToken: string;
  sourceClosureHash: string;
  contentEpoch: string;
  projectAliasManifest?: PdsProjectAliasManifest;
  closedSession: PdsClosedSessionMetadata;
  terminal: { cursor: string; itemCount: string };
  rawClosure: {
    recordCount: string;
    rawByteCount: string;
    records: PdsRawSourceRecord[];
  };
  originSignature: Signature;
}

export interface PdsRawSourceRecord {
  ordinal: string;
  sourceNativeItemId: string;
  sourceTimestamp: string;
  observedAt: string;
  payload: string;
  payloadHash: string;
}

export interface PdsSessionRecipient {
  deviceId: string;
  kemKeyId: string;
  kemPublicKey: string;
}

export interface PdsSessionPackageHeader {
  protocol: typeof PDS_PROTOCOL;
  version: typeof PDS_SESSION_PACKAGE_VERSION;
  transportId: string;
  groupId: string;
  packageId: string;
  sourceManifestHash: string;
  originDeviceId: string;
  contentEpoch: string;
  recipientEpoch: string;
  plaintextByteCount: string;
  chunkCount: string;
  payloadNonce: string;
  payloadCiphertextHash: string;
  payloadTag: string;
  expiresAt: string;
  servingDeviceId: string;
  servingSigningKeyId: string;
  authorityHead: string;
  intendedRecipientSnapshot: string[];
  intendedRecipientSnapshotHash: string;
  servingSignature: Signature;
}

export interface PdsSessionRecipientEnvelope {
  protocol: typeof PDS_PROTOCOL;
  version: typeof PDS_SESSION_PACKAGE_VERSION;
  transportId: string;
  packageId: string;
  contentEpoch: string;
  recipientEpoch: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  recipientKemKeyId: string;
  ephemeralPublicKey: string;
  nonce: string;
  ciphertext: string;
  tag: string;
  servingSignature: Signature;
}

export interface PdsSessionPackageChunk {
  protocol: typeof PDS_PROTOCOL;
  version: typeof PDS_SESSION_PACKAGE_VERSION;
  transportId: string;
  groupId: string;
  packageId: string;
  chunkIndex: string;
  chunkCount: string;
  ciphertext: string;
  chunkHash: string;
}

export interface PdsSessionPackage {
  header: PdsSessionPackageHeader;
  envelopes: PdsSessionRecipientEnvelope[];
  chunks: PdsSessionPackageChunk[];
  packageDigest: string;
}

export interface PdsRetainedSessionPackage {
  version: typeof PDS_SESSION_PACKAGE_VERSION;
  originManifest: PdsSessionManifest;
  package: PdsSessionPackage;
  localEncryption?: {
    provider: string;
    reference: string;
  };
}

export interface CreatePdsSessionManifestInput {
  originDeploymentId: string;
  originDeviceId: string;
  sourceSequence: string;
  sourceNativeSessionId: string;
  contentEpoch: string;
  closedSession: PdsClosedSessionMetadata;
  terminalCursor: string;
  items: PdsConversationSourceItem[];
  sourceFingerprintKey: string | Buffer;
  tombstoneFloorKey: string | Buffer;
  originSigningKeyId: string;
  originSigningPrivateKey: KeyObject;
  projectAliasManifest?: PdsProjectAliasManifest;
}

export interface CreatePdsSessionPackageInput {
  groupId: string;
  authorityHead: string;
  expiresAt: string;
  currentEpoch: string;
  servingDeviceId: string;
  servingSigningKeyId: string;
  servingSigningPrivateKey: KeyObject;
  recipients: PdsSessionRecipient[];
  manifest: PdsSessionManifest;
}

export interface PdsSessionPackageReplayEntry {
  packageId: string;
  sourceManifestHash: string;
}

export type PdsSessionPackageReplayResult = "new" | "idempotent" | "quarantine";

export interface VerifyPdsSessionPackageInput {
  groupId: string;
  authorityHead: string;
  currentEpoch: string;
  recipientDeviceId: string;
  recipientKemKeyId: string;
  recipientKemPrivateKey: string | Buffer;
  recipientKemPublicKey: string | Buffer;
  recipientSnapshot: string[];
  servingDeviceId: string;
  servingSigningPublicKey: string | Buffer;
  servingSigningKeyId: string;
  originSigningPublicKey: string | Buffer;
  originSigningKeyId: string;
  now?: Date;
  deletionFloor?: { logicalMemoryId: string; deletionFloorToken: string };
}

const own = (value: unknown, label: string): JsonRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`PDS ${label} must be a plain object`);
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`PDS ${label} must be a plain object`);
  }
  return value as JsonRecord;
};

const exact = (
  value: JsonRecord,
  fields: readonly string[],
  label: string
): void => {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, i) => key !== expected[i])
  ) {
    throw new TypeError(`PDS ${label} has unknown or missing fields`);
  }
};

const requireId = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !opaqueIdPattern.test(value)) {
    throw new TypeError(`PDS ${label} is invalid`);
  }
  return value;
};

const requireUint64 = (value: unknown, label: string): string => {
  if (typeof value !== "string")
    throw new TypeError(`PDS ${label} must be decimal`);
  parsePdsUint64(value);
  return value;
};

const requireIso = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`PDS ${label} must be RFC3339 UTC milliseconds`);
  }
  return value;
};

const requireHash = (value: unknown, label: string, length = 32): string => {
  if (typeof value !== "string") throw new TypeError(`PDS ${label} is invalid`);
  decodePdsBase64url(value, length);
  return value;
};

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("base64url");

const bytes = (value: unknown): Buffer =>
  Buffer.from(canonicalizePdsJson(value), "utf8");

const assertControlSize = (value: unknown, label: string): void => {
  if (bytes(value).length > PDS_SESSION_PACKAGE_MAX_CONTROL_BYTES) {
    throw new RangeError(`PDS ${label} exceeds control size limit`);
  }
};

const assertSortedUnique = (values: string[], label: string): void => {
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new TypeError(`PDS ${label} must be unique and non-empty`);
  }
  if (values.join("\0") !== [...values].sort().join("\0")) {
    throw new TypeError(`PDS ${label} must be ASCII sorted`);
  }
};

const x25519PublicKey = (raw: string | Buffer): KeyObject => {
  const value = typeof raw === "string" ? decodePdsBase64url(raw, 32) : raw;
  if (value.length !== 32)
    throw new TypeError("PDS X25519 public key is invalid");
  return createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: value.toString("base64url") },
    format: "jwk"
  });
};

const x25519PrivateKey = (
  seed: string | Buffer,
  publicKey: string | Buffer
): KeyObject => {
  const d = typeof seed === "string" ? decodePdsBase64url(seed, 32) : seed;
  const x =
    typeof publicKey === "string"
      ? decodePdsBase64url(publicKey, 32)
      : publicKey;
  if (d.length !== 32 || x.length !== 32)
    throw new TypeError("PDS X25519 private key is invalid");
  return createPrivateKey({
    key: {
      kty: "OKP",
      crv: "X25519",
      d: d.toString("base64url"),
      x: x.toString("base64url")
    },
    format: "jwk"
  });
};

const generatedX25519 = (): { privateKey: KeyObject; publicKey: string } => {
  const pair = generateKeyPairSync("x25519");
  const jwk = pair.publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string")
    throw new Error("PDS X25519 public export failed");
  decodePdsBase64url(jwk.x, 32);
  return { privateKey: pair.privateKey, publicKey: jwk.x };
};

const sharedSecret = (privateKey: KeyObject, publicKey: KeyObject): Buffer => {
  const secret = diffieHellman({ privateKey, publicKey });
  if (secret.length !== 32 || secret.every((byte) => byte === 0)) {
    throw new TypeError("PDS X25519 shared secret must be 32 non-zero bytes");
  }
  return secret;
};

const aesEncrypt = (
  key: Buffer,
  plaintext: Buffer,
  nonce: Buffer,
  aad: Buffer
) => {
  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: 16
  });
  cipher.setAAD(aad);
  return {
    ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]),
    tag: cipher.getAuthTag()
  };
};

const aesDecrypt = (
  key: Buffer,
  ciphertext: Buffer,
  nonce: Buffer,
  tag: Buffer,
  aad: Buffer
): Buffer => {
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
    authTagLength: 16
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
};

const signature = (value: unknown): Signature => {
  const wrapper = own(value, "signature");
  exact(wrapper, ["signerKeyId", "signature"], "signature");
  requireId(wrapper.signerKeyId, "signerKeyId");
  requireHash(wrapper.signature, "signature", 64);
  return wrapper as Signature;
};

const without = (value: object, field: string): JsonRecord => {
  const copy = { ...(value as JsonRecord) };
  delete copy[field];
  return copy;
};

const verifyRecord = (
  recordType: "source-manifest" | "transport-envelope",
  unsigned: JsonRecord,
  wrapper: Signature,
  publicKey: string | Buffer
): void => {
  const valid = verify(
    null,
    Buffer.from(
      `${PDS_PROTOCOL}/${recordType}\n${canonicalizePdsJson(unsigned)}`,
      "utf8"
    ),
    pdsEd25519PublicKey(publicKey),
    decodePdsBase64url(wrapper.signature, 64)
  );
  if (!valid) throw new TypeError(`PDS ${recordType} signature is invalid`);
};

const validateMetadata = (value: unknown): Record<string, string> => {
  const metadata = own(value, "source item metadata");
  for (const [key, item] of Object.entries(metadata)) {
    if (
      !sourceMetadataKeys.has(key) ||
      typeof item !== "string" ||
      item.length > 240
    ) {
      throw new TypeError("PDS source item metadata is invalid");
    }
  }
  return metadata as Record<string, string>;
};

export const validatePdsConversationSourceItem = (
  value: unknown
): PdsConversationSourceItem => {
  const item = own(value, "source item");
  exact(
    item,
    [
      "sourceNativeItemId",
      "sequence",
      "sourceTimestamp",
      "observedAt",
      "actor",
      "type",
      "content",
      "metadata"
    ],
    "source item"
  );
  requireId(item.sourceNativeItemId, "sourceNativeItemId");
  requireUint64(item.sequence, "source item sequence");
  const sourceTimestamp = requireIso(item.sourceTimestamp, "sourceTimestamp");
  const observedAt = requireIso(item.observedAt, "observedAt");
  if (Date.parse(sourceTimestamp) > Date.parse(observedAt)) {
    throw new TypeError("PDS source item observation precedes source time");
  }
  for (const field of ["actor", "type"]) requireId(item[field], field);
  if (
    typeof item.content !== "string" ||
    Buffer.byteLength(item.content, "utf8") >
      PDS_SESSION_PACKAGE_MAX_CHUNK_BYTES
  ) {
    throw new TypeError("PDS source item content is invalid");
  }
  validateMetadata(item.metadata);
  assertControlSize(item, "source item");
  return item as unknown as PdsConversationSourceItem;
};

const validateClosedSession = (value: unknown): PdsClosedSessionMetadata => {
  const session = own(value, "closed session");
  exact(
    session,
    [
      "closed",
      "sourceAdapter",
      "sourceAdapterVersion",
      "captureMethod",
      "sourceCreatedAt",
      "sourceClosedAt",
      "observedClosedAt"
    ],
    "closed session"
  );
  if (
    session.closed !== true ||
    session.captureMethod !== "supported_capture_hook"
  ) {
    throw new TypeError("PDS session is not eligible for capture");
  }
  for (const field of ["sourceAdapter", "sourceAdapterVersion"])
    requireId(session[field], field);
  for (const field of ["sourceCreatedAt", "sourceClosedAt", "observedClosedAt"])
    requireIso(session[field], field);
  const createdAt = Date.parse(session.sourceCreatedAt as string);
  const closedAt = Date.parse(session.sourceClosedAt as string);
  const observedAt = Date.parse(session.observedClosedAt as string);
  if (createdAt > closedAt || closedAt > observedAt) {
    throw new TypeError("PDS session closure timestamps are invalid");
  }
  return session as unknown as PdsClosedSessionMetadata;
};

const validateProjectAliases = (
  value: unknown,
  epoch: string
): PdsProjectAliasManifest => {
  const manifest = own(value, "project alias manifest");
  exact(manifest, ["version", "epoch", "tokens"], "project alias manifest");
  if (
    manifest.version !== "1" ||
    manifest.epoch !== epoch ||
    !Array.isArray(manifest.tokens) ||
    manifest.tokens.length > 16
  ) {
    throw new TypeError("PDS project alias manifest is invalid");
  }
  const tokens = manifest.tokens.map((token) =>
    requireHash(token, "project alias token")
  );
  assertSortedUnique(tokens, "project alias tokens");
  return manifest as unknown as PdsProjectAliasManifest;
};

const sourceItemRecord = (
  item: PdsConversationSourceItem
): PdsRawSourceRecord => {
  const payload = bytes(item);
  return {
    ordinal: item.sequence,
    sourceNativeItemId: item.sourceNativeItemId,
    sourceTimestamp: item.sourceTimestamp,
    observedAt: item.observedAt,
    payload: payload.toString("base64url"),
    payloadHash: sha256(payload)
  };
};

export const pdsSourceFingerprint = (
  key: string | Buffer,
  sourceNativeSessionId: string
): string => {
  requireId(sourceNativeSessionId, "sourceNativeSessionId");
  const secret = typeof key === "string" ? decodePdsBase64url(key, 32) : key;
  if (secret.length !== 32)
    throw new TypeError("PDS source fingerprint key is invalid");
  return createHmac("sha256", secret)
    .update(
      `${PDS_PROTOCOL}/source-fingerprint\0captured_session\0${sourceNativeSessionId}`,
      "utf8"
    )
    .digest("base64url");
};

const pdsTombstoneValue = (
  key: string | Buffer,
  label: string,
  sourceFingerprint: string
): string => {
  const secret = typeof key === "string" ? decodePdsBase64url(key, 32) : key;
  if (secret.length !== 32) throw new TypeError("PDS tombstone key is invalid");
  return createHmac("sha256", secret)
    .update(`${PDS_PROTOCOL}/${label}\0${sourceFingerprint}`, "utf8")
    .digest("base64url");
};

export const pdsLogicalMemoryId = (
  key: string | Buffer,
  sourceFingerprint: string
): string =>
  pdsTombstoneValue(
    key,
    "logical-memory-id",
    requireHash(sourceFingerprint, "sourceFingerprint")
  );

export const pdsDeletionFloorToken = (
  key: string | Buffer,
  sourceFingerprint: string
): string =>
  pdsTombstoneValue(
    key,
    "deletion-floor",
    requireHash(sourceFingerprint, "sourceFingerprint")
  );

export const pdsProjectAliasToken = (
  key: string | Buffer,
  alias: string
): string => {
  if (typeof alias !== "string" || alias.length === 0 || alias.length > 1_024)
    throw new TypeError("PDS project alias is invalid");
  const secret = typeof key === "string" ? decodePdsBase64url(key, 32) : key;
  if (secret.length !== 32)
    throw new TypeError("PDS project alias key is invalid");
  return createHmac("sha256", secret)
    .update(`${PDS_PROTOCOL}/project-alias\0${alias}`, "utf8")
    .digest("base64url");
};

const sourceClosureHash = (records: PdsRawSourceRecord[]): string =>
  sha256(bytes(records));

const sourcePackageId = (
  manifest: Omit<PdsSessionManifest, "originSignature">
): string =>
  sha256(
    Buffer.concat([
      Buffer.from(`${PDS_PROTOCOL}/package-id\n`, "utf8"),
      bytes(without(manifest, "packageId"))
    ])
  );

const sourceManifestHash = (manifest: PdsSessionManifest): string =>
  sha256(bytes(without(manifest, "originSignature")));

const preparedSourceClosure = (
  input: CreatePdsSessionManifestInput
): {
  records: PdsRawSourceRecord[];
  rawByteCount: number;
} => {
  requireUint64(input.terminalCursor, "terminal cursor");
  if (
    input.items.length === 0 ||
    input.items.length > PDS_SESSION_PACKAGE_MAX_CHUNKS * 1_024
  ) {
    throw new RangeError("PDS source item count is invalid");
  }
  const records = input.items
    .map(validatePdsConversationSourceItem)
    .map(sourceItemRecord);
  records.forEach((record, index) => {
    if (record.ordinal !== String(index))
      throw new TypeError("PDS source item sequence is not contiguous");
  });
  if (input.terminalCursor !== String(records.length))
    throw new TypeError("PDS terminal cursor is inconsistent");
  const rawByteCount = records.reduce(
    (total, record) => total + decodePdsBase64url(record.payload).length,
    0
  );
  if (rawByteCount > PDS_SESSION_PACKAGE_MAX_BYTES)
    throw new RangeError("PDS source closure exceeds package limit");
  return { records, rawByteCount };
};

const unsignedSourceManifest = (
  input: CreatePdsSessionManifestInput,
  closure: ReturnType<typeof preparedSourceClosure>
): Omit<PdsSessionManifest, "originSignature"> => {
  const fingerprint = pdsSourceFingerprint(
    input.sourceFingerprintKey,
    input.sourceNativeSessionId
  );
  const manifest = {
    protocol: PDS_PROTOCOL,
    packageId: "",
    originDeploymentId: input.originDeploymentId,
    originDeviceId: input.originDeviceId,
    sourceSequence: input.sourceSequence,
    sourceType: "captured_session" as const,
    sourceNativeSessionId: input.sourceNativeSessionId,
    sourceFingerprint: fingerprint,
    logicalMemoryId: pdsLogicalMemoryId(input.tombstoneFloorKey, fingerprint),
    deletionFloorToken: pdsDeletionFloorToken(
      input.tombstoneFloorKey,
      fingerprint
    ),
    sourceClosureHash: sourceClosureHash(closure.records),
    contentEpoch: input.contentEpoch,
    ...(input.projectAliasManifest
      ? { projectAliasManifest: input.projectAliasManifest }
      : {}),
    closedSession: input.closedSession,
    terminal: {
      cursor: input.terminalCursor,
      itemCount: String(closure.records.length)
    },
    rawClosure: {
      recordCount: String(closure.records.length),
      rawByteCount: String(closure.rawByteCount),
      records: closure.records
    }
  } as Omit<PdsSessionManifest, "originSignature">;
  manifest.packageId = sourcePackageId(manifest);
  return manifest;
};

export const createPdsSessionManifest = (
  input: CreatePdsSessionManifestInput
): PdsSessionManifest => {
  requireId(input.originDeploymentId, "originDeploymentId");
  requireId(input.originDeviceId, "originDeviceId");
  requireUint64(input.sourceSequence, "sourceSequence");
  requireId(input.sourceNativeSessionId, "sourceNativeSessionId");
  requireUint64(input.contentEpoch, "contentEpoch");
  requireId(input.originSigningKeyId, "originSigningKeyId");
  validateClosedSession(input.closedSession);
  if (input.projectAliasManifest)
    validateProjectAliases(input.projectAliasManifest, input.contentEpoch);
  const unsigned = unsignedSourceManifest(input, preparedSourceClosure(input));
  const manifest = {
    ...unsigned,
    originSignature: {
      signerKeyId: input.originSigningKeyId,
      signature: signPdsRecord(
        "source-manifest",
        unsigned,
        input.originSigningPrivateKey
      )
    }
  } as PdsSessionManifest;
  return validatePdsSessionManifest(manifest);
};

const validateRawRecord = (
  value: unknown,
  index: number
): PdsRawSourceRecord => {
  const record = own(value, "raw source record");
  exact(
    record,
    [
      "ordinal",
      "sourceNativeItemId",
      "sourceTimestamp",
      "observedAt",
      "payload",
      "payloadHash"
    ],
    "raw source record"
  );
  if (requireUint64(record.ordinal, "raw ordinal") !== String(index))
    throw new TypeError("PDS raw closure is not contiguous");
  requireId(record.sourceNativeItemId, "raw source ID");
  requireIso(record.sourceTimestamp, "raw source timestamp");
  requireIso(record.observedAt, "raw observed timestamp");
  const payload = decodePdsBase64url(record.payload);
  if (
    payload.length === 0 ||
    payload.length > PDS_SESSION_PACKAGE_MAX_CHUNK_BYTES ||
    sha256(payload) !== requireHash(record.payloadHash, "payload hash")
  ) {
    throw new TypeError("PDS raw source payload is invalid");
  }
  const item = validatePdsConversationSourceItem(
    parseCanonicalPdsJson(payload.toString("utf8"))
  );
  if (
    item.sequence !== record.ordinal ||
    item.sourceNativeItemId !== record.sourceNativeItemId ||
    item.sourceTimestamp !== record.sourceTimestamp ||
    item.observedAt !== record.observedAt
  ) {
    throw new TypeError("PDS raw source payload does not bind record");
  }
  return record as unknown as PdsRawSourceRecord;
};

const sourceManifestFields = [
  "protocol",
  "packageId",
  "originDeploymentId",
  "originDeviceId",
  "sourceSequence",
  "sourceType",
  "sourceNativeSessionId",
  "sourceFingerprint",
  "logicalMemoryId",
  "deletionFloorToken",
  "sourceClosureHash",
  "contentEpoch",
  "closedSession",
  "terminal",
  "rawClosure",
  "originSignature"
];

const validateManifestIdentity = (manifest: JsonRecord): void => {
  exact(
    manifest,
    "projectAliasManifest" in manifest
      ? [...sourceManifestFields, "projectAliasManifest"]
      : sourceManifestFields,
    "source manifest"
  );
  if (
    manifest.protocol !== PDS_PROTOCOL ||
    manifest.sourceType !== "captured_session"
  ) {
    throw new TypeError("PDS source manifest protocol is invalid");
  }
  for (const field of [
    "originDeploymentId",
    "originDeviceId",
    "sourceNativeSessionId"
  ])
    requireId(manifest[field], field);
  for (const field of ["sourceSequence", "contentEpoch"])
    requireUint64(manifest[field], field);
  for (const field of [
    "packageId",
    "sourceFingerprint",
    "logicalMemoryId",
    "deletionFloorToken",
    "sourceClosureHash"
  ])
    requireHash(manifest[field], field);
  validateClosedSession(manifest.closedSession);
  if ("projectAliasManifest" in manifest) {
    validateProjectAliases(
      manifest.projectAliasManifest,
      manifest.contentEpoch as string
    );
  }
};

const validateManifestClosure = (manifest: JsonRecord): void => {
  const terminal = own(manifest.terminal, "terminal");
  exact(terminal, ["cursor", "itemCount"], "terminal");
  requireUint64(terminal.cursor, "terminal cursor");
  requireUint64(terminal.itemCount, "terminal item count");
  const closure = own(manifest.rawClosure, "raw closure");
  exact(closure, ["recordCount", "rawByteCount", "records"], "raw closure");
  requireUint64(closure.recordCount, "record count");
  requireUint64(closure.rawByteCount, "raw byte count");
  if (
    !Array.isArray(closure.records) ||
    closure.records.length === 0 ||
    closure.records.length > PDS_SESSION_PACKAGE_MAX_CHUNKS * 1_024
  ) {
    throw new TypeError("PDS raw closure records are invalid");
  }
  const records = closure.records.map(validateRawRecord);
  const rawByteCount = records.reduce(
    (total, record) => total + decodePdsBase64url(record.payload).length,
    0
  );
  if (
    closure.recordCount !== String(records.length) ||
    closure.rawByteCount !== String(rawByteCount) ||
    rawByteCount > PDS_SESSION_PACKAGE_MAX_BYTES
  ) {
    throw new TypeError("PDS raw closure count is invalid");
  }
  if (
    terminal.itemCount !== closure.recordCount ||
    terminal.cursor !== closure.recordCount ||
    manifest.sourceClosureHash !== sourceClosureHash(records)
  ) {
    throw new TypeError("PDS source closure hash is invalid");
  }
};

const validateManifestPackageId = (manifest: JsonRecord): void => {
  const unsigned = without(manifest, "originSignature") as Omit<
    PdsSessionManifest,
    "originSignature"
  >;
  if (manifest.packageId !== sourcePackageId(unsigned)) {
    throw new TypeError("PDS source package ID is invalid");
  }
  signature(manifest.originSignature);
  if (bytes(manifest).length > PDS_SESSION_PACKAGE_MAX_BYTES) {
    throw new RangeError("PDS source manifest exceeds package size limit");
  }
};

export const validatePdsSessionManifest = (
  value: unknown
): PdsSessionManifest => {
  const manifest = own(value, "source manifest");
  validateManifestIdentity(manifest);
  validateManifestClosure(manifest);
  validateManifestPackageId(manifest);
  return manifest as unknown as PdsSessionManifest;
};

export const verifyPdsSessionManifest = (
  value: unknown,
  originSigningPublicKey: string | Buffer,
  expectedOriginSigningKeyId: string
): PdsSessionManifest => {
  const manifest = validatePdsSessionManifest(value);
  if (manifest.originSignature.signerKeyId !== expectedOriginSigningKeyId)
    throw new TypeError("PDS origin signing key does not match");
  verifyRecord(
    "source-manifest",
    without(manifest, "originSignature"),
    manifest.originSignature,
    originSigningPublicKey
  );
  return manifest;
};

const envelopeAad = (
  envelope: Pick<
    PdsSessionRecipientEnvelope,
    "recipientEpoch" | "packageId" | "recipientDeviceId" | "senderDeviceId"
  >
): Buffer =>
  bytes({
    recipientEpoch: envelope.recipientEpoch,
    packageId: envelope.packageId,
    recipientDeviceId: envelope.recipientDeviceId,
    senderDeviceId: envelope.senderDeviceId
  });

const envelopeKey = (
  shared: Buffer,
  groupId: string,
  envelope: Pick<
    PdsSessionRecipientEnvelope,
    "recipientEpoch" | "packageId" | "recipientDeviceId" | "senderDeviceId"
  >
): Buffer => {
  const salt = createHash("sha256")
    .update(`${PDS_PROTOCOL}/envelope/salt\0${groupId}`, "utf8")
    .digest();
  const info = Buffer.concat([
    Buffer.from(`${PDS_PROTOCOL}/envelope/key\0`, "utf8"),
    pdsUint64be(envelope.recipientEpoch),
    Buffer.from(envelope.packageId, "utf8"),
    Buffer.from("\0", "utf8"),
    Buffer.from(envelope.recipientDeviceId, "utf8"),
    Buffer.from("\0", "utf8"),
    Buffer.from(envelope.senderDeviceId, "utf8")
  ]);
  return Buffer.from(hkdfSync("sha256", shared, salt, info, 32));
};

const headerAad = (header: PdsSessionPackageHeader): Buffer =>
  bytes(
    without(
      without(without(header, "payloadCiphertextHash"), "payloadTag"),
      "servingSignature"
    )
  );

const headerUnsigned = (
  input: Omit<
    PdsSessionPackageHeader,
    "payloadCiphertextHash" | "payloadTag" | "servingSignature"
  >
): JsonRecord => ({ ...input });

const validateHeader = (value: unknown): PdsSessionPackageHeader => {
  const header = own(value, "transport header");
  exact(
    header,
    [
      "protocol",
      "version",
      "transportId",
      "groupId",
      "packageId",
      "sourceManifestHash",
      "originDeviceId",
      "contentEpoch",
      "recipientEpoch",
      "plaintextByteCount",
      "chunkCount",
      "payloadNonce",
      "payloadCiphertextHash",
      "payloadTag",
      "expiresAt",
      "servingDeviceId",
      "servingSigningKeyId",
      "authorityHead",
      "intendedRecipientSnapshot",
      "intendedRecipientSnapshotHash",
      "servingSignature"
    ],
    "transport header"
  );
  if (
    header.protocol !== PDS_PROTOCOL ||
    header.version !== PDS_SESSION_PACKAGE_VERSION
  )
    throw new TypeError("PDS transport version is invalid");
  for (const field of [
    "transportId",
    "packageId",
    "sourceManifestHash",
    "authorityHead",
    "payloadCiphertextHash"
  ])
    requireHash(header[field], field);
  for (const field of [
    "groupId",
    "originDeviceId",
    "servingDeviceId",
    "servingSigningKeyId"
  ])
    requireId(header[field], field);
  for (const field of [
    "contentEpoch",
    "recipientEpoch",
    "plaintextByteCount",
    "chunkCount"
  ])
    requireUint64(header[field], field);
  if (
    parsePdsUint64(header.plaintextByteCount as string) >
      BigInt(PDS_SESSION_PACKAGE_MAX_BYTES) ||
    parsePdsUint64(header.chunkCount as string) < 1n ||
    parsePdsUint64(header.chunkCount as string) >
      BigInt(PDS_SESSION_PACKAGE_MAX_CHUNKS)
  )
    throw new RangeError("PDS transport bounds are invalid");
  requireHash(header.payloadNonce, "payload nonce", 12);
  requireHash(header.payloadTag, "payload tag", 16);
  requireIso(header.expiresAt, "transport expiry");
  if (!Array.isArray(header.intendedRecipientSnapshot))
    throw new TypeError("PDS recipient snapshot is invalid");
  const snapshot = header.intendedRecipientSnapshot.map((id) =>
    requireId(id, "recipient snapshot member")
  );
  assertSortedUnique(snapshot, "recipient snapshot");
  if (
    sha256(bytes(snapshot)) !==
    requireHash(header.intendedRecipientSnapshotHash, "recipient snapshot hash")
  )
    throw new TypeError("PDS recipient snapshot hash is invalid");
  signature(header.servingSignature);
  assertControlSize(header, "transport header");
  return header as unknown as PdsSessionPackageHeader;
};

const validateEnvelope = (value: unknown): PdsSessionRecipientEnvelope => {
  const envelope = own(value, "recipient envelope");
  exact(
    envelope,
    [
      "protocol",
      "version",
      "transportId",
      "packageId",
      "contentEpoch",
      "recipientEpoch",
      "senderDeviceId",
      "recipientDeviceId",
      "recipientKemKeyId",
      "ephemeralPublicKey",
      "nonce",
      "ciphertext",
      "tag",
      "servingSignature"
    ],
    "recipient envelope"
  );
  if (
    envelope.protocol !== PDS_PROTOCOL ||
    envelope.version !== PDS_SESSION_PACKAGE_VERSION
  )
    throw new TypeError("PDS recipient envelope version is invalid");
  for (const field of ["transportId", "packageId"])
    requireHash(envelope[field], field);
  for (const field of ["contentEpoch", "recipientEpoch"])
    requireUint64(envelope[field], field);
  for (const field of [
    "senderDeviceId",
    "recipientDeviceId",
    "recipientKemKeyId"
  ])
    requireId(envelope[field], field);
  requireHash(envelope.ephemeralPublicKey, "ephemeral public key");
  requireHash(envelope.nonce, "envelope nonce", 12);
  requireHash(envelope.ciphertext, "envelope ciphertext", 32);
  requireHash(envelope.tag, "envelope tag", 16);
  signature(envelope.servingSignature);
  assertControlSize(envelope, "recipient envelope");
  return envelope as unknown as PdsSessionRecipientEnvelope;
};

const validateChunk = (
  value: unknown,
  index: number,
  header: PdsSessionPackageHeader
): PdsSessionPackageChunk => {
  const chunk = own(value, "package chunk");
  exact(
    chunk,
    [
      "protocol",
      "version",
      "transportId",
      "groupId",
      "packageId",
      "chunkIndex",
      "chunkCount",
      "ciphertext",
      "chunkHash"
    ],
    "package chunk"
  );
  if (
    chunk.protocol !== PDS_PROTOCOL ||
    chunk.version !== PDS_SESSION_PACKAGE_VERSION ||
    chunk.transportId !== header.transportId ||
    chunk.groupId !== header.groupId ||
    chunk.packageId !== header.packageId ||
    chunk.chunkIndex !== String(index) ||
    chunk.chunkCount !== header.chunkCount
  )
    throw new TypeError("PDS package chunk binding is invalid");
  const ciphertext = decodePdsBase64url(chunk.ciphertext);
  if (
    ciphertext.length === 0 ||
    ciphertext.length > PDS_SESSION_PACKAGE_MAX_CHUNK_BYTES ||
    sha256(ciphertext) !== requireHash(chunk.chunkHash, "chunk hash")
  )
    throw new TypeError("PDS package chunk is invalid");
  return chunk as unknown as PdsSessionPackageChunk;
};

const packagePreimage = (
  pkg: Omit<PdsSessionPackage, "packageDigest">
): JsonRecord => ({
  header: pkg.header,
  envelopes: pkg.envelopes,
  chunks: pkg.chunks
});

export const pdsSessionPackageDigest = (
  value: Omit<PdsSessionPackage, "packageDigest">
): string => sha256(bytes(packagePreimage(value)));

export const validatePdsSessionPackage = (
  value: unknown
): PdsSessionPackage => {
  const pkg = own(value, "session package");
  exact(
    pkg,
    ["header", "envelopes", "chunks", "packageDigest"],
    "session package"
  );
  const header = validateHeader(pkg.header);
  if (
    !Array.isArray(pkg.envelopes) ||
    pkg.envelopes.length !== header.intendedRecipientSnapshot.length
  )
    throw new TypeError("PDS recipient envelopes are invalid");
  const envelopes = pkg.envelopes.map(validateEnvelope);
  const recipients = envelopes.map((envelope) => envelope.recipientDeviceId);
  if (recipients.join("\0") !== header.intendedRecipientSnapshot.join("\0"))
    throw new TypeError("PDS recipient envelopes do not match snapshot");
  for (const envelope of envelopes) {
    if (
      envelope.transportId !== header.transportId ||
      envelope.packageId !== header.packageId ||
      envelope.contentEpoch !== header.contentEpoch ||
      envelope.recipientEpoch !== header.recipientEpoch ||
      envelope.senderDeviceId !== header.servingDeviceId ||
      envelope.servingSignature.signerKeyId !== header.servingSigningKeyId
    ) {
      throw new TypeError("PDS recipient envelope binding is invalid");
    }
  }
  if (
    !Array.isArray(pkg.chunks) ||
    pkg.chunks.length !== Number(header.chunkCount)
  )
    throw new TypeError("PDS package chunks are incomplete");
  const chunks = pkg.chunks.map((chunk, index) =>
    validateChunk(chunk, index, header)
  );
  const ciphertext = Buffer.concat(
    chunks.map((chunk) => decodePdsBase64url(chunk.ciphertext))
  );
  if (
    ciphertext.length !== Number(header.plaintextByteCount) ||
    sha256(
      Buffer.concat([ciphertext, decodePdsBase64url(header.payloadTag, 16)])
    ) !== header.payloadCiphertextHash
  )
    throw new TypeError("PDS package ciphertext hash is invalid");
  const digest = requireHash(pkg.packageDigest, "package digest");
  if (digest !== pdsSessionPackageDigest({ header, envelopes, chunks }))
    throw new TypeError("PDS package digest is invalid");
  return { header, envelopes, chunks, packageDigest: digest };
};

const recipientEnvelope = (input: {
  groupId: string;
  header: PdsSessionPackageHeader;
  recipient: PdsSessionRecipient;
  cek: Buffer;
  servingSigningPrivateKey: KeyObject;
}): PdsSessionRecipientEnvelope => {
  const ephemeral = generatedX25519();
  const unsigned = {
    protocol: PDS_PROTOCOL,
    version: PDS_SESSION_PACKAGE_VERSION,
    transportId: input.header.transportId,
    packageId: input.header.packageId,
    contentEpoch: input.header.contentEpoch,
    recipientEpoch: input.header.recipientEpoch,
    senderDeviceId: input.header.servingDeviceId,
    recipientDeviceId: input.recipient.deviceId,
    recipientKemKeyId: input.recipient.kemKeyId,
    ephemeralPublicKey: ephemeral.publicKey,
    nonce: randomBytes(12).toString("base64url"),
    ciphertext: "",
    tag: ""
  };
  const key = envelopeKey(
    sharedSecret(
      ephemeral.privateKey,
      x25519PublicKey(input.recipient.kemPublicKey)
    ),
    input.groupId,
    unsigned
  );
  const encrypted = aesEncrypt(
    key,
    input.cek,
    decodePdsBase64url(unsigned.nonce, 12),
    envelopeAad(unsigned)
  );
  unsigned.ciphertext = encrypted.ciphertext.toString("base64url");
  unsigned.tag = encrypted.tag.toString("base64url");
  return {
    ...unsigned,
    servingSignature: {
      signerKeyId: input.header.servingSigningKeyId,
      signature: signPdsRecord(
        "transport-envelope",
        unsigned,
        input.servingSigningPrivateKey
      )
    }
  };
};

const chunksFor = (
  header: PdsSessionPackageHeader,
  ciphertext: Buffer
): PdsSessionPackageChunk[] => {
  const count = Number(header.chunkCount);
  return Array.from({ length: count }, (_, index) => {
    const part = ciphertext.subarray(
      index * PDS_SESSION_PACKAGE_MAX_CHUNK_BYTES,
      (index + 1) * PDS_SESSION_PACKAGE_MAX_CHUNK_BYTES
    );
    return {
      protocol: PDS_PROTOCOL,
      version: PDS_SESSION_PACKAGE_VERSION,
      transportId: header.transportId,
      groupId: header.groupId,
      packageId: header.packageId,
      chunkIndex: String(index),
      chunkCount: header.chunkCount,
      ciphertext: part.toString("base64url"),
      chunkHash: sha256(part)
    };
  });
};

const packageRecipients = (
  recipients: PdsSessionRecipient[],
  servingSigningKeyId: string
): PdsSessionRecipient[] => {
  const sorted = [...recipients].sort((left, right) =>
    left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0
  );
  for (const recipient of sorted) {
    requireId(recipient.deviceId, "recipient device");
    requireId(recipient.kemKeyId, "recipient KEM key");
    requireHash(recipient.kemPublicKey, "recipient KEM public key");
    if (recipient.kemKeyId === servingSigningKeyId) {
      throw new TypeError("PDS signing and KEM key roles must differ");
    }
  }
  assertSortedUnique(
    sorted.map((recipient) => recipient.deviceId),
    "recipient snapshot"
  );
  assertSortedUnique(
    sorted.map((recipient) => recipient.kemKeyId),
    "recipient KEM keys"
  );
  if (
    new Set(sorted.map((recipient) => recipient.kemPublicKey)).size !==
    sorted.length
  ) {
    throw new TypeError("PDS recipient KEM public keys must not repeat");
  }
  return sorted;
};

const unsignedTransportHeader = (
  input: CreatePdsSessionPackageInput,
  manifest: PdsSessionManifest,
  recipients: PdsSessionRecipient[],
  plaintext: Buffer
): JsonRecord => {
  const snapshot = recipients.map((recipient) => recipient.deviceId);
  return headerUnsigned({
    protocol: PDS_PROTOCOL,
    version: PDS_SESSION_PACKAGE_VERSION,
    transportId: randomBytes(32).toString("base64url"),
    groupId: input.groupId,
    packageId: manifest.packageId,
    sourceManifestHash: sourceManifestHash(manifest),
    originDeviceId: manifest.originDeviceId,
    contentEpoch: manifest.contentEpoch,
    recipientEpoch: input.currentEpoch,
    plaintextByteCount: String(plaintext.length),
    chunkCount: String(
      Math.ceil(plaintext.length / PDS_SESSION_PACKAGE_MAX_CHUNK_BYTES)
    ),
    payloadNonce: randomBytes(12).toString("base64url"),
    expiresAt: input.expiresAt,
    servingDeviceId: input.servingDeviceId,
    servingSigningKeyId: input.servingSigningKeyId,
    authorityHead: input.authorityHead,
    intendedRecipientSnapshot: snapshot,
    intendedRecipientSnapshotHash: sha256(bytes(snapshot))
  });
};

const encryptTransportPayload = (
  unsigned: JsonRecord,
  plaintext: Buffer,
  signingKeyId: string,
  privateKey: KeyObject
): { header: PdsSessionPackageHeader; ciphertext: Buffer; cek: Buffer } => {
  const provisional = {
    ...unsigned,
    payloadCiphertextHash: "",
    payloadTag: "",
    servingSignature: { signerKeyId: signingKeyId, signature: "" }
  } as PdsSessionPackageHeader;
  const cek = randomBytes(32);
  const encrypted = aesEncrypt(
    cek,
    plaintext,
    decodePdsBase64url(provisional.payloadNonce, 12),
    headerAad(provisional)
  );
  const signed = {
    ...unsigned,
    payloadCiphertextHash: sha256(
      Buffer.concat([encrypted.ciphertext, encrypted.tag])
    ),
    payloadTag: encrypted.tag.toString("base64url")
  };
  return {
    header: {
      ...signed,
      servingSignature: {
        signerKeyId: signingKeyId,
        signature: signPdsRecord("transport-envelope", signed, privateKey)
      }
    } as PdsSessionPackageHeader,
    ciphertext: encrypted.ciphertext,
    cek
  };
};

export const createPdsSessionPackage = (
  input: CreatePdsSessionPackageInput
): PdsSessionPackage => {
  const manifest = validatePdsSessionManifest(input.manifest);
  requireId(input.groupId, "groupId");
  requireHash(input.authorityHead, "authority head");
  requireIso(input.expiresAt, "transport expiry");
  requireUint64(input.currentEpoch, "current epoch");
  requireId(input.servingDeviceId, "servingDeviceId");
  requireId(input.servingSigningKeyId, "servingSigningKeyId");
  const recipients = packageRecipients(
    input.recipients,
    input.servingSigningKeyId
  );
  const plaintext = bytes(manifest);
  if (plaintext.length > PDS_SESSION_PACKAGE_MAX_BYTES)
    throw new RangeError("PDS package plaintext exceeds limit");
  const encrypted = encryptTransportPayload(
    unsignedTransportHeader(input, manifest, recipients, plaintext),
    plaintext,
    input.servingSigningKeyId,
    input.servingSigningPrivateKey
  );
  const envelopes = recipients.map((recipient) =>
    recipientEnvelope({
      groupId: input.groupId,
      header: encrypted.header,
      recipient,
      cek: encrypted.cek,
      servingSigningPrivateKey: input.servingSigningPrivateKey
    })
  );
  const pkg = {
    header: encrypted.header,
    envelopes,
    chunks: chunksFor(encrypted.header, encrypted.ciphertext)
  };
  return { ...pkg, packageDigest: pdsSessionPackageDigest(pkg) };
};

const validateVerificationInput = (
  input: VerifyPdsSessionPackageInput
): void => {
  requireId(input.groupId, "verification group ID");
  requireHash(input.authorityHead, "verification authority head");
  requireUint64(input.currentEpoch, "verification current epoch");
  requireId(input.recipientDeviceId, "verification recipient device ID");
  requireId(input.recipientKemKeyId, "verification recipient KEM key ID");
  requireId(input.servingSigningKeyId, "verification serving key ID");
  requireId(input.originSigningKeyId, "verification origin key ID");
  if (!Array.isArray(input.recipientSnapshot)) {
    throw new TypeError("PDS verification recipient snapshot is invalid");
  }
  assertSortedUnique(
    input.recipientSnapshot.map((member) =>
      requireId(member, "verification snapshot member")
    ),
    "verification recipient snapshot"
  );
  if (input.deletionFloor) {
    const floor = own(input.deletionFloor, "verification deletion floor");
    exact(floor, ["logicalMemoryId", "deletionFloorToken"], "deletion floor");
    requireHash(floor.logicalMemoryId, "deletion floor logical memory ID");
    requireHash(floor.deletionFloorToken, "deletion floor token");
  }
  if (
    input.now !== undefined &&
    (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime()))
  ) {
    throw new TypeError("PDS verification clock is invalid");
  }
};

const verifyHeader = (
  header: PdsSessionPackageHeader,
  input: VerifyPdsSessionPackageInput
): void => {
  validateVerificationInput(input);
  if (
    header.groupId !== input.groupId ||
    header.authorityHead !== input.authorityHead ||
    header.recipientEpoch !== input.currentEpoch ||
    header.servingDeviceId !== input.servingDeviceId ||
    header.servingSigningKeyId !== input.servingSigningKeyId
  )
    throw new TypeError("PDS transport authority binding is invalid");
  if (
    !header.intendedRecipientSnapshot.includes(input.recipientDeviceId) ||
    canonicalizePdsJson(header.intendedRecipientSnapshot) !==
      canonicalizePdsJson(input.recipientSnapshot)
  )
    throw new TypeError("PDS transport recipient snapshot is invalid");
  if (Date.parse(header.expiresAt) <= (input.now ?? new Date()).getTime())
    throw new TypeError("PDS transport has expired");
  verifyRecord(
    "transport-envelope",
    without(header, "servingSignature"),
    header.servingSignature,
    input.servingSigningPublicKey
  );
};

const decryptCek = (
  pkg: PdsSessionPackage,
  input: VerifyPdsSessionPackageInput
): Buffer => {
  const envelope = pkg.envelopes.find(
    (item) => item.recipientDeviceId === input.recipientDeviceId
  );
  if (
    !envelope ||
    envelope.recipientKemKeyId !== input.recipientKemKeyId ||
    envelope.recipientEpoch !== input.currentEpoch ||
    envelope.senderDeviceId !== pkg.header.servingDeviceId ||
    envelope.servingSignature.signerKeyId !== input.servingSigningKeyId
  )
    throw new TypeError("PDS recipient envelope is not authorized");
  verifyRecord(
    "transport-envelope",
    without(envelope, "servingSignature"),
    envelope.servingSignature,
    input.servingSigningPublicKey
  );
  const privateKey = x25519PrivateKey(
    input.recipientKemPrivateKey,
    input.recipientKemPublicKey
  );
  const key = envelopeKey(
    sharedSecret(privateKey, x25519PublicKey(envelope.ephemeralPublicKey)),
    input.groupId,
    envelope
  );
  return aesDecrypt(
    key,
    decodePdsBase64url(envelope.ciphertext, 32),
    decodePdsBase64url(envelope.nonce, 12),
    decodePdsBase64url(envelope.tag, 16),
    envelopeAad(envelope)
  );
};

const replayEntry = (
  value: PdsSessionPackageReplayEntry,
  label: string
): PdsSessionPackageReplayEntry => {
  const entry = own(value, label);
  exact(entry, ["packageId", "sourceManifestHash"], label);
  return {
    packageId: requireHash(entry.packageId, `${label} package ID`),
    sourceManifestHash: requireHash(
      entry.sourceManifestHash,
      `${label} source manifest hash`
    )
  };
};

export const pdsSessionPackageReplayEntry = (
  value: unknown
): PdsSessionPackageReplayEntry => {
  const { header } = validatePdsSessionPackage(value);
  return {
    packageId: header.packageId,
    sourceManifestHash: header.sourceManifestHash
  };
};

export const classifyPdsSessionPackageReplay = (
  stored: PdsSessionPackageReplayEntry | undefined,
  received: PdsSessionPackageReplayEntry
): PdsSessionPackageReplayResult => {
  const current = replayEntry(received, "received replay entry");
  if (!stored) return "new";
  const previous = replayEntry(stored, "stored replay entry");
  if (previous.packageId !== current.packageId) return "new";
  return previous.sourceManifestHash === current.sourceManifestHash
    ? "idempotent"
    : "quarantine";
};

export const verifyAndDecryptPdsSessionPackage = (
  value: unknown,
  input: VerifyPdsSessionPackageInput
): PdsSessionManifest => {
  const pkg = validatePdsSessionPackage(value);
  verifyHeader(pkg.header, input);
  const cek = decryptCek(pkg, input);
  const ciphertext = Buffer.concat(
    pkg.chunks.map((chunk) => decodePdsBase64url(chunk.ciphertext))
  );
  const plaintext = aesDecrypt(
    cek,
    ciphertext,
    decodePdsBase64url(pkg.header.payloadNonce, 12),
    decodePdsBase64url(pkg.header.payloadTag, 16),
    headerAad(pkg.header)
  );
  if (plaintext.length !== Number(pkg.header.plaintextByteCount))
    throw new TypeError("PDS plaintext size is invalid");
  const manifest = verifyPdsSessionManifest(
    parseCanonicalPdsJson(plaintext.toString("utf8")),
    input.originSigningPublicKey,
    input.originSigningKeyId
  );
  if (
    manifest.packageId !== pkg.header.packageId ||
    manifest.originDeviceId !== pkg.header.originDeviceId ||
    sourceManifestHash(manifest) !== pkg.header.sourceManifestHash
  )
    throw new TypeError("PDS source manifest transport binding is invalid");
  if (
    input.deletionFloor &&
    manifest.logicalMemoryId === input.deletionFloor.logicalMemoryId &&
    manifest.deletionFloorToken === input.deletionFloor.deletionFloorToken
  )
    throw new TypeError("PDS deletion floor rejects source package");
  return manifest;
};

/** Retry exact bytes. Call create only for new transport or rewrap. */
export const retryPdsSessionPackage = (value: unknown): PdsSessionPackage =>
  validatePdsSessionPackage(value);

/** Rewrap preserves immutable origin manifest; fresh CEK, nonce, transport ID, and envelopes. */
export const rewrapPdsSessionPackage = (
  input: CreatePdsSessionPackageInput & {
    originSigningPublicKey: string | Buffer;
    originSigningKeyId: string;
  }
): PdsSessionPackage => {
  verifyPdsSessionManifest(
    input.manifest,
    input.originSigningPublicKey,
    input.originSigningKeyId
  );
  return createPdsSessionPackage(input);
};

export const retainPdsSessionPackage = (input: {
  originManifest: PdsSessionManifest;
  package: PdsSessionPackage;
  localEncryption?: PdsRetainedSessionPackage["localEncryption"];
}): PdsRetainedSessionPackage => {
  const manifest = validatePdsSessionManifest(input.originManifest);
  const pkg = validatePdsSessionPackage(input.package);
  if (
    pkg.header.packageId !== manifest.packageId ||
    pkg.header.sourceManifestHash !== sourceManifestHash(manifest)
  ) {
    throw new TypeError("PDS retained package does not bind origin manifest");
  }
  if (input.localEncryption) {
    requireId(input.localEncryption.provider, "local encryption provider");
    if (!/^[A-Za-z0-9_-]{1,240}$/.test(input.localEncryption.reference)) {
      throw new TypeError("PDS local encryption reference is invalid");
    }
  }
  return {
    version: PDS_SESSION_PACKAGE_VERSION,
    originManifest: manifest,
    package: pkg,
    ...(input.localEncryption ? { localEncryption: input.localEncryption } : {})
  };
};

export const parsePdsSessionManifestJson = (
  input: string
): PdsSessionManifest => {
  if (Buffer.byteLength(input, "utf8") > PDS_SESSION_PACKAGE_MAX_BYTES) {
    throw new RangeError("PDS source manifest JSON exceeds limit");
  }
  return validatePdsSessionManifest(parseCanonicalPdsJson(input));
};

export const parsePdsSessionPackageJson = (
  input: string
): PdsSessionPackage => {
  if (Buffer.byteLength(input, "utf8") > PDS_SESSION_PACKAGE_MAX_JSON_BYTES)
    throw new RangeError("PDS package JSON exceeds limit");
  return validatePdsSessionPackage(parseCanonicalPdsJson(input));
};
