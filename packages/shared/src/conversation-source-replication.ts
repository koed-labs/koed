import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type KeyObject
} from "node:crypto";
import { canonicalize } from "json-canonicalize";
import {
  resolveAiClientSourceAdapter,
  type AiClientSourceRuntime
} from "./ai-client-source-adapters.js";
import type { RecipientPublicKeyMaterial } from "./envelope-encryption.js";

export const CONVERSATION_SOURCE_REPLICATION_PROTOCOL =
  "koed.conversation-source-replication/v1" as const;
export const CONVERSATION_SOURCE_REPLICATION_MAX_SEGMENT_BYTES =
  16 * 1024 * 1024;
export const CONVERSATION_SOURCE_COMPONENT_SCHEMA_VERSION = 1 as const;

export type ConversationSourceComponentRole = "primary" | "auxiliary";
export type ConversationSourceContentFraming = "jsonl" | "immutable_blob";

export interface ConversationSourceComponentIdentity {
  sourceComponentSchemaVersion: typeof CONVERSATION_SOURCE_COMPONENT_SCHEMA_VERSION;
  sourceComponentId: string;
  sourceComponentRole: ConversationSourceComponentRole;
  parentSourceComponentId: string | null;
  contentFraming: ConversationSourceContentFraming;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const LOCAL_PROJECT_ID_PATTERN = /^lp_[0-9a-f]{32}$/;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]+$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const RFC3339_UTC_MILLISECONDS_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type JsonRecord = Record<string, unknown>;

export const assertConversationSourceReplicationJsonlSegment = (
  bytes: Uint8Array,
  expectedItems: number
): void => {
  if (
    !Number.isSafeInteger(expectedItems) ||
    expectedItems < 1 ||
    bytes.byteLength === 0 ||
    bytes.byteLength > CONVERSATION_SOURCE_REPLICATION_MAX_SEGMENT_BYTES ||
    bytes.at(-1) !== 0x0a
  ) {
    throw new TypeError("Conversation source segment boundary is invalid");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("Conversation source segment is not valid UTF-8");
  }
  const lines = text.split("\n").slice(0, -1);
  if (
    lines.length !== expectedItems ||
    lines.some((line) => line.trim().length === 0)
  ) {
    throw new TypeError("Conversation source segment item range is invalid");
  }
  try {
    for (const line of lines) JSON.parse(line.replace(/\r$/, ""));
  } catch {
    throw new TypeError("Conversation source segment contains malformed JSONL");
  }
};

export interface ConversationSourcePriorGenerationClosure {
  sourceGenerationId: string;
  contentDigest: string;
  closedAt: string;
}

export interface ConversationSourceReplicationManifest extends ConversationSourceComponentIdentity {
  protocol: typeof CONVERSATION_SOURCE_REPLICATION_PROTOCOL;
  logicalSourceId: string;
  sourceGenerationId: string;
  originKeyId: string;
  segmentIndex: number;
  startByteCursor: number;
  endByteCursor: number;
  startItemCursor: number;
  endItemCursor: number;
  previousContentDigest: string | null;
  plaintextDigest: string;
  sourceFormat: string;
  adapterVersion: string;
  sourceCreatedAt: string;
  priorGenerationClosure: ConversationSourcePriorGenerationClosure | null;
}

export interface SignedConversationSourceReplicationManifest {
  manifest: ConversationSourceReplicationManifest;
  signature: string;
}

export interface ConversationSourceClosureManifest extends ConversationSourceComponentIdentity {
  protocol: typeof CONVERSATION_SOURCE_REPLICATION_PROTOCOL;
  logicalSourceId: string;
  sourceGenerationId: string;
  originKeyId: string;
  segmentCount: number;
  endByteCursor: number;
  endItemCursor: number;
  chainHeadDigest: string | null;
  sourceRootDigest: string;
  sourceCreatedAt: string;
  closedAt: string;
  priorGenerationClosure: ConversationSourcePriorGenerationClosure | null;
}

export interface SignedConversationSourceClosureManifest {
  manifest: ConversationSourceClosureManifest;
  signature: string;
}

export interface ConversationSourceSetClosureMember extends Omit<
  ConversationSourceComponentIdentity,
  "sourceComponentSchemaVersion"
> {
  artifactClosureDigest: string;
}

export interface ConversationSourceSetClosureManifest {
  protocol: typeof CONVERSATION_SOURCE_REPLICATION_PROTOCOL;
  sourceSetClosureVersion: 1;
  sourceComponentSchemaVersion: typeof CONVERSATION_SOURCE_COMPONENT_SCHEMA_VERSION;
  logicalSourceId: string;
  sourceGenerationId: string;
  signingComponentId: string;
  originKeyId: string;
  components: ConversationSourceSetClosureMember[];
  componentSetDigest: string;
  closedAt: string;
}

export interface SignedConversationSourceSetClosureManifest {
  manifest: ConversationSourceSetClosureManifest;
  signature: string;
}

/**
 * Recipient-independent content recovered from a transport envelope.
 * Recipient, relationship, encryption, and upload metadata must be carried
 * separately and is deliberately rejected as an unknown field here.
 */
export interface ConversationSourceReplicationSegmentEnvelope {
  signedManifest: SignedConversationSourceReplicationManifest;
  plaintextBytes: string;
}

export const conversationSourceOriginKeyLifecycles = [
  "active",
  "lost",
  "revoked"
] as const;

export type ConversationSourceOriginKeyLifecycle =
  (typeof conversationSourceOriginKeyLifecycles)[number];

/**
 * The authority-pinned identity of one generation's immutable origin key.
 * A lost or revoked key remains useful for retained evidence verification but
 * cannot authorize acceptance of new segments.
 */
export interface ConversationSourceOriginKeyPin {
  protocol: typeof CONVERSATION_SOURCE_REPLICATION_PROTOCOL;
  logicalSourceId: string;
  sourceGenerationId: string;
  originKeyId: string;
  publicKey: string;
  sourceCreatedAt: string;
  priorGenerationClosure: ConversationSourcePriorGenerationClosure | null;
}

export interface ConversationSourceOriginKeyRegistration extends ConversationSourceOriginKeyPin {
  lifecycle: ConversationSourceOriginKeyLifecycle;
}

export type ConversationSourceReplicationSourceDescriptor = {
  sourceKind: "codex" | "claude-code" | "pi";
  sourceRuntime: AiClientSourceRuntime;
  artifactFormat: string;
  artifactFormatVersion: number;
  sourceAdapterVersion: string;
  sourceComponentSchemaVersion: typeof CONVERSATION_SOURCE_COMPONENT_SCHEMA_VERSION;
  sourceComponentId: string;
  sourceComponentRole: ConversationSourceComponentRole;
  parentSourceComponentId: string | null;
  contentFraming: ConversationSourceContentFraming;
  logicalSessionId: string;
  externalSessionId: string;
  forkedFromExternalThreadId: string | null;
  sourceFingerprint: string;
  redactedSourceLabel: string;
  originDeploymentId: string;
  originDeviceId: string;
  journalStartOffset: number;
  journalStartLine: number;
  liveStartOffset: number;
  liveStartLine: number;
  project: {
    id: string;
    name: string;
  } | null;
};

export interface ConversationSourceOriginKeyPair {
  originKeyId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyBase64url: string;
}

const ownRecord = (value: unknown, label: string): JsonRecord => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as JsonRecord;
};

const requireExactKeys = (
  value: JsonRecord,
  expectedKeys: readonly string[],
  label: string
): void => {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
};

const requireProtocol = (
  value: unknown
): typeof CONVERSATION_SOURCE_REPLICATION_PROTOCOL => {
  if (value !== CONVERSATION_SOURCE_REPLICATION_PROTOCOL) {
    throw new TypeError("Conversation source replication protocol is invalid");
  }
  return value;
};

const requireUuid = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a UUID`);
  }
  return value;
};

const requireDigest = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 hex digest`);
  }
  return value;
};

const requireNullableDigest = (value: unknown, label: string): string | null =>
  value === null ? null : requireDigest(value, label);

const requireCursor = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer`);
  }
  return value as number;
};

const requireIsoTimestamp = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    !RFC3339_UTC_MILLISECONDS_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(
      `${label} must be an RFC3339 UTC millisecond timestamp`
    );
  }
  return value;
};

const requireAsciiMetadata = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !PRINTABLE_ASCII_PATTERN.test(value)
  ) {
    throw new TypeError(`${label} must be 1-128 printable ASCII characters`);
  }
  return value;
};

const SOURCE_COMPONENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/;

const requireSourceComponentId = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !SOURCE_COMPONENT_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} sourceComponentId is invalid`);
  }
  return value;
};

const parseSourceComponentIdentity = (
  value: JsonRecord,
  label: string
): ConversationSourceComponentIdentity => {
  if (
    value.sourceComponentSchemaVersion !==
    CONVERSATION_SOURCE_COMPONENT_SCHEMA_VERSION
  ) {
    throw new TypeError(`${label} component schema version is invalid`);
  }
  if (
    typeof value.sourceComponentId !== "string" ||
    !SOURCE_COMPONENT_ID_PATTERN.test(value.sourceComponentId)
  ) {
    throw new TypeError(`${label} sourceComponentId is invalid`);
  }
  if (
    value.sourceComponentRole !== "primary" &&
    value.sourceComponentRole !== "auxiliary"
  ) {
    throw new TypeError(`${label} sourceComponentRole is invalid`);
  }
  const parentSourceComponentId = value.parentSourceComponentId;
  if (
    parentSourceComponentId !== null &&
    (typeof parentSourceComponentId !== "string" ||
      !SOURCE_COMPONENT_ID_PATTERN.test(parentSourceComponentId) ||
      parentSourceComponentId === value.sourceComponentId)
  ) {
    throw new TypeError(`${label} parentSourceComponentId is invalid`);
  }
  if (
    (value.sourceComponentRole === "primary" &&
      parentSourceComponentId !== null) ||
    (value.sourceComponentRole === "auxiliary" &&
      parentSourceComponentId === null)
  ) {
    throw new TypeError(`${label} component relationship is invalid`);
  }
  if (
    value.contentFraming !== "jsonl" &&
    value.contentFraming !== "immutable_blob"
  ) {
    throw new TypeError(`${label} contentFraming is invalid`);
  }
  return {
    sourceComponentSchemaVersion: CONVERSATION_SOURCE_COMPONENT_SCHEMA_VERSION,
    sourceComponentId: value.sourceComponentId,
    sourceComponentRole: value.sourceComponentRole,
    parentSourceComponentId,
    contentFraming: value.contentFraming
  };
};

const decodeBase64url = (
  value: unknown,
  label: string,
  expectedLength?: number
): Buffer => {
  if (
    typeof value !== "string" ||
    !BASE64URL_PATTERN.test(value) ||
    value.includes("=")
  ) {
    throw new TypeError(`${label} must be canonical base64url`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.toString("base64url") !== value ||
    (expectedLength !== undefined && decoded.length !== expectedLength)
  ) {
    throw new TypeError(`${label} must be canonical base64url`);
  }
  return decoded;
};

const parsePriorGenerationClosure = (
  value: unknown
): ConversationSourcePriorGenerationClosure | null => {
  if (value === null) return null;
  const closure = ownRecord(value, "Prior generation closure");
  requireExactKeys(
    closure,
    ["sourceGenerationId", "contentDigest", "closedAt"],
    "Prior generation closure"
  );
  return {
    sourceGenerationId: requireUuid(
      closure.sourceGenerationId,
      "Prior generation sourceGenerationId"
    ),
    contentDigest: requireDigest(
      closure.contentDigest,
      "Prior generation contentDigest"
    ),
    closedAt: requireIsoTimestamp(closure.closedAt, "Prior generation closedAt")
  };
};

const closuresEqual = (
  left: ConversationSourcePriorGenerationClosure | null,
  right: ConversationSourcePriorGenerationClosure | null
): boolean => canonicalize(left) === canonicalize(right);

export const parseConversationSourceReplicationManifest = (
  value: unknown
): ConversationSourceReplicationManifest => {
  const manifest = ownRecord(value, "Conversation source replication manifest");
  requireExactKeys(
    manifest,
    [
      "protocol",
      "sourceComponentSchemaVersion",
      "sourceComponentId",
      "sourceComponentRole",
      "parentSourceComponentId",
      "contentFraming",
      "logicalSourceId",
      "sourceGenerationId",
      "originKeyId",
      "segmentIndex",
      "startByteCursor",
      "endByteCursor",
      "startItemCursor",
      "endItemCursor",
      "previousContentDigest",
      "plaintextDigest",
      "sourceFormat",
      "adapterVersion",
      "sourceCreatedAt",
      "priorGenerationClosure"
    ],
    "Conversation source replication manifest"
  );

  const parsed: ConversationSourceReplicationManifest = {
    ...parseSourceComponentIdentity(manifest, "Manifest"),
    protocol: requireProtocol(manifest.protocol),
    logicalSourceId: requireUuid(
      manifest.logicalSourceId,
      "Manifest logicalSourceId"
    ),
    sourceGenerationId: requireUuid(
      manifest.sourceGenerationId,
      "Manifest sourceGenerationId"
    ),
    originKeyId: requireUuid(manifest.originKeyId, "Manifest originKeyId"),
    segmentIndex: requireCursor(manifest.segmentIndex, "Manifest segmentIndex"),
    startByteCursor: requireCursor(
      manifest.startByteCursor,
      "Manifest startByteCursor"
    ),
    endByteCursor: requireCursor(
      manifest.endByteCursor,
      "Manifest endByteCursor"
    ),
    startItemCursor: requireCursor(
      manifest.startItemCursor,
      "Manifest startItemCursor"
    ),
    endItemCursor: requireCursor(
      manifest.endItemCursor,
      "Manifest endItemCursor"
    ),
    previousContentDigest: requireNullableDigest(
      manifest.previousContentDigest,
      "Manifest previousContentDigest"
    ),
    plaintextDigest: requireDigest(
      manifest.plaintextDigest,
      "Manifest plaintextDigest"
    ),
    sourceFormat: requireAsciiMetadata(
      manifest.sourceFormat,
      "Manifest sourceFormat"
    ),
    adapterVersion: requireAsciiMetadata(
      manifest.adapterVersion,
      "Manifest adapterVersion"
    ),
    sourceCreatedAt: requireIsoTimestamp(
      manifest.sourceCreatedAt,
      "Manifest sourceCreatedAt"
    ),
    priorGenerationClosure: parsePriorGenerationClosure(
      manifest.priorGenerationClosure
    )
  };

  if (parsed.endByteCursor < parsed.startByteCursor) {
    throw new TypeError(
      "Manifest endByteCursor must not precede startByteCursor"
    );
  }
  if (parsed.endItemCursor < parsed.startItemCursor) {
    throw new TypeError(
      "Manifest endItemCursor must not precede startItemCursor"
    );
  }
  if (parsed.segmentIndex === 0 && parsed.previousContentDigest !== null) {
    throw new TypeError(
      "Manifest segment zero must have a null previousContentDigest"
    );
  }
  if (parsed.segmentIndex > 0 && parsed.previousContentDigest === null) {
    throw new TypeError(
      "Manifest nonzero segment must have a previousContentDigest"
    );
  }
  if (
    parsed.priorGenerationClosure?.sourceGenerationId ===
    parsed.sourceGenerationId
  ) {
    throw new TypeError(
      "Prior generation closure must name a different source generation"
    );
  }

  return parsed;
};

export const canonicalizeConversationSourceReplicationManifest = (
  manifest: ConversationSourceReplicationManifest
): string => canonicalize(parseConversationSourceReplicationManifest(manifest));

export const calculateConversationSourceReplicationManifestDigest = (
  manifest: ConversationSourceReplicationManifest
): string =>
  createHash("sha256")
    .update(canonicalizeConversationSourceReplicationManifest(manifest), "utf8")
    .digest("hex");

export const parseConversationSourceClosureManifest = (
  value: unknown
): ConversationSourceClosureManifest => {
  const manifest = ownRecord(value, "Conversation source closure manifest");
  requireExactKeys(
    manifest,
    [
      "protocol",
      "sourceComponentSchemaVersion",
      "sourceComponentId",
      "sourceComponentRole",
      "parentSourceComponentId",
      "contentFraming",
      "logicalSourceId",
      "sourceGenerationId",
      "originKeyId",
      "segmentCount",
      "endByteCursor",
      "endItemCursor",
      "chainHeadDigest",
      "sourceRootDigest",
      "sourceCreatedAt",
      "closedAt",
      "priorGenerationClosure"
    ],
    "Conversation source closure manifest"
  );
  const parsed: ConversationSourceClosureManifest = {
    ...parseSourceComponentIdentity(manifest, "Closure"),
    protocol: requireProtocol(manifest.protocol),
    logicalSourceId: requireUuid(
      manifest.logicalSourceId,
      "Closure logicalSourceId"
    ),
    sourceGenerationId: requireUuid(
      manifest.sourceGenerationId,
      "Closure sourceGenerationId"
    ),
    originKeyId: requireUuid(manifest.originKeyId, "Closure originKeyId"),
    segmentCount: requireCursor(manifest.segmentCount, "Closure segmentCount"),
    endByteCursor: requireCursor(
      manifest.endByteCursor,
      "Closure endByteCursor"
    ),
    endItemCursor: requireCursor(
      manifest.endItemCursor,
      "Closure endItemCursor"
    ),
    chainHeadDigest: requireNullableDigest(
      manifest.chainHeadDigest,
      "Closure chainHeadDigest"
    ),
    sourceRootDigest: requireDigest(
      manifest.sourceRootDigest,
      "Closure sourceRootDigest"
    ),
    sourceCreatedAt: requireIsoTimestamp(
      manifest.sourceCreatedAt,
      "Closure sourceCreatedAt"
    ),
    closedAt: requireIsoTimestamp(manifest.closedAt, "Closure closedAt"),
    priorGenerationClosure: parsePriorGenerationClosure(
      manifest.priorGenerationClosure
    )
  };
  if (
    (parsed.segmentCount === 0 && parsed.chainHeadDigest !== null) ||
    (parsed.segmentCount > 0 && parsed.chainHeadDigest === null)
  ) {
    throw new TypeError(
      "Closure segment count and chain head digest are inconsistent"
    );
  }
  if (
    parsed.priorGenerationClosure?.sourceGenerationId ===
    parsed.sourceGenerationId
  ) {
    throw new TypeError(
      "Prior generation closure must name a different source generation"
    );
  }
  if (Date.parse(parsed.closedAt) < Date.parse(parsed.sourceCreatedAt)) {
    throw new TypeError("Closure cannot predate source creation");
  }
  return parsed;
};

export const canonicalizeConversationSourceClosureManifest = (
  manifest: ConversationSourceClosureManifest
): string => canonicalize(parseConversationSourceClosureManifest(manifest));

export const calculateConversationSourceRootDigest = (
  contentDigests: readonly string[]
): string => {
  const parsed = contentDigests.map((digest, index) =>
    requireDigest(digest, `Source content digest ${index}`)
  );
  return createHash("sha256")
    .update(canonicalize(parsed), "utf8")
    .digest("hex");
};

const parseConversationSourceSetClosureMembers = (
  value: unknown
): ConversationSourceSetClosureMember[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new TypeError("Source-set closure components are invalid");
  }
  const members = value.map((candidate, index) => {
    const member = ownRecord(
      candidate,
      `Source-set closure component ${index}`
    );
    requireExactKeys(
      member,
      [
        "sourceComponentId",
        "sourceComponentRole",
        "parentSourceComponentId",
        "contentFraming",
        "artifactClosureDigest"
      ],
      `Source-set closure component ${index}`
    );
    const identity = parseSourceComponentIdentity(
      {
        ...member,
        sourceComponentSchemaVersion:
          CONVERSATION_SOURCE_COMPONENT_SCHEMA_VERSION
      },
      `Source-set closure component ${index}`
    );
    return {
      sourceComponentId: identity.sourceComponentId,
      sourceComponentRole: identity.sourceComponentRole,
      parentSourceComponentId: identity.parentSourceComponentId,
      contentFraming: identity.contentFraming,
      artifactClosureDigest: requireDigest(
        member.artifactClosureDigest,
        `Source-set closure component ${index} artifactClosureDigest`
      )
    };
  });
  const ids = members.map((member) => member.sourceComponentId);
  const sortedIds = [...ids].sort();
  if (
    ids.some((id, index) => id !== sortedIds[index]) ||
    new Set(ids).size !== ids.length
  ) {
    throw new TypeError(
      "Source-set closure components must be unique and canonically ordered"
    );
  }
  const primaries = members.filter(
    (member) => member.sourceComponentRole === "primary"
  );
  if (primaries.length !== 1 || primaries[0]?.sourceComponentId !== "main") {
    throw new TypeError(
      "Source-set closure must contain main as its sole primary component"
    );
  }
  for (const member of members) {
    if (
      member.parentSourceComponentId !== null &&
      !ids.includes(member.parentSourceComponentId)
    ) {
      throw new TypeError(
        "Source-set closure component parent is not a member"
      );
    }
    const visited = new Set<string>([member.sourceComponentId]);
    let parentId = member.parentSourceComponentId;
    while (parentId !== null) {
      if (visited.has(parentId)) {
        throw new TypeError("Source-set closure component ancestry is cyclic");
      }
      visited.add(parentId);
      parentId =
        members.find((candidate) => candidate.sourceComponentId === parentId)
          ?.parentSourceComponentId ?? null;
    }
    if (!visited.has("main")) {
      throw new TypeError("Source-set closure component is not rooted at main");
    }
  }
  return members;
};

export const calculateConversationSourceComponentSetDigest = (
  components: readonly ConversationSourceSetClosureMember[]
): string =>
  createHash("sha256")
    .update(
      canonicalize(parseConversationSourceSetClosureMembers(components)),
      "utf8"
    )
    .digest("hex");

export const parseConversationSourceSetClosureManifest = (
  value: unknown
): ConversationSourceSetClosureManifest => {
  const manifest = ownRecord(value, "Conversation source-set closure manifest");
  requireExactKeys(
    manifest,
    [
      "protocol",
      "sourceSetClosureVersion",
      "sourceComponentSchemaVersion",
      "logicalSourceId",
      "sourceGenerationId",
      "signingComponentId",
      "originKeyId",
      "components",
      "componentSetDigest",
      "closedAt"
    ],
    "Conversation source-set closure manifest"
  );
  if (
    manifest.sourceSetClosureVersion !== 1 ||
    manifest.sourceComponentSchemaVersion !==
      CONVERSATION_SOURCE_COMPONENT_SCHEMA_VERSION
  ) {
    throw new TypeError("Conversation source-set closure version is invalid");
  }
  const components = parseConversationSourceSetClosureMembers(
    manifest.components
  );
  const componentSetDigest = requireDigest(
    manifest.componentSetDigest,
    "Source-set closure componentSetDigest"
  );
  if (
    componentSetDigest !==
    calculateConversationSourceComponentSetDigest(components)
  ) {
    throw new TypeError("Source-set closure component digest is invalid");
  }
  if (manifest.signingComponentId !== "main") {
    throw new TypeError("Source-set closure signing component is invalid");
  }
  return {
    protocol: requireProtocol(manifest.protocol),
    sourceSetClosureVersion: 1,
    sourceComponentSchemaVersion: CONVERSATION_SOURCE_COMPONENT_SCHEMA_VERSION,
    logicalSourceId: requireUuid(
      manifest.logicalSourceId,
      "Source-set closure logicalSourceId"
    ),
    sourceGenerationId: requireUuid(
      manifest.sourceGenerationId,
      "Source-set closure sourceGenerationId"
    ),
    signingComponentId: "main",
    originKeyId: requireUuid(
      manifest.originKeyId,
      "Source-set closure originKeyId"
    ),
    components,
    componentSetDigest,
    closedAt: requireIsoTimestamp(
      manifest.closedAt,
      "Source-set closure closedAt"
    )
  };
};

export const canonicalizeConversationSourceSetClosureManifest = (
  manifest: ConversationSourceSetClosureManifest
): string => canonicalize(parseConversationSourceSetClosureManifest(manifest));

export const calculateConversationSourceSetClosureDigest = (
  signedClosure: SignedConversationSourceSetClosureManifest
): string => {
  const parsed = parseSignedConversationSourceSetClosureManifest(signedClosure);
  return createHash("sha256")
    .update(canonicalize(parsed), "utf8")
    .digest("hex");
};

export const signConversationSourceSetClosureManifest = (
  manifest: ConversationSourceSetClosureManifest,
  privateKey: KeyObject
): SignedConversationSourceSetClosureManifest => {
  assertEd25519Key(privateKey, "private");
  const parsed = parseConversationSourceSetClosureManifest(manifest);
  return {
    manifest: parsed,
    signature: sign(
      null,
      Buffer.from(canonicalize(parsed), "utf8"),
      privateKey
    ).toString("base64url")
  };
};

export const parseSignedConversationSourceSetClosureManifest = (
  value: unknown
): SignedConversationSourceSetClosureManifest => {
  const signed = ownRecord(value, "Signed conversation source-set closure");
  requireExactKeys(
    signed,
    ["manifest", "signature"],
    "Signed conversation source-set closure"
  );
  return {
    manifest: parseConversationSourceSetClosureManifest(signed.manifest),
    signature: decodeBase64url(
      signed.signature,
      "Source-set closure signature",
      64
    ).toString("base64url")
  };
};

export const verifyConversationSourceSetClosureManifestSignature = (
  signedClosure: SignedConversationSourceSetClosureManifest,
  publicKey: KeyObject | string
): boolean => {
  const parsed = parseSignedConversationSourceSetClosureManifest(signedClosure);
  const key =
    typeof publicKey === "string"
      ? importConversationSourceReplicationPublicKey(publicKey)
      : publicKey;
  assertEd25519Key(key, "public");
  return verify(
    null,
    Buffer.from(canonicalize(parsed.manifest), "utf8"),
    key,
    decodeBase64url(parsed.signature, "Source-set closure signature", 64)
  );
};

export const signConversationSourceClosureManifest = (
  manifest: ConversationSourceClosureManifest,
  privateKey: KeyObject
): SignedConversationSourceClosureManifest => {
  assertEd25519Key(privateKey, "private");
  const parsed = parseConversationSourceClosureManifest(manifest);
  return {
    manifest: parsed,
    signature: sign(
      null,
      Buffer.from(canonicalize(parsed), "utf8"),
      privateKey
    ).toString("base64url")
  };
};

export const parseSignedConversationSourceClosureManifest = (
  value: unknown
): SignedConversationSourceClosureManifest => {
  const signed = ownRecord(value, "Signed conversation source closure");
  requireExactKeys(
    signed,
    ["manifest", "signature"],
    "Signed conversation source closure"
  );
  decodeBase64url(signed.signature, "Closure origin signature", 64);
  return {
    manifest: parseConversationSourceClosureManifest(signed.manifest),
    signature: signed.signature as string
  };
};

export const verifyConversationSourceClosureManifestSignature = (
  signedClosure: SignedConversationSourceClosureManifest,
  publicKey: KeyObject | string
): boolean => {
  const parsed = parseSignedConversationSourceClosureManifest(signedClosure);
  const key =
    typeof publicKey === "string"
      ? importConversationSourceReplicationPublicKey(publicKey)
      : publicKey;
  assertEd25519Key(key, "public");
  return verify(
    null,
    Buffer.from(canonicalize(parsed.manifest), "utf8"),
    key,
    decodeBase64url(parsed.signature, "Closure origin signature", 64)
  );
};

export const calculateConversationSourceClosureDigest = (
  signedClosure: SignedConversationSourceClosureManifest
): string =>
  createHash("sha256")
    .update(
      canonicalize(parseSignedConversationSourceClosureManifest(signedClosure)),
      "utf8"
    )
    .digest("hex");

export const calculateConversationSourceClosureOperationContentDigest = (
  artifactClosureDigest: string,
  sourceSetClosureDigest: string | null
): string =>
  createHash("sha256")
    .update(
      canonicalize({
        artifactClosureDigest: requireDigest(
          artifactClosureDigest,
          "Artifact closure digest"
        ),
        sourceSetClosureDigest:
          sourceSetClosureDigest === null
            ? null
            : requireDigest(sourceSetClosureDigest, "Source-set closure digest")
      }),
      "utf8"
    )
    .digest("hex");

export const calculateConversationSourceReplicationPlaintextDigest = (
  plaintext: Uint8Array
): string => createHash("sha256").update(plaintext).digest("hex");

export const calculateConversationSourceReplicationOperationDigest = (input: {
  operationId: string;
  operationKind: "register_generation" | "append_segment" | "close_generation";
  logicalSourceId: string;
  sourceGenerationId: string;
  contentDigest: string;
  targetDeploymentId: string;
}): string => {
  const operationId = requireUuid(input.operationId, "Operation operationId");
  const logicalSourceId = requireUuid(
    input.logicalSourceId,
    "Operation logicalSourceId"
  );
  const sourceGenerationId = requireUuid(
    input.sourceGenerationId,
    "Operation sourceGenerationId"
  );
  const targetDeploymentId = requireUuid(
    input.targetDeploymentId,
    "Operation targetDeploymentId"
  );
  const contentDigest = requireDigest(
    input.contentDigest,
    "Operation contentDigest"
  );
  if (
    input.operationKind !== "register_generation" &&
    input.operationKind !== "append_segment" &&
    input.operationKind !== "close_generation"
  ) {
    throw new TypeError("Operation kind is invalid");
  }
  return createHash("sha256")
    .update(
      canonicalize({
        protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
        operationId,
        operationKind: input.operationKind,
        logicalSourceId,
        sourceGenerationId,
        contentDigest,
        targetDeploymentId
      }),
      "utf8"
    )
    .digest("hex");
};

export const calculateConversationSourceDownloadScopeHash = (input: {
  sourceGenerationId: string;
  sourceComponentId: string;
  targetDeploymentId: string;
  recipientKey: RecipientPublicKeyMaterial;
}): string =>
  createHash("sha256")
    .update(
      `${CONVERSATION_SOURCE_REPLICATION_PROTOCOL}/download-scope\n${canonicalize(
        {
          sourceGenerationId: requireUuid(
            input.sourceGenerationId,
            "Source download generation"
          ),
          sourceComponentId: requireSourceComponentId(
            input.sourceComponentId,
            "Source download"
          ),
          targetDeploymentId: requireUuid(
            input.targetDeploymentId,
            "Source download target deployment"
          ),
          recipientKey: input.recipientKey
        }
      )}`,
      "utf8"
    )
    .digest("hex");

export const CONVERSATION_SOURCE_DOWNLOAD_AUTHORIZATION_TTL_MS =
  30 * 60 * 1_000;

export const calculateConversationSourceDownloadRequestHash = (input: {
  sourceGenerationId: string;
  sourceComponentId: string;
  targetDeploymentId: string;
  recipientKey: RecipientPublicKeyMaterial;
  firstSegmentIndex: number;
}): string => {
  if (
    !Number.isSafeInteger(input.firstSegmentIndex) ||
    input.firstSegmentIndex < 0
  ) {
    throw new TypeError("Source download segment index is invalid");
  }
  return createHash("sha256")
    .update(
      `${CONVERSATION_SOURCE_REPLICATION_PROTOCOL}/download-request\n${canonicalize(
        {
          sourceGenerationId: requireUuid(
            input.sourceGenerationId,
            "Source download generation"
          ),
          sourceComponentId: requireSourceComponentId(
            input.sourceComponentId,
            "Source download"
          ),
          targetDeploymentId: requireUuid(
            input.targetDeploymentId,
            "Source download target deployment"
          ),
          recipientKey: input.recipientKey,
          firstSegmentIndex: input.firstSegmentIndex
        }
      )}`,
      "utf8"
    )
    .digest("hex");
};

export const calculateConversationSourceDiscoveryScopeHash = (): string =>
  createHash("sha256")
    .update(
      `${CONVERSATION_SOURCE_REPLICATION_PROTOCOL}/discovery-scope`,
      "utf8"
    )
    .digest("hex");

export const calculateConversationSourceDiscoveryRequestHash = (input: {
  cursor: { updatedAt: string; id: string } | null;
  limit: number;
}): string => {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  ) {
    throw new TypeError("Source discovery limit is invalid");
  }
  if (
    input.cursor &&
    (!RFC3339_UTC_MILLISECONDS_PATTERN.test(input.cursor.updatedAt) ||
      !UUID_PATTERN.test(input.cursor.id))
  ) {
    throw new TypeError("Source discovery cursor is invalid");
  }
  return createHash("sha256")
    .update(
      `${CONVERSATION_SOURCE_REPLICATION_PROTOCOL}/discovery-request\n${canonicalize(
        input
      )}`,
      "utf8"
    )
    .digest("hex");
};

export const parseSignedConversationSourceReplicationManifest = (
  value: unknown
): SignedConversationSourceReplicationManifest => {
  const signed = ownRecord(
    value,
    "Signed conversation source replication manifest"
  );
  requireExactKeys(
    signed,
    ["manifest", "signature"],
    "Signed conversation source replication manifest"
  );
  decodeBase64url(signed.signature, "Origin signature", 64);
  return {
    manifest: parseConversationSourceReplicationManifest(signed.manifest),
    signature: signed.signature as string
  };
};

const canonicalizeSignedManifest = (
  signedManifest: SignedConversationSourceReplicationManifest
): string =>
  canonicalize(
    parseSignedConversationSourceReplicationManifest(signedManifest)
  );

/**
 * Stable identity for exact origin-signed content. This includes the signature,
 * unlike manifestDigest, and is the value linked by the next segment.
 */
export const calculateConversationSourceReplicationContentDigest = (
  signedManifest: SignedConversationSourceReplicationManifest
): string =>
  createHash("sha256")
    .update(canonicalizeSignedManifest(signedManifest), "utf8")
    .digest("hex");

const assertEd25519Key = (
  key: KeyObject,
  expectedType: "private" | "public"
): void => {
  if (key.type !== expectedType || key.asymmetricKeyType !== "ed25519") {
    throw new TypeError(`Expected an Ed25519 ${expectedType} key`);
  }
};

export const exportConversationSourceReplicationPublicKey = (
  publicKey: KeyObject
): string => {
  assertEd25519Key(publicKey, "public");
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new TypeError("Ed25519 public key export is invalid");
  }
  decodeBase64url(jwk.x, "Ed25519 public key", 32);
  return jwk.x;
};

export const importConversationSourceReplicationPublicKey = (
  publicKey: string
): KeyObject => {
  const raw = decodeBase64url(publicKey, "Ed25519 public key", 32);
  return createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: raw.toString("base64url")
    },
    format: "jwk"
  });
};

export const generateConversationSourceReplicationOriginKeyPair =
  (): ConversationSourceOriginKeyPair => {
    const pair = generateKeyPairSync("ed25519");
    return {
      originKeyId: randomUUID(),
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      publicKeyBase64url: exportConversationSourceReplicationPublicKey(
        pair.publicKey
      )
    };
  };

export const signConversationSourceReplicationManifest = (
  manifest: ConversationSourceReplicationManifest,
  privateKey: KeyObject
): SignedConversationSourceReplicationManifest => {
  assertEd25519Key(privateKey, "private");
  const parsedManifest = parseConversationSourceReplicationManifest(manifest);
  const canonicalManifest = canonicalize(parsedManifest);
  return {
    manifest: parsedManifest,
    signature: sign(
      null,
      Buffer.from(canonicalManifest, "utf8"),
      privateKey
    ).toString("base64url")
  };
};

export const verifyConversationSourceReplicationManifestSignature = (
  signedManifest: SignedConversationSourceReplicationManifest,
  publicKey: KeyObject | string
): boolean => {
  const parsed =
    parseSignedConversationSourceReplicationManifest(signedManifest);
  const key =
    typeof publicKey === "string"
      ? importConversationSourceReplicationPublicKey(publicKey)
      : publicKey;
  assertEd25519Key(key, "public");
  return verify(
    null,
    Buffer.from(canonicalize(parsed.manifest), "utf8"),
    key,
    decodeBase64url(parsed.signature, "Origin signature", 64)
  );
};

const parseOriginKeyPinFields = (
  pin: JsonRecord
): ConversationSourceOriginKeyPin => {
  const publicKey = pin.publicKey;
  if (typeof publicKey !== "string") {
    throw new TypeError("Origin public key must be canonical base64url");
  }
  importConversationSourceReplicationPublicKey(publicKey);
  return {
    protocol: requireProtocol(pin.protocol),
    logicalSourceId: requireUuid(
      pin.logicalSourceId,
      "Origin key pin logicalSourceId"
    ),
    sourceGenerationId: requireUuid(
      pin.sourceGenerationId,
      "Origin key pin sourceGenerationId"
    ),
    originKeyId: requireUuid(pin.originKeyId, "Origin key pin originKeyId"),
    publicKey,
    sourceCreatedAt: requireIsoTimestamp(
      pin.sourceCreatedAt,
      "Origin key pin sourceCreatedAt"
    ),
    priorGenerationClosure: parsePriorGenerationClosure(
      pin.priorGenerationClosure
    )
  };
};

export const parseConversationSourceOriginKeyPin = (
  value: unknown
): ConversationSourceOriginKeyPin => {
  const pin = ownRecord(value, "Origin key pin");
  requireExactKeys(
    pin,
    [
      "protocol",
      "logicalSourceId",
      "sourceGenerationId",
      "originKeyId",
      "publicKey",
      "sourceCreatedAt",
      "priorGenerationClosure"
    ],
    "Origin key pin"
  );
  return parseOriginKeyPinFields(pin);
};

export const parseConversationSourceOriginKeyRegistration = (
  value: unknown
): ConversationSourceOriginKeyRegistration => {
  const registration = ownRecord(value, "Origin key registration");
  requireExactKeys(
    registration,
    [
      "protocol",
      "logicalSourceId",
      "sourceGenerationId",
      "originKeyId",
      "publicKey",
      "lifecycle",
      "sourceCreatedAt",
      "priorGenerationClosure"
    ],
    "Origin key registration"
  );
  if (
    typeof registration.lifecycle !== "string" ||
    !conversationSourceOriginKeyLifecycles.includes(
      registration.lifecycle as ConversationSourceOriginKeyLifecycle
    )
  ) {
    throw new TypeError("Origin key lifecycle is invalid");
  }
  const pin = parseOriginKeyPinFields(registration);
  return {
    ...pin,
    lifecycle: registration.lifecycle as ConversationSourceOriginKeyLifecycle
  };
};

export const calculateConversationSourceOriginKeyRegistrationDigest = (
  registration: ConversationSourceOriginKeyRegistration
): string =>
  createHash("sha256")
    .update(
      canonicalize(parseConversationSourceOriginKeyRegistration(registration)),
      "utf8"
    )
    .digest("hex");

export const parseConversationSourceReplicationSourceDescriptor = (
  value: unknown
): ConversationSourceReplicationSourceDescriptor => {
  const descriptor = ownRecord(value, "Conversation source descriptor");
  requireExactKeys(
    descriptor,
    [
      "sourceKind",
      "sourceComponentSchemaVersion",
      "sourceComponentId",
      "sourceComponentRole",
      "parentSourceComponentId",
      "contentFraming",
      "logicalSessionId",
      "externalSessionId",
      "forkedFromExternalThreadId",
      "sourceFingerprint",
      "artifactFormat",
      "artifactFormatVersion",
      "sourceAdapterVersion",
      "sourceRuntime",
      "redactedSourceLabel",
      "originDeploymentId",
      "originDeviceId",
      "journalStartOffset",
      "journalStartLine",
      "liveStartOffset",
      "liveStartLine",
      "project"
    ],
    "Conversation source descriptor"
  );
  const componentIdentity = parseSourceComponentIdentity(
    descriptor,
    "Descriptor"
  );
  const sourceAdapter = resolveAiClientSourceAdapter(descriptor);
  const immutableBlobAdapterValid =
    componentIdentity.contentFraming === "immutable_blob" &&
    Number.isSafeInteger(descriptor.artifactFormatVersion) &&
    (descriptor.artifactFormatVersion as number) > 0 &&
    typeof descriptor.artifactFormat === "string" &&
    /^[a-z][a-z0-9_]{0,127}$/.test(descriptor.artifactFormat) &&
    ((descriptor.sourceKind === "codex" &&
      (descriptor.sourceRuntime === "codex" ||
        descriptor.sourceRuntime === "codex-cli") &&
      descriptor.sourceAdapterVersion === "codex-transcript-v1") ||
      (descriptor.sourceKind === "claude-code" &&
        descriptor.sourceRuntime === "claude-code" &&
        descriptor.sourceAdapterVersion === "claude-code-transcript-v1") ||
      (descriptor.sourceKind === "pi" &&
        descriptor.sourceRuntime === "pi" &&
        descriptor.sourceAdapterVersion === "pi-session-v1"));
  if (!sourceAdapter && !immutableBlobAdapterValid) {
    throw new TypeError("Conversation source descriptor format is invalid");
  }
  if (
    typeof descriptor.externalSessionId !== "string" ||
    descriptor.externalSessionId.length < 1 ||
    descriptor.externalSessionId.length > 1_024 ||
    (descriptor.forkedFromExternalThreadId !== null &&
      (typeof descriptor.forkedFromExternalThreadId !== "string" ||
        descriptor.forkedFromExternalThreadId.length < 1 ||
        descriptor.forkedFromExternalThreadId.length > 1_024)) ||
    typeof descriptor.redactedSourceLabel !== "string" ||
    descriptor.redactedSourceLabel.trim().length < 1 ||
    descriptor.redactedSourceLabel.length > 255
  ) {
    throw new TypeError("Conversation source descriptor label is invalid");
  }
  const project =
    descriptor.project === null
      ? null
      : ownRecord(descriptor.project, "Conversation source project");
  let projectId: string | null = null;
  let projectName: string | null = null;
  if (project) {
    requireExactKeys(project, ["id", "name"], "Conversation source project");
    if (
      typeof project.id !== "string" ||
      !LOCAL_PROJECT_ID_PATTERN.test(project.id.trim()) ||
      typeof project.name !== "string" ||
      project.name.trim().length < 1 ||
      project.name.length > 160
    ) {
      throw new TypeError("Conversation source project is invalid");
    }
    projectId = project.id.trim();
    projectName = project.name.trim();
  }
  const journalStartOffset = requireCursor(
    descriptor.journalStartOffset,
    "Descriptor journalStartOffset"
  );
  const journalStartLine = requireCursor(
    descriptor.journalStartLine,
    "Descriptor journalStartLine"
  );
  const liveStartOffset = requireCursor(
    descriptor.liveStartOffset,
    "Descriptor liveStartOffset"
  );
  const liveStartLine = requireCursor(
    descriptor.liveStartLine,
    "Descriptor liveStartLine"
  );
  if (
    liveStartOffset < journalStartOffset ||
    liveStartLine < journalStartLine
  ) {
    throw new TypeError(
      "Conversation source descriptor live boundary precedes its journal boundary"
    );
  }
  return {
    ...componentIdentity,
    sourceKind: descriptor.sourceKind as "codex" | "claude-code" | "pi",
    logicalSessionId: requireUuid(
      descriptor.logicalSessionId,
      "Descriptor logicalSessionId"
    ),
    externalSessionId: descriptor.externalSessionId,
    forkedFromExternalThreadId:
      descriptor.forkedFromExternalThreadId === null
        ? null
        : descriptor.forkedFromExternalThreadId,
    sourceFingerprint: requireDigest(
      descriptor.sourceFingerprint,
      "Descriptor sourceFingerprint"
    ),
    artifactFormat:
      sourceAdapter?.artifactFormat ?? (descriptor.artifactFormat as string),
    artifactFormatVersion:
      sourceAdapter?.artifactFormatVersion ??
      (descriptor.artifactFormatVersion as number),
    sourceAdapterVersion:
      sourceAdapter?.sourceAdapterVersion ??
      (descriptor.sourceAdapterVersion as string),
    sourceRuntime:
      sourceAdapter?.sourceRuntime ??
      (descriptor.sourceRuntime as AiClientSourceRuntime),
    redactedSourceLabel: descriptor.redactedSourceLabel.trim(),
    originDeploymentId: requireUuid(
      descriptor.originDeploymentId,
      "Descriptor originDeploymentId"
    ),
    originDeviceId: requireUuid(
      descriptor.originDeviceId,
      "Descriptor originDeviceId"
    ),
    journalStartOffset,
    journalStartLine,
    liveStartOffset,
    liveStartLine,
    project:
      projectId && projectName
        ? {
            id: projectId,
            name: projectName
          }
        : null
  };
};

export const calculateConversationSourceGenerationRegistrationDigest = (
  registration: ConversationSourceOriginKeyRegistration,
  source: ConversationSourceReplicationSourceDescriptor
): string =>
  createHash("sha256")
    .update(
      canonicalize({
        registration:
          parseConversationSourceOriginKeyRegistration(registration),
        source: parseConversationSourceReplicationSourceDescriptor(source)
      }),
      "utf8"
    )
    .digest("hex");

export const assertConversationSourceOriginKeyAcceptsManifest = (
  registration: ConversationSourceOriginKeyRegistration,
  manifest: ConversationSourceReplicationManifest
): void => {
  const pinned = parseConversationSourceOriginKeyRegistration(registration);
  const parsedManifest = parseConversationSourceReplicationManifest(manifest);
  if (pinned.lifecycle !== "active") {
    throw new Error(
      `Origin key lifecycle ${pinned.lifecycle} rejects new segment acceptance`
    );
  }
  if (
    pinned.logicalSourceId !== parsedManifest.logicalSourceId ||
    pinned.sourceGenerationId !== parsedManifest.sourceGenerationId ||
    pinned.originKeyId !== parsedManifest.originKeyId ||
    pinned.sourceCreatedAt !== parsedManifest.sourceCreatedAt ||
    !closuresEqual(
      pinned.priorGenerationClosure,
      parsedManifest.priorGenerationClosure
    )
  ) {
    throw new Error(
      "Manifest does not match the pinned origin key registration"
    );
  }
};

export const verifyConversationSourceReplicationManifestForAcceptance = (
  signedManifest: SignedConversationSourceReplicationManifest,
  registration: ConversationSourceOriginKeyRegistration
): boolean => {
  const parsedSigned =
    parseSignedConversationSourceReplicationManifest(signedManifest);
  const pinned = parseConversationSourceOriginKeyRegistration(registration);
  assertConversationSourceOriginKeyAcceptsManifest(
    pinned,
    parsedSigned.manifest
  );
  return verifyConversationSourceReplicationManifestSignature(
    parsedSigned,
    pinned.publicKey
  );
};

export const parseConversationSourceReplicationSegmentEnvelope = (
  value: unknown
): ConversationSourceReplicationSegmentEnvelope => {
  const envelope = ownRecord(
    value,
    "Conversation source replication segment envelope"
  );
  requireExactKeys(
    envelope,
    ["signedManifest", "plaintextBytes"],
    "Conversation source replication segment envelope"
  );
  const signedManifest = parseSignedConversationSourceReplicationManifest(
    envelope.signedManifest
  );
  const plaintextBytes = decodeBase64url(
    envelope.plaintextBytes,
    "Segment plaintextBytes"
  );
  if (
    calculateConversationSourceReplicationPlaintextDigest(plaintextBytes) !==
    signedManifest.manifest.plaintextDigest
  ) {
    throw new Error("Segment plaintext digest does not match its manifest");
  }
  return {
    signedManifest,
    plaintextBytes: envelope.plaintextBytes as string
  };
};

export const parseCanonicalConversationSourceReplicationManifestJson = (
  input: string
): ConversationSourceReplicationManifest => {
  const parsed = JSON.parse(input) as unknown;
  const manifest = parseConversationSourceReplicationManifest(parsed);
  if (canonicalize(manifest) !== input) {
    throw new SyntaxError(
      "Conversation source replication manifest is not RFC 8785 canonical JSON"
    );
  }
  return manifest;
};
