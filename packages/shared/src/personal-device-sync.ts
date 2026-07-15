import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject
} from "node:crypto";
import {
  canonicalizePdsJson,
  parsePdsUint64
} from "./personal-device-sync-jcs.js";

export const PDS_PROTOCOL = "koed/pds/v1" as const;
export const PDS_CERTIFICATE_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
export const PDS_CERTIFICATE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

const opaqueId = /^[\x21-\x7e]{1,240}$/;
const base64url = /^[A-Za-z0-9_-]*$/;
const kinds = new Set([
  "genesis",
  "add-device",
  "revoke-device",
  "recover",
  "tombstone",
  "resolve-conflict"
]);

type JsonRecord = Record<string, unknown>;
export type PdsSignature = {
  signerKeyId?: string;
  keyId?: string;
  signature: string;
};
export type PdsGroupStatement = {
  draft: JsonRecord;
  authorization: { signerKeyId: string; signature: string };
  authority?: { keyId: string; signature: string };
};

const own = (value: unknown): JsonRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("PDS value must be an object");
  }
  if (Reflect.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("PDS value must be a plain object");
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
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new TypeError(`PDS ${label} has unknown or missing fields`);
  }
};

export const decodePdsBase64url = (value: unknown, length?: number): Buffer => {
  if (
    typeof value !== "string" ||
    !base64url.test(value) ||
    value.includes("=")
  ) {
    throw new TypeError("PDS binary value must be unpadded base64url");
  }
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.toString("base64url") !== value ||
    (length !== undefined && bytes.length !== length)
  ) {
    throw new TypeError("PDS binary value has invalid length or encoding");
  }
  return bytes;
};

const requireId = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !opaqueId.test(value))
    throw new TypeError(`PDS ${label} is invalid`);
  return value;
};

const requireUint64 = (value: unknown, label: string): string => {
  if (typeof value !== "string")
    throw new TypeError(`PDS ${label} must be a decimal string`);
  parsePdsUint64(value);
  return value;
};

const isoMillis = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`PDS ${label} must be RFC3339 UTC milliseconds`);
  }
  return value;
};

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("base64url");
export const pdsSha256 = sha256;

const rawOkp = (
  crv: "Ed25519" | "X25519",
  publicKey: Buffer,
  seed?: Buffer
): KeyObject =>
  seed
    ? createPrivateKey({
        key: {
          kty: "OKP",
          crv,
          x: publicKey.toString("base64url"),
          d: seed.toString("base64url")
        },
        format: "jwk"
      })
    : createPublicKey({
        key: { kty: "OKP", crv, x: publicKey.toString("base64url") },
        format: "jwk"
      });

/** Node crypto adapter. PDS wire keys stay raw 32-byte values, never JWK/PEM. */
export const pdsEd25519PublicKey = (raw: string | Buffer): KeyObject =>
  rawOkp(
    "Ed25519",
    typeof raw === "string" ? decodePdsBase64url(raw, 32) : raw
  );

/** Node crypto adapter. Secret is RFC8032 32-byte seed; public key binds it. */
export const pdsEd25519PrivateKey = (
  seed: string | Buffer,
  publicKey: string | Buffer
): KeyObject =>
  rawOkp(
    "Ed25519",
    typeof publicKey === "string"
      ? decodePdsBase64url(publicKey, 32)
      : publicKey,
    typeof seed === "string" ? decodePdsBase64url(seed, 32) : seed
  );

const signingBytes = (
  recordType: string,
  stage: "draft" | "final",
  value: unknown
): Buffer =>
  Buffer.from(
    `${PDS_PROTOCOL}/${recordType}/${stage}\n${canonicalizePdsJson(value)}`,
    "utf8"
  );

export const signPdsGroupDraft = (
  draft: JsonRecord,
  privateKey: KeyObject
): string =>
  sign(
    null,
    signingBytes("group-statement", "draft", draft),
    privateKey
  ).toString("base64url");

export const signPdsGroupFinal = (
  statement: Pick<PdsGroupStatement, "draft" | "authorization">,
  privateKey: KeyObject
): string =>
  sign(
    null,
    signingBytes("group-statement", "final", statement),
    privateKey
  ).toString("base64url");

export const signPdsRecord = (
  recordType:
    | "membership-certificate"
    | "source-manifest"
    | "transport-envelope"
    | "tombstone-ack"
    | "package-ack",
  unsignedRecord: JsonRecord,
  privateKey: KeyObject
): string =>
  sign(
    null,
    Buffer.from(
      `${PDS_PROTOCOL}/${recordType}\n${canonicalizePdsJson(unsignedRecord)}`,
      "utf8"
    ),
    privateKey
  ).toString("base64url");

export const signPdsTwoStageFinal = (
  recordType: "key-bundle" | "tombstone" | "conflict-resolution",
  record: { draft: JsonRecord; authorization: JsonRecord },
  privateKey: KeyObject
): string =>
  sign(null, signingBytes(recordType, "final", record), privateKey).toString(
    "base64url"
  );

const signatureWrapper = (
  value: unknown,
  field: "signerKeyId" | "keyId"
): string => {
  const wrapper = own(value);
  exact(wrapper, [field, "signature"], "signature wrapper");
  requireId(wrapper[field], field);
  decodePdsBase64url(wrapper.signature, 64);
  return wrapper.signature as string;
};

const validateBody = (kind: string, bodyValue: unknown): void => {
  const body = own(bodyValue);
  const key = (name: string) => requireId(body[name], name);
  const rawKey = (name: string) => decodePdsBase64url(body[name], 32);
  if (kind === "genesis") {
    exact(
      body,
      [
        "authorityKeyId",
        "authorityPublicKey",
        "recoverySigningKeyId",
        "recoverySigningPublicKey",
        "recoveryKemKeyId",
        "recoveryKemPublicKey",
        "recoveryKitHash",
        "recoveryKitVerified",
        "initialEpoch",
        "initialKeyCommitment"
      ],
      "genesis body"
    );
    for (const field of [
      "authorityKeyId",
      "recoverySigningKeyId",
      "recoveryKemKeyId"
    ])
      key(field);
    for (const field of [
      "authorityPublicKey",
      "recoverySigningPublicKey",
      "recoveryKemPublicKey",
      "recoveryKitHash",
      "initialKeyCommitment"
    ])
      rawKey(field);
    if (body.recoveryKitVerified !== true)
      throw new TypeError("PDS genesis requires verified recovery kit");
    requireUint64(body.initialEpoch, "initialEpoch");
    return;
  }
  if (kind === "add-device" || kind === "recover") {
    const fields =
      kind === "add-device"
        ? [
            "deviceId",
            "deviceSigningKeyId",
            "deviceSigningPublicKey",
            "deviceKemKeyId",
            "deviceKemPublicKey",
            "operationFamilies",
            "previousEpoch",
            "nextEpoch",
            "keyBundleHash"
          ]
        : [
            "deviceSigningKeyId",
            "deviceSigningPublicKey",
            "deviceKemKeyId",
            "deviceKemPublicKey",
            "recoveryKitHash",
            "previousEpoch",
            "nextEpoch",
            "keyBundleHash"
          ];
    exact(body, fields, `${kind} body`);
    for (const field of fields.filter((field) => field.endsWith("Id")))
      key(field);
    for (const field of fields.filter(
      (field) => field.endsWith("PublicKey") || field.endsWith("Hash")
    ))
      rawKey(field);
    if (kind === "add-device") {
      if (
        !Array.isArray(body.operationFamilies) ||
        body.operationFamilies.length !== 1 ||
        body.operationFamilies[0] !== "pds_relay"
      )
        throw new TypeError("PDS device operations are invalid");
    }
    assertEpochAdvance(body.previousEpoch, body.nextEpoch);
    return;
  }
  if (kind === "revoke-device") {
    exact(
      body,
      [
        "deviceId",
        "reasonCode",
        "revokedAt",
        "previousEpoch",
        "nextEpoch",
        "keyBundleHash"
      ],
      "revoke body"
    );
    key("deviceId");
    requireId(body.reasonCode, "reasonCode");
    isoMillis(body.revokedAt, "revokedAt");
    decodePdsBase64url(body.keyBundleHash, 32);
    assertEpochAdvance(body.previousEpoch, body.nextEpoch);
    return;
  }
  if (kind === "tombstone") {
    exact(body, ["tombstoneHash", "deletionFloorToken"], "tombstone body");
    decodePdsBase64url(body.tombstoneHash, 32);
    decodePdsBase64url(body.deletionFloorToken, 32);
    return;
  }
  exact(
    body,
    ["sourceFingerprint", "selectedClosureHash", "resolution"],
    "conflict resolution body"
  );
  decodePdsBase64url(body.sourceFingerprint, 32);
  if (body.selectedClosureHash !== null)
    decodePdsBase64url(body.selectedClosureHash, 32);
  if (body.resolution !== "select" && body.resolution !== "distinct")
    throw new TypeError("PDS conflict resolution is invalid");
};

export const assertEpochAdvance = (previous: unknown, next: unknown): void => {
  const previousValue = requireUint64(previous, "previousEpoch");
  const nextValue = requireUint64(next, "nextEpoch");
  if (parsePdsUint64(nextValue) !== parsePdsUint64(previousValue) + 1n)
    throw new TypeError("PDS membership change must advance epoch by one");
};

export const validatePdsGroupStatement = (
  value: unknown,
  options: {
    authorizationPublicKey: string | Buffer;
    authorityPublicKey?: string | Buffer;
    expectedGroupId?: string;
    expectedPreviousHash?: string | null;
    expectedSequence?: string;
  }
): PdsGroupStatement => {
  const statement = own(value);
  const finalized = "authority" in statement;
  exact(
    statement,
    finalized
      ? ["draft", "authorization", "authority"]
      : ["draft", "authorization"],
    "group statement"
  );
  const draft = own(statement.draft);
  exact(
    draft,
    ["protocol", "kind", "groupId", "sequence", "previousHash", "body"],
    "group statement draft"
  );
  if (
    draft.protocol !== PDS_PROTOCOL ||
    typeof draft.kind !== "string" ||
    !kinds.has(draft.kind)
  )
    throw new TypeError("PDS group statement protocol or kind is invalid");
  requireId(draft.groupId, "groupId");
  requireUint64(draft.sequence, "sequence");
  if (draft.previousHash !== null) decodePdsBase64url(draft.previousHash, 32);
  if (options.expectedGroupId && draft.groupId !== options.expectedGroupId)
    throw new TypeError("PDS statement group does not match");
  if (
    options.expectedPreviousHash !== undefined &&
    draft.previousHash !== options.expectedPreviousHash
  )
    throw new TypeError("PDS statement previous head does not match");
  if (options.expectedSequence && draft.sequence !== options.expectedSequence)
    throw new TypeError("PDS statement sequence is not next");
  validateBody(draft.kind, draft.body);
  const authorization = own(statement.authorization);
  const authorizationSignature = signatureWrapper(authorization, "signerKeyId");
  if (
    !verify(
      null,
      signingBytes("group-statement", "draft", draft),
      pdsEd25519PublicKey(options.authorizationPublicKey),
      decodePdsBase64url(authorizationSignature, 64)
    )
  )
    throw new TypeError("PDS draft authorization signature is invalid");
  if (finalized) {
    if (!options.authorityPublicKey)
      throw new TypeError("PDS authority public key is required");
    const authority = own(statement.authority);
    const authoritySignature = signatureWrapper(authority, "keyId");
    if (
      !verify(
        null,
        signingBytes("group-statement", "final", { draft, authorization }),
        pdsEd25519PublicKey(options.authorityPublicKey),
        decodePdsBase64url(authoritySignature, 64)
      )
    )
      throw new TypeError("PDS authority countersignature is invalid");
  }
  return statement as PdsGroupStatement;
};

export const pdsFinalizedStatementHash = (
  statement: PdsGroupStatement
): string => {
  if (!statement.authority)
    throw new TypeError("PDS statement is not finalized");
  return sha256(
    canonicalizePdsJson({
      draft: statement.draft,
      authorization: statement.authorization,
      authority: statement.authority
    })
  );
};

export const validatePdsKeyBundleMetadata = (
  value: unknown
): { hash: string; draft: JsonRecord } => {
  const bundle = own(value);
  exact(
    bundle,
    "authority" in bundle
      ? ["draft", "authorization", "authority"]
      : ["draft", "authorization"],
    "key bundle"
  );
  const draft = own(bundle.draft);
  exact(
    draft,
    [
      "protocol",
      "version",
      "groupId",
      "epoch",
      "transitionKind",
      "recipientSnapshot",
      "recipientSnapshotHash",
      "keyType",
      "epochKeyCommitment",
      "sourceFingerprintKeyCommitment",
      "tombstoneFloorKeyCommitment",
      "projectAliasKeyCommitment",
      "envelopes"
    ],
    "key bundle draft"
  );
  if (
    draft.protocol !== PDS_PROTOCOL ||
    draft.version !== "1" ||
    draft.keyType !== "group-secret-set" ||
    !["add-device", "revoke-device", "recover"].includes(
      draft.transitionKind as string
    )
  )
    throw new TypeError("PDS key bundle metadata is invalid");
  requireId(draft.groupId, "groupId");
  requireUint64(draft.epoch, "epoch");
  if (
    !Array.isArray(draft.recipientSnapshot) ||
    !Array.isArray(draft.envelopes) ||
    draft.recipientSnapshot.length !== draft.envelopes.length ||
    draft.recipientSnapshot.length < 2
  )
    throw new TypeError("PDS key bundle recipients are invalid");
  const recipients = draft.recipientSnapshot.map((recipient) =>
    requireId(recipient, "recipientId")
  );
  if (
    new Set(recipients).size !== recipients.length ||
    recipients.join("\0") !== [...recipients].sort().join("\0")
  )
    throw new TypeError("PDS key bundle recipients must be unique and sorted");
  if (sha256(canonicalizePdsJson(recipients)) !== draft.recipientSnapshotHash)
    throw new TypeError("PDS key bundle recipient hash is invalid");
  for (const field of [
    "recipientSnapshotHash",
    "epochKeyCommitment",
    "sourceFingerprintKeyCommitment",
    "tombstoneFloorKeyCommitment",
    "projectAliasKeyCommitment"
  ])
    decodePdsBase64url(draft[field], 32);
  const envelopeRecipients: string[] = [];
  for (const envelopeValue of draft.envelopes) {
    const envelope = own(envelopeValue);
    exact(
      envelope,
      [
        "recipientId",
        "recipientKind",
        "recipientKemKeyId",
        "ephemeralPublicKey",
        "nonce",
        "ciphertext",
        "tag",
        "envelopeContext"
      ],
      "key bundle envelope"
    );
    envelopeRecipients.push(requireId(envelope.recipientId, "recipientId"));
    if (
      envelope.recipientKind !== "device" &&
      envelope.recipientKind !== "recovery"
    )
      throw new TypeError("PDS recipient kind is invalid");
    requireId(envelope.recipientKemKeyId, "recipientKemKeyId");
    decodePdsBase64url(envelope.ephemeralPublicKey, 32);
    decodePdsBase64url(envelope.nonce, 12);
    decodePdsBase64url(envelope.tag, 16);
    if (
      typeof envelope.ciphertext !== "string" ||
      envelope.ciphertext.length === 0 ||
      envelope.envelopeContext !== "koed/pds/v1/key-bundle-envelope"
    )
      throw new TypeError("PDS key bundle envelope is invalid");
  }
  if (envelopeRecipients.join("\0") !== recipients.join("\0"))
    throw new TypeError("PDS key bundle envelopes do not match snapshot");
  return { hash: sha256(canonicalizePdsJson(bundle)), draft };
};

export const validatePdsKeyBundle = (
  value: unknown,
  options: {
    authorizationPublicKey: string | Buffer;
    authorityPublicKey?: string | Buffer;
  }
): { hash: string; draft: JsonRecord } => {
  const validated = validatePdsKeyBundleMetadata(value);
  const bundle = own(value);
  const authorization = own(bundle.authorization);
  const authorizationSignature = signatureWrapper(authorization, "signerKeyId");
  if (
    !verify(
      null,
      signingBytes("key-bundle", "draft", validated.draft),
      pdsEd25519PublicKey(options.authorizationPublicKey),
      decodePdsBase64url(authorizationSignature, 64)
    )
  )
    throw new TypeError("PDS key bundle authorization signature is invalid");
  if (options.authorityPublicKey && "authority" in bundle) {
    const authority = own(bundle.authority);
    const authoritySignature = signatureWrapper(authority, "keyId");
    if (
      !verify(
        null,
        signingBytes("key-bundle", "final", {
          draft: validated.draft,
          authorization
        }),
        pdsEd25519PublicKey(options.authorityPublicKey),
        decodePdsBase64url(authoritySignature, 64)
      )
    )
      throw new TypeError(
        "PDS key bundle authority countersignature is invalid"
      );
  }
  return validated;
};

export const verifyPdsEnrollmentProof = (input: {
  challengeId: string;
  challenge: string;
  groupId?: string;
  deviceId: string;
  deviceSigningPublicKey: string;
  signature: string;
}): void => {
  requireId(input.challengeId, "challengeId");
  requireId(input.deviceId, "deviceId");
  decodePdsBase64url(input.challenge, 32);
  decodePdsBase64url(input.signature, 64);
  if (input.groupId !== undefined) requireId(input.groupId, "groupId");
  const message = Buffer.from(
    `${PDS_PROTOCOL}/enrollment-proof\n${canonicalizePdsJson({ challengeId: input.challengeId, challenge: input.challenge, groupId: input.groupId ?? null, deviceId: input.deviceId })}`,
    "utf8"
  );
  if (
    !verify(
      null,
      message,
      pdsEd25519PublicKey(input.deviceSigningPublicKey),
      decodePdsBase64url(input.signature, 64)
    )
  )
    throw new TypeError("PDS device proof of possession is invalid");
};

export const certificateIsPdsValid = (
  certificate: unknown,
  authorityPublicKey: string | Buffer,
  now = new Date()
): boolean => {
  try {
    const record = own(certificate);
    exact(
      record,
      [
        "protocol",
        "groupId",
        "deviceId",
        "deviceSigningKeyId",
        "deviceSigningPublicKey",
        "deviceKemKeyId",
        "deviceKemPublicKey",
        "epoch",
        "operationFamilies",
        "statementSequence",
        "statementHash",
        "issuedAt",
        "expiresAt",
        "authoritySignature"
      ],
      "membership certificate"
    );
    if (
      record.protocol !== PDS_PROTOCOL ||
      !Array.isArray(record.operationFamilies) ||
      record.operationFamilies.length !== 1 ||
      record.operationFamilies[0] !== "pds_relay"
    )
      return false;
    for (const field of [
      "groupId",
      "deviceId",
      "deviceSigningKeyId",
      "deviceKemKeyId"
    ])
      requireId(record[field], field);
    for (const field of [
      "deviceSigningPublicKey",
      "deviceKemPublicKey",
      "statementHash"
    ])
      decodePdsBase64url(record[field], 32);
    requireUint64(record.epoch, "epoch");
    requireUint64(record.statementSequence, "statementSequence");
    const issued = new Date(isoMillis(record.issuedAt, "issuedAt"));
    const expires = new Date(isoMillis(record.expiresAt, "expiresAt"));
    if (
      issued.getTime() > now.getTime() + PDS_CERTIFICATE_CLOCK_SKEW_MS ||
      now >= expires ||
      expires.getTime() - issued.getTime() > PDS_CERTIFICATE_MAX_LIFETIME_MS
    )
      return false;
    const wrapper = own(record.authoritySignature);
    const signature = signatureWrapper(wrapper, "keyId");
    const unsigned = { ...record };
    delete unsigned.authoritySignature;
    return verify(
      null,
      Buffer.from(
        `${PDS_PROTOCOL}/membership-certificate\n${canonicalizePdsJson(unsigned)}`,
        "utf8"
      ),
      pdsEd25519PublicKey(authorityPublicKey),
      decodePdsBase64url(signature, 64)
    );
  } catch {
    return false;
  }
};
