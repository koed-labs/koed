import { createHash, sign, verify, type KeyObject } from "node:crypto";
import {
  canonicalizePdsJson,
  parseCanonicalPdsJson
} from "./personal-device-sync-jcs.js";
import { pdsEd25519PublicKey } from "./personal-device-sync.js";

export const PDS_ARTIFACT_PROTOCOL = "koed/pds-artifact/v1" as const;
export const PDS_ARTIFACT_SCHEMA_VERSION = "1" as const;
export const PDS_ARTIFACT_MAX_JSON_BYTES = 64 * 1024 * 1024;
export const PDS_ARTIFACT_MAX_ITEMS = 100_000;

export const pdsArtifactClasses = [
  "memory_event/v1",
  "memory_embedding/v1",
  "lcm_node/v1"
] as const;

export type PdsArtifactClass = (typeof pdsArtifactClasses)[number];
export type PdsReplicationClassification =
  | "replicate"
  | "derive_locally"
  | "device_local"
  | "external_authority";

export const PDS_PERSONAL_REPLICATION_REGISTRY = {
  canonical_conversation_source: "replicate",
  memory_events: "replicate",
  memory_event_embeddings: "replicate",
  lcm_compaction_frontiers: "derive_locally",
  lcm_nodes: "replicate",
  local_vector_indexes: "device_local",
  queue_jobs: "device_local",
  process_leases: "device_local",
  retry_state: "device_local",
  runtime_credentials: "device_local",
  api_tokens: "device_local",
  browser_sessions: "device_local",
  local_source_paths: "device_local",
  team_collaboration_data: "external_authority"
} as const satisfies Record<string, PdsReplicationClassification>;

export interface PdsMemoryEventContractV1 {
  artifactClass: "memory_event/v1";
  projectionPolicyKey: string;
  projectionPolicyRevision: string;
  projectionAlgorithmVersion: string;
  tokenCounter: string;
}

export interface PdsEmbeddingContractV1 {
  artifactClass: "memory_embedding/v1";
  modelKey: string;
  modelArtifactHash: string;
  dimensions: string;
  tokenizer: string;
  inputTransform: string;
  pooling: string;
  normalization: string;
  embeddingVersion: string;
}

export interface PdsLcmNodeContractV1 {
  artifactClass: "lcm_node/v1";
  nodeKind: "leaf" | "rollup";
  lcmAlgorithmVersion: string;
  summaryPromptVersion: string;
  summaryModel: string;
  structuredOutputSchema: string;
  sourceSelectionPolicy: string;
}

export type PdsArtifactCompatibilityContract =
  | PdsMemoryEventContractV1
  | PdsEmbeddingContractV1
  | PdsLcmNodeContractV1;

export interface PdsPortableMemoryEventV1 {
  logicalEventId: string;
  sourceOrdinals: string[];
  eventType: "captured" | "invalidated" | "summarized" | "embedded";
  actor: string;
  rawEventType: string;
  content: string;
  metadata: Record<string, unknown>;
  includeInEmbedding: boolean;
  includeInLcm: boolean;
  tokenCount: string;
  sealReason: string;
  sourceEventTime: string;
  sourceSequence: string;
  contentHash: string;
}

export interface PdsPortableMemoryEmbeddingV1 {
  logicalEmbeddingId: string;
  logicalSourceType: "memory_event" | "lcm_node";
  logicalSourceId: string;
  sourceContentHash: string;
  sourceChunkIndex: string;
  sourceChunkCount: string;
  sourceHash: string;
  canonicalSourceTextHash: string;
  sourceText: string;
  sourceTextHash: string;
  vector: string[];
  vectorHash: string;
}

export interface PdsPortableLcmNodeV1 {
  logicalNodeId: string;
  nodeKind: "leaf" | "rollup";
  orderedSourceIds: string[];
  summaryText: string;
  summaryTokenCount: string;
  structuredSummary: Record<string, unknown> | null;
  correctedRevision: string;
  sourceSpanStart: string;
  sourceSpanEnd: string;
  contentHash: string;
}

export type PdsArtifactPayload =
  | {
      artifactClass: "memory_event/v1";
      items: PdsPortableMemoryEventV1[];
    }
  | {
      artifactClass: "memory_embedding/v1";
      items: PdsPortableMemoryEmbeddingV1[];
    }
  | {
      artifactClass: "lcm_node/v1";
      items: PdsPortableLcmNodeV1[];
    };

export interface PdsArtifactManifest {
  protocol: typeof PDS_ARTIFACT_PROTOCOL;
  schemaVersion: typeof PDS_ARTIFACT_SCHEMA_VERSION;
  artifactClass: PdsArtifactClass;
  artifactId: string;
  workIdentity: string;
  groupId: string;
  sourcePackageId: string;
  sourceManifestHash: string;
  sourceFingerprint: string;
  sourceClosureHash: string;
  producerDeviceId: string;
  producerSigningKeyId: string;
  claimGeneration: string;
  compatibilityContract: PdsArtifactCompatibilityContract;
  compatibilityContractHash: string;
  orderedContentHashes: string[];
  payloadHash: string;
  createdAt: string;
  producerSignature: string;
}

export interface PdsArtifactRecord {
  manifest: PdsArtifactManifest;
  payload: PdsArtifactPayload;
}

const base64urlHashPattern = /^[A-Za-z0-9_-]{43}$/;
const decimalPattern = /^(0|[1-9][0-9]*)$/;
const opaqueIdPattern = /^[\x21-\x7e]{1,240}$/;

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("base64url");

const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`PDS ${label} fields are invalid`);
  }
};

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`PDS ${label} is invalid`);
  }
  return value as Record<string, unknown>;
};

const boundedString = (
  value: unknown,
  label: string,
  maximum = 32 * 1024
): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum
  ) {
    throw new TypeError(`PDS ${label} is invalid`);
  }
  return value;
};

const hashString = (value: unknown, label: string): string => {
  const parsed = boundedString(value, label, 43);
  if (!base64urlHashPattern.test(parsed)) {
    throw new TypeError(`PDS ${label} is invalid`);
  }
  return parsed;
};

const sha256HexString = (value: unknown, label: string): string => {
  const parsed = boundedString(value, label, 64);
  if (!/^[0-9a-f]{64}$/.test(parsed)) {
    throw new TypeError(`PDS ${label} is invalid`);
  }
  return parsed;
};

const decimalString = (value: unknown, label: string): string => {
  const parsed = boundedString(value, label, 64);
  if (!decimalPattern.test(parsed)) {
    throw new TypeError(`PDS ${label} is invalid`);
  }
  return parsed;
};

const opaqueId = (value: unknown, label: string): string => {
  const parsed = boundedString(value, label, 240);
  if (!opaqueIdPattern.test(parsed)) {
    throw new TypeError(`PDS ${label} is invalid`);
  }
  return parsed;
};

const isoTimestamp = (value: unknown, label: string): string => {
  const parsed = boundedString(value, label, 40);
  const timestamp = new Date(parsed);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== parsed) {
    throw new TypeError(`PDS ${label} is invalid`);
  }
  return parsed;
};

const artifactClass = (value: unknown): PdsArtifactClass => {
  if (
    typeof value !== "string" ||
    !pdsArtifactClasses.includes(value as PdsArtifactClass)
  ) {
    throw new TypeError("PDS artifact class is invalid");
  }
  return value as PdsArtifactClass;
};

const contractKeys: Record<PdsArtifactClass, readonly string[]> = {
  "memory_event/v1": [
    "artifactClass",
    "projectionPolicyKey",
    "projectionPolicyRevision",
    "projectionAlgorithmVersion",
    "tokenCounter"
  ],
  "memory_embedding/v1": [
    "artifactClass",
    "modelKey",
    "modelArtifactHash",
    "dimensions",
    "tokenizer",
    "inputTransform",
    "pooling",
    "normalization",
    "embeddingVersion"
  ],
  "lcm_node/v1": [
    "artifactClass",
    "nodeKind",
    "lcmAlgorithmVersion",
    "summaryPromptVersion",
    "summaryModel",
    "structuredOutputSchema",
    "sourceSelectionPolicy"
  ]
};

export const pdsArtifactCompatibilityHash = (
  contract: PdsArtifactCompatibilityContract
): string => sha256(canonicalizePdsJson(contract));

export const pdsArtifactPayloadHash = (payload: PdsArtifactPayload): string =>
  sha256(canonicalizePdsJson(payload));

export const pdsPortableMemoryEventContentHash = (
  event: Omit<PdsPortableMemoryEventV1, "logicalEventId" | "contentHash">
): string => sha256(canonicalizePdsJson(event));

const portableVectorValues = (vector: Array<number | string>): string[] => {
  if (vector.length === 0 || vector.length > 3072) {
    throw new TypeError("PDS embedding vector is invalid");
  }
  return vector.map((value) => {
    const parsed = typeof value === "number" ? value : Number(value);
    if (
      !Number.isFinite(parsed) ||
      (typeof value === "string" &&
        (value.length === 0 || value.length > 64 || /\s/.test(value)))
    ) {
      throw new TypeError("PDS embedding vector is invalid");
    }
    return String(parsed);
  });
};

export const pdsPortableEmbeddingVectorHash = (
  vector: Array<number | string>
): string => {
  return sha256(canonicalizePdsJson(portableVectorValues(vector)));
};

export const pdsPortableLcmNodeContentHash = (
  node: Omit<PdsPortableLcmNodeV1, "logicalNodeId" | "contentHash">
): string => sha256(canonicalizePdsJson(node));

export const pdsPortableMemoryEventId = (input: {
  sourceFingerprint: string;
  sourceClosureHash: string;
  sourceOrdinals: string[];
  projectionPolicyKey: string;
  projectionPolicyRevision: string;
  contentHash: string;
}): string => sha256(canonicalizePdsJson(input));

export const pdsPortableMemoryEmbeddingId = (input: {
  logicalSourceType: "memory_event" | "lcm_node";
  logicalSourceId: string;
  sourceContentHash: string;
  sourceChunkIndex: string;
  sourceChunkCount: string;
  canonicalSourceTextHash: string;
  compatibilityContractHash: string;
  vectorHash: string;
}): string => sha256(canonicalizePdsJson(input));

export const pdsPortableEmbeddingSourceHash = (input: {
  logicalSourceType: "memory_event" | "lcm_node";
  logicalSourceId: string;
  sourceContentHash: string;
  canonicalSourceTextHash: string;
}): string =>
  createHash("sha256").update(canonicalizePdsJson(input)).digest("hex");

export const pdsPortableMemoryEmbeddingWorkIdentity = (input: {
  logicalSourceType: "memory_event" | "lcm_node";
  logicalSourceId: string;
  sourceContentHash: string;
  compatibilityContractHash: string;
}): string => sha256(canonicalizePdsJson(input));

export const pdsPortableLcmNodeId = (input: {
  nodeKind: "leaf" | "rollup";
  orderedSourceIds: string[];
  compatibilityContractHash: string;
  correctedRevision: string;
  contentHash: string;
}): string => sha256(canonicalizePdsJson(input));

const unsignedManifest = (
  value: Omit<PdsArtifactManifest, "producerSignature">
): Record<string, unknown> => ({ ...value });

const manifestSigningBytes = (
  value: Omit<PdsArtifactManifest, "producerSignature">
): Buffer =>
  Buffer.from(
    `${PDS_ARTIFACT_PROTOCOL}/manifest\n${canonicalizePdsJson(
      unsignedManifest(value)
    )}`,
    "utf8"
  );

const artifactIdFor = (
  value: Omit<PdsArtifactManifest, "artifactId" | "producerSignature">
): string => sha256(canonicalizePdsJson(value));

export const createPdsArtifactRecord = (input: {
  groupId: string;
  workIdentity: string;
  sourcePackageId: string;
  sourceManifestHash: string;
  sourceFingerprint: string;
  sourceClosureHash: string;
  producerDeviceId: string;
  producerSigningKeyId: string;
  claimGeneration: string;
  compatibilityContract: PdsArtifactCompatibilityContract;
  payload: PdsArtifactPayload;
  createdAt: string;
  producerSigningPrivateKey: KeyObject;
}): PdsArtifactRecord => {
  if (
    input.compatibilityContract.artifactClass !== input.payload.artifactClass
  ) {
    throw new TypeError("PDS artifact contract and payload classes differ");
  }
  const orderedContentHashes = input.payload.items.map((item) =>
    hashString(
      (
        item as {
          contentHash?: string;
          vectorHash?: string;
        }
      ).contentHash ?? (item as { vectorHash?: string }).vectorHash,
      "artifact content hash"
    )
  );
  const withoutId = {
    protocol: PDS_ARTIFACT_PROTOCOL,
    schemaVersion: PDS_ARTIFACT_SCHEMA_VERSION,
    artifactClass: input.payload.artifactClass,
    workIdentity: input.workIdentity,
    groupId: input.groupId,
    sourcePackageId: input.sourcePackageId,
    sourceManifestHash: input.sourceManifestHash,
    sourceFingerprint: input.sourceFingerprint,
    sourceClosureHash: input.sourceClosureHash,
    producerDeviceId: input.producerDeviceId,
    producerSigningKeyId: input.producerSigningKeyId,
    claimGeneration: input.claimGeneration,
    compatibilityContract: input.compatibilityContract,
    compatibilityContractHash: pdsArtifactCompatibilityHash(
      input.compatibilityContract
    ),
    orderedContentHashes,
    payloadHash: pdsArtifactPayloadHash(input.payload),
    createdAt: input.createdAt
  } as const;
  const artifactId = artifactIdFor(withoutId);
  const unsigned = { ...withoutId, artifactId };
  return validatePdsArtifactRecord({
    manifest: {
      ...unsigned,
      producerSignature: sign(
        null,
        manifestSigningBytes(unsigned),
        input.producerSigningPrivateKey
      ).toString("base64url")
    },
    payload: input.payload
  });
};

const validateContract = (
  value: unknown,
  expectedClass: PdsArtifactClass
): PdsArtifactCompatibilityContract => {
  const parsed = record(value, "artifact compatibility contract");
  exactKeys(
    parsed,
    contractKeys[expectedClass],
    "artifact compatibility contract"
  );
  if (artifactClass(parsed.artifactClass) !== expectedClass) {
    throw new TypeError("PDS artifact compatibility class is invalid");
  }
  for (const [key, field] of Object.entries(parsed)) {
    if (key === "artifactClass") continue;
    if (key === "nodeKind") {
      if (field !== "leaf" && field !== "rollup") {
        throw new TypeError("PDS LCM node kind is invalid");
      }
      continue;
    }
    if (
      key.endsWith("Revision") ||
      key === "dimensions" ||
      key.endsWith("Threshold")
    ) {
      decimalString(field, key);
    } else if (key === "modelArtifactHash") {
      sha256HexString(field, key);
    } else if (key.endsWith("Hash")) {
      hashString(field, key);
    } else {
      opaqueId(field, key);
    }
  }
  return parsed as unknown as PdsArtifactCompatibilityContract;
};

const validatePayload = (
  value: unknown,
  expectedClass: PdsArtifactClass
): PdsArtifactPayload => {
  const parsed = record(value, "artifact payload");
  exactKeys(parsed, ["artifactClass", "items"], "artifact payload");
  if (artifactClass(parsed.artifactClass) !== expectedClass) {
    throw new TypeError("PDS artifact payload class is invalid");
  }
  if (
    !Array.isArray(parsed.items) ||
    parsed.items.length === 0 ||
    parsed.items.length > PDS_ARTIFACT_MAX_ITEMS
  ) {
    throw new TypeError("PDS artifact payload items are invalid");
  }
  const items = parsed.items.map((item) =>
    validateArtifactItem(item, expectedClass)
  );
  parsed.items = items;
  return parsed as PdsArtifactPayload;
};

const stringArray = (
  value: unknown,
  label: string,
  maximum = PDS_ARTIFACT_MAX_ITEMS
): string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new TypeError(`PDS ${label} is invalid`);
  }
  return value.map((item) => boundedString(item, label, 240));
};

const validateArtifactItem = (
  value: unknown,
  expectedClass: PdsArtifactClass
): Record<string, unknown> => {
  const item = record(value, "artifact payload item");
  if (expectedClass === "memory_event/v1") {
    exactKeys(
      item,
      [
        "logicalEventId",
        "sourceOrdinals",
        "eventType",
        "actor",
        "rawEventType",
        "content",
        "metadata",
        "includeInEmbedding",
        "includeInLcm",
        "tokenCount",
        "sealReason",
        "sourceEventTime",
        "sourceSequence",
        "contentHash"
      ],
      "Memory Event artifact"
    );
    const eventType = item.eventType;
    if (
      eventType !== "captured" &&
      eventType !== "invalidated" &&
      eventType !== "summarized" &&
      eventType !== "embedded"
    ) {
      throw new TypeError("PDS Memory Event type is invalid");
    }
    const normalizedEventType: PdsPortableMemoryEventV1["eventType"] =
      eventType;
    if (
      typeof item.includeInEmbedding !== "boolean" ||
      typeof item.includeInLcm !== "boolean"
    ) {
      throw new TypeError("PDS Memory Event inclusion policy is invalid");
    }
    const normalized = {
      logicalEventId: hashString(item.logicalEventId, "logical event ID"),
      sourceOrdinals: stringArray(item.sourceOrdinals, "source ordinals").map(
        (ordinal) => decimalString(ordinal, "source ordinal")
      ),
      eventType: normalizedEventType,
      actor: opaqueId(item.actor, "Memory Event actor"),
      rawEventType: opaqueId(item.rawEventType, "Memory Event raw type"),
      content: boundedString(
        item.content,
        "Memory Event content",
        8 * 1024 * 1024
      ),
      metadata: record(item.metadata, "Memory Event metadata"),
      includeInEmbedding: item.includeInEmbedding,
      includeInLcm: item.includeInLcm,
      tokenCount: decimalString(item.tokenCount, "Memory Event token count"),
      sealReason: opaqueId(item.sealReason, "Memory Event seal reason"),
      sourceEventTime: isoTimestamp(
        item.sourceEventTime,
        "Memory Event source time"
      ),
      sourceSequence: decimalString(
        item.sourceSequence,
        "Memory Event source sequence"
      ),
      contentHash: hashString(item.contentHash, "Memory Event content hash")
    };
    const { logicalEventId: _id, contentHash, ...content } = normalized;
    void _id;
    if (pdsPortableMemoryEventContentHash(content) !== contentHash) {
      throw new TypeError("PDS Memory Event content hash is invalid");
    }
    return normalized;
  }
  if (expectedClass === "memory_embedding/v1") {
    exactKeys(
      item,
      [
        "logicalEmbeddingId",
        "logicalSourceType",
        "logicalSourceId",
        "sourceContentHash",
        "sourceChunkIndex",
        "sourceChunkCount",
        "sourceHash",
        "canonicalSourceTextHash",
        "sourceText",
        "sourceTextHash",
        "vector",
        "vectorHash"
      ],
      "Memory embedding artifact"
    );
    if (!Array.isArray(item.vector)) {
      throw new TypeError("PDS embedding vector is invalid");
    }
    const vector = portableVectorValues(item.vector as Array<number | string>);
    const normalizedSourceType: PdsPortableMemoryEmbeddingV1["logicalSourceType"] =
      item.logicalSourceType === "memory_event" ||
      item.logicalSourceType === "lcm_node"
        ? item.logicalSourceType
        : (() => {
            throw new TypeError("PDS embedding source type is invalid");
          })();
    const normalized = {
      logicalEmbeddingId: hashString(
        item.logicalEmbeddingId,
        "logical embedding ID"
      ),
      logicalSourceType: normalizedSourceType,
      logicalSourceId: hashString(
        item.logicalSourceId,
        "logical embedding source ID"
      ),
      sourceContentHash: hashString(
        item.sourceContentHash,
        "embedding source content hash"
      ),
      sourceChunkIndex: decimalString(
        item.sourceChunkIndex,
        "embedding chunk index"
      ),
      sourceChunkCount: decimalString(
        item.sourceChunkCount,
        "embedding chunk count"
      ),
      sourceHash: sha256HexString(item.sourceHash, "embedding source hash"),
      canonicalSourceTextHash: hashString(
        item.canonicalSourceTextHash,
        "canonical embedding source-text hash"
      ),
      sourceText: boundedString(
        item.sourceText,
        "embedding source text",
        8 * 1024 * 1024
      ),
      sourceTextHash: hashString(
        item.sourceTextHash,
        "embedding source-text hash"
      ),
      vector,
      vectorHash: hashString(item.vectorHash, "embedding vector hash")
    };
    if (
      BigInt(normalized.sourceChunkCount) < 1n ||
      BigInt(normalized.sourceChunkIndex) >=
        BigInt(normalized.sourceChunkCount) ||
      sha256(normalized.sourceText) !== normalized.sourceTextHash ||
      pdsPortableEmbeddingSourceHash({
        logicalSourceType: normalized.logicalSourceType,
        logicalSourceId: normalized.logicalSourceId,
        sourceContentHash: normalized.sourceContentHash,
        canonicalSourceTextHash: normalized.canonicalSourceTextHash
      }) !== normalized.sourceHash ||
      pdsPortableEmbeddingVectorHash(vector) !== normalized.vectorHash
    ) {
      throw new TypeError("PDS embedding chunk binding is invalid");
    }
    return normalized;
  }
  exactKeys(
    item,
    [
      "logicalNodeId",
      "nodeKind",
      "orderedSourceIds",
      "summaryText",
      "summaryTokenCount",
      "structuredSummary",
      "correctedRevision",
      "sourceSpanStart",
      "sourceSpanEnd",
      "contentHash"
    ],
    "LCM node artifact"
  );
  if (item.nodeKind !== "leaf" && item.nodeKind !== "rollup") {
    throw new TypeError("PDS LCM node kind is invalid");
  }
  const normalizedNodeKind: PdsPortableLcmNodeV1["nodeKind"] = item.nodeKind;
  if (
    item.structuredSummary !== null &&
    (typeof item.structuredSummary !== "object" ||
      Array.isArray(item.structuredSummary))
  ) {
    throw new TypeError("PDS LCM structured summary is invalid");
  }
  const normalized = {
    logicalNodeId: hashString(item.logicalNodeId, "logical LCM node ID"),
    nodeKind: normalizedNodeKind,
    orderedSourceIds: stringArray(
      item.orderedSourceIds,
      "LCM ordered source IDs"
    ).map((id) => hashString(id, "LCM source ID")),
    summaryText: boundedString(
      item.summaryText,
      "LCM summary text",
      2 * 1024 * 1024
    ),
    summaryTokenCount: decimalString(
      item.summaryTokenCount,
      "LCM summary token count"
    ),
    structuredSummary: item.structuredSummary as Record<string, unknown> | null,
    correctedRevision: decimalString(
      item.correctedRevision,
      "LCM corrected revision"
    ),
    sourceSpanStart: isoTimestamp(
      item.sourceSpanStart,
      "LCM source span start"
    ),
    sourceSpanEnd: isoTimestamp(item.sourceSpanEnd, "LCM source span end"),
    contentHash: hashString(item.contentHash, "LCM content hash")
  };
  const { logicalNodeId: _id, contentHash, ...content } = normalized;
  void _id;
  if (
    Date.parse(normalized.sourceSpanEnd) <
      Date.parse(normalized.sourceSpanStart) ||
    pdsPortableLcmNodeContentHash(content) !== contentHash
  ) {
    throw new TypeError("PDS LCM node content binding is invalid");
  }
  return normalized;
};

export const validatePdsArtifactRecord = (
  value: unknown
): PdsArtifactRecord => {
  const root = record(value, "artifact record");
  exactKeys(root, ["manifest", "payload"], "artifact record");
  const manifest = record(root.manifest, "artifact manifest");
  exactKeys(
    manifest,
    [
      "protocol",
      "schemaVersion",
      "artifactClass",
      "artifactId",
      "workIdentity",
      "groupId",
      "sourcePackageId",
      "sourceManifestHash",
      "sourceFingerprint",
      "sourceClosureHash",
      "producerDeviceId",
      "producerSigningKeyId",
      "claimGeneration",
      "compatibilityContract",
      "compatibilityContractHash",
      "orderedContentHashes",
      "payloadHash",
      "createdAt",
      "producerSignature"
    ],
    "artifact manifest"
  );
  if (
    manifest.protocol !== PDS_ARTIFACT_PROTOCOL ||
    manifest.schemaVersion !== PDS_ARTIFACT_SCHEMA_VERSION
  ) {
    throw new TypeError("PDS artifact protocol is invalid");
  }
  const parsedClass = artifactClass(manifest.artifactClass);
  const contract = validateContract(
    manifest.compatibilityContract,
    parsedClass
  );
  const payload = validatePayload(root.payload, parsedClass);
  const parsedManifest = {
    ...manifest,
    artifactClass: parsedClass,
    artifactId: hashString(manifest.artifactId, "artifact id"),
    workIdentity: hashString(manifest.workIdentity, "semantic work identity"),
    groupId: opaqueId(manifest.groupId, "artifact group id"),
    sourcePackageId: hashString(manifest.sourcePackageId, "source package id"),
    sourceManifestHash: hashString(
      manifest.sourceManifestHash,
      "source manifest hash"
    ),
    sourceFingerprint: hashString(
      manifest.sourceFingerprint,
      "source fingerprint"
    ),
    sourceClosureHash: hashString(
      manifest.sourceClosureHash,
      "source closure hash"
    ),
    producerDeviceId: opaqueId(
      manifest.producerDeviceId,
      "artifact producer device"
    ),
    producerSigningKeyId: opaqueId(
      manifest.producerSigningKeyId,
      "artifact producer signing key"
    ),
    claimGeneration: decimalString(
      manifest.claimGeneration,
      "artifact claim generation"
    ),
    compatibilityContract: contract,
    compatibilityContractHash: hashString(
      manifest.compatibilityContractHash,
      "compatibility contract hash"
    ),
    payloadHash: hashString(manifest.payloadHash, "artifact payload hash"),
    createdAt: isoTimestamp(manifest.createdAt, "artifact creation time"),
    producerSignature: boundedString(
      manifest.producerSignature,
      "artifact producer signature",
      128
    )
  } as PdsArtifactManifest;
  if (
    !Array.isArray(manifest.orderedContentHashes) ||
    manifest.orderedContentHashes.length !== payload.items.length
  ) {
    throw new TypeError("PDS ordered artifact content hashes are invalid");
  }
  parsedManifest.orderedContentHashes = manifest.orderedContentHashes.map(
    (item) => hashString(item, "artifact content hash")
  );
  if (
    pdsArtifactCompatibilityHash(contract) !==
      parsedManifest.compatibilityContractHash ||
    pdsArtifactPayloadHash(payload) !== parsedManifest.payloadHash
  ) {
    throw new TypeError("PDS artifact content binding is invalid");
  }
  if (
    parsedClass === "memory_embedding/v1" &&
    (payload.items as PdsPortableMemoryEmbeddingV1[]).some(
      (item) =>
        pdsPortableMemoryEmbeddingId({
          logicalSourceType: item.logicalSourceType,
          logicalSourceId: item.logicalSourceId,
          sourceContentHash: item.sourceContentHash,
          sourceChunkIndex: item.sourceChunkIndex,
          sourceChunkCount: item.sourceChunkCount,
          canonicalSourceTextHash: item.canonicalSourceTextHash,
          compatibilityContractHash: parsedManifest.compatibilityContractHash,
          vectorHash: item.vectorHash
        }) !== item.logicalEmbeddingId
    )
  ) {
    throw new TypeError("PDS embedding identity is invalid");
  }
  const {
    artifactId,
    producerSignature: _signature,
    ...withoutId
  } = parsedManifest;
  void _signature;
  if (artifactIdFor(withoutId) !== artifactId) {
    throw new TypeError("PDS artifact identity is invalid");
  }
  return { manifest: parsedManifest, payload };
};

export const verifyPdsArtifactRecord = (
  value: unknown,
  producerSigningPublicKey: string | Buffer | KeyObject
): PdsArtifactRecord => {
  const parsed = validatePdsArtifactRecord(value);
  const { producerSignature, ...unsigned } = parsed.manifest;
  const publicKey =
    producerSigningPublicKey instanceof Object &&
    "type" in producerSigningPublicKey
      ? (producerSigningPublicKey as KeyObject)
      : pdsEd25519PublicKey(producerSigningPublicKey as string | Buffer);
  if (
    !verify(
      null,
      manifestSigningBytes(unsigned),
      publicKey,
      Buffer.from(producerSignature, "base64url")
    )
  ) {
    throw new TypeError("PDS artifact signature is invalid");
  }
  return parsed;
};

export const parsePdsArtifactRecordJson = (
  input: string | Uint8Array
): PdsArtifactRecord => {
  const bytes =
    typeof input === "string"
      ? Buffer.from(input, "utf8")
      : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length > PDS_ARTIFACT_MAX_JSON_BYTES) {
    throw new RangeError("PDS artifact record exceeds limit");
  }
  return validatePdsArtifactRecord(
    parseCanonicalPdsJson(bytes.toString("utf8"))
  );
};
