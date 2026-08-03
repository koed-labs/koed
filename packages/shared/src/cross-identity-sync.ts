import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJsonStringify } from "./canonical-json.js";

export const CAPTURED_SESSION_SYNC_FORMAT =
  "koed.captured-session-sync/v1" as const;
export const CAPTURED_SESSION_SYNC_FORMAT_VERSION = 1;
export const CAPTURED_SESSION_SYNC_POLICY_VERSION = 1;
export const CAPTURED_SESSION_SYNC_MAX_CHUNK_BYTES = 512 * 1024;
export const CAPTURED_SESSION_SYNC_MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
export const CAPTURED_SESSION_SYNC_MAX_CHANGES = 10_000;
export const CAPTURED_SESSION_SYNC_MAX_SUMMARY_NODES = 10_000;
export const CAPTURED_SESSION_SYNC_MAX_CONTRIBUTORS_PER_EVENT = 512;
export const CAPTURED_SESSION_SYNC_HTTP_TIMEOUT_MS = 30_000;
export const CAPTURED_SESSION_SYNC_MAX_CONTROL_RESPONSE_BYTES = 1024 * 1024;
export const CAPTURED_SESSION_SYNC_MAX_CHUNKS = Math.ceil(
  CAPTURED_SESSION_SYNC_MAX_PACKAGE_BYTES /
    CAPTURED_SESSION_SYNC_MAX_CHUNK_BYTES
);

export const capturedSessionSyncUploadPackageManifestSchema = z
  .object({
    objectClass: z.literal("sync_package"),
    format: z.literal(CAPTURED_SESSION_SYNC_FORMAT),
    formatVersion: z.literal(CAPTURED_SESSION_SYNC_FORMAT_VERSION),
    packageDigest: z.string().regex(/^[a-f0-9]{64}$/i),
    summaryRevisionHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .nullable(),
    recipientKeyId: z.string().trim().min(1).max(240),
    recipientKeyVersion: z.number().int().safe().positive(),
    recordCount: z
      .number()
      .int()
      .safe()
      .nonnegative()
      .max(CAPTURED_SESSION_SYNC_MAX_CHANGES)
  })
  .strict();

export type CapturedSessionSyncUploadPackageManifest = z.infer<
  typeof capturedSessionSyncUploadPackageManifestSchema
>;

export type CapturedSessionSyncChangeOperation = "upsert" | "delete";

export interface CapturedSessionSyncContributorV1 {
  originItemId: string;
  revisionHash: string;
  actor: string;
  kind: string;
  content: string;
  toolName: string | null;
  toolCallId: string | null;
  sourceEventTime: string | null;
  sourceSequence: number | null;
  sourceKind: string;
  sourceAdapterVersion: string;
  sourceTransport: string;
  sourceRecordType: string;
  sourceEventType: string | null;
  rawJson: unknown;
  rawText: string | null;
  metadata: Record<string, unknown>;
  logicalSourceId: string | null;
  transportChunkIndex: number;
  transportChunkCount: number;
  transportChunkText: string | null;
  transportChunkEncoding: string | null;
  projectionStatus: "pending" | "held" | "projected" | "error" | "raw_only";
  projectionVersion: string | null;
  projectionPolicyRevision: number | null;
  memoryExcludedAt: string | null;
  memoryExclusionReason: string | null;
}

export interface CapturedSessionSyncEventV1 {
  originEventId: string;
  revisionHash: string;
  eventType: string;
  actor: string;
  content: string;
  metadata: Record<string, unknown>;
  includeInEmbedding: boolean;
  includeInLcm: boolean;
  projectionPolicyKey: string | null;
  projectionPolicyRevision: number | null;
  tokenCount: number | null;
  sealReason: string | null;
  capturedAt: string;
  sourceEventTime: string | null;
  sourceSequence: number | null;
  contributors: CapturedSessionSyncContributorV1[];
}

export interface CapturedSessionSyncChangeV1 {
  cursor: number;
  operation: CapturedSessionSyncChangeOperation;
  originEventId: string;
  revisionHash: string;
  event: CapturedSessionSyncEventV1 | null;
}

export interface CapturedSessionSyncSummaryNodeV1 {
  originNodeId: string;
  kind: "leaf" | "rollup";
  depth: number;
  lcmAlgorithmVersion: string;
  summaryText: string;
  summaryModel: string;
  summaryPromptVersion: string;
  summaryStructuredJson: Record<string, unknown>;
  summaryStructuredSchemaVersion: string;
  sourceOriginEventIds: string[];
  childOriginNodeIds: string[];
  sourceHash: string;
  sourceEventCount: number;
  sourceTokenEstimate: number;
  summaryTokenEstimate: number;
  createdAt: string;
  updatedAt: string;
  revisionHash: string;
}

export interface CapturedSessionSyncPackageV1 {
  format: typeof CAPTURED_SESSION_SYNC_FORMAT;
  formatVersion: typeof CAPTURED_SESSION_SYNC_FORMAT_VERSION;
  policyVersion: typeof CAPTURED_SESSION_SYNC_POLICY_VERSION;
  packageId: string;
  relationshipId: string;
  logicalMemoryId: string;
  sourceDeploymentId: string;
  sourceUserId: string;
  sourceReplicaId: string;
  targetDeploymentId: string;
  targetUserId: string;
  targetReplicaId: string;
  packageSequence: number;
  fromCursor: number;
  toCursor: number;
  createdAt: string;
  consentDigest: string;
  policyDigest: string;
  summaryRevisionHash: string;
  session: {
    originSessionId: string;
    externalSessionId: string | null;
    sourceRuntime: string;
    captureMethod: string;
    capturedAt: string;
    title: string | null;
    sourceAdapterVersion: string | null;
  };
  changes: CapturedSessionSyncChangeV1[];
  summaryNodes: CapturedSessionSyncSummaryNodeV1[];
}

export interface CapturedSessionSyncChunkV1 {
  format: typeof CAPTURED_SESSION_SYNC_FORMAT;
  formatVersion: typeof CAPTURED_SESSION_SYNC_FORMAT_VERSION;
  packageId: string;
  relationshipId: string;
  packageSequence: number;
  fromCursor: number;
  toCursor: number;
  chunkIndex: number;
  chunkCount: number;
  packageDigest: string;
  package: CapturedSessionSyncPackageV1;
}

export const crossIdentitySyncDigest = (value: unknown): string =>
  createHash("sha256").update(canonicalJsonStringify(value)).digest("hex");

export const crossIdentitySyncSummaryNodeRevisionHash = (
  node:
    | CapturedSessionSyncSummaryNodeV1
    | Omit<CapturedSessionSyncSummaryNodeV1, "revisionHash">
): string => {
  const revisionSource: Partial<CapturedSessionSyncSummaryNodeV1> = { ...node };
  delete revisionSource.revisionHash;
  return crossIdentitySyncDigest(revisionSource);
};

export const crossIdentitySyncDeterministicUuid = (value: unknown): string => {
  const bytes = Buffer.from(crossIdentitySyncDigest(value).slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const crossIdentitySyncPackageRequestHash = (
  value: Pick<
    CapturedSessionSyncPackageV1,
    | "packageId"
    | "relationshipId"
    | "logicalMemoryId"
    | "sourceDeploymentId"
    | "sourceUserId"
    | "sourceReplicaId"
    | "targetDeploymentId"
    | "targetUserId"
    | "targetReplicaId"
    | "packageSequence"
    | "fromCursor"
    | "toCursor"
    | "consentDigest"
    | "policyDigest"
    | "summaryRevisionHash"
  >
): string => crossIdentitySyncDigest(value);

const hasOnlyKeys = (value: unknown, allowed: readonly string[]): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === allowed.length && keys.every((key) => allowed.includes(key))
  );
};

const validBoundedJsonValue = (
  value: unknown,
  state: {
    depth: number;
    nodes: { count: number };
    ancestors: Set<object>;
  }
): boolean => {
  state.nodes.count += 1;
  if (state.depth > 16 || state.nodes.count > 4_096) {
    return false;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value === "string") {
    return value.length <= 1_000_000;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (state.ancestors.has(value)) {
    return false;
  }
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((item) =>
        validBoundedJsonValue(item, {
          ...state,
          depth: state.depth + 1
        })
      );
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    return Object.entries(value as Record<string, unknown>).every(
      ([key, nested]) =>
        key.length <= 240 &&
        validBoundedJsonValue(nested, {
          ...state,
          depth: state.depth + 1
        })
    );
  } finally {
    state.ancestors.delete(value);
  }
};

const validBoundedJsonObject = (
  value: unknown
): value is Record<string, unknown> => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !validBoundedJsonValue(value, {
      depth: 0,
      nodes: { count: 0 },
      ancestors: new Set()
    })
  ) {
    return false;
  }
  try {
    return (
      Buffer.byteLength(canonicalJsonStringify(value), "utf8") <= 1_000_000
    );
  } catch {
    return false;
  }
};

const digestMatches = (value: unknown, digest: string): boolean => {
  try {
    return crossIdentitySyncDigest(value) === digest;
  } catch {
    return false;
  }
};

const validateCapturedSessionSyncPackageV1 = (
  value: unknown,
  requireFinalCursor: boolean
): value is CapturedSessionSyncPackageV1 => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const input = value as Partial<CapturedSessionSyncPackageV1>;
  const uuid = (candidate: unknown): candidate is string =>
    typeof candidate === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidate
    );
  const hash = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && /^[0-9a-f]{64}$/i.test(candidate);
  const nullableString = (candidate: unknown, max: number): boolean =>
    candidate === null ||
    (typeof candidate === "string" && candidate.length <= max);
  const timestamp = (candidate: unknown): candidate is string =>
    typeof candidate === "string" &&
    candidate.length === 24 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(candidate) &&
    Number.isFinite(Date.parse(candidate)) &&
    new Date(candidate).toISOString() === candidate;
  const session = input.session;
  const changes = input.changes;
  const summaryNodes = input.summaryNodes;
  const validSummaryGraph = (
    nodes: CapturedSessionSyncSummaryNodeV1[]
  ): boolean => {
    const byId = new Map(nodes.map((node) => [node.originNodeId, node]));
    return nodes.every((node) => {
      if (
        crossIdentitySyncSummaryNodeRevisionHash(node) !== node.revisionHash ||
        node.sourceEventCount !== node.sourceOriginEventIds.length ||
        node.summaryStructuredJson.summary_text !== node.summaryText ||
        node.summaryStructuredJson.schema_version !==
          node.summaryStructuredSchemaVersion
      ) {
        return false;
      }
      if (node.kind === "leaf") {
        return node.depth === 0;
      }
      const children = node.childOriginNodeIds.map((childId) =>
        byId.get(childId)
      );
      if (children.some((child) => !child || child.depth >= node.depth)) {
        return false;
      }
      const childSourceIds = [
        ...new Set(
          children.flatMap((child) => child?.sourceOriginEventIds ?? [])
        )
      ].sort();
      return (
        crossIdentitySyncDigest(childSourceIds) ===
        crossIdentitySyncDigest([...node.sourceOriginEventIds].sort())
      );
    });
  };
  return (
    hasOnlyKeys(input, [
      "format",
      "formatVersion",
      "policyVersion",
      "packageId",
      "relationshipId",
      "logicalMemoryId",
      "sourceDeploymentId",
      "sourceUserId",
      "sourceReplicaId",
      "targetDeploymentId",
      "targetUserId",
      "targetReplicaId",
      "packageSequence",
      "fromCursor",
      "toCursor",
      "createdAt",
      "consentDigest",
      "policyDigest",
      "summaryRevisionHash",
      "session",
      "changes",
      "summaryNodes"
    ]) &&
    input.format === CAPTURED_SESSION_SYNC_FORMAT &&
    input.formatVersion === CAPTURED_SESSION_SYNC_FORMAT_VERSION &&
    input.policyVersion === CAPTURED_SESSION_SYNC_POLICY_VERSION &&
    uuid(input.packageId) &&
    uuid(input.relationshipId) &&
    uuid(input.logicalMemoryId) &&
    uuid(input.sourceDeploymentId) &&
    typeof input.sourceUserId === "string" &&
    input.sourceUserId.length > 0 &&
    input.sourceUserId.length <= 240 &&
    uuid(input.sourceReplicaId) &&
    uuid(input.targetDeploymentId) &&
    typeof input.targetUserId === "string" &&
    input.targetUserId.length > 0 &&
    input.targetUserId.length <= 240 &&
    uuid(input.targetReplicaId) &&
    Number.isSafeInteger(input.packageSequence) &&
    input.packageSequence! > 0 &&
    Number.isSafeInteger(input.fromCursor) &&
    input.fromCursor! >= 0 &&
    Number.isSafeInteger(input.toCursor) &&
    input.toCursor! >= input.fromCursor! &&
    timestamp(input.createdAt) &&
    hash(input.consentDigest) &&
    hash(input.policyDigest) &&
    hash(input.summaryRevisionHash) &&
    Boolean(session) &&
    hasOnlyKeys(session!, [
      "originSessionId",
      "externalSessionId",
      "sourceRuntime",
      "captureMethod",
      "capturedAt",
      "title",
      "sourceAdapterVersion"
    ]) &&
    uuid(session?.originSessionId) &&
    nullableString(session?.externalSessionId, 500) &&
    ["codex", "codex-cli"].includes(session?.sourceRuntime ?? "") &&
    ["transcript", "mcp", "web", "api"].includes(
      session?.captureMethod ?? ""
    ) &&
    timestamp(session.capturedAt) &&
    nullableString(session.title, 500) &&
    nullableString(session.sourceAdapterVersion, 120) &&
    Array.isArray(changes) &&
    Array.isArray(summaryNodes) &&
    changes.length <= CAPTURED_SESSION_SYNC_MAX_CHANGES &&
    summaryNodes.length <= CAPTURED_SESSION_SYNC_MAX_SUMMARY_NODES &&
    new Set(summaryNodes.map((node) => node?.originNodeId)).size ===
      summaryNodes.length &&
    summaryNodes.every(
      (node) =>
        hasOnlyKeys(node, [
          "originNodeId",
          "kind",
          "depth",
          "lcmAlgorithmVersion",
          "summaryText",
          "summaryModel",
          "summaryPromptVersion",
          "summaryStructuredJson",
          "summaryStructuredSchemaVersion",
          "sourceOriginEventIds",
          "childOriginNodeIds",
          "sourceHash",
          "sourceEventCount",
          "sourceTokenEstimate",
          "summaryTokenEstimate",
          "createdAt",
          "updatedAt",
          "revisionHash"
        ]) &&
        uuid(node.originNodeId) &&
        ["leaf", "rollup"].includes(node.kind) &&
        Number.isSafeInteger(node.depth) &&
        node.depth >= 0 &&
        typeof node.lcmAlgorithmVersion === "string" &&
        node.lcmAlgorithmVersion.length > 0 &&
        node.lcmAlgorithmVersion.length <= 240 &&
        typeof node.summaryText === "string" &&
        node.summaryText.length > 0 &&
        node.summaryText.length <= 1_000_000 &&
        typeof node.summaryModel === "string" &&
        node.summaryModel.length > 0 &&
        node.summaryModel.length <= 240 &&
        typeof node.summaryPromptVersion === "string" &&
        node.summaryPromptVersion.length > 0 &&
        node.summaryPromptVersion.length <= 240 &&
        validBoundedJsonObject(node.summaryStructuredJson) &&
        typeof node.summaryStructuredSchemaVersion === "string" &&
        node.summaryStructuredSchemaVersion.length > 0 &&
        node.summaryStructuredSchemaVersion.length <= 240 &&
        Array.isArray(node.sourceOriginEventIds) &&
        node.sourceOriginEventIds.length > 0 &&
        node.sourceOriginEventIds.length <= CAPTURED_SESSION_SYNC_MAX_CHANGES &&
        new Set(node.sourceOriginEventIds).size ===
          node.sourceOriginEventIds.length &&
        node.sourceOriginEventIds.every(uuid) &&
        Array.isArray(node.childOriginNodeIds) &&
        node.childOriginNodeIds.length <=
          CAPTURED_SESSION_SYNC_MAX_SUMMARY_NODES &&
        new Set(node.childOriginNodeIds).size ===
          node.childOriginNodeIds.length &&
        node.childOriginNodeIds.every(uuid) &&
        (node.kind === "leaf"
          ? node.childOriginNodeIds.length === 0
          : node.childOriginNodeIds.length > 0) &&
        hash(node.sourceHash) &&
        Number.isSafeInteger(node.sourceEventCount) &&
        node.sourceEventCount > 0 &&
        Number.isSafeInteger(node.sourceTokenEstimate) &&
        node.sourceTokenEstimate >= 0 &&
        Number.isSafeInteger(node.summaryTokenEstimate) &&
        node.summaryTokenEstimate > 0 &&
        timestamp(node.createdAt) &&
        timestamp(node.updatedAt) &&
        hash(node.revisionHash)
    ) &&
    validSummaryGraph(summaryNodes as CapturedSessionSyncSummaryNodeV1[]) &&
    digestMatches(summaryNodes, input.summaryRevisionHash) &&
    (!requireFinalCursor ||
      (changes.length === 0
        ? input.fromCursor === input.toCursor
        : (changes[changes.length - 1] as { cursor?: unknown } | null)
            ?.cursor === input.toCursor)) &&
    changes.every((change, index) => {
      if (
        !hasOnlyKeys(change, [
          "cursor",
          "operation",
          "originEventId",
          "revisionHash",
          "event"
        ]) ||
        !Number.isSafeInteger(change.cursor) ||
        change.cursor <= input.fromCursor! ||
        change.cursor > input.toCursor! ||
        (index > 0 && changes[index - 1]!.cursor >= change.cursor) ||
        !uuid(change.originEventId) ||
        !hash(change.revisionHash) ||
        !["upsert", "delete"].includes(change.operation)
      ) {
        return false;
      }
      if (change.operation === "delete") return change.event === null;
      const event = change.event;
      return (
        Boolean(event) &&
        hasOnlyKeys(event!, [
          "originEventId",
          "revisionHash",
          "eventType",
          "actor",
          "content",
          "metadata",
          "includeInEmbedding",
          "includeInLcm",
          "projectionPolicyKey",
          "projectionPolicyRevision",
          "tokenCount",
          "sealReason",
          "capturedAt",
          "sourceEventTime",
          "sourceSequence",
          "contributors"
        ]) &&
        event!.originEventId === change.originEventId &&
        event!.revisionHash === change.revisionHash &&
        typeof event!.eventType === "string" &&
        event!.eventType.length > 0 &&
        event!.eventType.length <= 120 &&
        typeof event!.actor === "string" &&
        event!.actor.length > 0 &&
        event!.actor.length <= 120 &&
        typeof event!.content === "string" &&
        validBoundedJsonObject(event!.metadata) &&
        typeof event!.includeInEmbedding === "boolean" &&
        typeof event!.includeInLcm === "boolean" &&
        nullableString(event!.projectionPolicyKey, 240) &&
        (event!.projectionPolicyRevision === null ||
          (Number.isSafeInteger(event!.projectionPolicyRevision) &&
            event!.projectionPolicyRevision! > 0)) &&
        (event!.tokenCount === null ||
          (Number.isSafeInteger(event!.tokenCount) &&
            event!.tokenCount! >= 0)) &&
        nullableString(event!.sealReason, 120) &&
        timestamp(event!.capturedAt) &&
        (event!.sourceEventTime === null ||
          timestamp(event!.sourceEventTime)) &&
        (event!.sourceSequence === null ||
          (Number.isSafeInteger(event!.sourceSequence) &&
            event!.sourceSequence! >= 0)) &&
        Array.isArray(event!.contributors) &&
        event!.contributors.length <=
          CAPTURED_SESSION_SYNC_MAX_CONTRIBUTORS_PER_EVENT &&
        event!.contributors.every(
          (contributor) =>
            hasOnlyKeys(contributor, [
              "originItemId",
              "revisionHash",
              "actor",
              "kind",
              "content",
              "toolName",
              "toolCallId",
              "sourceEventTime",
              "sourceSequence",
              "sourceKind",
              "sourceAdapterVersion",
              "sourceTransport",
              "sourceRecordType",
              "sourceEventType",
              "rawJson",
              "rawText",
              "metadata",
              "logicalSourceId",
              "transportChunkIndex",
              "transportChunkCount",
              "transportChunkText",
              "transportChunkEncoding",
              "projectionStatus",
              "projectionVersion",
              "projectionPolicyRevision",
              "memoryExcludedAt",
              "memoryExclusionReason"
            ]) &&
            uuid(contributor.originItemId) &&
            hash(contributor.revisionHash) &&
            typeof contributor.actor === "string" &&
            contributor.actor.length > 0 &&
            contributor.actor.length <= 120 &&
            typeof contributor.kind === "string" &&
            contributor.kind.length > 0 &&
            contributor.kind.length <= 120 &&
            typeof contributor.content === "string" &&
            nullableString(contributor.toolName, 240) &&
            nullableString(contributor.toolCallId, 500) &&
            typeof contributor.sourceKind === "string" &&
            contributor.sourceKind.length > 0 &&
            contributor.sourceKind.length <= 120 &&
            typeof contributor.sourceAdapterVersion === "string" &&
            contributor.sourceAdapterVersion.length > 0 &&
            contributor.sourceAdapterVersion.length <= 120 &&
            typeof contributor.sourceTransport === "string" &&
            contributor.sourceTransport.length > 0 &&
            contributor.sourceTransport.length <= 120 &&
            typeof contributor.sourceRecordType === "string" &&
            contributor.sourceRecordType.length > 0 &&
            contributor.sourceRecordType.length <= 120 &&
            nullableString(contributor.sourceEventType, 120) &&
            validBoundedJsonValue(contributor.rawJson, {
              depth: 0,
              nodes: { count: 0 },
              ancestors: new Set()
            }) &&
            nullableString(contributor.rawText, 1_000_000) &&
            validBoundedJsonObject(contributor.metadata) &&
            nullableString(contributor.logicalSourceId, 500) &&
            Number.isSafeInteger(contributor.transportChunkIndex) &&
            contributor.transportChunkIndex >= 0 &&
            Number.isSafeInteger(contributor.transportChunkCount) &&
            contributor.transportChunkCount >= 1 &&
            contributor.transportChunkIndex < contributor.transportChunkCount &&
            nullableString(contributor.transportChunkText, 1_000_000) &&
            nullableString(contributor.transportChunkEncoding, 120) &&
            ["pending", "held", "projected", "error", "raw_only"].includes(
              contributor.projectionStatus
            ) &&
            nullableString(contributor.projectionVersion, 240) &&
            (contributor.projectionPolicyRevision === null ||
              (Number.isSafeInteger(contributor.projectionPolicyRevision) &&
                contributor.projectionPolicyRevision > 0)) &&
            (contributor.memoryExcludedAt === null ||
              timestamp(contributor.memoryExcludedAt)) &&
            nullableString(contributor.memoryExclusionReason, 240) &&
            (contributor.sourceEventTime === null ||
              timestamp(contributor.sourceEventTime)) &&
            (contributor.sourceSequence === null ||
              (Number.isSafeInteger(contributor.sourceSequence) &&
                contributor.sourceSequence! >= 0))
        )
      );
    })
  );
};

export const isCapturedSessionSyncPackageV1 = (
  value: unknown
): value is CapturedSessionSyncPackageV1 => {
  try {
    return validateCapturedSessionSyncPackageV1(value, true);
  } catch {
    return false;
  }
};

export const isCapturedSessionSyncChunkV1 = (
  value: unknown
): value is CapturedSessionSyncChunkV1 => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const input = value as Partial<CapturedSessionSyncChunkV1>;
    return (
      hasOnlyKeys(input, [
        "format",
        "formatVersion",
        "packageId",
        "relationshipId",
        "packageSequence",
        "fromCursor",
        "toCursor",
        "chunkIndex",
        "chunkCount",
        "packageDigest",
        "package"
      ]) &&
      input.format === CAPTURED_SESSION_SYNC_FORMAT &&
      input.formatVersion === CAPTURED_SESSION_SYNC_FORMAT_VERSION &&
      typeof input.packageId === "string" &&
      typeof input.relationshipId === "string" &&
      Number.isSafeInteger(input.packageSequence) &&
      Number.isSafeInteger(input.fromCursor) &&
      Number.isSafeInteger(input.toCursor) &&
      Number.isSafeInteger(input.chunkIndex) &&
      Number.isSafeInteger(input.chunkCount) &&
      input.chunkIndex! >= 0 &&
      input.chunkCount! > 0 &&
      input.chunkCount! <= CAPTURED_SESSION_SYNC_MAX_CHUNKS &&
      input.chunkIndex! < input.chunkCount! &&
      typeof input.packageDigest === "string" &&
      input.packageDigest.length === 64 &&
      validateCapturedSessionSyncPackageV1(input.package, false) &&
      input.package.packageId === input.packageId &&
      input.package.relationshipId === input.relationshipId &&
      input.package.packageSequence === input.packageSequence &&
      input.package.fromCursor === input.fromCursor &&
      input.package.toCursor === input.toCursor
    );
  } catch {
    return false;
  }
};
