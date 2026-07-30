import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject
} from "node:crypto";
import {
  canonicalizePdsJson,
  parseCanonicalPdsJson,
  parsePdsUint64,
  pdsUint64be
} from "./personal-device-sync-jcs.js";

export const PDS_PROTOCOL = "koed/pds/v1" as const;
export const PDS_CERTIFICATE_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
export const PDS_CERTIFICATE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

const opaqueId = /^[\x21-\x7e]{1,240}$/;
const base64url = /^[A-Za-z0-9_-]*$/;
const PDS_ENVELOPE_CIPHERTEXT_MAX_BYTES = 64 * 1024;
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

export const decodePdsBase64url = (
  value: unknown,
  length?: number,
  maximumLength = length
): Buffer => {
  if (
    typeof value !== "string" ||
    !base64url.test(value) ||
    value.includes("=") ||
    (length !== undefined && value.length !== Math.ceil((length * 4) / 3)) ||
    (maximumLength !== undefined &&
      value.length > Math.ceil((maximumLength * 4) / 3))
  ) {
    throw new TypeError(
      "PDS binary value has invalid base64url length or encoding"
    );
  }
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.toString("base64url") !== value ||
    (length !== undefined && bytes.length !== length) ||
    (maximumLength !== undefined && bytes.length > maximumLength)
  ) {
    throw new TypeError(
      "PDS binary value has invalid base64url length or encoding"
    );
  }
  return bytes;
};

const requireId = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !opaqueId.test(value))
    throw new TypeError(`PDS ${label} is invalid`);
  return value;
};

export const comparePdsCanonicalIds = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const requireUint64 = (value: unknown, label: string): string => {
  if (typeof value !== "string")
    throw new TypeError(`PDS ${label} must be a decimal string`);
  parsePdsUint64(value);
  return value;
};

export const pdsIsoMillis = (value: unknown, label: string): string => {
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

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("base64url");
export const pdsSha256 = sha256;
export const pdsPublicKeyCommitment = (publicKey: string): string =>
  sha256(decodePdsBase64url(publicKey, 32));

const assertDistinct = (values: string[], label: string): void => {
  if (new Set(values).size !== values.length)
    throw new TypeError(`PDS ${label} must not reuse a key`);
};

const rawOkp = (
  crv: "Ed25519" | "X25519",
  publicKey: Buffer,
  seed?: Buffer
): KeyObject => {
  if (publicKey.length !== 32 || (seed && seed.length !== 32))
    throw new TypeError("PDS OKP key length is invalid");
  return seed
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
};

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

export const pdsX25519PublicKey = (raw: string | Buffer): KeyObject =>
  rawOkp("X25519", typeof raw === "string" ? decodePdsBase64url(raw, 32) : raw);

export const pdsX25519PrivateKey = (
  seed: string | Buffer,
  publicKey: string | Buffer
): KeyObject =>
  rawOkp(
    "X25519",
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
    | "package-ack"
    | "key-bundle-ack",
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

export const signPdsTwoStageDraft = (
  recordType: "key-bundle" | "tombstone" | "conflict-resolution",
  draft: JsonRecord,
  privateKey: KeyObject
): string =>
  sign(null, signingBytes(recordType, "draft", draft), privateKey).toString(
    "base64url"
  );

export type PdsTombstone = {
  draft: JsonRecord;
  authorization: { signerKeyId: string; signature: string };
  authority?: { keyId: string; signature: string };
};

export type PdsConflictResolution = PdsTombstone;

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
        "initialDeviceId",
        "initialDeviceSigningKeyId",
        "initialDeviceSigningPublicKey",
        "initialDeviceKemKeyId",
        "initialDeviceKemPublicKey",
        "operationFamilies",
        "initialEpoch",
        "initialKeyCommitment"
      ],
      "genesis body"
    );
    for (const field of [
      "authorityKeyId",
      "recoverySigningKeyId",
      "recoveryKemKeyId",
      "initialDeviceId",
      "initialDeviceSigningKeyId",
      "initialDeviceKemKeyId"
    ])
      key(field);
    for (const field of [
      "authorityPublicKey",
      "recoverySigningPublicKey",
      "recoveryKemPublicKey",
      "initialDeviceSigningPublicKey",
      "initialDeviceKemPublicKey",
      "recoveryKitHash",
      "initialKeyCommitment"
    ])
      rawKey(field);
    if (body.recoveryKitVerified !== true)
      throw new TypeError("PDS genesis requires verified recovery kit");
    assertDistinct(
      [
        body.authorityKeyId,
        body.recoverySigningKeyId,
        body.recoveryKemKeyId,
        body.initialDeviceSigningKeyId,
        body.initialDeviceKemKeyId
      ] as string[],
      "genesis key IDs"
    );
    assertDistinct(
      [
        body.authorityPublicKey,
        body.recoverySigningPublicKey,
        body.recoveryKemPublicKey,
        body.initialDeviceSigningPublicKey,
        body.initialDeviceKemPublicKey
      ] as string[],
      "genesis public keys"
    );
    if (
      !Array.isArray(body.operationFamilies) ||
      body.operationFamilies.length !== 1 ||
      body.operationFamilies[0] !== "pds_relay"
    )
      throw new TypeError("PDS device operations are invalid");
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
            "deviceId",
            "revokedDeviceIds",
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
    } else {
      if (!Array.isArray(body.revokedDeviceIds))
        throw new TypeError("PDS recovery revoked devices are invalid");
      const revokedDeviceIds = body.revokedDeviceIds as unknown[];
      if (
        revokedDeviceIds.some((deviceId) => typeof deviceId !== "string") ||
        new Set(revokedDeviceIds).size !== revokedDeviceIds.length ||
        revokedDeviceIds.join("\0") !==
          [...(revokedDeviceIds as string[])].sort().join("\0") ||
        revokedDeviceIds.includes(body.deviceId)
      )
        throw new TypeError("PDS recovery revoked devices are invalid");
    }
    assertDistinct(
      [body.deviceSigningKeyId, body.deviceKemKeyId] as string[],
      "device key IDs"
    );
    assertDistinct(
      [body.deviceSigningPublicKey, body.deviceKemPublicKey] as string[],
      "device public keys"
    );
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
    pdsIsoMillis(body.revokedAt, "revokedAt");
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
    [
      "resolutionHash",
      "sourceFingerprint",
      "selectedClosureHash",
      "resolution"
    ],
    "conflict resolution body"
  );
  decodePdsBase64url(body.resolutionHash, 32);
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
    expectedAuthorizationKeyId?: string;
    expectedAuthorityKeyId?: string;
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
  if (draft.kind === "genesis") {
    const genesis = own(draft.body);
    if (authorization.signerKeyId !== genesis.initialDeviceSigningKeyId) {
      throw new TypeError(
        "PDS genesis authorization signer does not match embedded device"
      );
    }
    const suppliedPublicKey =
      typeof options.authorizationPublicKey === "string"
        ? decodePdsBase64url(options.authorizationPublicKey, 32)
        : Buffer.from(options.authorizationPublicKey);
    if (
      suppliedPublicKey.length !== 32 ||
      !suppliedPublicKey.equals(
        decodePdsBase64url(genesis.initialDeviceSigningPublicKey, 32)
      )
    ) {
      throw new TypeError(
        "PDS genesis authorization key does not match embedded device"
      );
    }
  }
  if (
    "expectedAuthorizationKeyId" in options &&
    options.expectedAuthorizationKeyId !== undefined &&
    authorization.signerKeyId !== options.expectedAuthorizationKeyId
  )
    throw new TypeError("PDS authorization signer does not match key");
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
      options.expectedAuthorityKeyId !== undefined &&
      authority.keyId !== options.expectedAuthorityKeyId
    )
      throw new TypeError("PDS authority signer does not match key");
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
): { hash: string; authorizationHash: string; draft: JsonRecord } => {
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
    draft.recipientSnapshot.length < 1
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
        "recipientKemPublicKeyCommitment",
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
    decodePdsBase64url(envelope.recipientKemPublicKeyCommitment, 32);
    decodePdsBase64url(envelope.ephemeralPublicKey, 32);
    decodePdsBase64url(envelope.nonce, 12);
    decodePdsBase64url(envelope.tag, 16);
    if (envelope.envelopeContext !== "koed/pds/v1/key-bundle-envelope")
      throw new TypeError("PDS key bundle envelope is invalid");
    const ciphertext = decodePdsBase64url(
      envelope.ciphertext,
      undefined,
      PDS_ENVELOPE_CIPHERTEXT_MAX_BYTES
    );
    if (
      ciphertext.length === 0 ||
      ciphertext.length > PDS_ENVELOPE_CIPHERTEXT_MAX_BYTES
    )
      throw new TypeError("PDS key bundle envelope is invalid");
  }
  if (envelopeRecipients.join("\0") !== recipients.join("\0"))
    throw new TypeError("PDS key bundle envelopes do not match snapshot");
  return {
    hash: sha256(canonicalizePdsJson(bundle)),
    authorizationHash: sha256(
      canonicalizePdsJson({
        draft,
        authorization: own(bundle.authorization)
      })
    ),
    draft
  };
};

export const validatePdsKeyBundle = (
  value: unknown,
  options: {
    authorizationPublicKey: string | Buffer;
    authorityPublicKey?: string | Buffer;
    expectedAuthorizationKeyId?: string;
    expectedAuthorityKeyId?: string;
    expectedRecipients?: Array<{
      recipientId: string;
      recipientKind: "device" | "recovery";
      recipientKemKeyId: string;
      recipientKemPublicKeyCommitment: string;
    }>;
  }
): { hash: string; authorizationHash: string; draft: JsonRecord } => {
  const validated = validatePdsKeyBundleMetadata(value);
  const bundle = own(value);
  const authorization = own(bundle.authorization);
  const authorizationSignature = signatureWrapper(authorization, "signerKeyId");
  if (
    options.expectedAuthorizationKeyId !== undefined &&
    authorization.signerKeyId !== options.expectedAuthorizationKeyId
  )
    throw new TypeError(
      "PDS key bundle authorization signer does not match key"
    );
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
      options.expectedAuthorityKeyId !== undefined &&
      authority.keyId !== options.expectedAuthorityKeyId
    )
      throw new TypeError("PDS key bundle authority signer does not match key");
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
  if (options.expectedRecipients) {
    const expected = [...options.expectedRecipients].sort((left, right) =>
      comparePdsCanonicalIds(left.recipientId, right.recipientId)
    );
    const actual = (validated.draft.envelopes as unknown[]).map((value) => {
      const envelope = own(value);
      return {
        recipientId: envelope.recipientId as string,
        recipientKind: envelope.recipientKind as "device" | "recovery",
        recipientKemKeyId: envelope.recipientKemKeyId as string,
        recipientKemPublicKeyCommitment:
          envelope.recipientKemPublicKeyCommitment as string
      };
    });
    if (canonicalizePdsJson(actual) !== canonicalizePdsJson(expected))
      throw new TypeError("PDS key bundle envelopes do not bind recipients");
  }
  return validated;
};

export type PdsGroupSecretSet = {
  epochSecret: string;
  sourceFingerprintKey: string;
  tombstoneFloorKey: string;
  projectAliasKey: string;
};

export type PdsKeyBundleRecipient = {
  recipientId: string;
  recipientKind: "device" | "recovery";
  recipientKemKeyId: string;
  recipientKemPublicKey: string;
};

const pdsKeyBundleSalt = (groupId: string): Buffer =>
  createHash("sha256")
    .update(Buffer.from("koed/pds/v1/key-bundle/salt\0", "utf8"))
    .update(Buffer.from(groupId, "utf8"))
    .digest();

const pdsKeyBundleInfo = (
  input: {
    recipientId: string;
    recipientKind: string;
    recipientKemKeyId: string;
  },
  epoch: string,
  keyType: string,
  recipientSnapshotHash: string
): Buffer =>
  Buffer.concat([
    Buffer.from("koed/pds/v1/key-bundle/key\0", "utf8"),
    pdsUint64be(epoch),
    Buffer.from(input.recipientId, "utf8"),
    Buffer.from([0]),
    Buffer.from(input.recipientKind, "utf8"),
    Buffer.from([0]),
    Buffer.from(input.recipientKemKeyId, "utf8"),
    Buffer.from([0]),
    Buffer.from(keyType, "utf8"),
    Buffer.from([0]),
    Buffer.from(recipientSnapshotHash, "utf8")
  ]);

const pdsKeyBundleAad = (
  bundle: {
    protocol: string;
    version: string;
    groupId: string;
    epoch: string;
    keyType: string;
    recipientSnapshotHash: string;
  },
  recipient: {
    recipientId: string;
    recipientKind: string;
    recipientKemKeyId: string;
  }
): string =>
  canonicalizePdsJson({
    protocol: bundle.protocol,
    version: bundle.version,
    groupId: bundle.groupId,
    epoch: bundle.epoch,
    recipientId: recipient.recipientId,
    recipientKind: recipient.recipientKind,
    recipientKemKeyId: recipient.recipientKemKeyId,
    keyType: bundle.keyType,
    recipientSnapshotHash: bundle.recipientSnapshotHash
  });

const validSecretSet = (value: unknown): PdsGroupSecretSet => {
  const secretSet = own(value);
  exact(
    secretSet,
    [
      "epochSecret",
      "sourceFingerprintKey",
      "tombstoneFloorKey",
      "projectAliasKey"
    ],
    "group secret set"
  );
  for (const field of [
    "epochSecret",
    "sourceFingerprintKey",
    "tombstoneFloorKey",
    "projectAliasKey"
  ])
    decodePdsBase64url(secretSet[field], 32);
  return secretSet as PdsGroupSecretSet;
};

const nonZeroSharedSecret = (value: Buffer): Buffer => {
  if (value.length !== 32 || value.every((byte) => byte === 0))
    throw new TypeError("PDS X25519 shared secret is invalid");
  return value;
};

export const createPdsAuthorizedKeyBundle = (input: {
  groupId: string;
  epoch: string;
  transitionKind: "add-device" | "revoke-device" | "recover";
  recipients: PdsKeyBundleRecipient[];
  secrets: PdsGroupSecretSet;
  authorizationKeyId: string;
  authorizationPrivateKey: KeyObject;
}): {
  bundle: {
    draft: JsonRecord;
    authorization: { signerKeyId: string; signature: string };
  };
  authorizationHash: string;
} => {
  requireId(input.groupId, "groupId");
  requireUint64(input.epoch, "epoch");
  requireId(input.authorizationKeyId, "authorizationKeyId");
  const secrets = validSecretSet(input.secrets);
  const recipients = [...input.recipients].sort((left, right) =>
    comparePdsCanonicalIds(left.recipientId, right.recipientId)
  );
  if (
    recipients.length < 1 ||
    new Set(recipients.map((recipient) => recipient.recipientId)).size !==
      recipients.length
  )
    throw new TypeError("PDS key bundle recipients are invalid");
  for (const recipient of recipients) {
    requireId(recipient.recipientId, "recipientId");
    requireId(recipient.recipientKemKeyId, "recipientKemKeyId");
    decodePdsBase64url(recipient.recipientKemPublicKey, 32);
  }
  const recipientSnapshot = recipients.map(
    (recipient) => recipient.recipientId
  );
  const recipientSnapshotHash = sha256(canonicalizePdsJson(recipientSnapshot));
  const keyType = "group-secret-set";
  const envelopeMetadata = {
    protocol: PDS_PROTOCOL,
    version: "1",
    groupId: input.groupId,
    epoch: input.epoch,
    keyType,
    recipientSnapshotHash
  };
  const plaintext = Buffer.from(canonicalizePdsJson(secrets), "utf8");
  const envelopes = recipients.map((recipient) => {
    const ephemeral = generateKeyPairSync("x25519");
    const ephemeralJwk = ephemeral.publicKey.export({
      format: "jwk"
    }) as JsonWebKey;
    if (typeof ephemeralJwk.x !== "string")
      throw new TypeError("PDS ephemeral public key is invalid");
    const shared = nonZeroSharedSecret(
      diffieHellman({
        privateKey: ephemeral.privateKey,
        publicKey: pdsX25519PublicKey(recipient.recipientKemPublicKey)
      })
    );
    const wrappingKey = Buffer.from(
      hkdfSync(
        "sha256",
        shared,
        pdsKeyBundleSalt(input.groupId),
        pdsKeyBundleInfo(
          recipient,
          input.epoch,
          keyType,
          recipientSnapshotHash
        ),
        32
      )
    );
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", wrappingKey, nonce);
    cipher.setAAD(
      Buffer.from(pdsKeyBundleAad(envelopeMetadata, recipient), "utf8")
    );
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final()
    ]);
    return {
      recipientId: recipient.recipientId,
      recipientKind: recipient.recipientKind,
      recipientKemKeyId: recipient.recipientKemKeyId,
      recipientKemPublicKeyCommitment: pdsPublicKeyCommitment(
        recipient.recipientKemPublicKey
      ),
      ephemeralPublicKey: ephemeralJwk.x,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      envelopeContext: "koed/pds/v1/key-bundle-envelope"
    };
  });
  const draft = {
    ...envelopeMetadata,
    transitionKind: input.transitionKind,
    recipientSnapshot,
    epochKeyCommitment: sha256(decodePdsBase64url(secrets.epochSecret, 32)),
    sourceFingerprintKeyCommitment: sha256(
      decodePdsBase64url(secrets.sourceFingerprintKey, 32)
    ),
    tombstoneFloorKeyCommitment: sha256(
      decodePdsBase64url(secrets.tombstoneFloorKey, 32)
    ),
    projectAliasKeyCommitment: sha256(
      decodePdsBase64url(secrets.projectAliasKey, 32)
    ),
    envelopes
  };
  const bundle = {
    draft,
    authorization: {
      signerKeyId: input.authorizationKeyId,
      signature: signPdsTwoStageDraft(
        "key-bundle",
        draft,
        input.authorizationPrivateKey
      )
    }
  };
  const authorizationJwk = createPublicKey(
    input.authorizationPrivateKey
  ).export({ format: "jwk" }) as JsonWebKey;
  if (typeof authorizationJwk.x !== "string")
    throw new TypeError("PDS authorization public key is invalid");
  const validated = validatePdsKeyBundle(bundle, {
    authorizationPublicKey: authorizationJwk.x,
    expectedAuthorizationKeyId: input.authorizationKeyId,
    expectedRecipients: recipients.map((recipient) => ({
      recipientId: recipient.recipientId,
      recipientKind: recipient.recipientKind,
      recipientKemKeyId: recipient.recipientKemKeyId,
      recipientKemPublicKeyCommitment: pdsPublicKeyCommitment(
        recipient.recipientKemPublicKey
      )
    }))
  });
  return { bundle, authorizationHash: validated.authorizationHash };
};

export const decryptPdsKeyBundleSecretSet = (input: {
  bundle: unknown;
  authorizationPublicKey: string;
  authorityPublicKey: string;
  recipientId: string;
  recipientKemKeyId: string;
  recipientKemPublicKey: string;
  recipientKemPrivateSeed: string;
}): PdsGroupSecretSet => {
  const validated = validatePdsKeyBundle(input.bundle, {
    authorizationPublicKey: input.authorizationPublicKey,
    authorityPublicKey: input.authorityPublicKey
  });
  const draft = validated.draft;
  const envelope = (draft.envelopes as unknown[])
    .map(own)
    .find((candidate) => candidate.recipientId === input.recipientId);
  if (
    !envelope ||
    envelope.recipientKemKeyId !== input.recipientKemKeyId ||
    envelope.recipientKemPublicKeyCommitment !==
      pdsPublicKeyCommitment(input.recipientKemPublicKey)
  )
    throw new TypeError("PDS key bundle recipient is unavailable");
  const shared = nonZeroSharedSecret(
    diffieHellman({
      privateKey: pdsX25519PrivateKey(
        input.recipientKemPrivateSeed,
        input.recipientKemPublicKey
      ),
      publicKey: pdsX25519PublicKey(
        requireId(envelope.ephemeralPublicKey, "ephemeralPublicKey")
      )
    })
  );
  const wrappingKey = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      pdsKeyBundleSalt(requireId(draft.groupId, "groupId")),
      pdsKeyBundleInfo(
        {
          recipientId: input.recipientId,
          recipientKind: requireId(envelope.recipientKind, "recipientKind"),
          recipientKemKeyId: input.recipientKemKeyId
        },
        requireUint64(draft.epoch, "epoch"),
        requireId(draft.keyType, "keyType"),
        requireId(draft.recipientSnapshotHash, "recipientSnapshotHash")
      ),
      32
    )
  );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    wrappingKey,
    decodePdsBase64url(envelope.nonce, 12)
  );
  decipher.setAAD(
    Buffer.from(
      pdsKeyBundleAad(
        {
          protocol: requireId(draft.protocol, "protocol"),
          version: requireId(draft.version, "version"),
          groupId: requireId(draft.groupId, "groupId"),
          epoch: requireUint64(draft.epoch, "epoch"),
          keyType: requireId(draft.keyType, "keyType"),
          recipientSnapshotHash: requireId(
            draft.recipientSnapshotHash,
            "recipientSnapshotHash"
          )
        },
        {
          recipientId: input.recipientId,
          recipientKind: requireId(envelope.recipientKind, "recipientKind"),
          recipientKemKeyId: input.recipientKemKeyId
        }
      ),
      "utf8"
    )
  );
  decipher.setAuthTag(decodePdsBase64url(envelope.tag, 16));
  const plaintext = Buffer.concat([
    decipher.update(decodePdsBase64url(envelope.ciphertext)),
    decipher.final()
  ]).toString("utf8");
  const secrets = validSecretSet(parseCanonicalPdsJson(plaintext));
  const commitments: Array<[keyof PdsGroupSecretSet, string]> = [
    ["epochSecret", requireId(draft.epochKeyCommitment, "commitment")],
    [
      "sourceFingerprintKey",
      requireId(draft.sourceFingerprintKeyCommitment, "commitment")
    ],
    [
      "tombstoneFloorKey",
      requireId(draft.tombstoneFloorKeyCommitment, "commitment")
    ],
    [
      "projectAliasKey",
      requireId(draft.projectAliasKeyCommitment, "commitment")
    ]
  ];
  if (
    commitments.some(
      ([field, commitment]) =>
        sha256(decodePdsBase64url(secrets[field], 32)) !== commitment
    )
  )
    throw new TypeError("PDS key bundle secret commitment is invalid");
  return secrets;
};

export const verifyPdsEnrollmentProof = (input: {
  challengeId: string;
  challenge: string;
  groupId?: string;
  deviceId: string;
  deviceSigningKeyId: string;
  deviceSigningPublicKey: string;
  deviceKemKeyId: string;
  deviceKemPublicKey: string;
  browserSubjectId: string;
  browserDeploymentId: string;
  expiresAt: string;
  signature: string;
}): void => {
  requireId(input.challengeId, "challengeId");
  for (const field of [
    "deviceId",
    "deviceSigningKeyId",
    "deviceKemKeyId",
    "browserSubjectId",
    "browserDeploymentId"
  ])
    requireId(input[field as keyof typeof input], field);
  decodePdsBase64url(input.deviceSigningPublicKey, 32);
  decodePdsBase64url(input.deviceKemPublicKey, 32);
  decodePdsBase64url(input.challenge, 32);
  decodePdsBase64url(input.signature, 64);
  pdsIsoMillis(input.expiresAt, "expiresAt");
  if (Date.parse(input.expiresAt) <= Date.now())
    throw new TypeError("PDS enrollment proof has expired");
  if (input.groupId !== undefined) requireId(input.groupId, "groupId");
  const message = Buffer.from(
    `${PDS_PROTOCOL}/enrollment-proof\n${canonicalizePdsJson({ challengeId: input.challengeId, challenge: input.challenge, groupId: input.groupId ?? null, deviceId: input.deviceId, deviceSigningKeyId: input.deviceSigningKeyId, deviceSigningPublicKey: input.deviceSigningPublicKey, deviceKemKeyId: input.deviceKemKeyId, deviceKemPublicKey: input.deviceKemPublicKey, browserSubjectId: input.browserSubjectId, browserDeploymentId: input.browserDeploymentId, expiresAt: input.expiresAt })}`,
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

export const validatePdsKeyBundleAck = (
  value: unknown,
  options: {
    signingPublicKey: string | Buffer;
    expectedSignerKeyId: string;
    expectedGroupId: string;
    expectedDeviceId: string;
    expectedEpoch: string;
    expectedBundleHash: string;
    expectedRecipientKemKeyId: string;
    expectedRecipientKemPublicKeyCommitment: string;
  }
): { acknowledgedAt: Date } => {
  const record = own(value);
  exact(
    record,
    [
      "protocol",
      "groupId",
      "bundleHash",
      "deviceId",
      "recipientKemKeyId",
      "recipientKemPublicKeyCommitment",
      "epoch",
      "acknowledgedAt",
      "signature"
    ],
    "key bundle acknowledgement"
  );
  if (
    record.protocol !== PDS_PROTOCOL ||
    record.groupId !== options.expectedGroupId ||
    record.deviceId !== options.expectedDeviceId ||
    record.epoch !== options.expectedEpoch ||
    record.bundleHash !== options.expectedBundleHash ||
    record.recipientKemKeyId !== options.expectedRecipientKemKeyId ||
    record.recipientKemPublicKeyCommitment !==
      options.expectedRecipientKemPublicKeyCommitment
  )
    throw new TypeError(
      "PDS key bundle acknowledgement does not bind transition"
    );
  requireId(record.recipientKemKeyId, "recipientKemKeyId");
  decodePdsBase64url(record.recipientKemPublicKeyCommitment, 32);
  requireUint64(record.epoch, "epoch");
  const acknowledgedAt = new Date(
    pdsIsoMillis(record.acknowledgedAt, "acknowledgedAt")
  );
  if (acknowledgedAt.getTime() > Date.now() + PDS_CERTIFICATE_CLOCK_SKEW_MS)
    throw new TypeError("PDS key bundle acknowledgement is from future");
  const signature = signatureWrapper(record.signature, "signerKeyId");
  if (
    (record.signature as JsonRecord).signerKeyId !== options.expectedSignerKeyId
  )
    throw new TypeError("PDS key bundle acknowledgement signer is invalid");
  const unsigned = { ...record };
  delete unsigned.signature;
  if (
    !verify(
      null,
      Buffer.from(
        `${PDS_PROTOCOL}/key-bundle-ack\n${canonicalizePdsJson(unsigned)}`,
        "utf8"
      ),
      pdsEd25519PublicKey(options.signingPublicKey),
      decodePdsBase64url(signature, 64)
    )
  )
    throw new TypeError("PDS key bundle acknowledgement signature is invalid");
  return { acknowledgedAt };
};

export const validatePdsEpochAck = (
  value: unknown,
  options: {
    publicKey: string | Buffer;
    expectedGroupId: string;
    expectedDeviceId: string;
    expectedSigningKeyId: string;
    expectedEpoch: string;
    expectedStatementSequence: string;
    expectedStatementHash: string;
  }
): void => {
  const record = own(value);
  exact(
    record,
    [
      "protocol",
      "groupId",
      "deviceId",
      "deviceSigningKeyId",
      "epoch",
      "statementSequence",
      "statementHash",
      "issuedAt",
      "signature"
    ],
    "epoch acknowledgement"
  );
  if (
    record.protocol !== PDS_PROTOCOL ||
    record.groupId !== options.expectedGroupId ||
    record.deviceId !== options.expectedDeviceId ||
    record.deviceSigningKeyId !== options.expectedSigningKeyId ||
    record.epoch !== options.expectedEpoch ||
    record.statementSequence !== options.expectedStatementSequence ||
    record.statementHash !== options.expectedStatementHash
  )
    throw new TypeError(
      "PDS epoch acknowledgement does not bind pending epoch"
    );
  pdsIsoMillis(record.issuedAt, "issuedAt");
  requireUint64(record.epoch, "epoch");
  requireUint64(record.statementSequence, "statementSequence");
  decodePdsBase64url(record.statementHash, 32);
  const signature = signatureWrapper(record.signature, "signerKeyId");
  const unsigned = { ...record };
  delete unsigned.signature;
  if (
    !verify(
      null,
      Buffer.from(
        `${PDS_PROTOCOL}/package-ack\n${canonicalizePdsJson(unsigned)}`,
        "utf8"
      ),
      pdsEd25519PublicKey(options.publicKey),
      decodePdsBase64url(signature, 64)
    )
  )
    throw new TypeError("PDS epoch acknowledgement signature is invalid");
};

const sortedUniqueIds = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.length === 0)
    throw new TypeError(`PDS ${label} is invalid`);
  const values = value.map((item) => requireId(item, label));
  if (
    new Set(values).size !== values.length ||
    values.join("\0") !== [...values].sort().join("\0")
  )
    throw new TypeError(`PDS ${label} must be unique and ASCII sorted`);
  return values;
};

const sortedUniqueHashes = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.length === 0)
    throw new TypeError(`PDS ${label} is invalid`);
  const values = value.map((item) => {
    decodePdsBase64url(item, 32);
    return item as string;
  });
  if (
    new Set(values).size !== values.length ||
    values.join("\0") !== [...values].sort().join("\0")
  )
    throw new TypeError(`PDS ${label} must be unique and ASCII sorted`);
  return values;
};

const validatePdsTwoStageRecord = (
  value: unknown,
  recordType: "tombstone" | "conflict-resolution",
  options: {
    authorizationPublicKey: string | Buffer;
    authorityPublicKey?: string | Buffer;
    expectedAuthorizationKeyId?: string;
    expectedAuthorityKeyId?: string;
    expectedGroupId?: string;
  }
): PdsTombstone => {
  const record = own(value);
  const finalized = "authority" in record;
  exact(
    record,
    finalized
      ? ["draft", "authorization", "authority"]
      : ["draft", "authorization"],
    recordType
  );
  const draft = own(record.draft);
  const authorization = own(record.authorization);
  const authorizationSignature = signatureWrapper(authorization, "signerKeyId");
  if (
    options.expectedAuthorizationKeyId !== undefined &&
    authorization.signerKeyId !== options.expectedAuthorizationKeyId
  )
    throw new TypeError(
      `PDS ${recordType} authorization signer does not match key`
    );
  if (
    !verify(
      null,
      signingBytes(recordType, "draft", draft),
      pdsEd25519PublicKey(options.authorizationPublicKey),
      decodePdsBase64url(authorizationSignature, 64)
    )
  )
    throw new TypeError(`PDS ${recordType} authorization signature is invalid`);
  if (finalized) {
    if (!options.authorityPublicKey)
      throw new TypeError("PDS authority public key is required");
    const authority = own(record.authority);
    const authoritySignature = signatureWrapper(authority, "keyId");
    if (
      options.expectedAuthorityKeyId !== undefined &&
      authority.keyId !== options.expectedAuthorityKeyId
    )
      throw new TypeError(
        `PDS ${recordType} authority signer does not match key`
      );
    if (
      !verify(
        null,
        signingBytes(recordType, "final", { draft, authorization }),
        pdsEd25519PublicKey(options.authorityPublicKey),
        decodePdsBase64url(authoritySignature, 64)
      )
    )
      throw new TypeError(
        `PDS ${recordType} authority countersignature is invalid`
      );
  }
  if (
    options.expectedGroupId !== undefined &&
    draft.groupId !== options.expectedGroupId
  )
    throw new TypeError(`PDS ${recordType} group does not match`);
  return record as PdsTombstone;
};

export const pdsFinalizedTwoStageRecordHash = (
  record: PdsTombstone
): string => {
  if (!record.authority) throw new TypeError("PDS record is not finalized");
  return sha256(canonicalizePdsJson(record));
};

export const validatePdsTombstone = (
  value: unknown,
  options: {
    authorizationPublicKey: string | Buffer;
    authorityPublicKey?: string | Buffer;
    expectedAuthorizationKeyId?: string;
    expectedAuthorityKeyId?: string;
    expectedGroupId?: string;
  }
): PdsTombstone => {
  const record = validatePdsTwoStageRecord(value, "tombstone", options);
  const draft = own(record.draft);
  exact(
    draft,
    [
      "protocol",
      "groupId",
      "logicalMemoryId",
      "sourceFingerprint",
      "deletionFloorToken",
      "closureHashes",
      "tombstoneSequence",
      "statementHash",
      "activeDeviceSnapshot",
      "issuedAt"
    ],
    "tombstone draft"
  );
  if (draft.protocol !== PDS_PROTOCOL)
    throw new TypeError("PDS tombstone protocol is invalid");
  requireId(draft.groupId, "groupId");
  for (const field of [
    "logicalMemoryId",
    "sourceFingerprint",
    "deletionFloorToken",
    "statementHash"
  ])
    decodePdsBase64url(draft[field], 32);
  sortedUniqueHashes(draft.closureHashes, "tombstone closure hashes");
  requireUint64(draft.tombstoneSequence, "tombstoneSequence");
  sortedUniqueIds(
    draft.activeDeviceSnapshot,
    "tombstone active device snapshot"
  );
  pdsIsoMillis(draft.issuedAt, "tombstone issuedAt");
  return record;
};

export const validatePdsConflictResolution = (
  value: unknown,
  options: {
    authorizationPublicKey: string | Buffer;
    authorityPublicKey?: string | Buffer;
    expectedAuthorizationKeyId?: string;
    expectedAuthorityKeyId?: string;
    expectedGroupId?: string;
  }
): PdsConflictResolution => {
  const record = validatePdsTwoStageRecord(
    value,
    "conflict-resolution",
    options
  );
  const draft = own(record.draft);
  exact(
    draft,
    [
      "protocol",
      "groupId",
      "sourceFingerprint",
      "candidateClosureHashes",
      "selectedClosureHash",
      "resolution",
      "statementHash",
      "issuedAt"
    ],
    "conflict resolution draft"
  );
  if (draft.protocol !== PDS_PROTOCOL)
    throw new TypeError("PDS conflict resolution protocol is invalid");
  requireId(draft.groupId, "groupId");
  decodePdsBase64url(draft.sourceFingerprint, 32);
  const candidates = sortedUniqueHashes(
    draft.candidateClosureHashes,
    "conflict candidates"
  );
  decodePdsBase64url(draft.statementHash, 32);
  pdsIsoMillis(draft.issuedAt, "conflict resolution issuedAt");
  if (draft.resolution === "select") {
    if (
      typeof draft.selectedClosureHash !== "string" ||
      !candidates.includes(draft.selectedClosureHash)
    )
      throw new TypeError(
        "PDS conflict selection must name an observed candidate"
      );
  } else if (
    draft.resolution !== "distinct" ||
    draft.selectedClosureHash !== null
  ) {
    throw new TypeError("PDS conflict resolution is invalid");
  }
  return record;
};

const validatePdsSingleSignatureRecord = (
  value: unknown,
  fields: string[],
  recordType: "tombstone-ack" | "package-ack",
  options: { signingPublicKey: string | Buffer; expectedSignerKeyId: string }
): JsonRecord => {
  const record = own(value);
  exact(record, fields, recordType);
  const wrapper = own(record.signature);
  const signature = signatureWrapper(wrapper, "signerKeyId");
  if (wrapper.signerKeyId !== options.expectedSignerKeyId)
    throw new TypeError(`PDS ${recordType} signer is invalid`);
  const unsigned = { ...record };
  delete unsigned.signature;
  if (
    !verify(
      null,
      Buffer.from(
        `${PDS_PROTOCOL}/${recordType}\n${canonicalizePdsJson(unsigned)}`,
        "utf8"
      ),
      pdsEd25519PublicKey(options.signingPublicKey),
      decodePdsBase64url(signature, 64)
    )
  )
    throw new TypeError(`PDS ${recordType} signature is invalid`);
  return record;
};

export const validatePdsTombstoneAck = (
  value: unknown,
  options: {
    signingPublicKey: string | Buffer;
    expectedSignerKeyId: string;
    expectedGroupId: string;
    expectedTombstoneHash: string;
    expectedDeviceId: string;
    expectedStatementHash: string;
  }
): { ackedAt: Date } => {
  const record = validatePdsSingleSignatureRecord(
    value,
    [
      "protocol",
      "groupId",
      "tombstoneHash",
      "deviceId",
      "statementHash",
      "ackedAt",
      "signature"
    ],
    "tombstone-ack",
    options
  );
  if (
    record.protocol !== PDS_PROTOCOL ||
    record.groupId !== options.expectedGroupId ||
    record.tombstoneHash !== options.expectedTombstoneHash ||
    record.deviceId !== options.expectedDeviceId ||
    record.statementHash !== options.expectedStatementHash
  )
    throw new TypeError(
      "PDS tombstone acknowledgement does not bind tombstone"
    );
  const ackedAt = new Date(
    pdsIsoMillis(record.ackedAt, "tombstone acknowledgement time")
  );
  if (ackedAt.getTime() > Date.now() + PDS_CERTIFICATE_CLOCK_SKEW_MS)
    throw new TypeError("PDS tombstone acknowledgement is from future");
  return { ackedAt };
};

export const validatePdsPackageAck = (
  value: unknown,
  options: {
    signingPublicKey: string | Buffer;
    expectedSignerKeyId: string;
    expectedGroupId: string;
    expectedDeviceId: string;
  }
): void => {
  const record = validatePdsSingleSignatureRecord(
    value,
    [
      "protocol",
      "groupId",
      "transportId",
      "packageId",
      "sourceManifestHash",
      "recipientDeviceId",
      "intendedRecipientSnapshotHash",
      "relayAcceptedAt",
      "ackedAt",
      "result",
      "signature"
    ],
    "package-ack",
    options
  );
  if (
    record.protocol !== PDS_PROTOCOL ||
    record.groupId !== options.expectedGroupId ||
    record.recipientDeviceId !== options.expectedDeviceId ||
    record.result !== "materialized"
  )
    throw new TypeError("PDS package acknowledgement does not bind recipient");
  for (const field of [
    "packageId",
    "sourceManifestHash",
    "intendedRecipientSnapshotHash"
  ])
    decodePdsBase64url(record[field], 32);
  requireId(record.transportId, "transportId");
  pdsIsoMillis(record.relayAcceptedAt, "relayAcceptedAt");
  pdsIsoMillis(record.ackedAt, "ackedAt");
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
    const issued = new Date(pdsIsoMillis(record.issuedAt, "issuedAt"));
    const expires = new Date(pdsIsoMillis(record.expiresAt, "expiresAt"));
    if (
      issued >= expires ||
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
