import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import {
  crossIdentitySyncDeterministicUuid,
  crossIdentitySyncDigest,
  sharedMemoryGrantScopedSourceId,
  sharedSourceArtifactHash,
  sharedSourceArtifactId,
  sharedSourcePreviewHash,
  sharedSourcePreviewId,
  SHARED_MEMORY_AUTHORITY_ACTION,
  SHARED_SOURCE_ARTIFACT_SCHEMA_VERSION,
  SHARED_SOURCE_PREVIEW_SCHEMA_VERSION,
  type SharedSourceArtifactReference,
  type SharedSourceArtifactV1,
  type SharedSourcePreviewReference,
  type SharedSourcePreviewV1,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider
} from "@koed/shared";
import {
  decryptOwnerPrivateEncryptedFieldWithClient,
  upsertEncryptedFieldPayloadWithClient
} from "./encrypted-payload-repository.js";
import {
  buildCapturedSessionSyncContributor,
  buildCapturedSessionSyncEvent,
  capturedSessionSyncContentFromUnknown,
  canonicalSyncJsonObject
} from "./cross-identity-sync-canonical.js";

import type { ActorContext } from "./types.js";
import { sharedMemoryPolicyHash } from "./shared-memory-policy.js";
import {
  cancelShareGrantRevocationRetentionWithClient,
  lockShareGrantRetentionScopeWithClient,
  scheduleShareGrantRevocationRetentionWithClient
} from "./retention-lifecycle-repository.js";

export const SHARED_MEMORY_AUTHORITY = SHARED_MEMORY_AUTHORITY_ACTION;

export const sharedMemoryRepresentations = [
  "memory_events",
  "lcm_leaves",
  "lcm_rollups"
] as const;

export type SharedMemoryRepresentation =
  (typeof sharedMemoryRepresentations)[number];
export type SharedMemoryConsentMode = "snapshot" | "continuous";
export type SharedMemoryConsentState =
  | "pending"
  | "active"
  | "paused"
  | "revoked"
  | "expired";
export type SharedMemoryGrantLifecycle =
  | "active"
  | "unavailable"
  | "revoked"
  | "tombstoned"
  | "purge_pending"
  | "purged";
export type SharedMemoryRepresentationState =
  | "pending"
  | "available"
  | "stale"
  | "invalidated"
  | "purge_pending"
  | "purged";

export interface SharedMemoryAuthorityContext {
  action: typeof SHARED_MEMORY_AUTHORITY;
  source: "browser_session" | "device_action_grant";
  referenceId: string;
}

export interface SharedMemoryCompanionScopeDto {
  scope: "team";
  kind: "shared_session_discussion";
  teamId: string;
  teamWorkspaceId: string;
  logicalMemoryId: string;
  shareGrantId: string;
}

export interface SharedMemoryPolicyRecord {
  id: string;
  policyId: string;
  scope: "source_owner" | "team" | "workspace";
  logicalMemoryId: string | null;
  sourceOwnerPrincipalId: string | null;
  teamId: string | null;
  teamWorkspaceId: string | null;
  version: number;
  allowedRepresentations: SharedMemoryRepresentation[];
  policyHash: string;
  effectiveAt: string;
  supersededAt: string | null;
}

export interface SharedMemorySourceBindingDto {
  sourceRevision: number;
  sourceHash: string;
  representationPolicyRevision: number;
  representationPolicyHash: string;
  contentPolicyVersion: number;
  contentPolicyHash: string;
  classifierVersion: number;
  classifierHash: string;
}

export type SharedMemorySourceItemType =
  | "user_message"
  | "assistant_message"
  | "thought"
  | "tool_call"
  | "tool_result"
  | "lcm_leaf"
  | "lcm_rollup";

export interface SharedMemorySourceItemInput {
  itemType: string;
  schemaVersion: number;
  sourceId: string;
  sourceLogicalMemoryId: string;
  sourceRevision: number;
  occurredAt?: string | null;
  classification?: {
    hiddenReasoning?: boolean;
    systemInstruction?: boolean;
    containsCredentials?: boolean;
    unsupportedProtocolItem?: boolean;
  };
  content: unknown;
}

export interface SharedMemoryRedactedSourceItemDto {
  itemType: SharedMemorySourceItemType;
  schemaVersion: 1;
  sourceId: string;
  sourceLogicalMemoryId: string;
  sourceRevision: number;
  occurredAt: string | null;
  content: Record<string, unknown>;
}

type SharedMemoryEventOrder = {
  occurredAt: string | null;
  sourceCursor: number;
  eventId: string;
};

export const compareSharedMemoryEventOrder = (
  left: SharedMemoryEventOrder,
  right: SharedMemoryEventOrder
): number =>
  (left.occurredAt ?? "").localeCompare(right.occurredAt ?? "") ||
  left.sourceCursor - right.sourceCursor ||
  left.eventId.localeCompare(right.eventId);

export interface SharedMemoryPreviewDto {
  representation: SharedMemoryRepresentation;
  logicalMemoryId: string;
  binding: SharedMemorySourceBindingDto;
  items: SharedMemoryRedactedSourceItemDto[];
  redactedContentHash: string;
  previewHash: string;
}

export interface SharedMemorySourceArtifactRecord extends SharedSourceArtifactReference {
  logicalMemoryId: string;
  remoteReplicaId: string;
  syncRelationshipId: string;
  ownerUserId: string | null;
  ownerPrincipalId: string;
  teamId: string;
  teamWorkspaceId: string;
  representation: SharedMemoryRepresentation;
  sourceRevision: number;
  sourceCursor: number;
  packageSequence: number;
  sourceHash: string;
  manifestHash: string;
  redactedContentHash: string;
  sourceOwnerPolicyId: string;
  sourceOwnerPolicyVersion: number;
  teamPolicyId: string;
  teamPolicyVersion: number;
  workspacePolicyId: string;
  workspacePolicyVersion: number;
  representationPolicyRevision: number;
  representationPolicyHash: string;
  contentPolicyVersion: number;
  contentPolicyHash: string;
  classifierVersion: number;
  classifierHash: string;
  sourceDeploymentIdentityId: string;
  remoteUserIdentityId: string;
  deviceCredentialId: string;
  deviceProvenanceHash: string;
  createdAt: string;
}

export interface SharedMemoryPersistedPreviewRecord extends SharedSourcePreviewReference {
  artifactId: string;
  artifactHash: string;
  logicalMemoryId: string;
  remoteReplicaId: string;
  ownerUserId: string | null;
  ownerPrincipalId: string;
  teamId: string;
  teamWorkspaceId: string;
  representation: SharedMemoryRepresentation;
  previewRevision: number;
  binding: SharedMemorySourceBindingDto;
  items: SharedMemoryRedactedSourceItemDto[];
  redactedContentHash: string;
  sourceRevision: number;
  sourceHash: string;
  syncRelationshipId: string;
  deviceProvenanceHash: string;
  createdAt: string;
}

export interface SharedMemoryConsentRecord {
  id: string;
  previewId: string;
  logicalMemoryId: string;
  remoteReplicaId: string;
  sourceOwnerPrincipalId: string;
  teamId: string;
  teamWorkspaceId: string;
  sourceOwnerPolicyId: string;
  sourceOwnerPolicyVersion: number;
  teamPolicyId: string;
  teamPolicyVersion: number;
  workspacePolicyId: string;
  workspacePolicyVersion: number;
  mode: SharedMemoryConsentMode;
  state: SharedMemoryConsentState;
  consentVersion: number;
  allowedRepresentations: SharedMemoryRepresentation[];
  selectedRepresentation: SharedMemoryRepresentation;
  previewRevision: number;
  previewHash: string;
  sourceRevision: number;
  maximumAuthorizedSourceRevision: number | null;
  sourceHash: string;
  representationPolicyRevision: number;
  representationPolicyHash: string;
  contentPolicyVersion: number;
  contentPolicyHash: string;
  classifierVersion: number;
  classifierHash: string;
  redactedContentHash: string;
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
  revokedAt: string | null;
}

export interface SharedMemoryGrantRecord {
  id: string;
  logicalGrantId: string;
  logicalMemoryId: string;
  remoteReplicaId: string;
  ownerUserId: string | null;
  ownerPrincipalId: string;
  sessionId: string | null;
  teamId: string;
  teamWorkspaceId: string;
  consentId: string;
  sourceOwnerPolicyId: string;
  sourceOwnerPolicyVersion: number;
  teamPolicyId: string;
  teamPolicyVersion: number;
  workspacePolicyId: string;
  workspacePolicyVersion: number;
  ownerAllowedRepresentations: SharedMemoryRepresentation[];
  activeRepresentation: SharedMemoryRepresentation | null;
  representationPolicyRevision: number;
  contentPolicyVersion: number;
  classifierVersion: number;
  sourceRevision: number;
  grantVersion: number;
  lifecycle: SharedMemoryGrantLifecycle;
  creatorAuthority: string;
  grantedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  companionScope: SharedMemoryCompanionScopeDto;
}

export interface SharedMemoryRepresentationRecord {
  id: string;
  shareGrantId: string;
  consentId: string;
  sourcePreviewId: string;
  sourceArtifactId: string;
  teamId: string;
  teamWorkspaceId: string;
  logicalMemoryId: string;
  representation: SharedMemoryRepresentation;
  sourceRevision: number;
  sourceRevisionHash: string;
  provenanceHash: string;
  sourceOwnerPolicyId: string;
  sourceOwnerPolicyVersion: number;
  teamPolicyId: string;
  teamPolicyVersion: number;
  workspacePolicyId: string;
  workspacePolicyVersion: number;
  representationPolicyRevision: number;
  contentPolicyVersion: number;
  classifierVersion: number;
  recordVersion: number;
  state: SharedMemoryRepresentationState;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
  availableAt: string | null;
  staleAt: string | null;
  invalidatedAt: string | null;
  invalidationReasonCode: string | null;
}

export interface SharedMemoryReadResult {
  grant: SharedMemoryGrantRecord;
  representation: SharedMemoryRepresentationRecord;
  items: SharedMemoryRedactedSourceItemDto[];
  sourcePage: {
    itemOffset: number;
    itemCount: number;
  };
  freshness: "fresh" | "stale";
  companionScope: SharedMemoryCompanionScopeDto;
}

export interface SharedMemoryWorkspaceIndexEntry {
  shareGrantId: string;
  logicalMemoryId: string;
  ownerUserId: string | null;
  activeRepresentation: SharedMemoryRepresentation;
  representationState: "available" | "stale";
  representationSourceRevision: number;
  representationUpdatedAt: string;
  freshness: "fresh" | "stale";
  lifecycle: SharedMemoryGrantLifecycle;
  createdAt: string;
  updatedAt: string;
  companionScope: SharedMemoryCompanionScopeDto;
}

export interface SharedMemoryWorkspaceIndexPage {
  entries: SharedMemoryWorkspaceIndexEntry[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface SharedMemoryOwnerGrantPage {
  entries: SharedMemoryGrantRecord[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface SharedMemoryRepository {
  createAuthoritativeSourcePreview(
    actor: ActorContext,
    input: {
      logicalMemoryId: string;
      remoteReplicaId: string;
      teamId: string;
      teamWorkspaceId: string;
      representation: SharedMemoryRepresentation;
      allowedRepresentations: SharedMemoryRepresentation[];
      authority: SharedMemoryAuthorityContext;
    }
  ): Promise<SharedMemoryPersistedPreviewRecord>;
  putSourceOwnerPolicy(
    actor: ActorContext,
    input: {
      mutationId: string;
      logicalMemoryId: string;
      policyId?: string;
      expectedCurrentVersion: number;
      allowedRepresentations: SharedMemoryRepresentation[];
    }
  ): Promise<SharedMemoryPolicyRecord>;
  putTeamPolicy(
    actor: ActorContext,
    input: {
      mutationId: string;
      teamId: string;
      policyId?: string;
      expectedCurrentVersion: number;
      allowedRepresentations: SharedMemoryRepresentation[];
    }
  ): Promise<SharedMemoryPolicyRecord>;
  putWorkspacePolicy(
    actor: ActorContext,
    input: {
      mutationId: string;
      teamId: string;
      teamWorkspaceId: string;
      policyId?: string;
      expectedCurrentVersion: number;
      allowedRepresentations: SharedMemoryRepresentation[];
    }
  ): Promise<SharedMemoryPolicyRecord>;
  createSourceOwnerConsent(
    actor: ActorContext,
    input: {
      consentId: string;
      preview: SharedSourcePreviewReference;
      mode: SharedMemoryConsentMode;
      allowedRepresentations: SharedMemoryRepresentation[];
      selectedRepresentation: SharedMemoryRepresentation;
      expiresAt?: string | null;
      authority: SharedMemoryAuthorityContext;
    }
  ): Promise<SharedMemoryConsentRecord>;
  createShareGrant(
    actor: ActorContext,
    input: {
      mutationId: string;
      logicalGrantId: string;
      consentId: string;
      authority: SharedMemoryAuthorityContext;
    }
  ): Promise<SharedMemoryGrantRecord>;
  selectGrantRepresentation(
    actor: ActorContext,
    input: {
      mutationId: string;
      shareGrantId: string;
      consentId: string;
      representation: SharedMemoryRepresentation;
      expectedGrantVersion: number;
      authority: SharedMemoryAuthorityContext;
    }
  ): Promise<SharedMemoryGrantRecord>;
  revokeShareGrant(
    actor: ActorContext,
    input: {
      mutationId: string;
      shareGrantId: string;
      expectedGrantVersion: number;
      reasonCode: string;
      authority: SharedMemoryAuthorityContext;
    }
  ): Promise<SharedMemoryGrantRecord>;
  materializeGrantRepresentation(
    actor: ActorContext,
    input: {
      mutationId: string;
      shareGrantId: string;
      consentId: string;
      expectedGrantVersion: number;
      expectedRepresentationVersion?: number;
      preview: SharedSourcePreviewReference;
    }
  ): Promise<SharedMemoryRepresentationRecord>;
  advanceContinuousGrantRepresentations(input: {
    remoteReplicaId: string;
    sourceRevision: number;
  }): Promise<{ advanced: number }>;
  rewrapTeamRepresentationChunkBatch(
    provider: EnvelopeEncryptionProvider,
    input?: {
      teamId?: string;
      batchSize?: number;
      force?: boolean;
      dryRun?: boolean;
      afterId?: string;
    }
  ): Promise<{
    processedRows: number;
    rewrappedRows: number;
    wouldRewrapRows: number;
    failedRows: number;
    done: boolean;
    nextCursorId: string | null;
  }>;
  listWorkspaceGrants(
    actor: ActorContext,
    input: {
      teamId: string;
      teamWorkspaceId: string;
      limit: number;
      offset: number;
    }
  ): Promise<SharedMemoryWorkspaceIndexPage>;
  listOwnerGrants(
    actor: ActorContext,
    input: {
      logicalMemoryId: string;
      limit: number;
      offset: number;
    }
  ): Promise<SharedMemoryOwnerGrantPage>;
  readGrantRepresentation(
    actor: ActorContext,
    input: {
      shareGrantId: string;
      representation?: SharedMemoryRepresentation;
      page?: {
        direction: "older" | "newer";
        boundary?: number;
        limit: number;
      };
    }
  ): Promise<SharedMemoryReadResult | null>;
}

export class SharedMemoryAuthorizationError extends Error {
  statusCode = 403;
  constructor(message = "Shared Memory operation is not authorized") {
    super(message);
    this.name = "SharedMemoryAuthorizationError";
  }
}

export class SharedMemoryConflictError extends Error {
  statusCode = 409;
  constructor(message = "Shared Memory optimistic version conflict") {
    super(message);
    this.name = "SharedMemoryConflictError";
  }
}

const isUniqueViolation = (error: unknown, constraint: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === "23505" &&
  (error as { constraint?: unknown }).constraint === constraint;

export class SharedMemorySourceItemRejectedError extends Error {
  statusCode = 422;
  constructor(
    public readonly reasonCode:
      | "unknown_item_type"
      | "unknown_schema_version"
      | "hidden_reasoning"
      | "system_instruction"
      | "credential_item"
      | "unsupported_protocol_item"
      | "invalid_item_schema"
      | "wrong_representation"
      | "cross_memory_provenance"
  ) {
    super(`Shared Memory source item rejected: ${reasonCode}`);
    this.name = "SharedMemorySourceItemRejectedError";
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SOURCE_ITEMS = 2_048;
const MAX_CHUNK_BYTES = 256 * 1_024;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_KEYS = 2_000;
const OUTBOX_REPLAY_DAYS = 30;
const MAX_WORKSPACE_INDEX_LIMIT = 100;
const MAX_WORKSPACE_INDEX_OFFSET = 10_000;
const ENCRYPTED_CONVERSATION_ITEM_TEXT = "[koed encrypted conversation item]";
const ENCRYPTED_MEMORY_NODE_TEXT = "[koed encrypted memory node]";
const SHARED_MEMORY_CLASSIFIER_VERSION = 1;

type SqlClient = pg.Pool | pg.PoolClient;
type Row = Record<string, unknown>;
type PgArrayParserFactory = {
  create(
    source: string,
    transform: (entry: string) => string
  ): { parse(): string[] };
};

const pgArrayParser = pg.types.arrayParser as unknown as PgArrayParserFactory;

const iso = (value: unknown): string =>
  value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();
const nullableIso = (value: unknown): string | null =>
  value === null || value === undefined ? null : iso(value);
const numberValue = (value: unknown): number => Number(value);
const stringValue = (value: unknown): string => String(value);
const stringArray = (value: unknown): SharedMemoryRepresentation[] => {
  const values =
    typeof value === "string"
      ? pgArrayParser.create(value, (entry) => entry).parse()
      : value;
  return Array.isArray(values)
    ? (values.map(String) as SharedMemoryRepresentation[])
    : [];
};

const assertUuid = (value: string, field: string): void => {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${field} must be a UUID`);
};

const assertHash = (value: string, field: string): void => {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  }
};

const normalizedRepresentations = (
  values: readonly SharedMemoryRepresentation[]
): SharedMemoryRepresentation[] => {
  const unique = [...new Set(values)].sort();
  if (
    unique.length === 0 ||
    unique.length > sharedMemoryRepresentations.length ||
    unique.some(
      (value) =>
        !sharedMemoryRepresentations.includes(
          value as SharedMemoryRepresentation
        )
    )
  ) {
    throw new TypeError(
      "allowedRepresentations must be a non-empty supported set"
    );
  }
  return unique as SharedMemoryRepresentation[];
};

const intersection = (
  ...sets: readonly SharedMemoryRepresentation[][]
): SharedMemoryRepresentation[] => {
  const [first = [], ...rest] = sets;
  return first.filter((value) => rest.every((set) => set.includes(value)));
};

const isSubset = (
  candidate: readonly SharedMemoryRepresentation[],
  current: readonly SharedMemoryRepresentation[]
): boolean => candidate.every((value) => current.includes(value));

const exactObjectKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean => Object.keys(value).every((key) => allowed.includes(key));

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const credentialKeyPattern =
  /^(?:authorization|cookie|credential|password|passwd|private[_-]?key|secret|session|token|access[_-]?token|refresh[_-]?token|api[_-]?key)$/i;
const prohibitedInstructionKeyPattern =
  /^(?:hidden[_-]?reasoning|chain[_-]?of[_-]?thought|system[_-]?(?:instruction|message|prompt))$/i;
const inlineSecretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g
];

const redactStructuredValue = (
  value: unknown,
  state: { depth: number; keys: { count: number } }
): unknown => {
  if (state.depth > MAX_JSON_DEPTH || state.keys.count > MAX_JSON_KEYS) {
    throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
    }
    return value;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_CHUNK_BYTES) {
      throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
    }
    return inlineSecretPatterns.reduce(
      (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
      value
    );
  }
  if (Array.isArray(value)) {
    state.keys.count += value.length;
    return value.map((item) =>
      redactStructuredValue(item, { ...state, depth: state.depth + 1 })
    );
  }
  if (!isPlainObject(value)) {
    throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    state.keys.count += 1;
    if (prohibitedInstructionKeyPattern.test(key)) {
      throw new SharedMemorySourceItemRejectedError("system_instruction");
    }
    output[key] = credentialKeyPattern.test(key)
      ? "[REDACTED]"
      : redactStructuredValue(item, { ...state, depth: state.depth + 1 });
  }
  return output;
};

const requiredString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const validateTextContent = (content: unknown): Record<string, unknown> => {
  if (
    !isPlainObject(content) ||
    !exactObjectKeys(content, ["text"]) ||
    !requiredString(content.text)
  ) {
    throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
  }
  return {
    text: redactStructuredValue(content.text, {
      depth: 0,
      keys: { count: 0 }
    })
  };
};

const validateToolContent = (content: unknown): Record<string, unknown> => {
  if (
    !isPlainObject(content) ||
    !exactObjectKeys(content, ["toolName", "toolCallId", "payload"]) ||
    !requiredString(content.toolName) ||
    (content.toolCallId !== null && !requiredString(content.toolCallId)) ||
    !("payload" in content)
  ) {
    throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
  }
  return {
    toolName: content.toolName,
    toolCallId: content.toolCallId,
    payload: redactStructuredValue(content.payload, {
      depth: 0,
      keys: { count: 0 }
    })
  };
};

const validateLcmContent = (content: unknown): Record<string, unknown> => {
  if (
    !isPlainObject(content) ||
    !exactObjectKeys(content, ["title", "summaryText", "sourceIds"]) ||
    (content.title !== undefined && typeof content.title !== "string") ||
    !requiredString(content.summaryText) ||
    !Array.isArray(content.sourceIds) ||
    content.sourceIds.length === 0 ||
    content.sourceIds.some(
      (value) => !requiredString(value) || !UUID_PATTERN.test(value)
    )
  ) {
    throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
  }
  return {
    ...(typeof content.title === "string"
      ? {
          title: redactStructuredValue(content.title, {
            depth: 0,
            keys: { count: 0 }
          })
        }
      : {}),
    summaryText: redactStructuredValue(content.summaryText, {
      depth: 0,
      keys: { count: 0 }
    }),
    sourceIds: [...new Set(content.sourceIds as string[])]
  };
};

const itemTypesByRepresentation: Record<
  SharedMemoryRepresentation,
  readonly SharedMemorySourceItemType[]
> = {
  memory_events: [
    "user_message",
    "assistant_message",
    "thought",
    "tool_call",
    "tool_result"
  ],
  lcm_leaves: ["lcm_leaf"],
  lcm_rollups: ["lcm_rollup"]
};

export const redactEligibleSharedMemorySourceItem = (input: {
  representation: SharedMemoryRepresentation;
  logicalMemoryId: string;
  sourceRevision: number;
  item: SharedMemorySourceItemInput;
}): SharedMemoryRedactedSourceItemDto => {
  const { item } = input;
  if (
    !isPlainObject(item) ||
    !exactObjectKeys(item, [
      "itemType",
      "schemaVersion",
      "sourceId",
      "sourceLogicalMemoryId",
      "sourceRevision",
      "occurredAt",
      "classification",
      "content"
    ]) ||
    (item.classification !== undefined &&
      (!isPlainObject(item.classification) ||
        !exactObjectKeys(item.classification, [
          "hiddenReasoning",
          "systemInstruction",
          "containsCredentials",
          "unsupportedProtocolItem"
        ]) ||
        Object.values(item.classification).some(
          (value) => typeof value !== "boolean"
        )))
  ) {
    throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
  }
  if (!sharedMemoryRepresentations.includes(input.representation)) {
    throw new SharedMemorySourceItemRejectedError("wrong_representation");
  }
  if (
    !itemTypesByRepresentation[input.representation].includes(
      item.itemType as SharedMemorySourceItemType
    )
  ) {
    if (
      [
        "user_message",
        "assistant_message",
        "tool_call",
        "tool_result",
        "lcm_leaf",
        "lcm_rollup"
      ].includes(item.itemType)
    ) {
      throw new SharedMemorySourceItemRejectedError("wrong_representation");
    }
    throw new SharedMemorySourceItemRejectedError("unknown_item_type");
  }
  if (item.schemaVersion !== 1) {
    throw new SharedMemorySourceItemRejectedError("unknown_schema_version");
  }
  if (item.classification?.hiddenReasoning) {
    throw new SharedMemorySourceItemRejectedError("hidden_reasoning");
  }
  if (item.classification?.systemInstruction) {
    throw new SharedMemorySourceItemRejectedError("system_instruction");
  }
  if (item.classification?.containsCredentials) {
    throw new SharedMemorySourceItemRejectedError("credential_item");
  }
  if (item.classification?.unsupportedProtocolItem) {
    throw new SharedMemorySourceItemRejectedError("unsupported_protocol_item");
  }
  if (item.sourceLogicalMemoryId !== input.logicalMemoryId) {
    throw new SharedMemorySourceItemRejectedError("cross_memory_provenance");
  }
  if (
    !requiredString(item.sourceId) ||
    !UUID_PATTERN.test(item.sourceId) ||
    item.sourceRevision !== input.sourceRevision ||
    !Number.isSafeInteger(item.sourceRevision) ||
    item.sourceRevision < 0 ||
    (item.occurredAt !== undefined &&
      item.occurredAt !== null &&
      Number.isNaN(Date.parse(item.occurredAt)))
  ) {
    throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
  }

  const itemType = item.itemType as SharedMemorySourceItemType;
  const content =
    itemType === "user_message" || itemType === "assistant_message"
      ? validateTextContent(item.content)
      : itemType === "tool_call" || itemType === "tool_result"
        ? validateToolContent(item.content)
        : validateLcmContent(item.content);

  return {
    itemType,
    schemaVersion: 1,
    sourceId: item.sourceId,
    sourceLogicalMemoryId: item.sourceLogicalMemoryId,
    sourceRevision: item.sourceRevision,
    occurredAt: item.occurredAt ?? null,
    content
  };
};

export const createSharedMemoryPreview = (input: {
  representation: SharedMemoryRepresentation;
  logicalMemoryId: string;
  binding: SharedMemorySourceBindingDto;
  items: SharedMemorySourceItemInput[];
}): SharedMemoryPreviewDto => {
  validateBinding(input.binding);
  if (input.items.length === 0 || input.items.length > MAX_SOURCE_ITEMS) {
    throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
  }
  const items = input.items.map((item) =>
    redactEligibleSharedMemorySourceItem({
      representation: input.representation,
      logicalMemoryId: input.logicalMemoryId,
      sourceRevision: input.binding.sourceRevision,
      item
    })
  );
  const redactedContentHash = crossIdentitySyncDigest(items);
  return {
    representation: input.representation,
    logicalMemoryId: input.logicalMemoryId,
    binding: { ...input.binding },
    items,
    redactedContentHash,
    previewHash: crossIdentitySyncDigest({
      representation: input.representation,
      logicalMemoryId: input.logicalMemoryId,
      binding: input.binding,
      redactedContentHash,
      items
    })
  };
};

const validateBinding = (binding: SharedMemorySourceBindingDto): void => {
  if (
    !Number.isSafeInteger(binding.sourceRevision) ||
    binding.sourceRevision < 0
  ) {
    throw new TypeError("sourceRevision must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(binding.representationPolicyRevision) ||
    binding.representationPolicyRevision < 1 ||
    !Number.isSafeInteger(binding.contentPolicyVersion) ||
    binding.contentPolicyVersion < 1 ||
    !Number.isSafeInteger(binding.classifierVersion) ||
    binding.classifierVersion < 1
  ) {
    throw new TypeError(
      "policy and classifier versions must be positive integers"
    );
  }
  assertHash(binding.sourceHash, "sourceHash");
  assertHash(binding.representationPolicyHash, "representationPolicyHash");
  assertHash(binding.contentPolicyHash, "contentPolicyHash");
  assertHash(binding.classifierHash, "classifierHash");
};

const mapPolicy = (
  row: Row,
  scope: SharedMemoryPolicyRecord["scope"]
): SharedMemoryPolicyRecord => ({
  id: stringValue(row.id),
  policyId: stringValue(row.policy_id),
  scope,
  logicalMemoryId: row.logical_memory_id
    ? stringValue(row.logical_memory_id)
    : null,
  sourceOwnerPrincipalId: row.source_owner_principal_id
    ? stringValue(row.source_owner_principal_id)
    : null,
  teamId: row.team_id ? stringValue(row.team_id) : null,
  teamWorkspaceId: row.team_workspace_id
    ? stringValue(row.team_workspace_id)
    : null,
  version: numberValue(row.version),
  allowedRepresentations: stringArray(row.allowed_representations),
  policyHash: stringValue(row.policy_hash),
  effectiveAt: iso(row.effective_at),
  supersededAt: nullableIso(row.superseded_at)
});

const mapConsent = (row: Row): SharedMemoryConsentRecord => ({
  id: stringValue(row.id),
  previewId: stringValue(row.preview_id),
  logicalMemoryId: stringValue(row.logical_memory_id),
  remoteReplicaId: stringValue(row.remote_replica_id),
  sourceOwnerPrincipalId: stringValue(row.source_owner_principal_id),
  teamId: stringValue(row.team_id),
  teamWorkspaceId: stringValue(row.team_workspace_id),
  sourceOwnerPolicyId: stringValue(row.source_owner_policy_id),
  sourceOwnerPolicyVersion: numberValue(row.source_owner_policy_version),
  teamPolicyId: stringValue(row.team_policy_id),
  teamPolicyVersion: numberValue(row.team_policy_version),
  workspacePolicyId: stringValue(row.workspace_policy_id),
  workspacePolicyVersion: numberValue(row.workspace_policy_version),
  mode: stringValue(row.mode) as SharedMemoryConsentMode,
  state: stringValue(row.state) as SharedMemoryConsentState,
  consentVersion: numberValue(row.consent_version),
  allowedRepresentations: stringArray(row.allowed_representations),
  selectedRepresentation: stringValue(
    row.selected_representation
  ) as SharedMemoryRepresentation,
  previewRevision: numberValue(row.preview_revision),
  previewHash: stringValue(row.preview_hash),
  sourceRevision: numberValue(row.source_revision),
  maximumAuthorizedSourceRevision:
    row.maximum_authorized_source_revision === null
      ? null
      : numberValue(row.maximum_authorized_source_revision),
  sourceHash: stringValue(row.source_hash),
  representationPolicyRevision: numberValue(row.representation_policy_revision),
  representationPolicyHash: stringValue(row.representation_policy_hash),
  contentPolicyVersion: numberValue(row.content_policy_version),
  contentPolicyHash: stringValue(row.content_policy_hash),
  classifierVersion: numberValue(row.classifier_version),
  classifierHash: stringValue(row.classifier_hash),
  redactedContentHash: stringValue(row.redacted_content_hash),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  activatedAt: nullableIso(row.activated_at),
  revokedAt: nullableIso(row.revoked_at)
});

const companionScope = (grant: {
  id: string;
  teamId: string;
  teamWorkspaceId: string;
  logicalMemoryId: string;
}): SharedMemoryCompanionScopeDto => ({
  scope: "team",
  kind: "shared_session_discussion",
  teamId: grant.teamId,
  teamWorkspaceId: grant.teamWorkspaceId,
  logicalMemoryId: grant.logicalMemoryId,
  shareGrantId: grant.id
});

const mapGrant = (row: Row): SharedMemoryGrantRecord => {
  const grant = {
    id: stringValue(row.id),
    logicalGrantId: stringValue(row.logical_grant_id),
    logicalMemoryId: stringValue(row.logical_memory_id),
    remoteReplicaId: stringValue(row.remote_replica_id),
    ownerUserId: row.owner_user_id ? stringValue(row.owner_user_id) : null,
    ownerPrincipalId: stringValue(row.owner_principal_id),
    sessionId: row.session_id ? stringValue(row.session_id) : null,
    teamId: stringValue(row.team_id),
    teamWorkspaceId: stringValue(row.team_workspace_id),
    consentId: stringValue(row.consent_id),
    sourceOwnerPolicyId: stringValue(row.source_owner_policy_id),
    sourceOwnerPolicyVersion: numberValue(row.source_owner_policy_version),
    teamPolicyId: stringValue(row.team_policy_id),
    teamPolicyVersion: numberValue(row.team_policy_version),
    workspacePolicyId: stringValue(row.workspace_policy_id),
    workspacePolicyVersion: numberValue(row.workspace_policy_version),
    ownerAllowedRepresentations: stringArray(row.owner_allowed_representations),
    activeRepresentation: row.active_representation
      ? (stringValue(row.active_representation) as SharedMemoryRepresentation)
      : null,
    representationPolicyRevision: numberValue(
      row.representation_policy_revision
    ),
    contentPolicyVersion: numberValue(row.content_policy_version),
    classifierVersion: numberValue(row.classifier_version),
    sourceRevision: numberValue(row.source_revision),
    grantVersion: numberValue(row.grant_version),
    lifecycle: stringValue(row.lifecycle) as SharedMemoryGrantLifecycle,
    creatorAuthority: stringValue(row.creator_authority),
    grantedByUserId: row.granted_by_user_id
      ? stringValue(row.granted_by_user_id)
      : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    revokedAt: nullableIso(row.revoked_at)
  };
  return { ...grant, companionScope: companionScope(grant) };
};

const mapRepresentation = (row: Row): SharedMemoryRepresentationRecord => ({
  id: stringValue(row.id),
  shareGrantId: stringValue(row.share_grant_id),
  consentId: stringValue(row.consent_id),
  sourcePreviewId: stringValue(row.source_preview_id),
  sourceArtifactId: stringValue(row.source_artifact_id),
  teamId: stringValue(row.team_id),
  teamWorkspaceId: stringValue(row.team_workspace_id),
  logicalMemoryId: stringValue(row.logical_memory_id),
  representation: stringValue(row.representation) as SharedMemoryRepresentation,
  sourceRevision: numberValue(row.source_revision),
  sourceRevisionHash: stringValue(row.source_revision_hash),
  provenanceHash: stringValue(row.provenance_hash),
  sourceOwnerPolicyId: stringValue(row.source_owner_policy_id),
  sourceOwnerPolicyVersion: numberValue(row.source_owner_policy_version),
  teamPolicyId: stringValue(row.team_policy_id),
  teamPolicyVersion: numberValue(row.team_policy_version),
  workspacePolicyId: stringValue(row.workspace_policy_id),
  workspacePolicyVersion: numberValue(row.workspace_policy_version),
  representationPolicyRevision: numberValue(row.representation_policy_revision),
  contentPolicyVersion: numberValue(row.content_policy_version),
  classifierVersion: numberValue(row.classifier_version),
  recordVersion: numberValue(row.record_version),
  state: stringValue(row.state) as SharedMemoryRepresentationState,
  chunkCount: numberValue(row.chunk_count),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  availableAt: nullableIso(row.available_at),
  staleAt: nullableIso(row.stale_at),
  invalidatedAt: nullableIso(row.invalidated_at),
  invalidationReasonCode: row.invalidation_reason_code
    ? stringValue(row.invalidation_reason_code)
    : null
});

const mapArtifact = (row: Row): SharedMemorySourceArtifactRecord => ({
  artifactId: stringValue(row.id),
  artifactHash: stringValue(row.artifact_hash),
  logicalMemoryId: stringValue(row.logical_memory_id),
  remoteReplicaId: stringValue(row.remote_replica_id),
  syncRelationshipId: stringValue(row.sync_relationship_id),
  ownerUserId: row.owner_user_id ? stringValue(row.owner_user_id) : null,
  ownerPrincipalId: stringValue(row.owner_principal_id),
  teamId: stringValue(row.team_id),
  teamWorkspaceId: stringValue(row.team_workspace_id),
  representation: stringValue(row.representation) as SharedMemoryRepresentation,
  sourceRevision: numberValue(row.source_revision),
  sourceCursor: numberValue(row.source_cursor),
  packageSequence: numberValue(row.package_sequence),
  sourceHash: stringValue(row.source_hash),
  manifestHash: stringValue(row.manifest_hash),
  redactedContentHash: stringValue(row.redacted_content_hash),
  sourceOwnerPolicyId: stringValue(row.source_owner_policy_id),
  sourceOwnerPolicyVersion: numberValue(row.source_owner_policy_version),
  teamPolicyId: stringValue(row.team_policy_id),
  teamPolicyVersion: numberValue(row.team_policy_version),
  workspacePolicyId: stringValue(row.workspace_policy_id),
  workspacePolicyVersion: numberValue(row.workspace_policy_version),
  representationPolicyRevision: numberValue(row.representation_policy_revision),
  representationPolicyHash: stringValue(row.representation_policy_hash),
  contentPolicyVersion: numberValue(row.content_policy_version),
  contentPolicyHash: stringValue(row.content_policy_hash),
  classifierVersion: numberValue(row.classifier_version),
  classifierHash: stringValue(row.classifier_hash),
  sourceDeploymentIdentityId: stringValue(row.source_deployment_identity_id),
  remoteUserIdentityId: stringValue(row.remote_user_identity_id),
  deviceCredentialId: stringValue(row.device_credential_id),
  deviceProvenanceHash: stringValue(row.device_provenance_hash),
  createdAt: iso(row.created_at)
});

const mapPersistedPreview = (
  row: Row,
  artifact: SharedMemorySourceArtifactRecord,
  preview: SharedSourcePreviewV1
): SharedMemoryPersistedPreviewRecord => ({
  previewId: stringValue(row.id),
  previewHash: stringValue(row.preview_hash),
  artifactId: artifact.artifactId,
  artifactHash: artifact.artifactHash,
  logicalMemoryId: stringValue(row.logical_memory_id),
  remoteReplicaId: stringValue(row.remote_replica_id),
  ownerUserId: row.owner_user_id ? stringValue(row.owner_user_id) : null,
  ownerPrincipalId: stringValue(row.owner_principal_id),
  teamId: stringValue(row.team_id),
  teamWorkspaceId: stringValue(row.team_workspace_id),
  representation: stringValue(row.representation) as SharedMemoryRepresentation,
  previewRevision: numberValue(row.preview_revision),
  binding: preview.binding,
  items: preview.items,
  redactedContentHash: stringValue(row.redacted_content_hash),
  sourceRevision: numberValue(row.source_revision),
  sourceHash: stringValue(row.source_hash),
  syncRelationshipId: artifact.syncRelationshipId,
  deviceProvenanceHash: artifact.deviceProvenanceHash,
  createdAt: iso(row.created_at)
});

const mapWorkspaceIndexEntry = (row: Row): SharedMemoryWorkspaceIndexEntry => {
  const grantScope = {
    id: stringValue(row.share_grant_id),
    teamId: stringValue(row.team_id),
    teamWorkspaceId: stringValue(row.team_workspace_id),
    logicalMemoryId: stringValue(row.logical_memory_id)
  };
  const representationState = stringValue(row.representation_state);
  if (representationState !== "available" && representationState !== "stale") {
    throw new SharedMemoryConflictError(
      "Workspace index selected an unavailable representation"
    );
  }
  return {
    shareGrantId: grantScope.id,
    logicalMemoryId: grantScope.logicalMemoryId,
    ownerUserId: row.owner_user_id ? stringValue(row.owner_user_id) : null,
    activeRepresentation: stringValue(
      row.active_representation
    ) as SharedMemoryRepresentation,
    representationState,
    representationSourceRevision: numberValue(
      row.representation_source_revision
    ),
    representationUpdatedAt: iso(row.representation_updated_at),
    freshness:
      representationState === "stale" ||
      row.replica_freshness_status === "stale" ||
      row.sync_relationship_state === "stale" ||
      row.sync_relationship_state === "revoked" ||
      (row.consent_mode === "continuous" &&
        numberValue(row.representation_source_revision) <
          numberValue(row.target_processing_cursor))
        ? "stale"
        : "fresh",
    lifecycle: stringValue(row.lifecycle) as SharedMemoryGrantLifecycle,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    companionScope: companionScope(grantScope)
  };
};

const withTransaction = async <T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const value = await work(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};

const requireWorkspaceAccess = async (
  client: SqlClient,
  actor: ActorContext,
  teamId: string,
  teamWorkspaceId: string,
  required: "read" | "write"
): Promise<void> => {
  const result = await client.query<{ allowed: boolean }>(
    `select exists (
       select 1
       from teams t
       join team_memberships tm
         on tm.team_id=t.id and tm.user_id=$3
        and tm.status='enabled' and tm.disabled_at is null
       join users u
         on u.id=tm.user_id and u.disabled_at is null and u.deleted_at is null
       join team_workspaces tw
         on tw.team_id=t.id and tw.id=$2 and tw.lifecycle='active'
        and tw.archived_at is null
       join team_workspace_access_grants wa
         on wa.team_id=t.id and wa.team_workspace_id=tw.id
        and wa.user_id=$3 and wa.disabled_at is null
       where t.id=$1 and t.lifecycle='active'
         and t.entitlement_status in ('active','grace')
         and wa.access ${required === "write" ? "='write'" : "in ('read','write')"}
     ) as allowed`,
    [teamId, teamWorkspaceId, actor.userId]
  );
  if (result.rows[0]?.allowed !== true)
    throw new SharedMemoryAuthorizationError();
};

const requireTeamManager = async (
  client: SqlClient,
  actor: ActorContext,
  teamId: string
): Promise<void> => {
  const result = await client.query<Row>(
    `select 1
       from teams t
       join team_memberships tm on tm.team_id=t.id
       join users u on u.id=tm.user_id
        and u.disabled_at is null and u.deleted_at is null
      where t.id=$1 and tm.user_id=$2
        and tm.role in ('owner','admin') and tm.status='enabled'
        and tm.disabled_at is null and t.lifecycle='active'
        and t.entitlement_status in ('active','grace')
      limit 1`,
    [teamId, actor.userId]
  );
  if (!result.rows[0]) throw new SharedMemoryAuthorizationError();
};

const requireSourceOwner = async (
  client: SqlClient,
  actor: ActorContext,
  logicalMemoryId: string
): Promise<{ ownerPrincipalId: string; sessionId: string | null }> => {
  const result = await client.query<Row>(
    `select owner_principal_id, local_session_id
       from logical_memories lm
       join users u on u.id=lm.owner_user_id
        and u.disabled_at is null and u.deleted_at is null
      where lm.id=$1 and lm.owner_user_id=$2 and lm.lifecycle='active'
        and lm.invalidated_at is null and lm.purge_completed_at is null
      limit 1`,
    [logicalMemoryId, actor.userId]
  );
  const row = result.rows[0];
  if (!row)
    throw new SharedMemoryAuthorizationError(
      "Only the source owner may perform this operation"
    );
  return {
    ownerPrincipalId: stringValue(row.owner_principal_id),
    sessionId: row.local_session_id ? stringValue(row.local_session_id) : null
  };
};

const authorityReference = (authority: SharedMemoryAuthorityContext): string =>
  `${authority.source}:${authority.referenceId}`;

const requireShareAuthority = async (
  client: SqlClient,
  actor: ActorContext,
  input: {
    teamId: string;
    teamWorkspaceId: string;
    authority: SharedMemoryAuthorityContext;
    consume: boolean;
    delegatedDeviceActionGrant: boolean;
    requireSharePermission?: boolean;
  }
): Promise<string> => {
  if (input.authority.action !== SHARED_MEMORY_AUTHORITY) {
    throw new SharedMemoryAuthorizationError(
      "Explicit Workspace share authority is required"
    );
  }
  assertUuid(input.authority.referenceId, "authority.referenceId");
  if (input.requireSharePermission !== false) {
    await requireWorkspaceAccess(
      client,
      actor,
      input.teamId,
      input.teamWorkspaceId,
      "write"
    );
    const shareAuthority = await client.query<{ allowed: boolean }>(
      `select exists (
         select 1 from team_workspace_access_grants
          where team_id=$1 and team_workspace_id=$2 and user_id=$3
            and access='write' and can_share_owned_memory=true
            and disabled_at is null
       ) as allowed`,
      [input.teamId, input.teamWorkspaceId, actor.userId]
    );
    if (shareAuthority.rows[0]?.allowed !== true) {
      throw new SharedMemoryAuthorizationError(
        "Workspace Memory sharing authority is required"
      );
    }
  }

  if (input.authority.source === "browser_session") {
    const session = await client.query(
      `select 1 from user_sessions
        where id=$1 and user_id=$2 and revoked_at is null and expires_at>now()
        limit 1`,
      [input.authority.referenceId, actor.userId]
    );
    if (!session.rows[0]) throw new SharedMemoryAuthorizationError();
    return authorityReference(input.authority);
  }

  if (!input.delegatedDeviceActionGrant) {
    throw new SharedMemoryAuthorizationError(
      "Device Action Grants require atomic high-risk execution"
    );
  }
  return authorityReference(input.authority);
};

const requireRecordedShareAuthority = async (
  client: SqlClient,
  actor: ActorContext,
  input: {
    teamId: string;
    teamWorkspaceId: string;
    authority: SharedMemoryAuthorityContext;
    recordedAuthority?: string;
    delegatedDeviceActionGrant: boolean;
    requireSharePermission?: boolean;
  }
): Promise<void> => {
  assertUuid(input.authority.referenceId, "authority.referenceId");
  if (input.authority.action !== SHARED_MEMORY_AUTHORITY) {
    throw new SharedMemoryAuthorizationError(
      "Explicit Workspace share authority is required"
    );
  }
  if (
    input.recordedAuthority !== undefined &&
    input.recordedAuthority !== authorityReference(input.authority)
  ) {
    throw new SharedMemoryConflictError("Authority idempotency conflict");
  }
  if (input.authority.source === "browser_session") {
    await requireShareAuthority(client, actor, {
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      authority: input.authority,
      consume: false,
      delegatedDeviceActionGrant: input.delegatedDeviceActionGrant,
      requireSharePermission: input.requireSharePermission
    });
    return;
  }
  if (!input.delegatedDeviceActionGrant) {
    throw new SharedMemoryAuthorizationError(
      "Device Action Grants require atomic high-risk execution"
    );
  }
};

const appendOutbox = async (
  client: SqlClient,
  input: {
    mutationId: string;
    family:
      | "share_grant_lifecycle"
      | "representation_changed"
      | "memory_event_available"
      | "lcm_leaf_available"
      | "lcm_rollup_available"
      | "access_revoked";
    teamId: string;
    teamWorkspaceId: string;
    shareGrantId: string;
    logicalMemoryId: string;
    resourceType: string;
    resourceId: string;
    actorPrincipalId: string | null;
  }
): Promise<void> => {
  const result = await client.query<Row>(
    `insert into collaboration_outbox (
       protocol_version, family, scope, team_id, team_workspace_id,
       share_grant_id, logical_memory_id, resource_type, resource_id,
       actor_principal_id, mutation_id, replay_until
     ) values (1,$1,'team',$2,$3,$4,$5,$6,$7,$8,$9,
       now()+make_interval(days=>$10::int))
     on conflict (mutation_id,family) do update
       set mutation_id=excluded.mutation_id
     returning team_id,team_workspace_id,share_grant_id,logical_memory_id,
               resource_type,resource_id,actor_principal_id`,
    [
      input.family,
      input.teamId,
      input.teamWorkspaceId,
      input.shareGrantId,
      input.logicalMemoryId,
      input.resourceType,
      input.resourceId,
      input.actorPrincipalId,
      input.mutationId,
      OUTBOX_REPLAY_DAYS
    ]
  );
  const row = result.rows[0];
  if (
    !row ||
    row.team_id !== input.teamId ||
    row.team_workspace_id !== input.teamWorkspaceId ||
    row.share_grant_id !== input.shareGrantId ||
    row.logical_memory_id !== input.logicalMemoryId ||
    row.resource_type !== input.resourceType ||
    row.resource_id !== input.resourceId ||
    row.actor_principal_id !== input.actorPrincipalId
  ) {
    throw new SharedMemoryConflictError("Collaboration mutation ID was reused");
  }
  await client.query(
    `select pg_notify(
       'koed_collaboration_realtime',
       json_build_object(
         'scope', 'team',
         'teamId', $1::uuid,
         'cursor', (
           select cursor
             from collaboration_outbox
            where mutation_id=$2 and family=$3
         ),
         'family', $3::text
       )::text
     )`,
    [input.teamId, input.mutationId, input.family]
  );
};

const appendPolicyAudit = async (
  client: SqlClient,
  input: {
    actorUserId: string;
    ownerUserId: string | null;
    action: string;
    targetTable: string;
    targetId: string;
    mutationId: string;
    scope: "source_owner" | "team" | "workspace";
    logicalMemoryId?: string;
    teamId?: string;
    teamWorkspaceId?: string;
    policyId: string;
    version: number;
    previousVersion: number;
    allowedRepresentations: SharedMemoryRepresentation[];
  }
): Promise<void> => {
  await client.query(
    `insert into audit_events (
       actor_user_id,owner_user_id,visibility,action,target_table,target_id,metadata
     ) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      input.actorUserId,
      input.ownerUserId,
      input.ownerUserId ? "personal" : null,
      input.action,
      input.targetTable,
      input.targetId,
      JSON.stringify({
        mutationId: input.mutationId,
        scope: input.scope,
        logicalMemoryId: input.logicalMemoryId ?? null,
        teamId: input.teamId ?? null,
        teamWorkspaceId: input.teamWorkspaceId ?? null,
        policyId: input.policyId,
        version: input.version,
        previousVersion: input.previousVersion,
        allowedRepresentations: input.allowedRepresentations
      })
    ]
  );
};

const invalidateAffectedGrants = async (
  client: SqlClient,
  input: {
    mutationId: string;
    actorUserId: string;
    whereSql: string;
    parameters: unknown[];
    reasonCode: string;
  }
): Promise<void> => {
  const affected = await client.query<Row>(
    `update team_session_share_grants g
        set lifecycle='unavailable', grant_version=grant_version+1, updated_at=now()
      where g.lifecycle='active' and (${input.whereSql})
      returning g.*`,
    input.parameters
  );
  for (const raw of affected.rows) {
    const row = raw as Row;
    await client.query(
      `update team_memory_representations
          set state='invalidated', invalidated_at=now(),
              invalidation_reason_code=$2, record_version=record_version+1,
              updated_at=now()
        where share_grant_id=$1 and state in ('pending','available','stale')`,
      [row.id, input.reasonCode]
    );
    await appendOutbox(client, {
      mutationId: crossIdentitySyncDeterministicUuid({
        parentMutationId: input.mutationId,
        shareGrantId: row.id,
        reasonCode: input.reasonCode
      }),
      family: "representation_changed",
      teamId: stringValue(row.team_id),
      teamWorkspaceId: stringValue(row.team_workspace_id),
      shareGrantId: stringValue(row.id),
      logicalMemoryId: stringValue(row.logical_memory_id),
      resourceType: "team_memory_representation",
      resourceId: stringValue(row.id),
      actorPrincipalId: input.actorUserId
    });
  }
};

const activePolicy = async (
  client: SqlClient,
  input: {
    table:
      | "source_owner_representation_policies"
      | "team_representation_policies"
      | "workspace_representation_policies";
    whereSql: string;
    parameters: unknown[];
  }
): Promise<Row | null> => {
  const result = await client.query(
    `select * from ${input.table} where ${input.whereSql}
      and superseded_at is null for update`,
    input.parameters
  );
  return (result.rows[0] as Row | undefined) ?? null;
};

const requireCurrentPolicies = async (
  client: SqlClient,
  input: {
    logicalMemoryId: string;
    ownerPrincipalId: string;
    teamId: string;
    teamWorkspaceId: string;
  }
): Promise<{
  owner: Row;
  team: Row;
  workspace: Row;
  intersection: SharedMemoryRepresentation[];
}> => {
  const owner = await activePolicy(client, {
    table: "source_owner_representation_policies",
    whereSql: "logical_memory_id=$1 and source_owner_principal_id=$2",
    parameters: [input.logicalMemoryId, input.ownerPrincipalId]
  });
  const team = await activePolicy(client, {
    table: "team_representation_policies",
    whereSql: "team_id=$1",
    parameters: [input.teamId]
  });
  const workspace = await activePolicy(client, {
    table: "workspace_representation_policies",
    whereSql: "team_id=$1 and team_workspace_id=$2",
    parameters: [input.teamId, input.teamWorkspaceId]
  });
  if (!owner || !team || !workspace) {
    throw new SharedMemoryConflictError(
      "All three active representation policies are required"
    );
  }
  return {
    owner,
    team,
    workspace,
    intersection: intersection(
      stringArray(owner.allowed_representations),
      stringArray(team.allowed_representations),
      stringArray(workspace.allowed_representations)
    )
  };
};

const sameConsentCreate = (
  row: Row,
  input: {
    logicalMemoryId: string;
    remoteReplicaId: string;
    teamId: string;
    teamWorkspaceId: string;
    mode: SharedMemoryConsentMode;
    allowed: SharedMemoryRepresentation[];
    selected: SharedMemoryRepresentation;
    preview: SharedSourcePreviewReference;
  }
): boolean =>
  row.logical_memory_id === input.logicalMemoryId &&
  row.remote_replica_id === input.remoteReplicaId &&
  row.team_id === input.teamId &&
  row.team_workspace_id === input.teamWorkspaceId &&
  row.mode === input.mode &&
  crossIdentitySyncDigest(stringArray(row.allowed_representations)) ===
    crossIdentitySyncDigest(input.allowed) &&
  row.selected_representation === input.selected &&
  row.preview_id === input.preview.previewId &&
  row.preview_hash === input.preview.previewHash;

const representationAvailableFamily = (
  representation: SharedMemoryRepresentation
): "memory_event_available" | "lcm_leaf_available" | "lcm_rollup_available" =>
  representation === "memory_events"
    ? "memory_event_available"
    : representation === "lcm_leaves"
      ? "lcm_leaf_available"
      : "lcm_rollup_available";

const chunkItems = (
  items: SharedMemoryRedactedSourceItemDto[]
): SharedMemoryRedactedSourceItemDto[][] => {
  const chunks: SharedMemoryRedactedSourceItemDto[][] = [];
  let current: SharedMemoryRedactedSourceItemDto[] = [];
  for (const item of items) {
    const candidate = [...current, item];
    if (
      Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_CHUNK_BYTES
    ) {
      if (current.length === 0) {
        throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
      }
      chunks.push(current);
      current = [item];
      if (
        Buffer.byteLength(JSON.stringify(current), "utf8") > MAX_CHUNK_BYTES
      ) {
        throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
      }
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

const ciphertextHash = (ciphertext: string): string =>
  createHash("sha256").update(Buffer.from(ciphertext, "base64")).digest("hex");

const envelopeScope = (input: {
  teamId: string;
  teamWorkspaceId: string;
}): EncryptedPayloadEnvelope["scope"] => ({
  teamId: input.teamId,
  workspaceId: input.teamWorkspaceId,
  objectClass: "shared_memory_representation_chunk"
});

const envelopeProvenance = (
  representationId: string
): EncryptedPayloadEnvelope["provenance"] => ({
  rowFamily: "team_memory_representation_chunk",
  sourceTable: "team_memory_representations",
  sourceId: representationId
});

const SHARED_MEMORY_CHUNK_FORMAT_VERSION = 1;

const envelopeAad = (input: {
  representationId: string;
  shareGrantId: string;
  teamId: string;
  teamWorkspaceId: string;
  logicalMemoryId: string;
  consentId: string;
  representation: SharedMemoryRepresentation;
  chunkIndex: number;
  chunkCount: number;
  itemOffset: number;
  itemCount: number;
  totalItemCount: number;
  binding: SharedMemorySourceBindingDto;
  redactedContentHash: string;
  provenanceHash: string;
}): Record<string, string | number> => ({
  chunkFormatVersion: SHARED_MEMORY_CHUNK_FORMAT_VERSION,
  representationId: input.representationId,
  shareGrantId: input.shareGrantId,
  teamId: input.teamId,
  teamWorkspaceId: input.teamWorkspaceId,
  logicalMemoryId: input.logicalMemoryId,
  consentId: input.consentId,
  representation: input.representation,
  chunkIndex: input.chunkIndex,
  chunkCount: input.chunkCount,
  itemOffset: input.itemOffset,
  itemCount: input.itemCount,
  totalItemCount: input.totalItemCount,
  sourceRevision: input.binding.sourceRevision,
  sourceHash: input.binding.sourceHash,
  representationPolicyRevision: input.binding.representationPolicyRevision,
  representationPolicyHash: input.binding.representationPolicyHash,
  contentPolicyVersion: input.binding.contentPolicyVersion,
  contentPolicyHash: input.binding.contentPolicyHash,
  classifierVersion: input.binding.classifierVersion,
  classifierHash: input.binding.classifierHash,
  redactedContentHash: input.redactedContentHash,
  provenanceHash: input.provenanceHash
});

const aadMatches = (
  actual: Record<string, string>,
  expected: Record<string, string | number>
): boolean =>
  Object.entries(expected).every(
    ([key, value]) => actual[key] === String(value)
  ) && Object.keys(actual).length === Object.keys(expected).length;

export const createSharedMemoryRepository = (
  pool: pg.Pool,
  options: {
    resolveTeamEncryptionProvider: (input: {
      teamId: string;
      purpose: "encrypt" | "decrypt";
      keyId?: string;
      keyVersion?: number;
    }) => EnvelopeEncryptionProvider | Promise<EnvelopeEncryptionProvider>;
    resolveOwnerPrivateReplicaEncryptionProvider: (input: {
      ownerUserId: string;
      ownerPrincipalId: string;
      logicalMemoryId: string;
      remoteReplicaId: string;
      teamId: string;
      teamWorkspaceId: string;
      purpose: "encrypt" | "decrypt";
      keyId?: string;
      keyVersion?: number;
    }) => EnvelopeEncryptionProvider | Promise<EnvelopeEncryptionProvider>;
    delegatedDeviceActionGrantExecution?: boolean;
  }
): SharedMemoryRepository => {
  const delegatedDeviceActionGrant =
    options.delegatedDeviceActionGrantExecution === true;
  const resolveOwnerPrivateReplicaEncryptionProvider = async (input: {
    ownerUserId: string;
    ownerPrincipalId: string;
    logicalMemoryId: string;
    remoteReplicaId: string;
    teamId: string;
    teamWorkspaceId: string;
    purpose: "encrypt" | "decrypt";
    keyId?: string;
    keyVersion?: number;
  }): Promise<EnvelopeEncryptionProvider> =>
    options.resolveOwnerPrivateReplicaEncryptionProvider(input);

  const nullableString = (value: unknown): string | null =>
    value === null || value === undefined
      ? null
      : typeof value === "string"
        ? value
        : typeof value === "number" ||
            typeof value === "bigint" ||
            typeof value === "boolean"
          ? String(value)
          : null;

  const nullableNumber = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);

  const encryptedJsonMarkerMatches = (
    value: unknown,
    sourceTable: string,
    sourceColumn: string
  ): boolean =>
    isPlainObject(value) &&
    value.contentEncrypted === true &&
    value.encryptedSourceTable === sourceTable &&
    value.encryptedSourceColumn === sourceColumn;

  const requireHydratedValue = <T>(
    value: T | null | undefined,
    message: string
  ): T => {
    if (value === null || value === undefined) {
      throw new SharedMemoryConflictError(message);
    }
    return value;
  };

  const deviceProvenanceHash = (row: Row): string =>
    crossIdentitySyncDigest({
      syncRelationshipId: stringValue(row.sync_relationship_id),
      deviceCredentialId: stringValue(row.device_credential_id),
      credentialKeyId: stringValue(row.credential_key_id),
      upstreamBackendId: stringValue(row.upstream_backend_id),
      deviceInstanceId: stringValue(row.device_instance_id),
      lineageId: stringValue(row.lineage_id),
      credentialVersion: numberValue(row.credential_version),
      verifierKind: stringValue(row.verifier_kind),
      verifierHash: nullableString(row.verifier_hash),
      publicKeyJwk: row.public_key_jwk ?? null
    });

  const representationPolicyHashForPreview = (input: {
    representation: SharedMemoryRepresentation;
    revision: number;
    owner: SharedMemoryPolicyRecord;
    team: SharedMemoryPolicyRecord;
    workspace: SharedMemoryPolicyRecord;
  }): string =>
    crossIdentitySyncDigest({
      kind: "shared_memory_representation_policy",
      representation: input.representation,
      revision: input.revision,
      owner: {
        policyId: input.owner.policyId,
        version: input.owner.version,
        hash: input.owner.policyHash
      },
      team: {
        policyId: input.team.policyId,
        version: input.team.version,
        hash: input.team.policyHash
      },
      workspace: {
        policyId: input.workspace.policyId,
        version: input.workspace.version,
        hash: input.workspace.policyHash
      }
    });

  const contentPolicyHashForPreview = (input: {
    representation: SharedMemoryRepresentation;
    version: number;
  }): string =>
    crossIdentitySyncDigest({
      kind: "shared_memory_content_policy",
      representation: input.representation,
      version: input.version
    });

  const classifierHashForPreview = (input: {
    representation: SharedMemoryRepresentation;
    version: number;
  }): string =>
    crossIdentitySyncDigest({
      kind: "shared_memory_classifier",
      representation: input.representation,
      version: input.version
    });

  type AuthoritativeSyncContext = {
    logicalMemoryId: string;
    remoteReplicaId: string;
    localSessionId: string;
    ownerUserId: string;
    ownerPrincipalId: string;
    teamId: string;
    teamWorkspaceId: string;
    syncRelationshipId: string;
    localReplicaId: string;
    remoteSyncReplicaId: string;
    sourceRevision: number;
    sourceCursor: number;
    packageSequence: number;
    representationPolicyRevision: number;
    representationPolicyHash: string;
    contentPolicyVersion: number;
    contentPolicyHash: string;
    classifierVersion: number;
    classifierHash: string;
    sourceOwnerPolicyId: string;
    sourceOwnerPolicyVersion: number;
    teamPolicyId: string;
    teamPolicyVersion: number;
    workspacePolicyId: string;
    workspacePolicyVersion: number;
    sourceDeploymentIdentityId: string;
    remoteUserIdentityId: string;
    deviceCredentialId: string;
    deviceProvenanceHash: string;
  };

  type PersistedPreviewLoadResult = {
    artifact: SharedMemorySourceArtifactRecord;
    preview: SharedMemoryPersistedPreviewRecord;
    artifactBody: SharedSourceArtifactV1;
    previewBody: SharedSourcePreviewV1;
  };

  type LoadedMappedEvent = {
    eventId: string;
    sourceCursor: number;
    mappedRevisionHash: string;
    occurredAt: string | null;
    contributorItems: SharedMemoryRedactedSourceItemDto[];
    manifestEntries: SharedSourceArtifactV1["manifest"];
  };

  type LoadedNodeItem = {
    item: SharedMemoryRedactedSourceItemDto;
    manifestEntry: SharedSourceArtifactV1["manifest"][number];
    sourceEventIds: string[];
    nodeRevisionHash: string;
  };

  type AuthoritativeSourceMaterial = {
    items: SharedMemoryRedactedSourceItemDto[];
    manifest: SharedSourceArtifactV1["manifest"];
    manifestHash: string;
    redactedContentHash: string;
    sourceHash: string;
    mappedEvents: Map<string, LoadedMappedEvent>;
  };

  const LCM_SUMMARY_SCHEMA_VERSION = "lcm-semantic-summary-v1";

  const hydrateOwnerPrivateEncryptedField = async (
    client: pg.PoolClient,
    actor: ActorContext,
    provider: EnvelopeEncryptionProvider | null,
    input: {
      ownerPrincipalId: string;
      sourceTable: "conversation_items" | "memory_events" | "memory_nodes";
      sourceId: string;
      sourceColumn: string;
      fallback: unknown;
      requiredMessage: string;
    }
  ): Promise<unknown> => {
    if (provider) {
      const decrypted = await decryptOwnerPrivateEncryptedFieldWithClient(
        client,
        provider,
        {
          ownerPrincipalId: input.ownerPrincipalId,
          sourceTable: input.sourceTable,
          sourceId: input.sourceId,
          sourceColumn: input.sourceColumn
        }
      );
      if (decrypted?.record.ownerUserId === actor.userId) {
        return decrypted.plaintext;
      }
    }
    if (
      input.fallback === ENCRYPTED_CONVERSATION_ITEM_TEXT ||
      input.fallback === ENCRYPTED_MEMORY_NODE_TEXT ||
      encryptedJsonMarkerMatches(
        input.fallback,
        input.sourceTable,
        input.sourceColumn
      )
    ) {
      throw new SharedMemoryConflictError(input.requiredMessage);
    }
    return input.fallback;
  };

  const decryptPersistedOwnerPrivatePayload = async (
    client: pg.PoolClient,
    input: {
      sourceTable: "shared_source_artifacts" | "shared_source_previews";
      sourceId: string;
      sourceColumn: "artifact" | "preview";
      ownerUserId: string;
      ownerPrincipalId: string;
      logicalMemoryId: string;
      remoteReplicaId: string;
      teamId: string;
      teamWorkspaceId: string;
      requiredMessage: string;
    }
  ): Promise<unknown> => {
    const provider = await resolveOwnerPrivateReplicaEncryptionProvider({
      ownerUserId: input.ownerUserId,
      ownerPrincipalId: input.ownerPrincipalId,
      logicalMemoryId: input.logicalMemoryId,
      remoteReplicaId: input.remoteReplicaId,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      purpose: "decrypt"
    });
    const decrypted = await decryptOwnerPrivateEncryptedFieldWithClient(
      client,
      provider,
      {
        ownerPrincipalId: input.ownerPrincipalId,
        sourceTable: input.sourceTable,
        sourceId: input.sourceId,
        sourceColumn: input.sourceColumn
      }
    );
    if (!decrypted) {
      throw new SharedMemoryConflictError(input.requiredMessage);
    }
    return decrypted.plaintext;
  };

  const RAW_REASONING_LABEL_PATTERN =
    /reasoning[_/ -]?raw|raw[_/ -]?reasoning|raw[_/ -]?content|reasoningTextDelta|ReasoningTextDelta|reasoning[_/ -]?text[_/ -]?delta|ReasoningRawContent|ReasoningRawContentDelta/i;
  const REASONING_LABEL_PATTERN = /reasoning|thought/i;
  const SYSTEM_LABEL_PATTERN =
    /system|developer|instruction|prompt|hidden[_ -]?reasoning|chain[_ -]?of[_ -]?thought/i;

  const uniqueOrderedUuids = (values: Iterable<string>): string[] => {
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      if (!seen.has(value)) {
        seen.add(value);
        ordered.push(value);
      }
    }
    return ordered;
  };

  const strictAuthoritativeSourceItem = (input: {
    representation: SharedMemoryRepresentation;
    logicalMemoryId: string;
    sourceRevision: number;
    itemType: SharedMemorySourceItemType;
    sourceId: string;
    occurredAt: string | null;
    content: Record<string, unknown>;
  }): SharedMemoryRedactedSourceItemDto => {
    const sourceItem: SharedMemorySourceItemInput = {
      itemType: input.itemType,
      schemaVersion: 1,
      sourceId: input.sourceId,
      sourceLogicalMemoryId: input.logicalMemoryId,
      sourceRevision: input.sourceRevision,
      occurredAt: input.occurredAt,
      content: input.content
    };
    const redacted = redactEligibleSharedMemorySourceItem({
      representation: input.representation,
      logicalMemoryId: input.logicalMemoryId,
      sourceRevision: input.sourceRevision,
      item: sourceItem
    });
    if (
      crossIdentitySyncDigest(redacted.content) !==
      crossIdentitySyncDigest(input.content)
    ) {
      throw new SharedMemorySourceItemRejectedError("credential_item");
    }
    return redacted;
  };

  const classifyMemoryEventItemType = (input: {
    actor: string;
    kind: string;
  }): SharedMemorySourceItemType => {
    const actor = input.actor.toLowerCase();
    const kind = input.kind.toLowerCase();
    if (SYSTEM_LABEL_PATTERN.test(actor) || SYSTEM_LABEL_PATTERN.test(kind)) {
      throw new SharedMemorySourceItemRejectedError("system_instruction");
    }
    if (RAW_REASONING_LABEL_PATTERN.test(kind)) {
      throw new SharedMemorySourceItemRejectedError("hidden_reasoning");
    }
    if (REASONING_LABEL_PATTERN.test(kind)) {
      return "thought";
    }
    if (
      kind === "tool_call" ||
      (actor === "tool" && !/result|output/.test(kind))
    ) {
      return "tool_call";
    }
    if (
      kind === "tool_result" ||
      (actor === "tool" && /result|output/.test(kind))
    ) {
      return "tool_result";
    }
    if (actor === "user" || kind === "user_message") {
      return "user_message";
    }
    if (
      actor === "assistant" ||
      actor === "agent" ||
      actor === "subagent" ||
      /agent_message|assistant_message|final_message|subagent_message/.test(
        kind
      )
    ) {
      return "assistant_message";
    }
    throw new SharedMemorySourceItemRejectedError("unknown_item_type");
  };

  const buildMemoryEventSourceItem = (input: {
    logicalMemoryId: string;
    sourceRevision: number;
    contributor: ReturnType<typeof buildCapturedSessionSyncContributor>;
  }): SharedMemoryRedactedSourceItemDto => {
    const itemType = classifyMemoryEventItemType({
      actor: input.contributor.actor,
      kind: input.contributor.kind
    });
    const textContent =
      input.contributor.content.trim().length > 0
        ? input.contributor.content
        : (input.contributor.rawText ?? "");
    if (itemType === "tool_call" || itemType === "tool_result") {
      if (!input.contributor.toolName) {
        throw new SharedMemorySourceItemRejectedError(
          "unsupported_protocol_item"
        );
      }
      return strictAuthoritativeSourceItem({
        representation: "memory_events",
        logicalMemoryId: input.logicalMemoryId,
        sourceRevision: input.sourceRevision,
        itemType,
        sourceId: input.contributor.originItemId,
        occurredAt: input.contributor.sourceEventTime,
        content: {
          toolName: input.contributor.toolName,
          toolCallId: input.contributor.toolCallId,
          payload: isPlainObject(input.contributor.rawJson)
            ? input.contributor.rawJson
            : { text: textContent }
        }
      });
    }
    return strictAuthoritativeSourceItem({
      representation: "memory_events",
      logicalMemoryId: input.logicalMemoryId,
      sourceRevision: input.sourceRevision,
      itemType,
      sourceId: input.contributor.originItemId,
      occurredAt: input.contributor.sourceEventTime,
      content: { text: textContent }
    });
  };

  const authoritativeSourceBinding = (input: {
    representation: SharedMemoryRepresentation;
    sourceRevision: number;
    ownerPolicy: SharedMemoryPolicyRecord;
    teamPolicy: SharedMemoryPolicyRecord;
    workspacePolicy: SharedMemoryPolicyRecord;
    representationPolicyRevision: number;
    contentPolicyVersion: number;
  }): SharedMemorySourceBindingDto => ({
    sourceRevision: input.sourceRevision,
    sourceHash: "",
    representationPolicyRevision: input.representationPolicyRevision,
    representationPolicyHash: representationPolicyHashForPreview({
      representation: input.representation,
      revision: input.representationPolicyRevision,
      owner: input.ownerPolicy,
      team: input.teamPolicy,
      workspace: input.workspacePolicy
    }),
    contentPolicyVersion: input.contentPolicyVersion,
    contentPolicyHash: contentPolicyHashForPreview({
      representation: input.representation,
      version: input.contentPolicyVersion
    }),
    classifierVersion: SHARED_MEMORY_CLASSIFIER_VERSION,
    classifierHash: classifierHashForPreview({
      representation: input.representation,
      version: SHARED_MEMORY_CLASSIFIER_VERSION
    })
  });

  const canonicalStructuredLcmSummary = (
    value: unknown
  ): {
    schema_version: typeof LCM_SUMMARY_SCHEMA_VERSION;
    title: string;
    summary_text: string;
  } => {
    if (
      !isPlainObject(value) ||
      !exactObjectKeys(value, ["schema_version", "title", "summary_text"]) ||
      value.schema_version !== LCM_SUMMARY_SCHEMA_VERSION ||
      !requiredString(value.title) ||
      !requiredString(value.summary_text)
    ) {
      throw new SharedMemoryConflictError(
        "LCM summary must use the exact semantic summary schema"
      );
    }
    return {
      schema_version: LCM_SUMMARY_SCHEMA_VERSION,
      title: value.title,
      summary_text: value.summary_text
    };
  };

  type ParsedSemanticItemManifestEntry = {
    sourceIds: string[];
    actor: string;
    kind: string;
    toolName: string | null;
    toolCallId: string | null;
    sourceSequence: number | null;
    sourceEventTime: string | null;
    offsetStart: number;
    offsetEnd: number;
  };

  const parseSemanticItemManifest = (
    value: unknown
  ): ParsedSemanticItemManifestEntry[] => {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.length > MAX_SOURCE_ITEMS
    ) {
      throw new SharedMemoryConflictError(
        "Memory Event semantic item manifest is missing or invalid"
      );
    }
    return value.map((entryValue) => {
      if (!isPlainObject(entryValue)) {
        throw new SharedMemoryConflictError(
          "Memory Event semantic item manifest entry is invalid"
        );
      }
      const entry = entryValue as Record<string, unknown>;
      const offsetStart = entry.offsetStart;
      const offsetEnd = entry.offsetEnd;
      const sourceSequence = entry.sourceSequence;
      const sourceEventTime = entry.sourceEventTime;
      if (
        !Array.isArray(entry.sourceIds) ||
        entry.sourceIds.length === 0 ||
        entry.sourceIds.some(
          (sourceId) =>
            !requiredString(sourceId) || !UUID_PATTERN.test(sourceId)
        ) ||
        !requiredString(entry.actor) ||
        !requiredString(entry.kind) ||
        !Number.isSafeInteger(offsetStart) ||
        !Number.isSafeInteger(offsetEnd) ||
        Number(offsetStart) < 0 ||
        Number(offsetEnd) <= Number(offsetStart) ||
        (entry.toolName !== undefined &&
          entry.toolName !== null &&
          !requiredString(entry.toolName)) ||
        (entry.toolCallId !== undefined &&
          entry.toolCallId !== null &&
          !requiredString(entry.toolCallId)) ||
        (sourceSequence !== undefined &&
          sourceSequence !== null &&
          (!Number.isSafeInteger(sourceSequence) ||
            Number(sourceSequence) < 0)) ||
        (sourceEventTime !== undefined &&
          sourceEventTime !== null &&
          (typeof sourceEventTime !== "string" ||
            Number.isNaN(Date.parse(sourceEventTime))))
      ) {
        throw new SharedMemoryConflictError(
          "Memory Event semantic item manifest entry is invalid"
        );
      }
      return {
        sourceIds: uniqueOrderedUuids(entry.sourceIds as string[]),
        actor: entry.actor,
        kind: entry.kind,
        toolName: nullableString(entry.toolName),
        toolCallId: nullableString(entry.toolCallId),
        sourceSequence: nullableNumber(sourceSequence),
        sourceEventTime: nullableString(sourceEventTime),
        offsetStart: Number(offsetStart),
        offsetEnd: Number(offsetEnd)
      };
    });
  };

  const sourceMaterialHashes = (input: {
    representation: SharedMemoryRepresentation;
    logicalMemoryId: string;
    sourceRevision: number;
    sourceCursor: number;
    manifest: SharedSourceArtifactV1["manifest"];
    items: SharedMemoryRedactedSourceItemDto[];
  }): Pick<
    AuthoritativeSourceMaterial,
    "manifestHash" | "redactedContentHash" | "sourceHash"
  > => {
    const manifestHash = crossIdentitySyncDigest(input.manifest);
    const redactedContentHash = crossIdentitySyncDigest(input.items);
    const sourceHash = crossIdentitySyncDigest({
      kind: "shared_memory_authoritative_source",
      representation: input.representation,
      logicalMemoryId: input.logicalMemoryId,
      sourceRevision: input.sourceRevision,
      sourceCursor: input.sourceCursor,
      manifestHash,
      redactedContentHash
    });
    return {
      manifestHash,
      redactedContentHash,
      sourceHash
    };
  };

  const buildArtifactBody = (input: {
    context: AuthoritativeSyncContext;
    representation: SharedMemoryRepresentation;
    sourceHash: string;
    manifestHash: string;
    redactedContentHash: string;
    items: SharedMemoryRedactedSourceItemDto[];
    manifest: SharedSourceArtifactV1["manifest"];
  }): SharedSourceArtifactV1 => {
    const artifactBase: Omit<SharedSourceArtifactV1, "artifactHash"> = {
      schemaVersion: SHARED_SOURCE_ARTIFACT_SCHEMA_VERSION,
      artifactId: "",
      logicalMemoryId: input.context.logicalMemoryId,
      representation: input.representation,
      binding: {
        sourceRevision: input.context.sourceRevision,
        sourceHash: input.sourceHash,
        representationPolicyRevision:
          input.context.representationPolicyRevision,
        representationPolicyHash: input.context.representationPolicyHash,
        contentPolicyVersion: input.context.contentPolicyVersion,
        contentPolicyHash: input.context.contentPolicyHash,
        classifierVersion: input.context.classifierVersion,
        classifierHash: input.context.classifierHash
      },
      sync: {
        relationshipId: input.context.syncRelationshipId,
        localReplicaId: input.context.localReplicaId,
        remoteReplicaId: input.context.remoteSyncReplicaId,
        localSessionId: input.context.localSessionId,
        sourceCursor: input.context.sourceCursor,
        packageSequence: input.context.packageSequence,
        sourceDeploymentIdentityId: input.context.sourceDeploymentIdentityId,
        remoteUserIdentityId: input.context.remoteUserIdentityId,
        deviceCredentialId: input.context.deviceCredentialId,
        deviceProvenanceHash: input.context.deviceProvenanceHash
      },
      policies: {
        sourceOwnerPolicyId: input.context.sourceOwnerPolicyId,
        sourceOwnerPolicyVersion: input.context.sourceOwnerPolicyVersion,
        teamPolicyId: input.context.teamPolicyId,
        teamPolicyVersion: input.context.teamPolicyVersion,
        workspacePolicyId: input.context.workspacePolicyId,
        workspacePolicyVersion: input.context.workspacePolicyVersion
      },
      manifest: input.manifest,
      manifestHash: input.manifestHash,
      items: input.items,
      redactedContentHash: input.redactedContentHash
    };
    const artifactHash = sharedSourceArtifactHash(artifactBase);
    return {
      ...artifactBase,
      artifactId: sharedSourceArtifactId(artifactHash),
      artifactHash
    };
  };

  const buildPreviewBody = (input: {
    artifact: SharedSourceArtifactV1;
  }): SharedSourcePreviewV1 => {
    const previewBase: Omit<SharedSourcePreviewV1, "previewHash"> = {
      schemaVersion: SHARED_SOURCE_PREVIEW_SCHEMA_VERSION,
      previewId: "",
      artifactId: input.artifact.artifactId,
      logicalMemoryId: input.artifact.logicalMemoryId,
      representation: input.artifact.representation,
      binding: input.artifact.binding,
      items: input.artifact.items,
      redactedContentHash: input.artifact.redactedContentHash
    };
    const previewHash = sharedSourcePreviewHash(previewBase);
    return {
      ...previewBase,
      previewId: sharedSourcePreviewId(previewHash),
      previewHash
    };
  };

  const validateLoadedSourceItems = (
    representation: SharedMemoryRepresentation,
    logicalMemoryId: string,
    sourceRevision: number,
    items: unknown
  ): SharedMemoryRedactedSourceItemDto[] => {
    if (
      !Array.isArray(items) ||
      items.length === 0 ||
      items.length > MAX_SOURCE_ITEMS
    ) {
      throw new SharedMemoryConflictError(
        "Persisted Shared Memory source items are invalid"
      );
    }
    return items.map((item) =>
      redactEligibleSharedMemorySourceItem({
        representation,
        logicalMemoryId,
        sourceRevision,
        item: item as SharedMemorySourceItemInput
      })
    );
  };

  const loadAuthoritativeMappedEvents = async (
    client: pg.PoolClient,
    actor: ActorContext,
    provider: EnvelopeEncryptionProvider,
    input: {
      logicalMemoryId: string;
      ownerUserId: string;
      ownerPrincipalId: string;
      localSessionId: string;
      syncRelationshipId: string;
      sourceRevision: number;
    }
  ): Promise<Map<string, LoadedMappedEvent>> => {
    const mappedResult = await client.query<Row>(
      `select sem.origin_event_id,sem.revision_hash as mapped_revision_hash,
              sem.source_cursor,me.*
         from sync_event_mappings sem
         join memory_events me
           on me.id=sem.local_memory_event_id
          and me.owner_user_id=$2
          and me.visibility='personal'
          and me.session_id=$3
          and me.invalidated_at is null
          and me.personal_deleted_at is null
        where sem.sync_relationship_id=$1
          and sem.active=true
          and sem.invalidated_at is null
          and sem.local_memory_event_id is not null
          and sem.source_cursor <= $4
        order by sem.source_cursor asc,me.captured_at asc,me.id asc`,
      [
        input.syncRelationshipId,
        input.ownerUserId,
        input.localSessionId,
        input.sourceRevision
      ]
    );
    if (mappedResult.rows.length === 0) {
      throw new SharedMemoryConflictError(
        "No authoritative synced Memory Events are available for this Shared Memory source"
      );
    }
    const eventIds = mappedResult.rows.map((row) => stringValue(row.id));
    const sourceResult = await client.query<Row>(
      `select mes.memory_event_id,mes.source_order,ci.*
         from memory_event_sources mes
         join conversation_items ci
           on ci.id=mes.conversation_item_id
        where mes.memory_event_id = any($1::uuid[])
        order by mes.memory_event_id asc,
                 mes.source_order asc,
                 ci.source_sequence asc nulls last,
                 ci.id asc`,
      [eventIds]
    );
    const sourcesByEventId = new Map<string, Row[]>();
    for (const row of sourceResult.rows) {
      const eventId = stringValue(row.memory_event_id);
      const group = sourcesByEventId.get(eventId);
      if (group) {
        group.push(row);
      } else {
        sourcesByEventId.set(eventId, [row]);
      }
    }

    const hydratedSourceCache = new Map<
      string,
      {
        contributor: ReturnType<typeof buildCapturedSessionSyncContributor>;
        rawJson: unknown;
        rawText: string | null;
        metadata: Record<string, unknown>;
        transportChunkText: string | null;
      }
    >();
    const sourceOriginId = (sourceRow: Row): string => {
      const originItemId = nullableString(sourceRow.external_item_id);
      if (!originItemId) {
        throw new SharedMemoryConflictError(
          "Synchronized Conversation Item origin identity is missing"
        );
      }
      return originItemId;
    };
    const hydrateCanonicalSource = async (sourceRow: Row) => {
      const localSourceId = stringValue(sourceRow.id);
      const originItemId = sourceOriginId(sourceRow);
      const cached = hydratedSourceCache.get(localSourceId);
      if (cached) return cached;
      const rawJson = await hydrateOwnerPrivateEncryptedField(
        client,
        actor,
        provider,
        {
          ownerPrincipalId: input.ownerPrincipalId,
          sourceTable: "conversation_items",
          sourceId: localSourceId,
          sourceColumn: "raw_json",
          fallback: sourceRow.raw_json,
          requiredMessage:
            "Conversation Item raw JSON decryption is required for Shared Memory"
        }
      );
      const rawTextValue = await hydrateOwnerPrivateEncryptedField(
        client,
        actor,
        provider,
        {
          ownerPrincipalId: input.ownerPrincipalId,
          sourceTable: "conversation_items",
          sourceId: localSourceId,
          sourceColumn: "raw_text",
          fallback: sourceRow.raw_text,
          requiredMessage:
            "Conversation Item raw text decryption is required for Shared Memory"
        }
      );
      const metadataValue = await hydrateOwnerPrivateEncryptedField(
        client,
        actor,
        provider,
        {
          ownerPrincipalId: input.ownerPrincipalId,
          sourceTable: "conversation_items",
          sourceId: localSourceId,
          sourceColumn: "metadata",
          fallback: sourceRow.metadata,
          requiredMessage:
            "Conversation Item metadata decryption is required for Shared Memory"
        }
      );
      const transportChunkValue = await hydrateOwnerPrivateEncryptedField(
        client,
        actor,
        provider,
        {
          ownerPrincipalId: input.ownerPrincipalId,
          sourceTable: "conversation_items",
          sourceId: localSourceId,
          sourceColumn: "transport_chunk_text",
          fallback: sourceRow.transport_chunk_text,
          requiredMessage:
            "Conversation Item transport chunk decryption is required for Shared Memory"
        }
      );
      const rawText = nullableString(rawTextValue);
      const metadata = canonicalSyncJsonObject(
        metadataValue ?? {},
        "conversation item metadata"
      );
      const transportChunkText = nullableString(transportChunkValue);
      const actorValue = metadata.actor ?? sourceRow.source_event_type;
      const kindValue =
        sourceRow.source_event_type ?? sourceRow.source_record_type;
      const contributor = buildCapturedSessionSyncContributor({
        originItemId,
        actor: typeof actorValue === "string" ? actorValue : "unknown",
        kind: typeof kindValue === "string" ? kindValue : "unknown",
        content:
          rawText && rawText.length > 0
            ? rawText
            : capturedSessionSyncContentFromUnknown(rawJson),
        toolName:
          typeof metadata.toolName === "string"
            ? String(metadata.toolName)
            : null,
        toolCallId:
          typeof metadata.toolCallId === "string"
            ? String(metadata.toolCallId)
            : null,
        sourceEventTime: nullableIso(sourceRow.event_time),
        sourceSequence: nullableNumber(sourceRow.source_sequence),
        sourceKind: stringValue(sourceRow.source_kind),
        sourceAdapterVersion: stringValue(sourceRow.source_adapter_version),
        sourceTransport: stringValue(sourceRow.source_transport),
        sourceRecordType: stringValue(sourceRow.source_record_type),
        sourceEventType: nullableString(sourceRow.source_event_type),
        rawJson,
        rawText,
        metadata,
        logicalSourceId: nullableString(sourceRow.logical_source_id),
        transportChunkIndex: numberValue(sourceRow.transport_chunk_index),
        transportChunkCount: numberValue(sourceRow.transport_chunk_count),
        transportChunkText,
        transportChunkEncoding: nullableString(
          sourceRow.transport_chunk_encoding
        ),
        projectionStatus: stringValue(sourceRow.projection_status) as
          | "pending"
          | "held"
          | "projected"
          | "error"
          | "raw_only",
        projectionVersion: nullableString(sourceRow.projection_version),
        projectionPolicyRevision: nullableNumber(
          sourceRow.projection_policy_revision
        ),
        memoryExcludedAt: nullableIso(sourceRow.memory_excluded_at),
        memoryExclusionReason: nullableString(sourceRow.memory_exclusion_reason)
      });
      const hydrated = {
        contributor,
        rawJson,
        rawText,
        metadata,
        transportChunkText
      };
      hydratedSourceCache.set(localSourceId, hydrated);
      return hydrated;
    };
    const loaded = new Map<string, LoadedMappedEvent>();
    for (const row of mappedResult.rows) {
      const eventId = stringValue(row.id);
      const sourceRows = sourcesByEventId.get(eventId) ?? [];
      if (sourceRows.length === 0) {
        throw new SharedMemoryConflictError(
          "Memory Event source contributors are incomplete"
        );
      }
      for (const sourceRow of sourceRows) {
        if (
          stringValue(sourceRow.owner_user_id) !== input.ownerUserId ||
          stringValue(sourceRow.visibility) !== "personal" ||
          stringValue(sourceRow.session_id) !== input.localSessionId ||
          sourceRow.personal_deleted_at !== null ||
          nullableString(sourceRow.projection_status) !== "projected"
        ) {
          throw new SharedMemoryConflictError(
            "Memory Event contributor provenance is invalid"
          );
        }
      }
      const payloadValue = await hydrateOwnerPrivateEncryptedField(
        client,
        actor,
        provider,
        {
          ownerPrincipalId: input.ownerPrincipalId,
          sourceTable: "memory_events",
          sourceId: eventId,
          sourceColumn: "payload",
          fallback: row.payload,
          requiredMessage:
            "Memory Event payload decryption is required for Shared Memory"
        }
      );
      if (!isPlainObject(payloadValue) || !requiredString(payloadValue.actor)) {
        throw new SharedMemoryConflictError(
          "Memory Event payload is not canonical Shared Memory source content"
        );
      }
      const eventContent =
        typeof payloadValue.content === "string" ? payloadValue.content : "";
      const payloadMetadata =
        payloadValue.metadata === undefined
          ? {}
          : canonicalSyncJsonObject(
              payloadValue.metadata,
              "memory event metadata"
            );
      const manifest = parseSemanticItemManifest(
        payloadMetadata.semanticItemManifest
      );
      const sourceRowsById = new Map<string, Row>();
      for (const sourceRow of sourceRows) {
        const originItemId = sourceOriginId(sourceRow);
        if (sourceRowsById.has(originItemId)) {
          throw new SharedMemoryConflictError(
            "Synchronized Conversation Item origin identity is duplicated"
          );
        }
        sourceRowsById.set(originItemId, sourceRow);
      }
      const manifestSourceIds = manifest.flatMap((entry) => entry.sourceIds);
      const uniqueManifestSourceIds = new Set(manifestSourceIds);
      if (
        uniqueManifestSourceIds.size !== manifestSourceIds.length ||
        uniqueManifestSourceIds.size !== sourceRowsById.size ||
        [...uniqueManifestSourceIds].some(
          (sourceId) => !sourceRowsById.has(sourceId)
        )
      ) {
        throw new SharedMemoryConflictError(
          "Memory Event semantic manifest does not exactly cover persisted source rows"
        );
      }
      const canonicalContributors = [];
      for (const sourceRow of sourceRows) {
        canonicalContributors.push(
          (await hydrateCanonicalSource(sourceRow)).contributor
        );
      }
      const canonicalEvent = buildCapturedSessionSyncEvent({
        originEventId: stringValue(row.origin_event_id),
        eventType: stringValue(row.event_type),
        actor: payloadValue.actor,
        content: eventContent,
        metadata: payloadMetadata,
        includeInEmbedding: Boolean(row.include_in_embedding),
        includeInLcm: Boolean(row.include_in_lcm),
        projectionPolicyKey: nullableString(row.projection_policy_key),
        projectionPolicyRevision: nullableNumber(
          row.projection_policy_revision
        ),
        tokenCount: nullableNumber(row.token_count),
        sealReason: nullableString(row.seal_reason),
        capturedAt: iso(row.captured_at),
        sourceEventTime: nullableIso(row.source_event_time),
        sourceSequence: nullableNumber(row.source_sequence),
        contributors: canonicalContributors
      });
      if (
        canonicalEvent.revisionHash !== stringValue(row.mapped_revision_hash)
      ) {
        throw new SharedMemoryConflictError(
          "Memory Event sync revision hash does not match active mapping"
        );
      }
      const contributorItems: SharedMemoryRedactedSourceItemDto[] = [];
      const manifestEntries: SharedSourceArtifactV1["manifest"] = [];
      for (const entry of manifest) {
        const sourceRowsForEntry = entry.sourceIds.map((sourceId) => {
          const sourceRow = sourceRowsById.get(sourceId);
          if (!sourceRow) {
            throw new SharedMemoryConflictError(
              "Memory Event semantic manifest does not match persisted source rows"
            );
          }
          return sourceRow;
        });
        if (
          sourceRowsForEntry.some(
            (sourceRow) => sourceRow.memory_excluded_at !== null
          )
        ) {
          continue;
        }
        const primary = sourceRowsForEntry[0]!;
        const primaryId = sourceOriginId(primary);
        const hydrated = await hydrateCanonicalSource(primary);
        const slicedContent =
          entry.offsetEnd <= eventContent.length
            ? eventContent.slice(entry.offsetStart, entry.offsetEnd)
            : "";
        const contributor = buildCapturedSessionSyncContributor({
          originItemId: primaryId,
          actor: entry.actor,
          kind: entry.kind,
          content:
            slicedContent.trim().length > 0
              ? slicedContent
              : (hydrated.rawText ?? ""),
          toolName: entry.toolName,
          toolCallId: entry.toolCallId,
          sourceEventTime:
            entry.sourceEventTime ?? nullableIso(primary.event_time),
          sourceSequence:
            entry.sourceSequence ?? nullableNumber(primary.source_sequence),
          sourceKind: stringValue(primary.source_kind),
          sourceAdapterVersion: stringValue(primary.source_adapter_version),
          sourceTransport: stringValue(primary.source_transport),
          sourceRecordType: stringValue(primary.source_record_type),
          sourceEventType: nullableString(primary.source_event_type),
          rawJson: hydrated.rawJson,
          rawText: hydrated.rawText,
          metadata: hydrated.metadata,
          logicalSourceId: nullableString(primary.logical_source_id),
          transportChunkIndex: numberValue(primary.transport_chunk_index),
          transportChunkCount: numberValue(primary.transport_chunk_count),
          transportChunkText: hydrated.transportChunkText,
          transportChunkEncoding: nullableString(
            primary.transport_chunk_encoding
          ),
          projectionStatus: stringValue(primary.projection_status) as
            | "pending"
            | "held"
            | "projected"
            | "error"
            | "raw_only",
          projectionVersion: nullableString(primary.projection_version),
          projectionPolicyRevision: nullableNumber(
            primary.projection_policy_revision
          ),
          memoryExcludedAt: nullableIso(primary.memory_excluded_at),
          memoryExclusionReason: nullableString(primary.memory_exclusion_reason)
        });
        let item: SharedMemoryRedactedSourceItemDto;
        try {
          item = buildMemoryEventSourceItem({
            logicalMemoryId: input.logicalMemoryId,
            sourceRevision: input.sourceRevision,
            contributor
          });
        } catch (error) {
          if (
            error instanceof SharedMemorySourceItemRejectedError &&
            [
              "hidden_reasoning",
              "system_instruction",
              "credential_item",
              "unsupported_protocol_item"
            ].includes(error.reasonCode)
          ) {
            continue;
          }
          throw error;
        }
        contributorItems.push(item);
        manifestEntries.push({
          sourceId: primaryId,
          sourceTable: "conversation_items",
          itemType: item.itemType,
          sourceCursor: numberValue(row.source_cursor),
          revisionHash: contributor.revisionHash,
          occurredAt: contributor.sourceEventTime,
          sourceEventId: eventId,
          sourceNodeId: null
        });
      }
      loaded.set(eventId, {
        eventId,
        sourceCursor: numberValue(row.source_cursor),
        mappedRevisionHash: stringValue(row.mapped_revision_hash),
        occurredAt:
          canonicalEvent.sourceEventTime ??
          nullableIso(row.source_event_time) ??
          iso(row.captured_at),
        contributorItems,
        manifestEntries
      });
    }
    return loaded;
  };

  const loadAuthoritativeLeafNodes = async (
    client: pg.PoolClient,
    actor: ActorContext,
    provider: EnvelopeEncryptionProvider,
    input: {
      logicalMemoryId: string;
      ownerUserId: string;
      ownerPrincipalId: string;
      localSessionId: string;
      sourceRevision: number;
      mappedEvents: Map<string, LoadedMappedEvent>;
    }
  ): Promise<Map<string, LoadedNodeItem>> => {
    const result = await client.query<Row>(
      `select mn.*,mns.memory_event_id,mns.source_order
         from memory_nodes mn
         join memory_node_sources mns on mns.memory_node_id=mn.id
        where mn.owner_user_id=$1
          and mn.session_id=$2
          and mn.visibility='personal'
          and mn.kind='leaf'
          and mn.invalidated_at is null
          and mn.personal_deleted_at is null
        order by mn.created_at asc,mn.id asc,mns.source_order asc`,
      [input.ownerUserId, input.localSessionId]
    );
    const rowsByNodeId = new Map<string, Row[]>();
    for (const row of result.rows) {
      const nodeId = stringValue(row.id);
      const group = rowsByNodeId.get(nodeId);
      if (group) {
        group.push(row);
      } else {
        rowsByNodeId.set(nodeId, [row]);
      }
    }
    const loaded = new Map<string, LoadedNodeItem>();
    for (const [nodeId, rows] of rowsByNodeId) {
      const sourceEventIds = uniqueOrderedUuids(
        rows.map((row) => stringValue(row.memory_event_id))
      );
      const matchingCount = sourceEventIds.filter((eventId) =>
        input.mappedEvents.has(eventId)
      ).length;
      if (matchingCount === 0) {
        continue;
      }
      if (matchingCount !== sourceEventIds.length) {
        throw new SharedMemoryConflictError(
          "LCM leaf mixes shared and unshared source provenance"
        );
      }
      const row = rows[0]!;
      if (!requiredString(row.summary_model)) {
        throw new SharedMemoryConflictError(
          "LCM placeholder leaves cannot be shared authoritatively"
        );
      }
      if (
        !requiredString(row.summary_prompt_version) ||
        !requiredString(row.lcm_algorithm_version)
      ) {
        throw new SharedMemoryConflictError(
          "LCM leaf summary provenance is incomplete"
        );
      }
      if (
        nullableString(row.summary_structured_schema_version) !==
        LCM_SUMMARY_SCHEMA_VERSION
      ) {
        throw new SharedMemoryConflictError(
          "Legacy or incomplete LCM leaves cannot be shared authoritatively"
        );
      }
      const summaryTextValue = await hydrateOwnerPrivateEncryptedField(
        client,
        actor,
        provider,
        {
          ownerPrincipalId: input.ownerPrincipalId,
          sourceTable: "memory_nodes",
          sourceId: nodeId,
          sourceColumn: "summary_text",
          fallback: row.summary_text,
          requiredMessage:
            "LCM leaf summary decryption is required for Shared Memory"
        }
      );
      const structuredValue = await hydrateOwnerPrivateEncryptedField(
        client,
        actor,
        provider,
        {
          ownerPrincipalId: input.ownerPrincipalId,
          sourceTable: "memory_nodes",
          sourceId: nodeId,
          sourceColumn: "summary_structured_json",
          fallback: row.summary_structured_json,
          requiredMessage:
            "LCM structured summary decryption is required for Shared Memory"
        }
      );
      const structured = canonicalStructuredLcmSummary(structuredValue);
      const summaryText = requireHydratedValue(
        nullableString(summaryTextValue),
        "LCM leaf summary text is required"
      );
      if (summaryText !== structured.summary_text) {
        throw new SharedMemoryConflictError(
          "LCM leaf summary text drift prevents authoritative sharing"
        );
      }
      const eventRevisionHashes = sourceEventIds.map(
        (eventId) => input.mappedEvents.get(eventId)!.mappedRevisionHash
      );
      const item = strictAuthoritativeSourceItem({
        representation: "lcm_leaves",
        logicalMemoryId: input.logicalMemoryId,
        sourceRevision: input.sourceRevision,
        itemType: "lcm_leaf",
        sourceId: nodeId,
        occurredAt: nullableIso(row.updated_at) ?? iso(row.created_at),
        content: {
          title: structured.title,
          summaryText: structured.summary_text,
          sourceIds: sourceEventIds
        }
      });
      const sourceCursor = Math.max(
        ...sourceEventIds.map(
          (eventId) => input.mappedEvents.get(eventId)!.sourceCursor
        )
      );
      const nodeRevisionHash = crossIdentitySyncDigest({
        kind: "shared_memory_lcm_leaf",
        nodeId,
        summaryModel: stringValue(row.summary_model),
        summaryPromptVersion: stringValue(row.summary_prompt_version),
        summaryStructuredSchemaVersion: nullableString(
          row.summary_structured_schema_version
        ),
        lcmAlgorithmVersion: stringValue(row.lcm_algorithm_version),
        structured,
        sourceEventIds,
        eventRevisionHashes
      });
      loaded.set(nodeId, {
        item,
        manifestEntry: {
          sourceId: nodeId,
          sourceTable: "memory_nodes",
          itemType: "lcm_leaf",
          sourceCursor,
          revisionHash: nodeRevisionHash,
          occurredAt: item.occurredAt,
          sourceEventId: null,
          sourceNodeId: nodeId
        },
        sourceEventIds,
        nodeRevisionHash
      });
    }
    return loaded;
  };

  const loadAuthoritativeRollupNodes = async (
    client: pg.PoolClient,
    actor: ActorContext,
    provider: EnvelopeEncryptionProvider,
    input: {
      logicalMemoryId: string;
      ownerUserId: string;
      ownerPrincipalId: string;
      localSessionId: string;
      sourceRevision: number;
      mappedEvents: Map<string, LoadedMappedEvent>;
      leaves: Map<string, LoadedNodeItem>;
    }
  ): Promise<LoadedNodeItem[]> => {
    const rowResult = await client.query<Row>(
      `select *
         from memory_nodes
        where owner_user_id=$1
          and session_id=$2
          and visibility='personal'
          and kind='rollup'
          and invalidated_at is null
          and personal_deleted_at is null
        order by depth asc,created_at asc,id asc`,
      [input.ownerUserId, input.localSessionId]
    );
    const childResult = await client.query<Row>(
      `select child.parent_memory_node_id,child.child_memory_node_id,child.child_order
         from memory_node_children child
         join memory_nodes parent on parent.id=child.parent_memory_node_id
         join memory_nodes descendant on descendant.id=child.child_memory_node_id
        where parent.owner_user_id=$1
          and parent.session_id=$2
          and descendant.owner_user_id=$1
          and descendant.session_id=$2
        order by parent_memory_node_id asc,child_order asc`,
      [input.ownerUserId, input.localSessionId]
    );
    const sourceResult = await client.query<Row>(
      `select source.memory_node_id,source.memory_event_id,source.source_order
         from memory_node_sources source
         join memory_nodes node on node.id=source.memory_node_id
        where node.owner_user_id=$1
          and node.session_id=$2
        order by memory_node_id asc,source_order asc`,
      [input.ownerUserId, input.localSessionId]
    );
    const rowsById = new Map(
      rowResult.rows.map((row) => [stringValue(row.id), row])
    );
    const childIdsByParent = new Map<string, string[]>();
    for (const row of childResult.rows) {
      const parentId = stringValue(row.parent_memory_node_id);
      const group = childIdsByParent.get(parentId);
      if (group) {
        group.push(stringValue(row.child_memory_node_id));
      } else {
        childIdsByParent.set(parentId, [stringValue(row.child_memory_node_id)]);
      }
    }
    const sourceIdsByNode = new Map<string, string[]>();
    for (const row of sourceResult.rows) {
      const nodeId = stringValue(row.memory_node_id);
      const group = sourceIdsByNode.get(nodeId);
      if (group) {
        group.push(stringValue(row.memory_event_id));
      } else {
        sourceIdsByNode.set(nodeId, [stringValue(row.memory_event_id)]);
      }
    }
    const cache = new Map<string, LoadedNodeItem | null>();
    const visiting = new Set<string>();
    const loadNode = async (nodeId: string): Promise<LoadedNodeItem | null> => {
      if (cache.has(nodeId)) {
        return cache.get(nodeId)!;
      }
      if (visiting.has(nodeId)) {
        throw new SharedMemoryConflictError(
          "LCM rollup provenance contains a cycle"
        );
      }
      const row = rowsById.get(nodeId);
      if (!row) {
        cache.set(nodeId, null);
        return null;
      }
      const directSourceEventIds = uniqueOrderedUuids(
        sourceIdsByNode.get(nodeId) ?? []
      );
      const relevantDirectSourceIds = directSourceEventIds.filter((eventId) =>
        input.mappedEvents.has(eventId)
      );
      if (
        relevantDirectSourceIds.length > 0 &&
        relevantDirectSourceIds.length !== directSourceEventIds.length
      ) {
        throw new SharedMemoryConflictError(
          "LCM rollup mixes shared and unshared source provenance"
        );
      }
      const childIds = childIdsByParent.get(nodeId) ?? [];
      visiting.add(nodeId);
      const childNodes: LoadedNodeItem[] = [];
      for (const childId of childIds) {
        const leaf = input.leaves.get(childId);
        if (leaf) {
          childNodes.push(leaf);
          continue;
        }
        const rollupChild = await loadNode(childId);
        if (rollupChild) {
          childNodes.push(rollupChild);
          continue;
        }
        if (relevantDirectSourceIds.length > 0 || childNodes.length > 0) {
          visiting.delete(nodeId);
          throw new SharedMemoryConflictError(
            "LCM rollup mixes cross-session or incomplete child provenance"
          );
        }
      }
      visiting.delete(nodeId);
      if (relevantDirectSourceIds.length === 0 && childNodes.length === 0) {
        cache.set(nodeId, null);
        return null;
      }
      if (!requiredString(row.summary_model)) {
        throw new SharedMemoryConflictError(
          "LCM placeholder rollups cannot be shared authoritatively"
        );
      }
      if (
        !requiredString(row.summary_prompt_version) ||
        !requiredString(row.lcm_algorithm_version)
      ) {
        throw new SharedMemoryConflictError(
          "LCM rollup summary provenance is incomplete"
        );
      }
      if (
        nullableString(row.summary_structured_schema_version) !==
        LCM_SUMMARY_SCHEMA_VERSION
      ) {
        throw new SharedMemoryConflictError(
          "Legacy or incomplete LCM rollups cannot be shared authoritatively"
        );
      }
      if (childNodes.length === 0) {
        throw new SharedMemoryConflictError(
          "LCM rollups must have complete summarized children"
        );
      }
      const descendantSourceEventIds = uniqueOrderedUuids(
        childNodes.flatMap((child) => child.sourceEventIds)
      );
      if (
        crossIdentitySyncDigest(directSourceEventIds) !==
        crossIdentitySyncDigest(descendantSourceEventIds)
      ) {
        throw new SharedMemoryConflictError(
          "LCM rollup direct source provenance does not match its child tree"
        );
      }
      const summaryTextValue = await hydrateOwnerPrivateEncryptedField(
        client,
        actor,
        provider,
        {
          ownerPrincipalId: input.ownerPrincipalId,
          sourceTable: "memory_nodes",
          sourceId: nodeId,
          sourceColumn: "summary_text",
          fallback: row.summary_text,
          requiredMessage:
            "LCM rollup summary decryption is required for Shared Memory"
        }
      );
      const structuredValue = await hydrateOwnerPrivateEncryptedField(
        client,
        actor,
        provider,
        {
          ownerPrincipalId: input.ownerPrincipalId,
          sourceTable: "memory_nodes",
          sourceId: nodeId,
          sourceColumn: "summary_structured_json",
          fallback: row.summary_structured_json,
          requiredMessage:
            "LCM structured rollup decryption is required for Shared Memory"
        }
      );
      const structured = canonicalStructuredLcmSummary(structuredValue);
      const summaryText = requireHydratedValue(
        nullableString(summaryTextValue),
        "LCM rollup summary text is required"
      );
      if (summaryText !== structured.summary_text) {
        throw new SharedMemoryConflictError(
          "LCM rollup summary text drift prevents authoritative sharing"
        );
      }
      const item = strictAuthoritativeSourceItem({
        representation: "lcm_rollups",
        logicalMemoryId: input.logicalMemoryId,
        sourceRevision: input.sourceRevision,
        itemType: "lcm_rollup",
        sourceId: nodeId,
        occurredAt: nullableIso(row.updated_at) ?? iso(row.created_at),
        content: {
          title: structured.title,
          summaryText: structured.summary_text,
          sourceIds: descendantSourceEventIds
        }
      });
      const sourceCursor = Math.max(
        ...descendantSourceEventIds.map(
          (eventId) => input.mappedEvents.get(eventId)!.sourceCursor
        )
      );
      const nodeRevisionHash = crossIdentitySyncDigest({
        kind: "shared_memory_lcm_rollup",
        nodeId,
        summaryModel: stringValue(row.summary_model),
        summaryPromptVersion: stringValue(row.summary_prompt_version),
        summaryStructuredSchemaVersion: nullableString(
          row.summary_structured_schema_version
        ),
        lcmAlgorithmVersion: stringValue(row.lcm_algorithm_version),
        structured,
        childNodeIds: childIds,
        childRevisionHashes: childNodes.map((child) => child.nodeRevisionHash),
        sourceEventIds: descendantSourceEventIds
      });
      const loadedNode = {
        item,
        manifestEntry: {
          sourceId: nodeId,
          sourceTable: "memory_nodes",
          itemType: "lcm_rollup",
          sourceCursor,
          revisionHash: nodeRevisionHash,
          occurredAt: item.occurredAt,
          sourceEventId: null,
          sourceNodeId: nodeId
        },
        sourceEventIds: descendantSourceEventIds,
        nodeRevisionHash
      } satisfies LoadedNodeItem;
      cache.set(nodeId, loadedNode);
      return loadedNode;
    };
    const loaded: LoadedNodeItem[] = [];
    for (const row of rowResult.rows) {
      const node = await loadNode(stringValue(row.id));
      if (node) {
        loaded.push(node);
      }
    }
    return loaded;
  };

  const loadAuthoritativeSourceMaterial = async (
    client: pg.PoolClient,
    actor: ActorContext,
    provider: EnvelopeEncryptionProvider,
    input: {
      representation: SharedMemoryRepresentation;
      logicalMemoryId: string;
      ownerUserId: string;
      ownerPrincipalId: string;
      localSessionId: string;
      syncRelationshipId: string;
      sourceRevision: number;
    }
  ): Promise<AuthoritativeSourceMaterial> => {
    const mappedEvents = await loadAuthoritativeMappedEvents(
      client,
      actor,
      provider,
      {
        logicalMemoryId: input.logicalMemoryId,
        ownerUserId: input.ownerUserId,
        ownerPrincipalId: input.ownerPrincipalId,
        localSessionId: input.localSessionId,
        syncRelationshipId: input.syncRelationshipId,
        sourceRevision: input.sourceRevision
      }
    );
    const orderedMappedEvents = [...mappedEvents.values()].sort(
      compareSharedMemoryEventOrder
    );
    let items: SharedMemoryRedactedSourceItemDto[];
    let manifest: SharedSourceArtifactV1["manifest"];
    if (input.representation === "memory_events") {
      items = orderedMappedEvents.flatMap((event) => event.contributorItems);
      manifest = orderedMappedEvents.flatMap((event) => event.manifestEntries);
    } else {
      const leaves = await loadAuthoritativeLeafNodes(client, actor, provider, {
        logicalMemoryId: input.logicalMemoryId,
        ownerUserId: input.ownerUserId,
        ownerPrincipalId: input.ownerPrincipalId,
        localSessionId: input.localSessionId,
        sourceRevision: input.sourceRevision,
        mappedEvents
      });
      if (input.representation === "lcm_leaves") {
        const orderedLeaves = [...leaves.values()].sort(
          (left, right) =>
            left.manifestEntry.sourceCursor -
              right.manifestEntry.sourceCursor ||
            left.item.sourceId.localeCompare(right.item.sourceId)
        );
        items = orderedLeaves.map((leaf) => leaf.item);
        manifest = orderedLeaves.map((leaf) => leaf.manifestEntry);
        const coveredEventIds = new Set(
          orderedLeaves.flatMap((leaf) => leaf.sourceEventIds)
        );
        if (
          orderedLeaves.length > 0 &&
          (coveredEventIds.size !== orderedMappedEvents.length ||
            orderedMappedEvents.some(
              (event) => !coveredEventIds.has(event.eventId)
            ))
        ) {
          throw new SharedMemoryConflictError(
            "LCM leaves do not cover the authoritative source revision"
          );
        }
      } else {
        const rollups = await loadAuthoritativeRollupNodes(
          client,
          actor,
          provider,
          {
            logicalMemoryId: input.logicalMemoryId,
            ownerUserId: input.ownerUserId,
            ownerPrincipalId: input.ownerPrincipalId,
            localSessionId: input.localSessionId,
            sourceRevision: input.sourceRevision,
            mappedEvents,
            leaves
          }
        );
        const orderedRollups = [...rollups].sort(
          (left, right) =>
            left.manifestEntry.sourceCursor -
              right.manifestEntry.sourceCursor ||
            left.item.sourceId.localeCompare(right.item.sourceId)
        );
        items = orderedRollups.map((rollup) => rollup.item);
        manifest = orderedRollups.map((rollup) => rollup.manifestEntry);
        const coveredEventIds = new Set(
          orderedRollups.flatMap((rollup) => rollup.sourceEventIds)
        );
        if (
          orderedRollups.length > 0 &&
          (coveredEventIds.size !== orderedMappedEvents.length ||
            orderedMappedEvents.some(
              (event) => !coveredEventIds.has(event.eventId)
            ))
        ) {
          throw new SharedMemoryConflictError(
            "LCM rollups do not cover the authoritative source revision"
          );
        }
      }
    }
    if (
      items.length === 0 ||
      manifest.length === 0 ||
      items.length > MAX_SOURCE_ITEMS
    ) {
      throw new SharedMemoryConflictError(
        "Authoritative Shared Memory source material is empty or invalid"
      );
    }
    const hashes = sourceMaterialHashes({
      representation: input.representation,
      logicalMemoryId: input.logicalMemoryId,
      sourceRevision: input.sourceRevision,
      sourceCursor: input.sourceRevision,
      manifest,
      items
    });
    return {
      items,
      manifest,
      ...hashes,
      mappedEvents
    };
  };

  const persistArtifactAndPreview = async (
    client: pg.PoolClient,
    actor: ActorContext,
    input: {
      context: AuthoritativeSyncContext;
      artifactBody: SharedSourceArtifactV1;
      previewBody: SharedSourcePreviewV1;
    }
  ): Promise<PersistedPreviewLoadResult> => {
    const artifactResult = await client.query<Row>(
      `insert into shared_source_artifacts (
         id,logical_memory_id,remote_replica_id,sync_relationship_id,
         owner_user_id,owner_principal_id,team_id,team_workspace_id,
         representation,artifact_schema_version,source_revision,source_cursor,
         package_sequence,source_hash,manifest_hash,artifact_hash,
         redacted_content_hash,source_owner_policy_id,
         source_owner_policy_version,team_policy_id,team_policy_version,
         workspace_policy_id,workspace_policy_version,
         representation_policy_revision,representation_policy_hash,
         content_policy_version,content_policy_hash,
         classifier_version,classifier_hash,
         source_deployment_identity_id,remote_user_identity_id,
         device_credential_id,device_provenance_hash
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
         $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33
       )
       on conflict (artifact_hash) do update
         set invalidated_at=null,invalidation_reason=null
       returning *`,
      [
        input.artifactBody.artifactId,
        input.context.logicalMemoryId,
        input.context.remoteReplicaId,
        input.context.syncRelationshipId,
        input.context.ownerUserId,
        input.context.ownerPrincipalId,
        input.context.teamId,
        input.context.teamWorkspaceId,
        input.artifactBody.representation,
        input.artifactBody.schemaVersion,
        input.context.sourceRevision,
        input.context.sourceCursor,
        input.context.packageSequence,
        input.artifactBody.binding.sourceHash,
        input.artifactBody.manifestHash,
        input.artifactBody.artifactHash,
        input.artifactBody.redactedContentHash,
        input.context.sourceOwnerPolicyId,
        input.context.sourceOwnerPolicyVersion,
        input.context.teamPolicyId,
        input.context.teamPolicyVersion,
        input.context.workspacePolicyId,
        input.context.workspacePolicyVersion,
        input.context.representationPolicyRevision,
        input.context.representationPolicyHash,
        input.context.contentPolicyVersion,
        input.context.contentPolicyHash,
        input.context.classifierVersion,
        input.context.classifierHash,
        input.context.sourceDeploymentIdentityId,
        input.context.remoteUserIdentityId,
        input.context.deviceCredentialId,
        input.context.deviceProvenanceHash
      ]
    );
    const artifactRow = artifactResult.rows[0]!;
    const provider = await resolveOwnerPrivateReplicaEncryptionProvider({
      ownerUserId: input.context.ownerUserId,
      ownerPrincipalId: input.context.ownerPrincipalId,
      logicalMemoryId: input.context.logicalMemoryId,
      remoteReplicaId: input.context.remoteReplicaId,
      teamId: input.context.teamId,
      teamWorkspaceId: input.context.teamWorkspaceId,
      purpose: "encrypt"
    });
    await upsertEncryptedFieldPayloadWithClient(client, actor, provider, {
      sourceTable: "shared_source_artifacts",
      sourceId: input.artifactBody.artifactId,
      sourceColumn: "artifact",
      plaintext: input.artifactBody,
      visibility: "owner_private_replica",
      ownerPrincipalId: input.context.ownerPrincipalId,
      rowFamily: "shared_source_artifact",
      scope: {
        tenantId: input.context.ownerUserId,
        objectClass: "shared_source_artifact"
      },
      aad: {
        logicalMemoryId: input.context.logicalMemoryId,
        remoteReplicaId: input.context.remoteReplicaId,
        teamId: input.context.teamId,
        teamWorkspaceId: input.context.teamWorkspaceId,
        representation: input.artifactBody.representation,
        artifactHash: input.artifactBody.artifactHash,
        sourceRevision: input.context.sourceRevision,
        syncRelationshipId: input.context.syncRelationshipId,
        sourceDeploymentIdentityId: input.context.sourceDeploymentIdentityId,
        remoteUserIdentityId: input.context.remoteUserIdentityId,
        deviceCredentialId: input.context.deviceCredentialId,
        deviceProvenanceHash: input.context.deviceProvenanceHash
      }
    });
    const previewResult = await client.query<Row>(
      `insert into shared_source_previews (
         id,source_artifact_id,logical_memory_id,remote_replica_id,
         owner_user_id,owner_principal_id,team_id,team_workspace_id,
         representation,preview_schema_version,preview_revision,
         preview_hash,source_revision,source_hash,redacted_content_hash
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
       )
       on conflict (preview_hash) do update
         set invalidated_at=null,invalidation_reason=null
       returning *`,
      [
        input.previewBody.previewId,
        input.artifactBody.artifactId,
        input.context.logicalMemoryId,
        input.context.remoteReplicaId,
        input.context.ownerUserId,
        input.context.ownerPrincipalId,
        input.context.teamId,
        input.context.teamWorkspaceId,
        input.previewBody.representation,
        input.previewBody.schemaVersion,
        1,
        input.previewBody.previewHash,
        input.context.sourceRevision,
        input.previewBody.binding.sourceHash,
        input.previewBody.redactedContentHash
      ]
    );
    await upsertEncryptedFieldPayloadWithClient(client, actor, provider, {
      sourceTable: "shared_source_previews",
      sourceId: input.previewBody.previewId,
      sourceColumn: "preview",
      plaintext: input.previewBody,
      visibility: "owner_private_replica",
      ownerPrincipalId: input.context.ownerPrincipalId,
      rowFamily: "shared_source_preview",
      scope: {
        tenantId: input.context.ownerUserId,
        objectClass: "shared_source_preview"
      },
      aad: {
        logicalMemoryId: input.context.logicalMemoryId,
        remoteReplicaId: input.context.remoteReplicaId,
        teamId: input.context.teamId,
        teamWorkspaceId: input.context.teamWorkspaceId,
        representation: input.previewBody.representation,
        artifactId: input.previewBody.artifactId,
        previewHash: input.previewBody.previewHash,
        sourceRevision: input.context.sourceRevision
      }
    });
    return {
      artifact: mapArtifact(artifactRow),
      preview: mapPersistedPreview(
        previewResult.rows[0]!,
        mapArtifact(artifactRow),
        input.previewBody
      ),
      artifactBody: input.artifactBody,
      previewBody: input.previewBody
    };
  };

  const loadPersistedPreviewByReference = async (
    client: pg.PoolClient,
    input: {
      preview: SharedSourcePreviewReference;
      requiredMessage: string;
    }
  ): Promise<PersistedPreviewLoadResult> => {
    const result = await client.query<Row>(
      `select
          sp.id as preview_id,
          sp.source_artifact_id as preview_source_artifact_id,
          sp.logical_memory_id as preview_logical_memory_id,
          sp.remote_replica_id as preview_remote_replica_id,
          sp.owner_user_id as preview_owner_user_id,
          sp.owner_principal_id as preview_owner_principal_id,
          sp.team_id as preview_team_id,
          sp.team_workspace_id as preview_team_workspace_id,
          sp.representation as preview_representation,
          sp.preview_schema_version,
          sp.preview_revision,
          sp.preview_hash,
          sp.source_revision as preview_source_revision,
          sp.source_hash as preview_source_hash,
          sp.redacted_content_hash as preview_redacted_content_hash,
          sp.created_at as preview_created_at,
          sa.id as artifact_id,
          sa.logical_memory_id as artifact_logical_memory_id,
          sa.remote_replica_id as artifact_remote_replica_id,
          sa.sync_relationship_id,
          sa.owner_user_id as artifact_owner_user_id,
          sa.owner_principal_id as artifact_owner_principal_id,
          sa.team_id as artifact_team_id,
          sa.team_workspace_id as artifact_team_workspace_id,
          sa.representation as artifact_representation,
          sa.source_revision as artifact_source_revision,
          sa.source_cursor,
          sa.package_sequence,
          sa.source_hash as artifact_source_hash,
          sa.manifest_hash,
          sa.artifact_hash,
          sa.redacted_content_hash as artifact_redacted_content_hash,
          sa.source_owner_policy_id,
          sa.source_owner_policy_version,
          sa.team_policy_id,
          sa.team_policy_version,
          sa.workspace_policy_id,
          sa.workspace_policy_version,
          sa.representation_policy_revision,
          sa.representation_policy_hash,
          sa.content_policy_version,
          sa.content_policy_hash,
          sa.classifier_version,
          sa.classifier_hash,
          sa.source_deployment_identity_id,
          sa.remote_user_identity_id,
          sa.device_credential_id,
          sa.device_provenance_hash,
          sa.created_at as artifact_created_at
         from shared_source_previews sp
         join shared_source_artifacts sa on sa.id=sp.source_artifact_id
        where sp.id=$1 and sp.preview_hash=$2
          and sp.invalidated_at is null
          and sa.invalidated_at is null
        limit 1`,
      [input.preview.previewId, input.preview.previewHash]
    );
    const row = result.rows[0];
    if (!row) {
      throw new SharedMemoryConflictError(input.requiredMessage);
    }
    const artifactRow: Row = {
      id: row.artifact_id,
      logical_memory_id: row.artifact_logical_memory_id,
      remote_replica_id: row.artifact_remote_replica_id,
      sync_relationship_id: row.sync_relationship_id,
      owner_user_id: row.artifact_owner_user_id,
      owner_principal_id: row.artifact_owner_principal_id,
      team_id: row.artifact_team_id,
      team_workspace_id: row.artifact_team_workspace_id,
      representation: row.artifact_representation,
      source_revision: row.artifact_source_revision,
      source_cursor: row.source_cursor,
      package_sequence: row.package_sequence,
      source_hash: row.artifact_source_hash,
      manifest_hash: row.manifest_hash,
      artifact_hash: row.artifact_hash,
      redacted_content_hash: row.artifact_redacted_content_hash,
      source_owner_policy_id: row.source_owner_policy_id,
      source_owner_policy_version: row.source_owner_policy_version,
      team_policy_id: row.team_policy_id,
      team_policy_version: row.team_policy_version,
      workspace_policy_id: row.workspace_policy_id,
      workspace_policy_version: row.workspace_policy_version,
      representation_policy_revision: row.representation_policy_revision,
      representation_policy_hash: row.representation_policy_hash,
      content_policy_version: row.content_policy_version,
      content_policy_hash: row.content_policy_hash,
      classifier_version: row.classifier_version,
      classifier_hash: row.classifier_hash,
      source_deployment_identity_id: row.source_deployment_identity_id,
      remote_user_identity_id: row.remote_user_identity_id,
      device_credential_id: row.device_credential_id,
      device_provenance_hash: row.device_provenance_hash,
      created_at: row.artifact_created_at
    };
    const artifact = mapArtifact(artifactRow);
    const ownerUserId = artifact.ownerUserId;
    if (!ownerUserId) {
      throw new SharedMemoryConflictError(
        "Persisted Shared Memory source owner binding is missing"
      );
    }
    const artifactPlain = await decryptPersistedOwnerPrivatePayload(client, {
      sourceTable: "shared_source_artifacts",
      sourceId: artifact.artifactId,
      sourceColumn: "artifact",
      ownerUserId,
      ownerPrincipalId: artifact.ownerPrincipalId,
      logicalMemoryId: artifact.logicalMemoryId,
      remoteReplicaId: artifact.remoteReplicaId,
      teamId: artifact.teamId,
      teamWorkspaceId: artifact.teamWorkspaceId,
      requiredMessage: "Shared Memory source artifact decryption is required"
    });
    const previewPlain = await decryptPersistedOwnerPrivatePayload(client, {
      sourceTable: "shared_source_previews",
      sourceId: input.preview.previewId,
      sourceColumn: "preview",
      ownerUserId,
      ownerPrincipalId: artifact.ownerPrincipalId,
      logicalMemoryId: artifact.logicalMemoryId,
      remoteReplicaId: artifact.remoteReplicaId,
      teamId: artifact.teamId,
      teamWorkspaceId: artifact.teamWorkspaceId,
      requiredMessage: "Shared Memory source preview decryption is required"
    });
    if (!isPlainObject(artifactPlain) || !isPlainObject(previewPlain)) {
      throw new SharedMemoryConflictError(
        "Persisted Shared Memory source payload is invalid"
      );
    }
    const artifactBody = artifactPlain as unknown as SharedSourceArtifactV1;
    const previewBody = previewPlain as unknown as SharedSourcePreviewV1;
    const validatedArtifactItems = validateLoadedSourceItems(
      artifact.representation,
      artifact.logicalMemoryId,
      artifact.sourceRevision,
      artifactBody.items
    );
    const validatedPreviewItems = validateLoadedSourceItems(
      artifact.representation,
      artifact.logicalMemoryId,
      artifact.sourceRevision,
      previewBody.items
    );
    const manifestHash = crossIdentitySyncDigest(artifactBody.manifest);
    const artifactHash = sharedSourceArtifactHash({
      ...artifactBody,
      items: validatedArtifactItems
    });
    const previewHash = sharedSourcePreviewHash({
      ...previewBody,
      items: validatedPreviewItems
    });
    if (
      artifactBody.schemaVersion !== SHARED_SOURCE_ARTIFACT_SCHEMA_VERSION ||
      previewBody.schemaVersion !== SHARED_SOURCE_PREVIEW_SCHEMA_VERSION ||
      artifactBody.artifactId !== artifact.artifactId ||
      artifactBody.artifactHash !== artifact.artifactHash ||
      artifactHash !== artifact.artifactHash ||
      sharedSourceArtifactId(artifactHash) !== artifact.artifactId ||
      artifactBody.logicalMemoryId !== artifact.logicalMemoryId ||
      artifactBody.representation !== artifact.representation ||
      artifactBody.binding.sourceHash !== artifact.sourceHash ||
      artifactBody.binding.sourceRevision !== artifact.sourceRevision ||
      artifactBody.manifestHash !== artifact.manifestHash ||
      manifestHash !== artifact.manifestHash ||
      artifactBody.redactedContentHash !== artifact.redactedContentHash ||
      crossIdentitySyncDigest(validatedArtifactItems) !==
        artifact.redactedContentHash ||
      artifactBody.sync.relationshipId !== artifact.syncRelationshipId ||
      artifactBody.sync.localReplicaId !== artifact.remoteReplicaId ||
      artifactBody.sync.sourceDeploymentIdentityId !==
        artifact.sourceDeploymentIdentityId ||
      artifactBody.sync.remoteUserIdentityId !==
        artifact.remoteUserIdentityId ||
      artifactBody.sync.deviceCredentialId !== artifact.deviceCredentialId ||
      artifactBody.sync.deviceProvenanceHash !==
        artifact.deviceProvenanceHash ||
      artifactBody.policies.sourceOwnerPolicyId !==
        artifact.sourceOwnerPolicyId ||
      artifactBody.policies.sourceOwnerPolicyVersion !==
        artifact.sourceOwnerPolicyVersion ||
      artifactBody.policies.teamPolicyId !== artifact.teamPolicyId ||
      artifactBody.policies.teamPolicyVersion !== artifact.teamPolicyVersion ||
      artifactBody.policies.workspacePolicyId !== artifact.workspacePolicyId ||
      artifactBody.policies.workspacePolicyVersion !==
        artifact.workspacePolicyVersion
    ) {
      throw new SharedMemoryConflictError(
        "Persisted Shared Memory source artifact binding mismatch"
      );
    }
    if (
      previewBody.previewId !== input.preview.previewId ||
      previewBody.previewHash !== input.preview.previewHash ||
      previewHash !== input.preview.previewHash ||
      sharedSourcePreviewId(previewHash) !== input.preview.previewId ||
      previewBody.artifactId !== artifact.artifactId ||
      previewBody.logicalMemoryId !== artifact.logicalMemoryId ||
      previewBody.representation !== artifact.representation ||
      previewBody.binding.sourceHash !== artifact.sourceHash ||
      previewBody.binding.sourceRevision !== artifact.sourceRevision ||
      previewBody.redactedContentHash !== artifact.redactedContentHash ||
      crossIdentitySyncDigest(validatedPreviewItems) !==
        artifact.redactedContentHash ||
      crossIdentitySyncDigest(validatedPreviewItems) !==
        crossIdentitySyncDigest(validatedArtifactItems)
    ) {
      throw new SharedMemoryConflictError(
        "Persisted Shared Memory source preview binding mismatch"
      );
    }
    const previewRecord = mapPersistedPreview(
      {
        id: row.preview_id,
        logical_memory_id: row.preview_logical_memory_id,
        remote_replica_id: row.preview_remote_replica_id,
        owner_user_id: row.preview_owner_user_id,
        owner_principal_id: row.preview_owner_principal_id,
        team_id: row.preview_team_id,
        team_workspace_id: row.preview_team_workspace_id,
        representation: row.preview_representation,
        preview_revision: row.preview_revision,
        preview_hash: row.preview_hash,
        source_revision: row.preview_source_revision,
        source_hash: row.preview_source_hash,
        redacted_content_hash: row.preview_redacted_content_hash,
        created_at: row.preview_created_at
      },
      artifact,
      {
        ...previewBody,
        items: validatedPreviewItems
      }
    );
    return {
      artifact,
      preview: previewRecord,
      artifactBody: {
        ...artifactBody,
        items: validatedArtifactItems
      },
      previewBody: {
        ...previewBody,
        items: validatedPreviewItems
      }
    };
  };

  const loadActiveReplicaState = async (
    client: pg.PoolClient,
    input: {
      logicalMemoryId: string;
      remoteReplicaId: string;
      ownerUserId: string;
      ownerPrincipalId: string;
      syncRelationshipId: string;
    }
  ): Promise<{
    localSessionId: string;
    localReplicaId: string;
    remoteSyncReplicaId: string;
    sourceCursor: number;
    packageSequence: number;
    sourceDeploymentIdentityId: string;
    remoteUserIdentityId: string;
    deviceCredentialId: string;
    deviceProvenanceHash: string;
  }> => {
    const result = await client.query<Row>(
      `select lm.local_session_id,
              mr.id as local_replica_id,
              sr.remote_replica_id as remote_sync_replica_id,
              sr.target_processing_cursor,
              sr.package_sequence,
              sr.remote_deployment_identity_id as source_deployment_identity_id,
              sr.remote_user_identity_id,
              sr.device_credential_id,
              credential.credential_key_id,credential.upstream_backend_id,
              credential.device_instance_id,credential.lineage_id,
              credential.credential_version,credential.verifier_kind,
              credential.verifier_hash,credential.public_key_jwk,
              sr.id as sync_relationship_id
         from logical_memories lm
         join memory_replicas mr
           on mr.logical_memory_id=lm.id
          and mr.id=$2
          and mr.owner_user_id=$3
          and mr.owner_principal_id=$4
          and mr.replica_role='target'
          and mr.encryption_scope='owner_private_replica'
          and mr.lifecycle='active'
          and mr.disabled_at is null
         join cross_identity_sync_relationships sr
           on sr.id=$5
          and sr.local_replica_id=mr.id
          and sr.logical_memory_id=lm.id
          and sr.side='target'
          and sr.local_user_id=$3
          and sr.revoked_at is null
          and sr.state in ('processing','partially_available','ready','stale')
         join device_credentials credential
           on credential.id=sr.device_credential_id
          and credential.owner_user_id=$3
          and credential.revoked_at is null
          and (credential.expires_at is null or credential.expires_at > now())
        where lm.id=$1
          and lm.owner_user_id=$3
          and lm.owner_principal_id=$4
        limit 1`,
      [
        input.logicalMemoryId,
        input.remoteReplicaId,
        input.ownerUserId,
        input.ownerPrincipalId,
        input.syncRelationshipId
      ]
    );
    const row = result.rows[0];
    if (!row || !nullableString(row.local_session_id)) {
      throw new SharedMemoryConflictError(
        "Active owner-private sync relationship is required"
      );
    }
    return {
      localSessionId: stringValue(row.local_session_id),
      localReplicaId: stringValue(row.local_replica_id),
      remoteSyncReplicaId: stringValue(row.remote_sync_replica_id),
      sourceCursor: numberValue(row.target_processing_cursor),
      packageSequence: numberValue(row.package_sequence),
      sourceDeploymentIdentityId: stringValue(
        row.source_deployment_identity_id
      ),
      remoteUserIdentityId: stringValue(row.remote_user_identity_id),
      deviceCredentialId: stringValue(row.device_credential_id),
      deviceProvenanceHash: deviceProvenanceHash({
        ...row,
        sync_relationship_id: row.sync_relationship_id
      })
    };
  };

  const loadAuthoritativeSyncContext = async (
    client: pg.PoolClient,
    actor: ActorContext,
    input: {
      logicalMemoryId: string;
      remoteReplicaId: string;
      teamId: string;
      teamWorkspaceId: string;
      representation: SharedMemoryRepresentation;
      allowedRepresentations: SharedMemoryRepresentation[];
      authority?: SharedMemoryAuthorityContext;
      continuousGrantId?: string;
    }
  ): Promise<{
    context: AuthoritativeSyncContext;
    ownerPolicy: SharedMemoryPolicyRecord;
    teamPolicy: SharedMemoryPolicyRecord;
    workspacePolicy: SharedMemoryPolicyRecord;
  }> => {
    if (!delegatedDeviceActionGrant) {
      await client.query("set transaction isolation level repeatable read");
    }
    const owner = await requireSourceOwner(
      client,
      actor,
      input.logicalMemoryId
    );
    if (input.authority) {
      await requireShareAuthority(client, actor, {
        teamId: input.teamId,
        teamWorkspaceId: input.teamWorkspaceId,
        authority: input.authority,
        consume: false,
        delegatedDeviceActionGrant
      });
    } else {
      if (!input.continuousGrantId) {
        throw new SharedMemoryAuthorizationError(
          "Continuous Share Grant authority is required"
        );
      }
      const continuousAuthority = await client.query<{ allowed: boolean }>(
        `select exists (
           select 1
             from team_session_share_grants g
             join source_owner_representation_consents consent
               on consent.id=g.consent_id
              and consent.mode='continuous'
              and consent.state='active'
              and consent.revoked_at is null
              and (consent.expires_at is null or consent.expires_at>now())
            where g.id=$1
              and g.logical_memory_id=$2
              and g.remote_replica_id=$3
              and g.owner_user_id=$4
              and g.owner_principal_id=$5
              and g.team_id=$6
              and g.team_workspace_id=$7
              and g.active_representation=$8
              and g.lifecycle='active'
              and g.revoked_at is null
              and $8=any(consent.allowed_representations)
         ) as allowed`,
        [
          input.continuousGrantId,
          input.logicalMemoryId,
          input.remoteReplicaId,
          actor.userId,
          owner.ownerPrincipalId,
          input.teamId,
          input.teamWorkspaceId,
          input.representation
        ]
      );
      if (continuousAuthority.rows[0]?.allowed !== true) {
        throw new SharedMemoryAuthorizationError(
          "Active continuous consent is required"
        );
      }
    }
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `shared-memory-owner-policy:${input.logicalMemoryId}:${owner.ownerPrincipalId}`
    ]);
    const existingOwnerPolicy = await activePolicy(client, {
      table: "source_owner_representation_policies",
      whereSql: "logical_memory_id=$1 and source_owner_principal_id=$2",
      parameters: [input.logicalMemoryId, owner.ownerPrincipalId]
    });
    const allowedRepresentations = normalizedRepresentations(
      input.allowedRepresentations
    );
    const currentAllowed = existingOwnerPolicy
      ? normalizedRepresentations(
          stringArray(existingOwnerPolicy.allowed_representations)
        )
      : [];
    const policyChanged =
      !existingOwnerPolicy ||
      currentAllowed.length !== allowedRepresentations.length ||
      !isSubset(allowedRepresentations, currentAllowed);
    if (policyChanged && !input.authority) {
      throw new SharedMemoryConflictError(
        "Continuous materialization requires the existing source-owner policy"
      );
    }
    if (policyChanged) {
      const previousVersion = existingOwnerPolicy
        ? numberValue(existingOwnerPolicy.version)
        : 0;
      const policyId = existingOwnerPolicy
        ? stringValue(existingOwnerPolicy.policy_id)
        : randomUUID();
      const version = previousVersion + 1;
      const hash = sharedMemoryPolicyHash({
        scope: "source_owner",
        scopeId: `${input.logicalMemoryId}:${owner.ownerPrincipalId}`,
        policyId,
        version,
        allowedRepresentations
      });
      if (existingOwnerPolicy) {
        await client.query(
          "update source_owner_representation_policies set superseded_at=now() where id=$1",
          [existingOwnerPolicy.id]
        );
      }
      const inserted = await client.query<Row>(
        `insert into source_owner_representation_policies (
           policy_id,logical_memory_id,source_owner_principal_id,version,
           allowed_representations,policy_hash,created_by_user_id,effective_at
         ) values ($1,$2,$3,$4,$5::shared_memory_representation[],$6,$7,now())
         returning *`,
        [
          policyId,
          input.logicalMemoryId,
          owner.ownerPrincipalId,
          version,
          allowedRepresentations,
          hash,
          actor.userId
        ]
      );
      await appendPolicyAudit(client, {
        actorUserId: actor.userId,
        ownerUserId: actor.userId,
        action: existingOwnerPolicy
          ? "shared_memory.source_owner_policy.updated"
          : "shared_memory.source_owner_policy.created",
        targetTable: "source_owner_representation_policies",
        targetId: stringValue(inserted.rows[0]?.id),
        mutationId: input.authority!.referenceId,
        scope: "source_owner",
        logicalMemoryId: input.logicalMemoryId,
        policyId,
        version,
        previousVersion,
        allowedRepresentations
      });
      if (existingOwnerPolicy) {
        await client.query(
          `update source_owner_representation_consents
            set state='paused', paused_at=now(), updated_at=now(),
                state_reason_code='source_owner_policy_changed'
          where logical_memory_id=$1 and source_owner_principal_id=$2 and state='active'`,
          [input.logicalMemoryId, owner.ownerPrincipalId]
        );
        await invalidateAffectedGrants(client, {
          mutationId: input.authority!.referenceId,
          actorUserId: actor.userId,
          whereSql: "g.logical_memory_id=$1 and g.owner_principal_id=$2",
          parameters: [input.logicalMemoryId, owner.ownerPrincipalId],
          reasonCode: "source_owner_policy_changed"
        });
      }
    }
    const policies = await requireCurrentPolicies(client, {
      logicalMemoryId: input.logicalMemoryId,
      ownerPrincipalId: owner.ownerPrincipalId,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId
    });
    if (!policies.intersection.includes(input.representation)) {
      throw new SharedMemoryConflictError(
        "Representation is outside the exact policy intersection"
      );
    }
    const approvedRepresentations = normalizedRepresentations(
      input.allowedRepresentations
    );
    if (
      !approvedRepresentations.includes(input.representation) ||
      !isSubset(approvedRepresentations, policies.intersection)
    ) {
      throw new SharedMemoryConflictError(
        "Preview allowlist is outside the exact policy intersection"
      );
    }
    const ownerPolicy = mapPolicy(policies.owner, "source_owner");
    const teamPolicy = mapPolicy(policies.team, "team");
    const workspacePolicy = mapPolicy(policies.workspace, "workspace");
    const rowResult = await client.query<Row>(
      `select lm.id as logical_memory_id,lm.owner_user_id,lm.owner_principal_id,
              lm.local_session_id,lm.latest_source_revision,
              mr.id as remote_replica_id,mr.latest_revision,
              mr.representation_policy_revision as replica_representation_policy_revision,
              mr.content_policy_version as replica_content_policy_version,
              sr.id as sync_relationship_id,sr.local_replica_id,
              sr.remote_replica_id as remote_sync_replica_id,
              sr.remote_deployment_identity_id as source_deployment_identity_id,
              sr.remote_user_identity_id,sr.device_credential_id,
              sr.source_cursor,sr.target_processing_cursor,sr.package_sequence,
              credential.credential_key_id,credential.upstream_backend_id,
              credential.device_instance_id,credential.lineage_id,
              credential.credential_version,credential.verifier_kind,
              credential.verifier_hash,credential.public_key_jwk
         from logical_memories lm
         join memory_replicas mr
           on mr.logical_memory_id=lm.id
          and mr.id=$2
          and mr.owner_user_id=$3
          and mr.owner_principal_id=lm.owner_principal_id
          and mr.replica_role='target'
          and mr.encryption_scope='owner_private_replica'
          and mr.lifecycle='active'
          and mr.disabled_at is null
         join cross_identity_sync_relationships sr
           on sr.local_replica_id=mr.id
          and sr.logical_memory_id=lm.id
          and sr.side='target'
          and sr.local_user_id=$3
          and sr.revoked_at is null
          and sr.state in ('processing','partially_available','ready','stale')
         join device_credentials credential
           on credential.id=sr.device_credential_id
          and credential.owner_user_id=$3
          and credential.revoked_at is null
          and (credential.expires_at is null or credential.expires_at > now())
        where lm.id=$1
          and lm.owner_user_id=$3
          and lm.owner_principal_id=$4
        for update of lm,mr,sr,credential`,
      [
        input.logicalMemoryId,
        input.remoteReplicaId,
        actor.userId,
        owner.ownerPrincipalId
      ]
    );
    const row = rowResult.rows[0];
    if (!row) {
      throw new SharedMemoryAuthorizationError(
        "Owner-private sync relationship is not active for this Memory source"
      );
    }
    const sourceRevision = numberValue(row.target_processing_cursor);
    if (
      sourceRevision !== numberValue(row.latest_source_revision) ||
      sourceRevision !== numberValue(row.latest_revision) ||
      nullableString(row.local_session_id) === null
    ) {
      throw new SharedMemoryConflictError(
        "Replica revision drift prevents authoritative source preview generation"
      );
    }
    const representationPolicyRevision =
      nullableNumber(row.replica_representation_policy_revision) ?? 1;
    const contentPolicyVersion =
      nullableNumber(row.replica_content_policy_version) ?? 1;
    const binding = authoritativeSourceBinding({
      representation: input.representation,
      sourceRevision,
      ownerPolicy,
      teamPolicy,
      workspacePolicy,
      representationPolicyRevision,
      contentPolicyVersion
    });
    return {
      context: {
        logicalMemoryId: input.logicalMemoryId,
        remoteReplicaId: stringValue(row.remote_replica_id),
        localSessionId: requireHydratedValue(
          nullableString(row.local_session_id),
          "Target replica session is required"
        ),
        ownerUserId: stringValue(row.owner_user_id),
        ownerPrincipalId: stringValue(row.owner_principal_id),
        teamId: input.teamId,
        teamWorkspaceId: input.teamWorkspaceId,
        syncRelationshipId: stringValue(row.sync_relationship_id),
        localReplicaId: stringValue(row.local_replica_id),
        remoteSyncReplicaId: stringValue(row.remote_sync_replica_id),
        sourceRevision,
        sourceCursor: sourceRevision,
        packageSequence: numberValue(row.package_sequence),
        representationPolicyRevision,
        representationPolicyHash: binding.representationPolicyHash,
        contentPolicyVersion,
        contentPolicyHash: binding.contentPolicyHash,
        classifierVersion: binding.classifierVersion,
        classifierHash: binding.classifierHash,
        sourceOwnerPolicyId: ownerPolicy.policyId,
        sourceOwnerPolicyVersion: ownerPolicy.version,
        teamPolicyId: teamPolicy.policyId,
        teamPolicyVersion: teamPolicy.version,
        workspacePolicyId: workspacePolicy.policyId,
        workspacePolicyVersion: workspacePolicy.version,
        sourceDeploymentIdentityId: stringValue(
          row.source_deployment_identity_id
        ),
        remoteUserIdentityId: stringValue(row.remote_user_identity_id),
        deviceCredentialId: stringValue(row.device_credential_id),
        deviceProvenanceHash: deviceProvenanceHash({
          ...row,
          sync_relationship_id: row.sync_relationship_id
        })
      },
      ownerPolicy,
      teamPolicy,
      workspacePolicy
    };
  };

  const createAuthoritativeSourcePreview = async (
    actor: ActorContext,
    input: Omit<
      Parameters<SharedMemoryRepository["createAuthoritativeSourcePreview"]>[1],
      "authority"
    > & { authority?: SharedMemoryAuthorityContext },
    continuousGrantId?: string
  ): Promise<SharedMemoryPersistedPreviewRecord> => {
    assertUuid(input.logicalMemoryId, "logicalMemoryId");
    assertUuid(input.remoteReplicaId, "remoteReplicaId");
    assertUuid(input.teamId, "teamId");
    assertUuid(input.teamWorkspaceId, "teamWorkspaceId");
    return withTransaction(pool, async (client) => {
      const { context } = await loadAuthoritativeSyncContext(client, actor, {
        ...input,
        continuousGrantId
      });
      const provider = await resolveOwnerPrivateReplicaEncryptionProvider({
        ownerUserId: context.ownerUserId,
        ownerPrincipalId: context.ownerPrincipalId,
        logicalMemoryId: context.logicalMemoryId,
        remoteReplicaId: context.remoteReplicaId,
        teamId: context.teamId,
        teamWorkspaceId: context.teamWorkspaceId,
        purpose: "decrypt"
      });
      const material = await loadAuthoritativeSourceMaterial(
        client,
        actor,
        provider,
        {
          representation: input.representation,
          logicalMemoryId: context.logicalMemoryId,
          ownerUserId: context.ownerUserId,
          ownerPrincipalId: context.ownerPrincipalId,
          localSessionId: context.localSessionId,
          syncRelationshipId: context.syncRelationshipId,
          sourceRevision: context.sourceRevision
        }
      );
      const artifactBody = buildArtifactBody({
        context,
        representation: input.representation,
        sourceHash: material.sourceHash,
        manifestHash: material.manifestHash,
        redactedContentHash: material.redactedContentHash,
        items: material.items,
        manifest: material.manifest
      });
      const previewBody = buildPreviewBody({ artifact: artifactBody });
      const persisted = await persistArtifactAndPreview(client, actor, {
        context,
        artifactBody,
        previewBody
      });
      return persisted.preview;
    });
  };

  const repository: SharedMemoryRepository = {
    async createAuthoritativeSourcePreview(actor, input) {
      return createAuthoritativeSourcePreview(actor, input);
    },
    async putSourceOwnerPolicy(actor, input) {
      assertUuid(input.mutationId, "mutationId");
      const allowed = normalizedRepresentations(input.allowedRepresentations);
      return withTransaction(pool, async (client) => {
        const owner = await requireSourceOwner(
          client,
          actor,
          input.logicalMemoryId
        );
        const current = await activePolicy(client, {
          table: "source_owner_representation_policies",
          whereSql: "logical_memory_id=$1 and source_owner_principal_id=$2",
          parameters: [input.logicalMemoryId, owner.ownerPrincipalId]
        });
        if (
          numberValue(current?.version ?? 0) !== input.expectedCurrentVersion
        ) {
          throw new SharedMemoryConflictError();
        }
        if (
          current &&
          input.policyId !== undefined &&
          input.policyId !== current.policy_id
        ) {
          throw new SharedMemoryConflictError(
            "Policy lineage cannot be replaced"
          );
        }
        const id =
          input.policyId ??
          (current ? stringValue(current.policy_id) : randomUUID());
        const version = input.expectedCurrentVersion + 1;
        const hash = sharedMemoryPolicyHash({
          scope: "source_owner",
          scopeId: `${input.logicalMemoryId}:${owner.ownerPrincipalId}`,
          policyId: id,
          version,
          allowedRepresentations: allowed
        });
        const existing = await client.query<Row>(
          `select * from source_owner_representation_policies
          where policy_id=$1 and version=$2 limit 1`,
          [id, version]
        );
        if (existing.rows[0]) {
          if (existing.rows[0].policy_hash !== hash) {
            throw new SharedMemoryConflictError("Policy idempotency conflict");
          }
          return mapPolicy(existing.rows[0] as Row, "source_owner");
        }
        if (current) {
          await client.query(
            "update source_owner_representation_policies set superseded_at=now() where id=$1",
            [current.id]
          );
        }
        const inserted = await client.query<Row>(
          `insert into source_owner_representation_policies (
           policy_id,logical_memory_id,source_owner_principal_id,version,
           allowed_representations,policy_hash,created_by_user_id,effective_at
         ) values ($1,$2,$3,$4,$5::shared_memory_representation[],$6,$7,now())
         returning *`,
          [
            id,
            input.logicalMemoryId,
            owner.ownerPrincipalId,
            version,
            allowed,
            hash,
            actor.userId
          ]
        );
        await appendPolicyAudit(client, {
          actorUserId: actor.userId,
          ownerUserId: actor.userId,
          action: "shared_memory.source_owner_policy.updated",
          targetTable: "source_owner_representation_policies",
          targetId: stringValue(inserted.rows[0]?.id),
          mutationId: input.mutationId,
          scope: "source_owner",
          logicalMemoryId: input.logicalMemoryId,
          policyId: id,
          version,
          previousVersion: input.expectedCurrentVersion,
          allowedRepresentations: allowed
        });
        if (current) {
          await client.query(
            `update source_owner_representation_consents
              set state='paused', paused_at=now(), updated_at=now(),
                  state_reason_code='source_owner_policy_changed'
            where logical_memory_id=$1 and source_owner_principal_id=$2 and state='active'`,
            [input.logicalMemoryId, owner.ownerPrincipalId]
          );
          await invalidateAffectedGrants(client, {
            mutationId: input.mutationId,
            actorUserId: actor.userId,
            whereSql: "g.logical_memory_id=$1 and g.owner_principal_id=$2",
            parameters: [input.logicalMemoryId, owner.ownerPrincipalId],
            reasonCode: "source_owner_policy_changed"
          });
        }
        return mapPolicy(inserted.rows[0] as Row, "source_owner");
      });
    },

    async putTeamPolicy(actor, input) {
      assertUuid(input.mutationId, "mutationId");
      const allowed = normalizedRepresentations(input.allowedRepresentations);
      return withTransaction(pool, async (client) => {
        await requireTeamManager(client, actor, input.teamId);
        const current = await activePolicy(client, {
          table: "team_representation_policies",
          whereSql: "team_id=$1",
          parameters: [input.teamId]
        });
        if (
          numberValue(current?.version ?? 0) !== input.expectedCurrentVersion
        ) {
          throw new SharedMemoryConflictError();
        }
        if (
          current &&
          input.policyId !== undefined &&
          input.policyId !== current.policy_id
        ) {
          throw new SharedMemoryConflictError(
            "Policy lineage cannot be replaced"
          );
        }
        if (
          current &&
          !isSubset(allowed, stringArray(current.allowed_representations))
        ) {
          throw new SharedMemoryAuthorizationError(
            "Team policy updates may only reduce the allowlist"
          );
        }
        const id =
          input.policyId ??
          (current ? stringValue(current.policy_id) : randomUUID());
        const version = input.expectedCurrentVersion + 1;
        const hash = sharedMemoryPolicyHash({
          scope: "team",
          scopeId: input.teamId,
          policyId: id,
          version,
          allowedRepresentations: allowed
        });
        const existing = await client.query<Row>(
          "select * from team_representation_policies where policy_id=$1 and version=$2 limit 1",
          [id, version]
        );
        if (existing.rows[0]) {
          if (existing.rows[0].policy_hash !== hash)
            throw new SharedMemoryConflictError("Policy idempotency conflict");
          return mapPolicy(existing.rows[0] as Row, "team");
        }
        if (current)
          await client.query(
            "update team_representation_policies set superseded_at=now() where id=$1",
            [current.id]
          );
        const inserted = await client.query<Row>(
          `insert into team_representation_policies (
           policy_id,team_id,version,allowed_representations,policy_hash,
           created_by_user_id,effective_at
         ) values ($1,$2,$3,$4::shared_memory_representation[],$5,$6,now()) returning *`,
          [id, input.teamId, version, allowed, hash, actor.userId]
        );
        await appendPolicyAudit(client, {
          actorUserId: actor.userId,
          ownerUserId: null,
          action: "team.shared_memory_policy.updated",
          targetTable: "team_representation_policies",
          targetId: stringValue(inserted.rows[0]?.id),
          mutationId: input.mutationId,
          scope: "team",
          teamId: input.teamId,
          policyId: id,
          version,
          previousVersion: input.expectedCurrentVersion,
          allowedRepresentations: allowed
        });
        if (current) {
          await client.query(
            `update source_owner_representation_consents set state='paused',paused_at=now(),
                  updated_at=now(),state_reason_code='team_policy_changed'
            where team_id=$1 and state='active'`,
            [input.teamId]
          );
          await invalidateAffectedGrants(client, {
            mutationId: input.mutationId,
            actorUserId: actor.userId,
            whereSql: "g.team_id=$1",
            parameters: [input.teamId],
            reasonCode: "team_policy_changed"
          });
        }
        return mapPolicy(inserted.rows[0] as Row, "team");
      });
    },

    async putWorkspacePolicy(actor, input) {
      assertUuid(input.mutationId, "mutationId");
      const allowed = normalizedRepresentations(input.allowedRepresentations);
      return withTransaction(pool, async (client) => {
        await requireTeamManager(client, actor, input.teamId);
        await requireWorkspaceAccess(
          client,
          actor,
          input.teamId,
          input.teamWorkspaceId,
          "write"
        );
        const current = await activePolicy(client, {
          table: "workspace_representation_policies",
          whereSql: "team_id=$1 and team_workspace_id=$2",
          parameters: [input.teamId, input.teamWorkspaceId]
        });
        if (numberValue(current?.version ?? 0) !== input.expectedCurrentVersion)
          throw new SharedMemoryConflictError();
        if (
          current &&
          input.policyId !== undefined &&
          input.policyId !== current.policy_id
        ) {
          throw new SharedMemoryConflictError(
            "Policy lineage cannot be replaced"
          );
        }
        if (
          current &&
          !isSubset(allowed, stringArray(current.allowed_representations))
        ) {
          throw new SharedMemoryAuthorizationError(
            "Workspace policy updates may only reduce the allowlist"
          );
        }
        const id =
          input.policyId ??
          (current ? stringValue(current.policy_id) : randomUUID());
        const version = input.expectedCurrentVersion + 1;
        const hash = sharedMemoryPolicyHash({
          scope: "workspace",
          scopeId: `${input.teamId}:${input.teamWorkspaceId}`,
          policyId: id,
          version,
          allowedRepresentations: allowed
        });
        const existing = await client.query<Row>(
          "select * from workspace_representation_policies where policy_id=$1 and version=$2 limit 1",
          [id, version]
        );
        if (existing.rows[0]) {
          if (existing.rows[0].policy_hash !== hash)
            throw new SharedMemoryConflictError("Policy idempotency conflict");
          return mapPolicy(existing.rows[0] as Row, "workspace");
        }
        if (current)
          await client.query(
            "update workspace_representation_policies set superseded_at=now() where id=$1",
            [current.id]
          );
        const inserted = await client.query<Row>(
          `insert into workspace_representation_policies (
           policy_id,team_id,team_workspace_id,version,allowed_representations,
           policy_hash,created_by_user_id,effective_at
         ) values ($1,$2,$3,$4,$5::shared_memory_representation[],$6,$7,now()) returning *`,
          [
            id,
            input.teamId,
            input.teamWorkspaceId,
            version,
            allowed,
            hash,
            actor.userId
          ]
        );
        await appendPolicyAudit(client, {
          actorUserId: actor.userId,
          ownerUserId: null,
          action: "team.workspace.shared_memory_policy.updated",
          targetTable: "workspace_representation_policies",
          targetId: stringValue(inserted.rows[0]?.id),
          mutationId: input.mutationId,
          scope: "workspace",
          teamId: input.teamId,
          teamWorkspaceId: input.teamWorkspaceId,
          policyId: id,
          version,
          previousVersion: input.expectedCurrentVersion,
          allowedRepresentations: allowed
        });
        if (current) {
          await client.query(
            `update source_owner_representation_consents set state='paused',paused_at=now(),
                  updated_at=now(),state_reason_code='workspace_policy_changed'
            where team_id=$1 and team_workspace_id=$2 and state='active'`,
            [input.teamId, input.teamWorkspaceId]
          );
          await invalidateAffectedGrants(client, {
            mutationId: input.mutationId,
            actorUserId: actor.userId,
            whereSql: "g.team_id=$1 and g.team_workspace_id=$2",
            parameters: [input.teamId, input.teamWorkspaceId],
            reasonCode: "workspace_policy_changed"
          });
        }
        return mapPolicy(inserted.rows[0] as Row, "workspace");
      });
    },

    async createSourceOwnerConsent(actor, input) {
      assertUuid(input.consentId, "consentId");
      const allowed = normalizedRepresentations(input.allowedRepresentations);
      if (!allowed.includes(input.selectedRepresentation))
        throw new SharedMemoryConflictError(
          "Selected representation is outside owner consent"
        );
      return withTransaction(pool, async (client) => {
        const loaded = await loadPersistedPreviewByReference(client, {
          preview: input.preview,
          requiredMessage: "Consent preview reference is not active"
        });
        const { preview, artifact, artifactBody } = loaded;
        const logicalMemoryId = preview.logicalMemoryId;
        const teamId = preview.teamId;
        const teamWorkspaceId = preview.teamWorkspaceId;
        const remoteReplicaId = preview.remoteReplicaId;
        const owner = await requireSourceOwner(client, actor, logicalMemoryId);
        if (preview.ownerPrincipalId !== owner.ownerPrincipalId) {
          throw new SharedMemoryAuthorizationError(
            "Only the source owner may consent to this preview"
          );
        }
        await requireShareAuthority(client, actor, {
          teamId,
          teamWorkspaceId,
          authority: input.authority,
          consume: false,
          delegatedDeviceActionGrant
        });
        const replicaState = await loadActiveReplicaState(client, {
          logicalMemoryId,
          remoteReplicaId,
          ownerUserId: actor.userId,
          ownerPrincipalId: owner.ownerPrincipalId,
          syncRelationshipId: artifact.syncRelationshipId
        });
        if (
          replicaState.sourceCursor < preview.sourceRevision ||
          replicaState.localReplicaId !== remoteReplicaId ||
          artifactBody.sync.relationshipId !== artifact.syncRelationshipId ||
          artifactBody.sync.localReplicaId !== remoteReplicaId ||
          artifactBody.sync.remoteReplicaId !==
            replicaState.remoteSyncReplicaId ||
          artifactBody.sync.localSessionId !== replicaState.localSessionId ||
          artifactBody.sync.sourceDeploymentIdentityId !==
            replicaState.sourceDeploymentIdentityId ||
          artifactBody.sync.remoteUserIdentityId !==
            replicaState.remoteUserIdentityId ||
          artifactBody.sync.deviceCredentialId !==
            replicaState.deviceCredentialId ||
          artifactBody.sync.deviceProvenanceHash !==
            replicaState.deviceProvenanceHash ||
          preview.deviceProvenanceHash !== replicaState.deviceProvenanceHash
        ) {
          throw new SharedMemoryAuthorizationError(
            "Owner-private remote replica binding is invalid"
          );
        }
        const policies = await requireCurrentPolicies(client, {
          logicalMemoryId,
          ownerPrincipalId: owner.ownerPrincipalId,
          teamId,
          teamWorkspaceId
        });
        if (
          !policies.intersection.includes(input.selectedRepresentation) ||
          !isSubset(
            allowed,
            stringArray(policies.owner.allowed_representations)
          ) ||
          input.selectedRepresentation !== preview.representation ||
          stringValue(policies.owner.policy_id) !==
            artifact.sourceOwnerPolicyId ||
          numberValue(policies.owner.version) !==
            artifact.sourceOwnerPolicyVersion ||
          stringValue(policies.team.policy_id) !== artifact.teamPolicyId ||
          numberValue(policies.team.version) !== artifact.teamPolicyVersion ||
          stringValue(policies.workspace.policy_id) !==
            artifact.workspacePolicyId ||
          numberValue(policies.workspace.version) !==
            artifact.workspacePolicyVersion ||
          preview.binding.representationPolicyRevision !==
            artifact.representationPolicyRevision ||
          preview.binding.representationPolicyHash !==
            artifact.representationPolicyHash ||
          preview.binding.contentPolicyVersion !==
            artifact.contentPolicyVersion ||
          preview.binding.contentPolicyHash !== artifact.contentPolicyHash ||
          preview.binding.classifierVersion !== artifact.classifierVersion ||
          preview.binding.classifierHash !== artifact.classifierHash
        ) {
          throw new SharedMemoryConflictError(
            "Active representation must be in the exact three-policy intersection"
          );
        }
        const existing = await client.query(
          "select * from source_owner_representation_consents where id=$1 for update",
          [input.consentId]
        );
        if (existing.rows[0]) {
          if (
            !sameConsentCreate(existing.rows[0] as Row, {
              logicalMemoryId,
              remoteReplicaId,
              teamId,
              teamWorkspaceId,
              mode: input.mode,
              allowed,
              selected: input.selectedRepresentation,
              preview: input.preview
            })
          )
            throw new SharedMemoryConflictError("Consent idempotency conflict");
          return mapConsent(existing.rows[0] as Row);
        }
        const inserted = await client.query(
          `insert into source_owner_representation_consents (
           id,preview_id,logical_memory_id,remote_replica_id,source_owner_principal_id,
           team_id,team_workspace_id,source_owner_policy_id,source_owner_policy_version,
           team_policy_id,team_policy_version,workspace_policy_id,workspace_policy_version,
           mode,state,consent_version,allowed_representations,selected_representation,
           preview_revision,preview_hash,source_revision,maximum_authorized_source_revision,
           source_hash,representation_policy_revision,representation_policy_hash,
           content_policy_version,content_policy_hash,classifier_version,classifier_hash,
           redacted_content_hash,activated_at,expires_at
         ) values (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'active',1,
           $15::shared_memory_representation[],$16,$17,$18,$19,$20,$21,$22,$23,
           $24,$25,$26,$27,$28,now(),$29
         ) returning *`,
          [
            input.consentId,
            input.preview.previewId,
            logicalMemoryId,
            remoteReplicaId,
            owner.ownerPrincipalId,
            teamId,
            teamWorkspaceId,
            artifact.sourceOwnerPolicyId,
            artifact.sourceOwnerPolicyVersion,
            artifact.teamPolicyId,
            artifact.teamPolicyVersion,
            artifact.workspacePolicyId,
            artifact.workspacePolicyVersion,
            input.mode,
            allowed,
            input.selectedRepresentation,
            preview.previewRevision,
            input.preview.previewHash,
            preview.sourceRevision,
            input.mode === "snapshot" ? preview.sourceRevision : null,
            preview.sourceHash,
            artifact.representationPolicyRevision,
            artifact.representationPolicyHash,
            artifact.contentPolicyVersion,
            artifact.contentPolicyHash,
            artifact.classifierVersion,
            artifact.classifierHash,
            preview.redactedContentHash,
            input.expiresAt ?? null
          ]
        );
        return mapConsent(inserted.rows[0] as Row);
      });
    },

    async createShareGrant(actor, input) {
      assertUuid(input.mutationId, "mutationId");
      assertUuid(input.logicalGrantId, "logicalGrantId");
      return withTransaction(pool, async (client) => {
        const consentResult = await client.query(
          `select c.*,lm.owner_user_id,lm.local_session_id
           from source_owner_representation_consents c
           join logical_memories lm on lm.id=c.logical_memory_id
          where c.id=$1 and c.state='active' and c.revoked_at is null
            and (c.expires_at is null or c.expires_at>now())
          for update of c`,
          [input.consentId]
        );
        const consent = consentResult.rows[0] as Row | undefined;
        if (!consent || consent.owner_user_id !== actor.userId)
          throw new SharedMemoryAuthorizationError(
            "Only the source owner may create a Share Grant"
          );
        const existing = await client.query(
          "select * from team_session_share_grants where logical_grant_id=$1 for update",
          [input.logicalGrantId]
        );
        if (existing.rows[0]) {
          const row = existing.rows[0] as Row;
          if (
            row.consent_id !== input.consentId ||
            row.owner_user_id !== actor.userId
          )
            throw new SharedMemoryConflictError(
              "Share Grant idempotency conflict"
            );
          await requireRecordedShareAuthority(client, actor, {
            teamId: stringValue(row.team_id),
            teamWorkspaceId: stringValue(row.team_workspace_id),
            authority: input.authority,
            recordedAuthority: stringValue(row.creator_authority),
            delegatedDeviceActionGrant
          });
          return mapGrant(row);
        }
        const destination = await client.query(
          `select id from team_session_share_grants
           where logical_memory_id=$1 and team_workspace_id=$2
           for update`,
          [consent.logical_memory_id, consent.team_workspace_id]
        );
        if (destination.rows[0]) {
          throw new SharedMemoryConflictError(
            "This logical memory already has a Share Grant for the destination Workspace"
          );
        }
        const authority = await requireShareAuthority(client, actor, {
          teamId: stringValue(consent.team_id),
          teamWorkspaceId: stringValue(consent.team_workspace_id),
          authority: input.authority,
          consume: true,
          delegatedDeviceActionGrant
        });
        const policies = await requireCurrentPolicies(client, {
          logicalMemoryId: stringValue(consent.logical_memory_id),
          ownerPrincipalId: stringValue(consent.source_owner_principal_id),
          teamId: stringValue(consent.team_id),
          teamWorkspaceId: stringValue(consent.team_workspace_id)
        });
        const selected = stringValue(
          consent.selected_representation
        ) as SharedMemoryRepresentation;
        if (!policies.intersection.includes(selected))
          throw new SharedMemoryConflictError(
            "Consent is no longer in the exact policy intersection"
          );
        const retentionPolicy = await client.query(
          `select 1 from retention_policies
            where effective_at <= transaction_timestamp()
              and (superseded_at is null
                or superseded_at > transaction_timestamp())
              and (
                (scope = 'workspace' and team_id = $1
                  and team_workspace_id = $2)
                or (scope = 'team' and team_id = $1)
              )
            limit 1
            for share`,
          [consent.team_id, consent.team_workspace_id]
        );
        if (!retentionPolicy.rowCount) {
          throw new SharedMemoryConflictError(
            "A Team or Workspace retention policy is required before sharing"
          );
        }
        let inserted: pg.QueryResult<Row>;
        try {
          inserted = await client.query<Row>(
            `insert into team_session_share_grants (
           logical_grant_id,logical_memory_id,remote_replica_id,owner_user_id,
           owner_principal_id,session_id,team_id,team_workspace_id,consent_id,
           source_owner_policy_id,source_owner_policy_version,team_policy_id,
           team_policy_version,workspace_policy_id,workspace_policy_version,
           owner_allowed_representations,active_representation,
           representation_policy_revision,content_policy_version,classifier_version,
           source_revision,grant_version,lifecycle,creator_authority,granted_by_user_id
         ) values (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
           $16::shared_memory_representation[],$17,$18,$19,$20,$21,1,'active',$22,$4
           ) returning *`,
            [
              input.logicalGrantId,
              consent.logical_memory_id,
              consent.remote_replica_id,
              actor.userId,
              consent.source_owner_principal_id,
              consent.local_session_id,
              consent.team_id,
              consent.team_workspace_id,
              consent.id,
              consent.source_owner_policy_id,
              consent.source_owner_policy_version,
              consent.team_policy_id,
              consent.team_policy_version,
              consent.workspace_policy_id,
              consent.workspace_policy_version,
              consent.allowed_representations,
              selected,
              consent.representation_policy_revision,
              consent.content_policy_version,
              consent.classifier_version,
              consent.source_revision,
              authority
            ]
          );
        } catch (error) {
          if (
            isUniqueViolation(
              error,
              "team_session_share_grants_destination_unique"
            )
          ) {
            throw new SharedMemoryConflictError(
              "This logical memory already has a Share Grant for the destination Workspace"
            );
          }
          throw error;
        }
        const row = inserted.rows[0] as Row;
        await appendOutbox(client, {
          mutationId: input.mutationId,
          family: "share_grant_lifecycle",
          teamId: stringValue(row.team_id),
          teamWorkspaceId: stringValue(row.team_workspace_id),
          shareGrantId: stringValue(row.id),
          logicalMemoryId: stringValue(row.logical_memory_id),
          resourceType: "team_session_share_grant",
          resourceId: stringValue(row.id),
          actorPrincipalId: actor.userId
        });
        return mapGrant(row);
      });
    },

    async selectGrantRepresentation(actor, input) {
      assertUuid(input.mutationId, "mutationId");
      return withTransaction(pool, async (client) => {
        await lockShareGrantRetentionScopeWithClient(
          client,
          input.shareGrantId
        );
        const grantResult = await client.query(
          "select * from team_session_share_grants where id=$1 for update",
          [input.shareGrantId]
        );
        const grant = grantResult.rows[0] as Row | undefined;
        if (!grant || grant.owner_user_id !== actor.userId)
          throw new SharedMemoryAuthorizationError(
            "Only the source owner may select a representation"
          );
        if (grant.lifecycle !== "active" && grant.lifecycle !== "revoked") {
          throw new SharedMemoryConflictError(
            "Share Grant cannot be changed after retention purge has started"
          );
        }
        if (numberValue(grant.grant_version) !== input.expectedGrantVersion) {
          const replay = await client.query(
            `select 1 from collaboration_outbox
            where mutation_id=$1 and family='representation_changed'
              and share_grant_id=$2 and resource_id=$2
              and actor_principal_id=$3 and invalidated_at is null
            limit 1`,
            [input.mutationId, input.shareGrantId, actor.userId]
          );
          if (replay.rows[0] && grant.consent_id === input.consentId) {
            await requireRecordedShareAuthority(client, actor, {
              teamId: stringValue(grant.team_id),
              teamWorkspaceId: stringValue(grant.team_workspace_id),
              authority: input.authority,
              delegatedDeviceActionGrant
            });
            return mapGrant(grant);
          }
          throw new SharedMemoryConflictError();
        }
        await requireShareAuthority(client, actor, {
          teamId: stringValue(grant.team_id),
          teamWorkspaceId: stringValue(grant.team_workspace_id),
          authority: input.authority,
          consume: true,
          delegatedDeviceActionGrant
        });
        const consentResult = await client.query(
          `select * from source_owner_representation_consents
          where id=$1 and logical_memory_id=$2 and source_owner_principal_id=$3
            and team_id=$4 and team_workspace_id=$5 and state='active'
            and revoked_at is null and (expires_at is null or expires_at>now())
          for update`,
          [
            input.consentId,
            grant.logical_memory_id,
            grant.owner_principal_id,
            grant.team_id,
            grant.team_workspace_id
          ]
        );
        const consent = consentResult.rows[0] as Row | undefined;
        if (!consent)
          throw new SharedMemoryConflictError(
            "Replacement consent is not active"
          );
        if (consent.selected_representation !== input.representation) {
          throw new SharedMemoryConflictError(
            "Replacement consent representation does not match the request"
          );
        }
        const policies = await requireCurrentPolicies(client, {
          logicalMemoryId: stringValue(grant.logical_memory_id),
          ownerPrincipalId: stringValue(grant.owner_principal_id),
          teamId: stringValue(grant.team_id),
          teamWorkspaceId: stringValue(grant.team_workspace_id)
        });
        const selected = stringValue(
          consent.selected_representation
        ) as SharedMemoryRepresentation;
        if (!policies.intersection.includes(selected))
          throw new SharedMemoryConflictError(
            "Selected representation is outside the exact policy intersection"
          );
        if (grant.lifecycle === "revoked") {
          const clock = await client.query<{ now: Date }>(
            "select transaction_timestamp() as now"
          );
          const cancellation =
            await cancelShareGrantRevocationRetentionWithClient(client, {
              shareGrantId: input.shareGrantId,
              actorUserId: actor.userId,
              mutationId: input.mutationId,
              canceledAt: clock.rows[0]!.now
            });
          if (cancellation === "purge_started") {
            throw new SharedMemoryConflictError(
              "Share Grant retention purge has already started"
            );
          }
        }
        await client.query(
          `update team_memory_representations
            set state='invalidated',invalidated_at=now(),updated_at=now(),
                record_version=record_version+1,
                invalidation_reason_code='owner_selected_replacement'
          where share_grant_id=$1 and state in ('pending','available','stale')`,
          [input.shareGrantId]
        );
        const updated = await client.query(
          `update team_session_share_grants set
           consent_id=$2,source_owner_policy_id=$3,source_owner_policy_version=$4,
           team_policy_id=$5,team_policy_version=$6,workspace_policy_id=$7,
           workspace_policy_version=$8,owner_allowed_representations=$9,
           active_representation=$10,representation_policy_revision=$11,
           content_policy_version=$12,classifier_version=$13,source_revision=$14,
           lifecycle='active',grant_version=grant_version+1,updated_at=now(),
           revoked_at=null,revoked_by_user_id=null,revocation_reason=null,
           retention_policy_id=null,retention_policy_version=null,
           retention_triggered_at=null,retain_until=null,
           active_retention_decision_id=null,active_purge_job_id=null,
           tombstoned_at=null,purge_completed_at=null
         where id=$1 returning *`,
          [
            input.shareGrantId,
            consent.id,
            consent.source_owner_policy_id,
            consent.source_owner_policy_version,
            consent.team_policy_id,
            consent.team_policy_version,
            consent.workspace_policy_id,
            consent.workspace_policy_version,
            consent.allowed_representations,
            selected,
            consent.representation_policy_revision,
            consent.content_policy_version,
            consent.classifier_version,
            consent.source_revision
          ]
        );
        const row = updated.rows[0] as Row;
        await appendOutbox(client, {
          mutationId: input.mutationId,
          family: "representation_changed",
          teamId: stringValue(row.team_id),
          teamWorkspaceId: stringValue(row.team_workspace_id),
          shareGrantId: stringValue(row.id),
          logicalMemoryId: stringValue(row.logical_memory_id),
          resourceType: "team_session_share_grant",
          resourceId: stringValue(row.id),
          actorPrincipalId: actor.userId
        });
        return mapGrant(row);
      });
    },

    async revokeShareGrant(actor, input) {
      assertUuid(input.mutationId, "mutationId");
      if (!requiredString(input.reasonCode) || input.reasonCode.length > 120)
        throw new TypeError("reasonCode is required");
      return withTransaction(pool, async (client) => {
        await lockShareGrantRetentionScopeWithClient(
          client,
          input.shareGrantId
        );
        const result = await client.query(
          "select * from team_session_share_grants where id=$1 for update",
          [input.shareGrantId]
        );
        const grant = result.rows[0] as Row | undefined;
        if (!grant) throw new SharedMemoryAuthorizationError();
        if (grant.lifecycle === "revoked") {
          const replay = await client.query(
            `select 1
             where exists (
               select 1 from collaboration_outbox
                where mutation_id=$1 and family='access_revoked'
                  and share_grant_id=$2 and resource_id=$2
                  and actor_principal_id=$3 and invalidated_at is null
             ) or exists (
               select 1 from purge_jobs
                where idempotency_key = 'share-grant:' || $2::text
                  || ':revocation:' || $1::text
             )`,
            [input.mutationId, input.shareGrantId, actor.userId]
          );
          if (!replay.rows[0])
            throw new SharedMemoryConflictError(
              "Share Grant is already revoked"
            );
          if (grant.revocation_reason !== input.reasonCode) {
            throw new SharedMemoryConflictError(
              "Share Grant revocation idempotency conflict"
            );
          }
          if (grant.revoked_by_user_id !== actor.userId) {
            throw new SharedMemoryConflictError(
              "Share Grant revocation idempotency conflict"
            );
          }
          await requireRecordedShareAuthority(client, actor, {
            teamId: stringValue(grant.team_id),
            teamWorkspaceId: stringValue(grant.team_workspace_id),
            authority: input.authority,
            delegatedDeviceActionGrant,
            requireSharePermission: false
          });
          return mapGrant(grant);
        }
        const reusedMutation = await client.query(
          `select 1 from purge_jobs
            where idempotency_key = 'share-grant:' || $1::text
              || ':revocation:' || $2::text
            limit 1`,
          [input.shareGrantId, input.mutationId]
        );
        if (reusedMutation.rowCount) {
          throw new SharedMemoryConflictError(
            "Share Grant revocation mutation was already used"
          );
        }
        await requireShareAuthority(client, actor, {
          teamId: stringValue(grant.team_id),
          teamWorkspaceId: stringValue(grant.team_workspace_id),
          authority: input.authority,
          consume: true,
          delegatedDeviceActionGrant,
          requireSharePermission: false
        });
        if (numberValue(grant.grant_version) !== input.expectedGrantVersion)
          throw new SharedMemoryConflictError();
        const clock = await client.query<{ now: Date }>(
          "select transaction_timestamp() as now"
        );
        const revokedAt = clock.rows[0]!.now;
        const updated = await client.query(
          `update team_session_share_grants
            set lifecycle='revoked',grant_version=grant_version+1,updated_at=now(),
                revocation_epoch=revocation_epoch+1,
                revoked_at=$4,revoked_by_user_id=$2,revocation_reason=$3
          where id=$1 returning *`,
          [input.shareGrantId, actor.userId, input.reasonCode, revokedAt]
        );
        await client.query(
          `update team_memory_representations
            set state='invalidated',invalidated_at=now(),updated_at=now(),
                record_version=record_version+1,invalidation_reason_code='share_revoked'
          where share_grant_id=$1 and state in ('pending','available','stale')`,
          [input.shareGrantId]
        );
        const row = updated.rows[0] as Row;
        await scheduleShareGrantRevocationRetentionWithClient(client, {
          shareGrantId: input.shareGrantId,
          actorUserId: actor.userId,
          mutationId: input.mutationId,
          revocationEpoch: numberValue(row.revocation_epoch),
          triggeredAt: revokedAt
        });
        await appendOutbox(client, {
          mutationId: input.mutationId,
          family: "access_revoked",
          teamId: stringValue(row.team_id),
          teamWorkspaceId: stringValue(row.team_workspace_id),
          shareGrantId: stringValue(row.id),
          logicalMemoryId: stringValue(row.logical_memory_id),
          resourceType: "team_session_share_grant",
          resourceId: stringValue(row.id),
          actorPrincipalId: actor.userId
        });
        return mapGrant(row);
      });
    },

    async materializeGrantRepresentation(actor, input) {
      assertUuid(input.mutationId, "mutationId");
      return withTransaction(pool, async (client) => {
        const grantResult = await client.query<Row>(
          `select g.*,
                mr.freshness_status as replica_freshness_status,
                sr.state as sync_relationship_state
           from team_session_share_grants g
           join memory_replicas mr
             on mr.id=g.remote_replica_id
            and mr.replica_role='target'
            and mr.encryption_scope='owner_private_replica'
            and mr.lifecycle='active'
            and mr.disabled_at is null
           join cross_identity_sync_relationships sr
             on sr.local_replica_id=mr.id
            and sr.logical_memory_id=g.logical_memory_id
            and sr.side='target'
            and sr.revoked_at is null
            and sr.state in ('processing','partially_available','ready','stale')
          where g.id=$1
          for update of g,mr,sr`,
          [input.shareGrantId]
        );
        const grantRow = grantResult.rows[0] as Row | undefined;
        if (!grantRow || grantRow.owner_user_id !== actor.userId) {
          throw new SharedMemoryAuthorizationError(
            "Only the source owner may materialize a Share Grant representation"
          );
        }
        if (
          stringValue(grantRow.lifecycle) !== "active" ||
          grantRow.revoked_at !== null
        ) {
          throw new SharedMemoryConflictError(
            "Share Grant is not active for materialization"
          );
        }
        if (
          numberValue(grantRow.grant_version) !== input.expectedGrantVersion
        ) {
          throw new SharedMemoryConflictError();
        }
        const grant = mapGrant(grantRow);
        const ownerProvider =
          await resolveOwnerPrivateReplicaEncryptionProvider({
            ownerUserId: actor.userId,
            ownerPrincipalId: grant.ownerPrincipalId,
            logicalMemoryId: grant.logicalMemoryId,
            remoteReplicaId: grant.remoteReplicaId,
            teamId: grant.teamId,
            teamWorkspaceId: grant.teamWorkspaceId,
            purpose: "decrypt"
          });
        const teamProvider = await options.resolveTeamEncryptionProvider({
          teamId: grant.teamId,
          purpose: "encrypt"
        });
        if (ownerProvider.keyId === teamProvider.keyId) {
          throw new SharedMemoryConflictError(
            "Owner-private replica and Team representations require distinct encryption keys"
          );
        }
        const loaded = await loadPersistedPreviewByReference(client, {
          preview: input.preview,
          requiredMessage: "Materialization preview reference is not active"
        });
        const { preview, artifact, previewBody, artifactBody } = loaded;
        const consentResult = await client.query<Row>(
          `select *
           from source_owner_representation_consents
          where id=$1
            and logical_memory_id=$2
            and remote_replica_id=$3
            and source_owner_principal_id=$4
            and team_id=$5
            and team_workspace_id=$6
            and state='active'
            and revoked_at is null
            and (expires_at is null or expires_at>now())
          for update`,
          [
            input.consentId,
            grantRow.logical_memory_id,
            grantRow.remote_replica_id,
            grantRow.owner_principal_id,
            grantRow.team_id,
            grantRow.team_workspace_id
          ]
        );
        const consentRow = consentResult.rows[0] as Row | undefined;
        if (
          !consentRow ||
          stringValue(grantRow.consent_id) !== input.consentId
        ) {
          throw new SharedMemoryConflictError(
            "Share Grant is no longer bound to the requested consent"
          );
        }
        const consent = mapConsent(consentRow);
        if (
          preview.logicalMemoryId !== grant.logicalMemoryId ||
          preview.remoteReplicaId !== grant.remoteReplicaId ||
          preview.teamId !== grant.teamId ||
          preview.teamWorkspaceId !== grant.teamWorkspaceId ||
          preview.ownerPrincipalId !== grant.ownerPrincipalId ||
          preview.representation !== grant.activeRepresentation ||
          artifact.artifactId !== preview.artifactId ||
          artifact.sourceOwnerPolicyId !== grant.sourceOwnerPolicyId ||
          artifact.sourceOwnerPolicyVersion !==
            grant.sourceOwnerPolicyVersion ||
          artifact.teamPolicyId !== grant.teamPolicyId ||
          artifact.teamPolicyVersion !== grant.teamPolicyVersion ||
          artifact.workspacePolicyId !== grant.workspacePolicyId ||
          artifact.workspacePolicyVersion !== grant.workspacePolicyVersion ||
          artifact.representationPolicyRevision !==
            grant.representationPolicyRevision ||
          artifact.contentPolicyVersion !== grant.contentPolicyVersion ||
          artifact.classifierVersion !== grant.classifierVersion ||
          preview.binding.representationPolicyRevision !==
            grant.representationPolicyRevision ||
          preview.binding.contentPolicyVersion !== grant.contentPolicyVersion ||
          preview.binding.classifierVersion !== grant.classifierVersion
        ) {
          throw new SharedMemoryConflictError(
            "Authoritative preview does not match the active Share Grant binding"
          );
        }
        if (consent.selectedRepresentation !== preview.representation) {
          throw new SharedMemoryConflictError(
            "Consent representation does not match the materialized preview"
          );
        }
        if (
          consent.mode === "snapshot" &&
          (preview.previewId !== consent.previewId ||
            preview.previewHash !== consent.previewHash ||
            preview.sourceRevision !== consent.sourceRevision)
        ) {
          throw new SharedMemoryConflictError(
            "Snapshot consent requires the exact consented preview revision"
          );
        }
        if (
          consent.maximumAuthorizedSourceRevision !== null &&
          preview.sourceRevision > consent.maximumAuthorizedSourceRevision
        ) {
          throw new SharedMemoryConflictError(
            "Preview exceeds the consented source revision boundary"
          );
        }
        const currentPolicies = await requireCurrentPolicies(client, {
          logicalMemoryId: grant.logicalMemoryId,
          ownerPrincipalId: grant.ownerPrincipalId,
          teamId: grant.teamId,
          teamWorkspaceId: grant.teamWorkspaceId
        });
        if (
          !currentPolicies.intersection.includes(preview.representation) ||
          stringValue(currentPolicies.owner.policy_id) !==
            grant.sourceOwnerPolicyId ||
          numberValue(currentPolicies.owner.version) !==
            grant.sourceOwnerPolicyVersion ||
          stringValue(currentPolicies.team.policy_id) !== grant.teamPolicyId ||
          numberValue(currentPolicies.team.version) !==
            grant.teamPolicyVersion ||
          stringValue(currentPolicies.workspace.policy_id) !==
            grant.workspacePolicyId ||
          numberValue(currentPolicies.workspace.version) !==
            grant.workspacePolicyVersion
        ) {
          throw new SharedMemoryConflictError(
            "Materialization requires the exact active policy intersection"
          );
        }
        const replicaState = await loadActiveReplicaState(client, {
          logicalMemoryId: grant.logicalMemoryId,
          remoteReplicaId: grant.remoteReplicaId,
          ownerUserId: actor.userId,
          ownerPrincipalId: grant.ownerPrincipalId,
          syncRelationshipId: artifact.syncRelationshipId
        });
        if (
          replicaState.sourceCursor < preview.sourceRevision ||
          replicaState.localReplicaId !== grant.remoteReplicaId ||
          artifactBody.sync.relationshipId !== artifact.syncRelationshipId ||
          artifactBody.sync.localReplicaId !== grant.remoteReplicaId ||
          artifactBody.sync.remoteReplicaId !==
            replicaState.remoteSyncReplicaId ||
          artifactBody.sync.localSessionId !== replicaState.localSessionId ||
          artifactBody.sync.sourceDeploymentIdentityId !==
            replicaState.sourceDeploymentIdentityId ||
          artifactBody.sync.remoteUserIdentityId !==
            replicaState.remoteUserIdentityId ||
          artifactBody.sync.deviceCredentialId !==
            replicaState.deviceCredentialId ||
          artifactBody.sync.deviceProvenanceHash !==
            replicaState.deviceProvenanceHash ||
          preview.deviceProvenanceHash !== replicaState.deviceProvenanceHash
        ) {
          throw new SharedMemoryConflictError(
            "Active replica provenance no longer matches the authoritative preview"
          );
        }
        const sourceMaterial = await loadAuthoritativeSourceMaterial(
          client,
          actor,
          ownerProvider,
          {
            representation: preview.representation,
            logicalMemoryId: grant.logicalMemoryId,
            ownerUserId: actor.userId,
            ownerPrincipalId: grant.ownerPrincipalId,
            localSessionId: replicaState.localSessionId,
            syncRelationshipId: artifact.syncRelationshipId,
            sourceRevision: preview.sourceRevision
          }
        );
        if (
          sourceMaterial.manifestHash !== artifact.manifestHash ||
          sourceMaterial.redactedContentHash !== artifact.redactedContentHash ||
          sourceMaterial.sourceHash !== artifact.sourceHash ||
          crossIdentitySyncDigest(sourceMaterial.items) !==
            crossIdentitySyncDigest(artifactBody.items) ||
          crossIdentitySyncDigest(sourceMaterial.items) !==
            crossIdentitySyncDigest(previewBody.items) ||
          crossIdentitySyncDigest(sourceMaterial.manifest) !==
            crossIdentitySyncDigest(artifactBody.manifest)
        ) {
          throw new SharedMemoryConflictError(
            "Authoritative source rows drifted from the persisted preview"
          );
        }
        const monotonicFloor = Math.max(
          consent.sourceRevision,
          grant.sourceRevision
        );
        const latestResult = await client.query<Row>(
          `select max(source_revision)::bigint as latest_source_revision
           from team_memory_representations
          where share_grant_id=$1
            and representation=$2
            and state in ('pending','available','stale')
            and invalidated_at is null`,
          [grant.id, preview.representation]
        );
        const latestMaterializedRevision =
          nullableNumber(latestResult.rows[0]?.latest_source_revision) ?? 0;
        if (
          consent.mode === "continuous" &&
          preview.sourceRevision <
            Math.max(monotonicFloor, latestMaterializedRevision)
        ) {
          throw new SharedMemoryConflictError(
            "Continuous materialization cannot move the Share Grant backwards"
          );
        }
        const provenanceHash = crossIdentitySyncDigest({
          shareGrantId: grant.id,
          consentId: consent.id,
          logicalMemoryId: grant.logicalMemoryId,
          representation: preview.representation,
          binding: preview.binding,
          redactedContentHash: preview.redactedContentHash,
          sourceOwnerPolicyId: grant.sourceOwnerPolicyId,
          sourceOwnerPolicyVersion: grant.sourceOwnerPolicyVersion,
          teamPolicyId: grant.teamPolicyId,
          teamPolicyVersion: grant.teamPolicyVersion,
          workspacePolicyId: grant.workspacePolicyId,
          workspacePolicyVersion: grant.workspacePolicyVersion
        });
        const existingResult = await client.query<Row>(
          `select *
           from team_memory_representations
          where share_grant_id=$1
            and representation=$2
            and source_revision=$3
            and representation_policy_revision=$4
            and content_policy_version=$5
            and classifier_version=$6
          for update`,
          [
            grant.id,
            preview.representation,
            preview.sourceRevision,
            grant.representationPolicyRevision,
            grant.contentPolicyVersion,
            grant.classifierVersion
          ]
        );
        let representationRow = existingResult.rows[0] as Row | undefined;
        if (representationRow) {
          const representationState = stringValue(representationRow.state);
          if (
            input.expectedRepresentationVersion !== undefined &&
            numberValue(representationRow.record_version) !==
              input.expectedRepresentationVersion
          ) {
            throw new SharedMemoryConflictError();
          }
          if (
            representationState !== "invalidated" &&
            (stringValue(representationRow.consent_id) !== consent.id ||
              stringValue(representationRow.source_preview_id) !==
                preview.previewId ||
              stringValue(representationRow.source_artifact_id) !==
                artifact.artifactId ||
              stringValue(representationRow.source_revision_hash) !==
                preview.sourceHash ||
              stringValue(representationRow.provenance_hash) !==
                provenanceHash ||
              stringValue(representationRow.source_owner_policy_id) !==
                grant.sourceOwnerPolicyId ||
              numberValue(representationRow.source_owner_policy_version) !==
                grant.sourceOwnerPolicyVersion ||
              stringValue(representationRow.team_policy_id) !==
                grant.teamPolicyId ||
              numberValue(representationRow.team_policy_version) !==
                grant.teamPolicyVersion ||
              stringValue(representationRow.workspace_policy_id) !==
                grant.workspacePolicyId ||
              numberValue(representationRow.workspace_policy_version) !==
                grant.workspacePolicyVersion)
          ) {
            throw new SharedMemoryConflictError(
              "Existing materialized representation does not match the authoritative preview"
            );
          }
          if (
            representationState === "available" ||
            representationState === "stale"
          ) {
            return mapRepresentation(representationRow);
          }
        } else {
          if (
            input.expectedRepresentationVersion !== undefined &&
            input.expectedRepresentationVersion !== 0
          ) {
            throw new SharedMemoryConflictError();
          }
          const inserted = await client.query<Row>(
            `insert into team_memory_representations (
             share_grant_id,consent_id,source_preview_id,source_artifact_id,
             team_id,team_workspace_id,logical_memory_id,representation,
             source_revision,source_revision_hash,provenance_hash,
             source_owner_policy_id,source_owner_policy_version,
             team_policy_id,team_policy_version,
             workspace_policy_id,workspace_policy_version,
             representation_policy_revision,content_policy_version,
             classifier_version,record_version,state,chunk_count
           ) values (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             $12,$13,$14,$15,$16,$17,$18,$19,$20,1,'pending',0
           ) returning *`,
            [
              grant.id,
              consent.id,
              preview.previewId,
              artifact.artifactId,
              grant.teamId,
              grant.teamWorkspaceId,
              grant.logicalMemoryId,
              preview.representation,
              preview.sourceRevision,
              preview.sourceHash,
              provenanceHash,
              grant.sourceOwnerPolicyId,
              grant.sourceOwnerPolicyVersion,
              grant.teamPolicyId,
              grant.teamPolicyVersion,
              grant.workspacePolicyId,
              grant.workspacePolicyVersion,
              grant.representationPolicyRevision,
              grant.contentPolicyVersion,
              grant.classifierVersion
            ]
          );
          representationRow = inserted.rows[0]!;
        }
        const representationId = stringValue(representationRow.id);
        const resetResult = await client.query<Row>(
          `update team_memory_representations
            set consent_id=$2,
                source_preview_id=$3,
                source_artifact_id=$4,
                source_revision_hash=$5,
                provenance_hash=$6,
                source_owner_policy_id=$7,
                source_owner_policy_version=$8,
                team_policy_id=$9,
                team_policy_version=$10,
                workspace_policy_id=$11,
                workspace_policy_version=$12,
                record_version=case when id=$1 and record_version>0 then record_version+1 else 1 end,
                state='pending',
                chunk_count=0,
                freshness_evaluated_at=null,
                available_at=null,
                stale_at=null,
                invalidated_at=null,
                invalidation_reason_code=null,
                updated_at=now()
          where id=$1
          returning *`,
          [
            representationId,
            consent.id,
            preview.previewId,
            artifact.artifactId,
            preview.sourceHash,
            provenanceHash,
            grant.sourceOwnerPolicyId,
            grant.sourceOwnerPolicyVersion,
            grant.teamPolicyId,
            grant.teamPolicyVersion,
            grant.workspacePolicyId,
            grant.workspacePolicyVersion
          ]
        );
        if (!resetResult.rows[0]) {
          throw new SharedMemoryConflictError(
            "Failed to reset Shared Memory representation state"
          );
        }
        const chunks = chunkItems(previewBody.items);
        let itemOffset = 0;
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index]!;
          const envelope = await teamProvider.encrypt({
            plaintext: Buffer.from(JSON.stringify(chunk), "utf8"),
            scope: envelopeScope({
              teamId: grant.teamId,
              teamWorkspaceId: grant.teamWorkspaceId
            }),
            provenance: envelopeProvenance(representationId),
            ciphertextLocation: "team_memory_representation_chunks",
            aad: envelopeAad({
              representationId,
              shareGrantId: grant.id,
              teamId: grant.teamId,
              teamWorkspaceId: grant.teamWorkspaceId,
              logicalMemoryId: grant.logicalMemoryId,
              consentId: consent.id,
              representation: preview.representation,
              chunkIndex: index,
              chunkCount: chunks.length,
              itemOffset,
              itemCount: chunk.length,
              totalItemCount: previewBody.items.length,
              binding: preview.binding,
              redactedContentHash: preview.redactedContentHash,
              provenanceHash
            })
          });
          await client.query(
            `insert into team_memory_representation_chunks (
             representation_id,share_grant_id,team_id,team_workspace_id,
             logical_memory_id,chunk_index,envelope_version,provider_mode,
             algorithm,key_id,key_version,ciphertext,ciphertext_hash,nonce,tag,
             wrapped_dek,aad,envelope_created_at,envelope_reencrypted_at,
             verified_at
           ) values (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,
             $17::jsonb,$18,$19,now()
           )
           on conflict (representation_id,chunk_index) do update
             set share_grant_id=excluded.share_grant_id,
                 team_id=excluded.team_id,
                 team_workspace_id=excluded.team_workspace_id,
                 logical_memory_id=excluded.logical_memory_id,
                 envelope_version=excluded.envelope_version,
                 provider_mode=excluded.provider_mode,
                 algorithm=excluded.algorithm,
                 key_id=excluded.key_id,
                 key_version=excluded.key_version,
                 ciphertext=excluded.ciphertext,
                 ciphertext_hash=excluded.ciphertext_hash,
                 nonce=excluded.nonce,
                 tag=excluded.tag,
                 wrapped_dek=excluded.wrapped_dek,
                 aad=excluded.aad,
                 envelope_created_at=excluded.envelope_created_at,
                 envelope_reencrypted_at=excluded.envelope_reencrypted_at,
                 verified_at=now(),
                 purged_at=null`,
            [
              representationId,
              grant.id,
              grant.teamId,
              grant.teamWorkspaceId,
              grant.logicalMemoryId,
              index,
              envelope.version,
              envelope.providerMode,
              envelope.algorithm,
              envelope.keyId,
              envelope.keyVersion,
              envelope.ciphertext,
              ciphertextHash(envelope.ciphertext),
              envelope.nonce,
              envelope.tag,
              JSON.stringify(envelope.wrappedDek),
              JSON.stringify(envelope.aad),
              envelope.createdAt,
              envelope.reencryptedAt
            ]
          );
          itemOffset += chunk.length;
        }
        await client.query(
          `delete from team_memory_representation_chunks
          where representation_id=$1
            and chunk_index >= $2`,
          [representationId, chunks.length]
        );
        const staleState =
          stringValue(grantRow.replica_freshness_status) === "stale" ||
          stringValue(grantRow.sync_relationship_state) === "stale" ||
          (consent.mode === "continuous" &&
            preview.sourceRevision < replicaState.sourceCursor);
        const finalized = await client.query<Row>(
          `update team_memory_representations
            set state=$2,
                chunk_count=$3,
                freshness_evaluated_at=now(),
                available_at=coalesce(available_at, now()),
                stale_at=$4,
                updated_at=now()
          where id=$1
          returning *`,
          [
            representationId,
            staleState ? "stale" : "available",
            chunks.length,
            staleState ? new Date() : null
          ]
        );
        if (
          consent.mode === "continuous" &&
          preview.sourceRevision > grant.sourceRevision
        ) {
          await client.query(
            `update team_session_share_grants
              set source_revision=$2,updated_at=now()
            where id=$1`,
            [grant.id, preview.sourceRevision]
          );
        }
        await appendOutbox(client, {
          mutationId: input.mutationId,
          family: representationAvailableFamily(preview.representation),
          teamId: grant.teamId,
          teamWorkspaceId: grant.teamWorkspaceId,
          shareGrantId: grant.id,
          logicalMemoryId: grant.logicalMemoryId,
          resourceType: "team_memory_representation",
          resourceId: representationId,
          actorPrincipalId: actor.userId
        });
        return mapRepresentation(finalized.rows[0] as Row);
      });
    },

    async advanceContinuousGrantRepresentations(input) {
      assertUuid(input.remoteReplicaId, "remoteReplicaId");
      if (
        !Number.isSafeInteger(input.sourceRevision) ||
        input.sourceRevision < 0
      ) {
        throw new SharedMemoryConflictError("Source revision is invalid");
      }
      const candidates = await pool.query<Row>(
        `select g.id,g.owner_user_id,g.logical_memory_id,
                g.remote_replica_id,g.team_id,g.team_workspace_id,
                g.active_representation,g.grant_version,
                consent.id as consent_id,consent.allowed_representations
           from team_session_share_grants g
           join source_owner_representation_consents consent
             on consent.id=g.consent_id
            and consent.mode='continuous'
            and consent.state='active'
            and consent.revoked_at is null
            and (consent.expires_at is null or consent.expires_at>now())
          where g.remote_replica_id=$1
            and g.lifecycle='active'
            and g.revoked_at is null
            and g.source_revision<$2
            and g.active_representation=any(consent.allowed_representations)
          order by g.id`,
        [input.remoteReplicaId, input.sourceRevision]
      );
      let advanced = 0;
      for (const row of candidates.rows) {
        const grantId = stringValue(row.id);
        const actor = { userId: stringValue(row.owner_user_id) };
        const representation = stringValue(
          row.active_representation
        ) as SharedMemoryRepresentation;
        const preview = await createAuthoritativeSourcePreview(
          actor,
          {
            logicalMemoryId: stringValue(row.logical_memory_id),
            remoteReplicaId: stringValue(row.remote_replica_id),
            teamId: stringValue(row.team_id),
            teamWorkspaceId: stringValue(row.team_workspace_id),
            representation,
            allowedRepresentations: normalizedRepresentations(
              stringArray(row.allowed_representations)
            )
          },
          grantId
        );
        if (preview.sourceRevision !== input.sourceRevision) {
          throw new SharedMemoryConflictError(
            "Continuous preview revision does not match the synced replica"
          );
        }
        await repository.materializeGrantRepresentation(actor, {
          mutationId: crossIdentitySyncDeterministicUuid({
            operation: "continuous-shared-memory-materialization",
            shareGrantId: grantId,
            consentId: stringValue(row.consent_id),
            representation,
            sourceRevision: input.sourceRevision,
            previewHash: preview.previewHash
          }),
          shareGrantId: grantId,
          consentId: stringValue(row.consent_id),
          expectedGrantVersion: numberValue(row.grant_version),
          preview: {
            previewId: preview.previewId,
            previewHash: preview.previewHash
          }
        });
        advanced += 1;
      }
      return { advanced };
    },

    async listWorkspaceGrants(actor, input) {
      assertUuid(input.teamId, "teamId");
      assertUuid(input.teamWorkspaceId, "teamWorkspaceId");
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_WORKSPACE_INDEX_LIMIT
      ) {
        throw new TypeError(
          `limit must be between 1 and ${MAX_WORKSPACE_INDEX_LIMIT}`
        );
      }
      if (
        !Number.isSafeInteger(input.offset) ||
        input.offset < 0 ||
        input.offset > MAX_WORKSPACE_INDEX_OFFSET
      ) {
        throw new TypeError(
          `offset must be between 0 and ${MAX_WORKSPACE_INDEX_OFFSET}`
        );
      }

      return withTransaction(pool, async (client) => {
        await client.query(
          "set transaction isolation level repeatable read read only"
        );
        await requireWorkspaceAccess(
          client,
          actor,
          input.teamId,
          input.teamWorkspaceId,
          "read"
        );
        const result = await client.query<Row>(
          `select g.id as share_grant_id,g.logical_memory_id,g.owner_user_id,
                g.team_id,g.team_workspace_id,g.active_representation,
                g.lifecycle,g.created_at,g.updated_at,
                r.state as representation_state,
                r.source_revision as representation_source_revision,
                r.updated_at as representation_updated_at,
                mr.freshness_status as replica_freshness_status,
                sr.state as sync_relationship_state,
                sr.target_processing_cursor,
                c.mode as consent_mode
           from team_session_share_grants g
           join teams t on t.id=g.team_id and t.lifecycle='active'
             and t.entitlement_status in ('active','grace')
           join team_memberships tm on tm.team_id=g.team_id and tm.user_id=$1
             and tm.status='enabled' and tm.disabled_at is null
           join users u on u.id=tm.user_id and u.disabled_at is null and u.deleted_at is null
           join team_workspaces tw on tw.id=g.team_workspace_id and tw.team_id=g.team_id
             and tw.lifecycle='active' and tw.archived_at is null
           join team_workspace_access_grants wa on wa.team_workspace_id=tw.id
             and wa.team_id=g.team_id and wa.user_id=$1 and wa.disabled_at is null
             and wa.access in ('read','write')
           join source_owner_representation_consents c on c.id=g.consent_id
             and c.state='active' and c.revoked_at is null
             and (c.expires_at is null or c.expires_at>now())
           join source_owner_representation_policies op on op.policy_id=g.source_owner_policy_id
             and op.version=g.source_owner_policy_version and op.superseded_at is null
           join team_representation_policies tp on tp.policy_id=g.team_policy_id
             and tp.version=g.team_policy_version and tp.team_id=g.team_id
             and tp.superseded_at is null
           join workspace_representation_policies wp on wp.policy_id=g.workspace_policy_id
             and wp.version=g.workspace_policy_version and wp.team_id=g.team_id
             and wp.team_workspace_id=g.team_workspace_id and wp.superseded_at is null
           join memory_replicas mr on mr.id=g.remote_replica_id and mr.replica_role='target'
             and mr.encryption_scope='owner_private_replica' and mr.lifecycle='active'
             and mr.disabled_at is null
           join cross_identity_sync_relationships sr on sr.local_replica_id=mr.id
             and sr.logical_memory_id=g.logical_memory_id and sr.side='target'
             and sr.state <> 'purge_pending'
           join lateral (
             select r0.state,r0.source_revision,r0.updated_at
               from team_memory_representations r0
              where r0.share_grant_id=g.id and r0.consent_id=g.consent_id
                and r0.representation=g.active_representation
                and r0.state in ('available','stale')
                and r0.source_owner_policy_id=g.source_owner_policy_id
                and r0.source_owner_policy_version=g.source_owner_policy_version
                and r0.team_policy_id=g.team_policy_id
                and r0.team_policy_version=g.team_policy_version
                and r0.workspace_policy_id=g.workspace_policy_id
                and r0.workspace_policy_version=g.workspace_policy_version
                and r0.representation_policy_revision=g.representation_policy_revision
                and r0.content_policy_version=g.content_policy_version
                and r0.classifier_version=g.classifier_version
                and (c.maximum_authorized_source_revision is null
                  or r0.source_revision<=c.maximum_authorized_source_revision)
              order by r0.source_revision desc,r0.available_at desc,r0.id desc
              limit 1
           ) r on true
          where g.team_id=$2 and g.team_workspace_id=$3
            and g.lifecycle='active' and g.revoked_at is null
            and g.active_representation=any(g.owner_allowed_representations)
            and g.active_representation=any(c.allowed_representations)
            and g.active_representation=any(op.allowed_representations)
            and g.active_representation=any(tp.allowed_representations)
            and g.active_representation=any(wp.allowed_representations)
          order by g.updated_at desc,g.id desc
          limit $4 offset $5`,
          [
            actor.userId,
            input.teamId,
            input.teamWorkspaceId,
            input.limit + 1,
            input.offset
          ]
        );
        const hasMore = result.rows.length > input.limit;
        return {
          entries: result.rows
            .slice(0, input.limit)
            .map(mapWorkspaceIndexEntry),
          limit: input.limit,
          offset: input.offset,
          hasMore
        };
      });
    },

    async listOwnerGrants(actor, input) {
      assertUuid(input.logicalMemoryId, "logicalMemoryId");
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_WORKSPACE_INDEX_LIMIT
      ) {
        throw new TypeError(
          `limit must be between 1 and ${MAX_WORKSPACE_INDEX_LIMIT}`
        );
      }
      if (
        !Number.isSafeInteger(input.offset) ||
        input.offset < 0 ||
        input.offset > MAX_WORKSPACE_INDEX_OFFSET
      ) {
        throw new TypeError(
          `offset must be between 0 and ${MAX_WORKSPACE_INDEX_OFFSET}`
        );
      }

      return withTransaction(pool, async (client) => {
        await client.query(
          "set transaction isolation level repeatable read read only"
        );
        await requireSourceOwner(client, actor, input.logicalMemoryId);
        const result = await client.query<Row>(
          `select g.*
             from team_session_share_grants g
            where g.logical_memory_id=$1 and g.owner_user_id=$2
            order by g.updated_at desc,g.id desc
            limit $3 offset $4`,
          [input.logicalMemoryId, actor.userId, input.limit + 1, input.offset]
        );
        return {
          entries: result.rows.slice(0, input.limit).map(mapGrant),
          limit: input.limit,
          offset: input.offset,
          hasMore: result.rows.length > input.limit
        };
      });
    },

    async rewrapTeamRepresentationChunkBatch(provider, input = {}) {
      if (!provider.rewrap) {
        throw new Error(
          `Envelope provider ${provider.mode} does not support Shared Memory representation rewrap`
        );
      }
      const batchSize = Math.min(Math.max(input.batchSize ?? 100, 1), 500);
      const result = await pool.query<Row>(
        `select * from team_memory_representation_chunks
          where provider_mode=$1
            and key_id=$2
            and purged_at is null
            and ($3::uuid is null or team_id=$3)
            and ($4::boolean or key_version<>$5)
            and ($6::text is null or id::text>$6)
          order by id::text asc
          limit $7`,
        [
          provider.mode,
          provider.keyId,
          input.teamId ?? null,
          input.force ?? false,
          provider.keyVersion,
          input.afterId ?? null,
          batchSize
        ]
      );

      let rewrappedRows = 0;
      if (input.dryRun) {
        return {
          processedRows: result.rows.length,
          rewrappedRows: 0,
          wouldRewrapRows: result.rows.length,
          failedRows: 0,
          done: result.rows.length < batchSize,
          nextCursorId: nullableString(result.rows.at(-1)?.id)
        };
      }
      for (const row of result.rows) {
        try {
          const envelope: EncryptedPayloadEnvelope = {
            version: numberValue(
              row.envelope_version
            ) as EncryptedPayloadEnvelope["version"],
            providerMode: stringValue(
              row.provider_mode
            ) as EncryptedPayloadEnvelope["providerMode"],
            keyId: stringValue(row.key_id),
            keyVersion: numberValue(row.key_version),
            scope: envelopeScope({
              teamId: stringValue(row.team_id),
              teamWorkspaceId: stringValue(row.team_workspace_id)
            }),
            provenance: envelopeProvenance(stringValue(row.representation_id)),
            algorithm: stringValue(
              row.algorithm
            ) as EncryptedPayloadEnvelope["algorithm"],
            ciphertext: stringValue(row.ciphertext),
            nonce: stringValue(row.nonce),
            tag: stringValue(row.tag),
            wrappedDek:
              row.wrapped_dek as EncryptedPayloadEnvelope["wrappedDek"],
            ciphertextLocation: "team_memory_representation_chunks",
            aad: row.aad as EncryptedPayloadEnvelope["aad"],
            createdAt: iso(row.envelope_created_at),
            reencryptedAt: nullableIso(row.envelope_reencrypted_at)
          };
          const rewrapped = await provider.rewrap(envelope);
          const updated = await pool.query(
            `update team_memory_representation_chunks
                set key_version=$2,
                    wrapped_dek=$3::jsonb,
                    envelope_reencrypted_at=$4,
                    verified_at=now()
              where id=$1
                and provider_mode=$5
                and key_id=$6
                and key_version=$7
                and purged_at is null`,
            [
              row.id,
              rewrapped.keyVersion,
              JSON.stringify(rewrapped.wrappedDek),
              rewrapped.reencryptedAt,
              provider.mode,
              provider.keyId,
              row.key_version
            ]
          );
          if ((updated.rowCount ?? 0) > 0) rewrappedRows += 1;
        } catch {
          throw new Error(
            `Shared Memory representation rewrap failed after ${rewrappedRows} successful row(s)`
          );
        }
      }

      return {
        processedRows: result.rows.length,
        rewrappedRows,
        wouldRewrapRows: 0,
        failedRows: 0,
        done: result.rows.length < batchSize,
        nextCursorId: nullableString(result.rows.at(-1)?.id)
      };
    },

    async readGrantRepresentation(actor, input) {
      return withTransaction(pool, async (client) => {
        await client.query(
          "set transaction isolation level repeatable read read only"
        );
        const result = await client.query(
          `select g.*,
                r.id as representation_row_id,r.consent_id as representation_consent_id,
                r.source_preview_id,r.source_artifact_id,
                r.representation,r.source_revision as representation_source_revision,
                r.source_revision_hash,r.provenance_hash,
                r.source_owner_policy_id as representation_owner_policy_id,
                r.source_owner_policy_version as representation_owner_policy_version,
                r.team_policy_id as representation_team_policy_id,
                r.team_policy_version as representation_team_policy_version,
                r.workspace_policy_id as representation_workspace_policy_id,
                r.workspace_policy_version as representation_workspace_policy_version,
                r.representation_policy_revision as representation_policy_revision_row,
                r.content_policy_version as representation_content_policy_version,
                r.classifier_version as representation_classifier_version,
                r.record_version,r.state as representation_state,r.chunk_count,
                r.created_at as representation_created_at,r.updated_at as representation_updated_at,
                r.available_at,r.stale_at,r.invalidated_at,r.invalidation_reason_code,
                c.source_revision as consent_source_revision,
                c.source_hash as consent_source_hash,
                c.representation_policy_hash as consent_representation_policy_hash,
                c.content_policy_hash as consent_content_policy_hash,
                c.classifier_hash as consent_classifier_hash,
                c.redacted_content_hash as consent_redacted_content_hash,
                sp.preview_hash as representation_preview_hash,
                sp.source_artifact_id as preview_source_artifact_id,
                sp.source_hash as preview_source_hash,
                sp.representation as preview_representation,
                sa.artifact_hash as representation_artifact_hash,
                mr.freshness_status as replica_freshness_status,
                sr.state as sync_relationship_state,
                sr.target_processing_cursor,
                c.mode as consent_mode
           from team_session_share_grants g
           join teams t on t.id=g.team_id and t.lifecycle='active' and t.entitlement_status in ('active','grace')
           join team_memberships tm on tm.team_id=g.team_id and tm.user_id=$2
             and tm.status='enabled' and tm.disabled_at is null
           join users u on u.id=tm.user_id and u.disabled_at is null and u.deleted_at is null
           join team_workspaces tw on tw.id=g.team_workspace_id and tw.team_id=g.team_id
             and tw.lifecycle='active' and tw.archived_at is null
           join team_workspace_access_grants wa on wa.team_workspace_id=tw.id
             and wa.team_id=g.team_id and wa.user_id=$2 and wa.disabled_at is null
             and wa.access in ('read','write')
           join source_owner_representation_consents c on c.id=g.consent_id
             and c.state='active' and c.revoked_at is null and (c.expires_at is null or c.expires_at>now())
           join source_owner_representation_policies op on op.policy_id=g.source_owner_policy_id
             and op.version=g.source_owner_policy_version and op.superseded_at is null
           join team_representation_policies tp on tp.policy_id=g.team_policy_id
             and tp.version=g.team_policy_version and tp.team_id=g.team_id and tp.superseded_at is null
           join workspace_representation_policies wp on wp.policy_id=g.workspace_policy_id
             and wp.version=g.workspace_policy_version and wp.team_id=g.team_id
             and wp.team_workspace_id=g.team_workspace_id and wp.superseded_at is null
           join memory_replicas mr on mr.id=g.remote_replica_id and mr.replica_role='target'
             and mr.encryption_scope='owner_private_replica' and mr.lifecycle='active' and mr.disabled_at is null
           join cross_identity_sync_relationships sr on sr.local_replica_id=mr.id
             and sr.logical_memory_id=g.logical_memory_id and sr.side='target'
             and sr.state <> 'purge_pending'
           join lateral (
             select r0.* from team_memory_representations r0
              where r0.share_grant_id=g.id and r0.consent_id=g.consent_id
                and r0.representation=g.active_representation
                and r0.state in ('available','stale')
                and r0.source_owner_policy_id=g.source_owner_policy_id
                and r0.source_owner_policy_version=g.source_owner_policy_version
                and r0.team_policy_id=g.team_policy_id
                and r0.team_policy_version=g.team_policy_version
                and r0.workspace_policy_id=g.workspace_policy_id
                and r0.workspace_policy_version=g.workspace_policy_version
                and r0.representation_policy_revision=g.representation_policy_revision
                and r0.content_policy_version=g.content_policy_version
                and r0.classifier_version=g.classifier_version
              order by r0.source_revision desc,r0.available_at desc limit 1
           ) r on true
           join shared_source_previews sp on sp.id=r.source_preview_id and sp.invalidated_at is null
           join shared_source_artifacts sa on sa.id=r.source_artifact_id and sa.invalidated_at is null
          where g.id=$1 and g.lifecycle='active' and g.revoked_at is null
            and g.active_representation=any(g.owner_allowed_representations)
            and g.active_representation=any(c.allowed_representations)
            and g.active_representation=any(op.allowed_representations)
            and g.active_representation=any(tp.allowed_representations)
            and g.active_representation=any(wp.allowed_representations)
            and ($3::shared_memory_representation is null or g.active_representation=$3)
          limit 1`,
          [input.shareGrantId, actor.userId, input.representation ?? null]
        );
        const row = result.rows[0] as Row | undefined;
        if (!row) return null;

        const grant = mapGrant(row);
        const representationRow: Row = {
          id: row.representation_row_id,
          share_grant_id: row.id,
          consent_id: row.representation_consent_id,
          source_preview_id: row.source_preview_id,
          source_artifact_id: row.source_artifact_id,
          team_id: row.team_id,
          team_workspace_id: row.team_workspace_id,
          logical_memory_id: row.logical_memory_id,
          representation: row.representation,
          source_revision: row.representation_source_revision,
          source_revision_hash: row.source_revision_hash,
          provenance_hash: row.provenance_hash,
          source_owner_policy_id: row.representation_owner_policy_id,
          source_owner_policy_version: row.representation_owner_policy_version,
          team_policy_id: row.representation_team_policy_id,
          team_policy_version: row.representation_team_policy_version,
          workspace_policy_id: row.representation_workspace_policy_id,
          workspace_policy_version: row.representation_workspace_policy_version,
          representation_policy_revision:
            row.representation_policy_revision_row,
          content_policy_version: row.representation_content_policy_version,
          classifier_version: row.representation_classifier_version,
          record_version: row.record_version,
          state: row.representation_state,
          chunk_count: row.chunk_count,
          created_at: row.representation_created_at,
          updated_at: row.representation_updated_at,
          available_at: row.available_at,
          stale_at: row.stale_at,
          invalidated_at: row.invalidated_at,
          invalidation_reason_code: row.invalidation_reason_code
        };
        const representation = mapRepresentation(representationRow);
        if (
          stringValue(row.preview_source_artifact_id) !==
            representation.sourceArtifactId ||
          stringValue(row.preview_source_hash) !==
            representation.sourceRevisionHash ||
          stringValue(row.preview_representation) !==
            representation.representation ||
          stringValue(row.representation_preview_hash).length !== 64 ||
          stringValue(row.representation_artifact_hash).length !== 64
        ) {
          throw new SharedMemoryConflictError(
            "Team representation source preview binding mismatch"
          );
        }
        const chunksResult = await client.query(
          `select id,chunk_index,aad from team_memory_representation_chunks
          where representation_id=$1 and share_grant_id=$2 and team_id=$3
            and team_workspace_id=$4 and logical_memory_id=$5 and purged_at is null
          order by chunk_index`,
          [
            representation.id,
            grant.id,
            grant.teamId,
            grant.teamWorkspaceId,
            grant.logicalMemoryId
          ]
        );
        if (chunksResult.rows.length !== representation.chunkCount)
          throw new SharedMemoryConflictError(
            "Encrypted representation chunks are incomplete"
          );

        const chunkPages = chunksResult.rows.map((rawChunk, index) => {
          const chunk = rawChunk as Row;
          const actualAad = chunk.aad as Record<string, string>;
          const itemOffset = numberValue(actualAad.itemOffset);
          const itemCount = numberValue(actualAad.itemCount);
          const totalItemCount = numberValue(actualAad.totalItemCount);
          if (
            numberValue(chunk.chunk_index) !== index ||
            !Number.isSafeInteger(itemOffset) ||
            itemOffset < 0 ||
            !Number.isSafeInteger(itemCount) ||
            itemCount < 1 ||
            !Number.isSafeInteger(totalItemCount) ||
            totalItemCount < 1 ||
            itemOffset + itemCount > totalItemCount
          ) {
            throw new SharedMemoryConflictError(
              "Encrypted representation chunk integrity check failed"
            );
          }
          return { index, itemOffset, itemCount, totalItemCount };
        });
        let itemCount = 0;
        for (const chunkPage of chunkPages) {
          if (
            chunkPage.itemOffset !== itemCount ||
            (itemCount > 0 &&
              chunkPage.totalItemCount !== chunkPages[0]!.totalItemCount)
          ) {
            throw new SharedMemoryConflictError(
              "Encrypted representation chunk paging metadata is inconsistent"
            );
          }
          itemCount += chunkPage.itemCount;
        }
        if (
          chunkPages.length === 0 ||
          itemCount !== chunkPages[0]!.totalItemCount
        ) {
          throw new SharedMemoryConflictError(
            "Encrypted representation item count is inconsistent"
          );
        }
        const pageBoundary =
          input.page?.boundary ??
          (input.page?.direction === "newer" ? 0 : itemCount);
        if (
          !Number.isSafeInteger(pageBoundary) ||
          pageBoundary < 0 ||
          pageBoundary > itemCount ||
          (input.page &&
            (!Number.isSafeInteger(input.page.limit) ||
              input.page.limit < 1 ||
              input.page.limit > MAX_SOURCE_ITEMS))
        ) {
          throw new SharedMemoryConflictError(
            "Shared Memory source page is outside the current representation"
          );
        }
        const itemOffset =
          input.page?.direction === "newer"
            ? pageBoundary
            : Math.max(0, pageBoundary - (input.page?.limit ?? itemCount));
        const itemEnd =
          input.page?.direction === "newer"
            ? Math.min(
                itemCount,
                pageBoundary + (input.page?.limit ?? itemCount)
              )
            : pageBoundary;
        const selectedChunkPages = chunkPages.filter(
          (chunkPage) =>
            chunkPage.itemOffset < itemEnd &&
            chunkPage.itemOffset + chunkPage.itemCount > itemOffset
        );
        const selectedChunks =
          selectedChunkPages.length === 0
            ? []
            : (
                await client.query(
                  `select * from team_memory_representation_chunks
                    where representation_id=$1 and share_grant_id=$2 and team_id=$3
                      and team_workspace_id=$4 and logical_memory_id=$5
                      and purged_at is null and chunk_index=any($6::integer[])
                    order by chunk_index`,
                  [
                    representation.id,
                    grant.id,
                    grant.teamId,
                    grant.teamWorkspaceId,
                    grant.logicalMemoryId,
                    selectedChunkPages.map(({ index }) => index)
                  ]
                )
              ).rows;
        if (selectedChunks.length !== selectedChunkPages.length) {
          throw new SharedMemoryConflictError(
            "Encrypted representation page chunks are incomplete"
          );
        }

        // Every request-time authorization predicate above completes before key resolution or decryption.
        const selectedItems: SharedMemoryRedactedSourceItemDto[] = [];
        let expectedRedactedContentHash: string | null = null;
        for (
          let selectedIndex = 0;
          selectedIndex < selectedChunkPages.length;
          selectedIndex += 1
        ) {
          const chunkPage = selectedChunkPages[selectedIndex]!;
          const chunk = selectedChunks[selectedIndex] as Row;
          const { index } = chunkPage;
          if (
            numberValue(chunk.chunk_index) !== index ||
            ciphertextHash(stringValue(chunk.ciphertext)) !==
              chunk.ciphertext_hash
          ) {
            throw new SharedMemoryConflictError(
              "Encrypted representation chunk integrity check failed"
            );
          }
          const actualAad = chunk.aad as Record<string, string>;
          const binding: SharedMemorySourceBindingDto = {
            sourceRevision: representation.sourceRevision,
            sourceHash: representation.sourceRevisionHash,
            representationPolicyRevision:
              representation.representationPolicyRevision,
            representationPolicyHash: stringValue(
              actualAad.representationPolicyHash
            ),
            contentPolicyVersion: representation.contentPolicyVersion,
            contentPolicyHash: stringValue(actualAad.contentPolicyHash),
            classifierVersion: representation.classifierVersion,
            classifierHash: stringValue(actualAad.classifierHash)
          };
          const redactedContentHash = stringValue(
            actualAad.redactedContentHash
          );
          if (
            actualAad.representationPolicyHash !==
              row.consent_representation_policy_hash ||
            actualAad.contentPolicyHash !== row.consent_content_policy_hash ||
            actualAad.classifierHash !== row.consent_classifier_hash ||
            (representation.sourceRevision ===
              numberValue(row.consent_source_revision) &&
              (representation.sourceRevisionHash !== row.consent_source_hash ||
                redactedContentHash !== row.consent_redacted_content_hash))
          ) {
            throw new SharedMemoryConflictError(
              "Encrypted representation consent binding mismatch"
            );
          }
          const expectedProvenanceHash = crossIdentitySyncDigest({
            shareGrantId: grant.id,
            consentId: grant.consentId,
            logicalMemoryId: grant.logicalMemoryId,
            representation: representation.representation,
            binding,
            redactedContentHash,
            sourceOwnerPolicyId: grant.sourceOwnerPolicyId,
            sourceOwnerPolicyVersion: grant.sourceOwnerPolicyVersion,
            teamPolicyId: grant.teamPolicyId,
            teamPolicyVersion: grant.teamPolicyVersion,
            workspacePolicyId: grant.workspacePolicyId,
            workspacePolicyVersion: grant.workspacePolicyVersion
          });
          if (expectedProvenanceHash !== representation.provenanceHash) {
            throw new SharedMemoryConflictError(
              "Encrypted representation provenance binding mismatch"
            );
          }
          const expectedAad = envelopeAad({
            representationId: representation.id,
            shareGrantId: grant.id,
            teamId: grant.teamId,
            teamWorkspaceId: grant.teamWorkspaceId,
            logicalMemoryId: grant.logicalMemoryId,
            consentId: grant.consentId,
            representation: representation.representation,
            chunkIndex: index,
            chunkCount: representation.chunkCount,
            itemOffset: chunkPage.itemOffset,
            itemCount: chunkPage.itemCount,
            totalItemCount: chunkPage.totalItemCount,
            binding,
            redactedContentHash,
            provenanceHash: representation.provenanceHash
          });
          if (!aadMatches(actualAad, expectedAad))
            throw new SharedMemoryConflictError(
              "Encrypted representation AAD does not match its grant scope"
            );
          expectedRedactedContentHash ??= redactedContentHash;
          if (expectedRedactedContentHash !== redactedContentHash)
            throw new SharedMemoryConflictError(
              "Encrypted chunks disagree on content binding"
            );
          const provider = await options.resolveTeamEncryptionProvider({
            teamId: grant.teamId,
            purpose: "decrypt",
            keyId: stringValue(chunk.key_id),
            keyVersion: numberValue(chunk.key_version)
          });
          const envelope: EncryptedPayloadEnvelope = {
            version: numberValue(
              chunk.envelope_version
            ) as EncryptedPayloadEnvelope["version"],
            providerMode: stringValue(
              chunk.provider_mode
            ) as EncryptedPayloadEnvelope["providerMode"],
            keyId: stringValue(chunk.key_id),
            keyVersion: numberValue(chunk.key_version),
            scope: envelopeScope({
              teamId: grant.teamId,
              teamWorkspaceId: grant.teamWorkspaceId
            }),
            provenance: envelopeProvenance(representation.id),
            algorithm: stringValue(
              chunk.algorithm
            ) as EncryptedPayloadEnvelope["algorithm"],
            ciphertext: stringValue(chunk.ciphertext),
            nonce: stringValue(chunk.nonce),
            tag: stringValue(chunk.tag),
            wrappedDek:
              chunk.wrapped_dek as EncryptedPayloadEnvelope["wrappedDek"],
            ciphertextLocation: "team_memory_representation_chunks",
            aad: actualAad,
            createdAt: iso(chunk.envelope_created_at),
            reencryptedAt: nullableIso(chunk.envelope_reencrypted_at)
          };
          const plaintext = Buffer.from(
            await provider.decrypt(envelope)
          ).toString("utf8");
          let parsed: unknown;
          try {
            parsed = JSON.parse(plaintext) as unknown;
          } catch {
            throw new SharedMemoryConflictError(
              "Encrypted representation plaintext is invalid JSON"
            );
          }
          if (!Array.isArray(parsed))
            throw new SharedMemoryConflictError(
              "Encrypted representation plaintext is not a source item chunk"
            );
          if (parsed.length !== chunkPage.itemCount) {
            throw new SharedMemoryConflictError(
              "Encrypted representation chunk item count is inconsistent"
            );
          }
          for (const item of parsed as SharedMemoryRedactedSourceItemDto[]) {
            selectedItems.push(
              redactEligibleSharedMemorySourceItem({
                representation: representation.representation,
                logicalMemoryId: grant.logicalMemoryId,
                sourceRevision: representation.sourceRevision,
                item
              })
            );
          }
        }
        const selectedItemOffset =
          selectedChunkPages[0]?.itemOffset ?? itemOffset;
        const pageItems = selectedItems.slice(
          itemOffset - selectedItemOffset,
          itemEnd - selectedItemOffset
        );
        if (
          itemOffset === 0 &&
          itemEnd === itemCount &&
          (!expectedRedactedContentHash ||
            crossIdentitySyncDigest(pageItems) !== expectedRedactedContentHash)
        )
          throw new SharedMemoryConflictError(
            "Decrypted representation content hash mismatch"
          );
        const grantScopedItems = pageItems.map((item) => {
          const content = item.content;
          const contentSourceIds = (content as { sourceIds?: unknown[] })
            .sourceIds;
          const pseudonymousSourceId = sharedMemoryGrantScopedSourceId(
            grant.id,
            item.sourceId
          );
          const pseudonymousContent =
            Array.isArray(contentSourceIds) &&
            contentSourceIds.every((value) => typeof value === "string")
              ? {
                  ...content,
                  sourceIds: (contentSourceIds as string[]).map((sourceId) =>
                    sharedMemoryGrantScopedSourceId(grant.id, sourceId)
                  )
                }
              : content;
          return {
            ...item,
            sourceId: pseudonymousSourceId,
            content: pseudonymousContent
          };
        });
        return {
          grant,
          representation,
          items: grantScopedItems,
          sourcePage: { itemOffset, itemCount },
          freshness:
            representation.state === "stale" ||
            row.replica_freshness_status === "stale" ||
            row.sync_relationship_state === "stale" ||
            row.sync_relationship_state === "revoked" ||
            (row.consent_mode === "continuous" &&
              representation.sourceRevision <
                numberValue(row.target_processing_cursor))
              ? "stale"
              : "fresh",
          companionScope: grant.companionScope
        };
      });
    }
  };
  return repository;
};
