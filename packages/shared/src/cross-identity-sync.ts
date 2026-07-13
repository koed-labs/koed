import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";

export const CAPTURED_SESSION_SYNC_FORMAT =
  "koed.captured-session-sync/v1" as const;
export const CAPTURED_SESSION_SYNC_FORMAT_VERSION = 1;
export const CAPTURED_SESSION_SYNC_POLICY_VERSION = 1;
export const CAPTURED_SESSION_SYNC_MAX_CHUNK_BYTES = 512 * 1024;
export const CAPTURED_SESSION_SYNC_MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
export const CAPTURED_SESSION_SYNC_MAX_CHANGES = 10_000;
export const CAPTURED_SESSION_SYNC_MAX_CONTRIBUTORS_PER_EVENT = 512;
export const CAPTURED_SESSION_SYNC_HTTP_TIMEOUT_MS = 30_000;
export const CAPTURED_SESSION_SYNC_MAX_CONTROL_RESPONSE_BYTES = 1024 * 1024;
export const CAPTURED_SESSION_SYNC_MAX_CHUNKS = Math.ceil(
  CAPTURED_SESSION_SYNC_MAX_PACKAGE_BYTES /
    CAPTURED_SESSION_SYNC_MAX_CHUNK_BYTES
);

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
}

export interface CapturedSessionSyncEventV1 {
  originEventId: string;
  revisionHash: string;
  eventType: string;
  actor: string;
  content: string;
  metadata: Record<string, unknown>;
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
  >
): string => crossIdentitySyncDigest(value);

const hasOnlyKeys = (value: unknown, allowed: readonly string[]): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === allowed.length && keys.every((key) => allowed.includes(key))
  );
};

const validEventMetadata = (
  value: unknown
): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  const allowed = [
    "includeInLcm",
    "semanticUnitType",
    "rawEventType",
    "sourceRole"
  ];
  return (
    Object.keys(metadata).every((key) => allowed.includes(key)) &&
    (metadata.includeInLcm === undefined ||
      typeof metadata.includeInLcm === "boolean") &&
    ["semanticUnitType", "rawEventType", "sourceRole"].every(
      (key) =>
        metadata[key] === undefined ||
        (typeof metadata[key] === "string" && metadata[key].length <= 120)
    )
  );
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
      "session",
      "changes"
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
    ["hook", "mcp", "web", "api"].includes(session?.captureMethod ?? "") &&
    timestamp(session.capturedAt) &&
    nullableString(session.title, 500) &&
    nullableString(session.sourceAdapterVersion, 120) &&
    Array.isArray(changes) &&
    changes.length > 0 &&
    changes.length <= CAPTURED_SESSION_SYNC_MAX_CHANGES &&
    (!requireFinalCursor ||
      (changes[changes.length - 1] as { cursor?: unknown } | null)?.cursor ===
        input.toCursor) &&
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
        validEventMetadata(event!.metadata) &&
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
              "sourceSequence"
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
): value is CapturedSessionSyncPackageV1 =>
  validateCapturedSessionSyncPackageV1(value, true);

export const isCapturedSessionSyncChunkV1 = (
  value: unknown
): value is CapturedSessionSyncChunkV1 => {
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
};
