import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import type pg from "pg";
import {
  PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
  PRIVACY_CLASSIFICATION_AGGREGATE_FIELD_LIMIT,
  PRIVACY_REPLACEMENT_CONTRACT_VERSION,
  privacyClassificationAggregateResponseSchema,
  privacyClassificationFieldRequestSchema,
  privacyMaterializationSourceAdapters,
  privacyClassifierHash,
  privacyContentPolicyHash,
  privacyDetectedSpanSchema,
  privacyLabelPolicySchema,
  resolveEffectivePrivacyPolicy,
  type EnvelopeEncryptionProvider,
  type PrivacyClassificationResponse,
  type PrivacyDetectedSpan,
  type PrivacyLabelPolicy
} from "@koed/shared";
import {
  decryptAuthorizedEncryptedFieldPayloadWithClient,
  decryptTeamEncryptedFieldAfterAuthorizationWithClient,
  upsertEncryptedFieldPayloadWithClient,
  type EncryptedFieldSourceTable
} from "./encrypted-payload-repository.js";
import type { ActorContext } from "./types.js";

const CLASSIFICATION_SOURCE: EncryptedFieldSourceTable =
  "privacy_classification_results";
const SANITIZED_ARTIFACT_SOURCE: EncryptedFieldSourceTable =
  "privacy_sanitized_source_artifacts";
const SANITIZED_CHUNK_SOURCE: EncryptedFieldSourceTable =
  "privacy_sanitized_source_chunks";
const CLASSIFICATION_PAYLOAD_COLUMN = "detected_spans";
const SANITIZED_METADATA_COLUMN = "sanitized_metadata";
const SANITIZED_CHUNK_COLUMN = "sanitized_text";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type PrivacyClassifierGenerationStatus =
  | "staged"
  | "active"
  | "retired"
  | "revoked";

export interface PrivacyClassifierGenerationRecord {
  id: string;
  version: number;
  classifierHash: string;
  modelKey: string;
  modelRevision: string;
  artifactSha256: string;
  tokenizerSha256: string;
  decoderSha256: string;
  calibrationSha256: string;
  deterministicDetectorVersion: string;
  inputContractVersion: string;
  status: PrivacyClassifierGenerationStatus;
  createdAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
  revokedAt: string | null;
  revocationReasonCode: string | null;
}

export type PrivacyContentPolicyScope =
  | "deployment"
  | "source_owner"
  | "team"
  | "workspace";
export type PrivacyContentPolicyStatus = "active" | "superseded" | "revoked";

export interface PrivacyContentPolicySubject {
  deploymentIdentityId: string;
  sourceOwnerUserId?: string | null;
  teamId?: string | null;
  teamWorkspaceId?: string | null;
}

export interface PrivacyContentPolicyRecord extends PrivacyContentPolicySubject {
  id: string;
  policyId: string;
  version: number;
  scope: PrivacyContentPolicyScope;
  labels: PrivacyLabelPolicy;
  replacementContractVersion: string;
  policyHash: string;
  status: PrivacyContentPolicyStatus;
  effectiveAt: string;
  createdAt: string;
  supersededAt: string | null;
  revokedAt: string | null;
  revocationReasonCode: string | null;
}

export interface EffectivePrivacyContentPolicy {
  labels: PrivacyLabelPolicy;
  effectivePolicyHash: string;
  policies: PrivacyContentPolicyRecord[];
}

export type PrivacyClassificationResultStatus =
  | "pending"
  | "ready"
  | "failed"
  | "invalidated";

export interface PrivacyClassificationResultRecord {
  id: string;
  ownerUserId: string;
  classifierGenerationId: string;
  classifierHash: string;
  ownerContentFingerprint: string;
  inputByteLength: number;
  payloadBindingHash: string | null;
  spanCount: number | null;
  status: PrivacyClassificationResultStatus;
  failureCode: string | null;
  createdAt: string;
  readyAt: string | null;
  invalidatedAt: string | null;
  invalidationReasonCode: string | null;
}

export interface DecryptedPrivacyClassificationResult {
  record: PrivacyClassificationResultRecord;
  fields: Array<{
    path: string;
    inputSha256: string;
    inputByteLength: number;
    spans: PrivacyDetectedSpan[];
  }>;
}

export interface PrivacySanitizedSourceChunkRecord {
  id: string;
  artifactId: string;
  classificationResultId: string;
  chunkIndex: number;
  sourceStartByte: number;
  sourceEndByte: number;
  sanitizedByteLength: number;
  ownerChunkFingerprint: string;
  payloadBindingHash: string;
}

export interface PrivacySanitizedSourceArtifactRecord {
  id: string;
  shareGrantId: string;
  sourceArtifactId: string;
  ownerUserId: string;
  teamId: string;
  teamWorkspaceId: string;
  classifierGenerationId: string;
  classifierHash: string;
  effectivePolicyHash: string;
  sourceFrontierHash: string;
  sourceFrontierCursor: number;
  sourceSegmentCount: number;
  sourceClosureHash: string | null;
  ownerManifestFingerprint: string;
  metadataBindingHash: string | null;
  artifactBindingHash: string | null;
  chunkCount: number;
  sanitizedByteCount: number;
  format: string;
  formatVersion: number;
  status: "pending" | "ready" | "failed" | "invalidated";
  failureCode: string | null;
  createdAt: string;
  readyAt: string | null;
  invalidatedAt: string | null;
  invalidationReasonCode: string | null;
}

export interface DecryptedPrivacySanitizedSourceArtifact {
  record: PrivacySanitizedSourceArtifactRecord;
  metadata: unknown;
  chunks: Array<{
    record: PrivacySanitizedSourceChunkRecord;
    text: string;
  }>;
}

export interface PrivacySanitizedSourceManifest {
  record: PrivacySanitizedSourceArtifactRecord;
  chunks: PrivacySanitizedSourceChunkRecord[];
}

export interface DecryptedPrivacySanitizedSourceChunk {
  artifact: PrivacySanitizedSourceArtifactRecord;
  chunk: {
    record: PrivacySanitizedSourceChunkRecord;
    text: string;
  };
}

export interface PrivacySourceMaterializationTarget {
  shareGrantId: string;
  ownerUserId: string;
  teamId: string;
  teamWorkspaceId: string;
  mode: "snapshot" | "continuous";
  sourceArtifactId: string;
  sourceKind: string;
  artifactFormat: string;
  artifactFormatVersion: number;
  sourceFrontierCursor: number;
  sourceSegmentCount: number;
  throughSegmentIndex: number;
  headContentDigest: string;
  sourceClosureHash: string | null;
}

export class PrivacyClassificationConflictError extends Error {
  statusCode = 409;
  constructor(message = "Privacy classification state conflict") {
    super(message);
    this.name = "PrivacyClassificationConflictError";
  }
}

export class PrivacyClassificationMismatchError extends Error {
  statusCode = 422;
  constructor(message = "Privacy classification binding mismatch") {
    super(message);
    this.name = "PrivacyClassificationMismatchError";
  }
}

export class PrivacyClassificationUnavailableError extends Error {
  statusCode = 503;
  constructor(message = "Privacy classification material is unavailable") {
    super(message);
    this.name = "PrivacyClassificationUnavailableError";
  }
}

interface ClassificationPayload {
  version: 1;
  resultId: string;
  ownerUserId: string;
  ownerContentFingerprint: string;
  classifierGenerationId: string;
  classifierHash: string;
  inputByteLength: number;
  fields: Array<{
    path: string;
    inputSha256: string;
    inputByteLength: number;
    spans: PrivacyDetectedSpan[];
  }>;
}

type Row = Record<string, unknown>;
type Queryable = pg.Pool | pg.PoolClient;

const stringValue = (value: unknown): string => {
  if (typeof value !== "string") throw new TypeError("Expected string value");
  return value;
};

const nullableString = (value: unknown): string | null =>
  value === null || value === undefined ? null : stringValue(value);

const numberValue = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new TypeError("Expected integer value");
  return parsed;
};

const nullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : numberValue(value);

const iso = (value: unknown): string => {
  if (!(value instanceof Date) && typeof value !== "string") {
    throw new TypeError("Expected timestamp value");
  }
  return new Date(value).toISOString();
};

const nullableIso = (value: unknown): string | null =>
  value === null || value === undefined ? null : iso(value);

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};

const assertSha256 = (value: string, label: string): void => {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
};

const safeHashEqual = (left: string, right: string): boolean => {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
};

const fingerprintKey = (value: string | Uint8Array): Buffer => {
  const key =
    typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  if (key.byteLength < 32) {
    throw new TypeError(
      "Privacy fingerprint key must contain at least 32 bytes"
    );
  }
  return key;
};

const keyedHash = (
  key: Buffer,
  domain: string,
  ownerUserId: string,
  value: string | Uint8Array
): string => {
  const hmac = createHmac("sha256", key);
  hmac.update(`koed:${domain}:v1\0${ownerUserId}\0`, "utf8");
  hmac.update(value);
  return hmac.digest("hex");
};

export const ownerScopedPrivacyContentFingerprint = (input: {
  fingerprintKey: string | Uint8Array;
  ownerUserId: string;
  text: string;
}): string =>
  keyedHash(
    fingerprintKey(input.fingerprintKey),
    "privacy-content",
    input.ownerUserId,
    Buffer.from(input.text, "utf8")
  );

export const privacySourceFrontierHash = (input: {
  sourceArtifactId: string;
  sourceFrontierCursor: number;
  sourceSegmentCount: number;
  headContentDigest: string | null;
}): string => {
  if (
    !Number.isSafeInteger(input.sourceFrontierCursor) ||
    input.sourceFrontierCursor < 0 ||
    !Number.isSafeInteger(input.sourceSegmentCount) ||
    input.sourceSegmentCount < 0 ||
    (input.headContentDigest !== null &&
      !SHA256_PATTERN.test(input.headContentDigest))
  ) {
    throw new TypeError("Invalid Conversation Source frontier identity");
  }
  return createHash("sha256")
    .update(
      canonicalJson({
        contract: "koed-conversation-source-frontier-v1",
        sourceArtifactId: input.sourceArtifactId,
        sourceFrontierCursor: input.sourceFrontierCursor,
        sourceSegmentCount: input.sourceSegmentCount,
        headContentDigest: input.headContentDigest
      })
    )
    .digest("hex");
};

const bindingHash = (
  key: Buffer,
  ownerUserId: string,
  domain: string,
  value: unknown
): string => keyedHash(key, domain, ownerUserId, canonicalJson(value));

const mapClassifierGeneration = (
  row: Row
): PrivacyClassifierGenerationRecord => ({
  id: stringValue(row.id),
  version: numberValue(row.version),
  classifierHash: stringValue(row.classifier_hash),
  modelKey: stringValue(row.model_key),
  modelRevision: stringValue(row.model_revision),
  artifactSha256: stringValue(row.artifact_sha256),
  tokenizerSha256: stringValue(row.tokenizer_sha256),
  decoderSha256: stringValue(row.decoder_sha256),
  calibrationSha256: stringValue(row.calibration_sha256),
  deterministicDetectorVersion: stringValue(row.deterministic_detector_version),
  inputContractVersion: stringValue(row.input_contract_version),
  status: stringValue(row.status) as PrivacyClassifierGenerationStatus,
  createdAt: iso(row.created_at),
  activatedAt: nullableIso(row.activated_at),
  retiredAt: nullableIso(row.retired_at),
  revokedAt: nullableIso(row.revoked_at),
  revocationReasonCode: nullableString(row.revocation_reason_code)
});

const mapPolicy = (row: Row): PrivacyContentPolicyRecord => {
  const labels = privacyLabelPolicySchema.parse(row.labels);
  return {
    id: stringValue(row.id),
    policyId: stringValue(row.policy_id),
    version: numberValue(row.version),
    scope: stringValue(row.scope) as PrivacyContentPolicyScope,
    deploymentIdentityId: stringValue(row.deployment_identity_id),
    sourceOwnerUserId: nullableString(row.source_owner_user_id),
    teamId: nullableString(row.team_id),
    teamWorkspaceId: nullableString(row.team_workspace_id),
    labels,
    replacementContractVersion: stringValue(row.replacement_contract_version),
    policyHash: stringValue(row.policy_hash),
    status: stringValue(row.status) as PrivacyContentPolicyStatus,
    effectiveAt: iso(row.effective_at),
    createdAt: iso(row.created_at),
    supersededAt: nullableIso(row.superseded_at),
    revokedAt: nullableIso(row.revoked_at),
    revocationReasonCode: nullableString(row.revocation_reason_code)
  };
};

const mapClassificationResult = (
  row: Row
): PrivacyClassificationResultRecord => ({
  id: stringValue(row.id),
  ownerUserId: stringValue(row.owner_user_id),
  classifierGenerationId: stringValue(row.classifier_generation_id),
  classifierHash: stringValue(row.classifier_hash),
  ownerContentFingerprint: stringValue(row.owner_content_fingerprint),
  inputByteLength: numberValue(row.input_byte_length),
  payloadBindingHash: nullableString(row.payload_binding_hash),
  spanCount: nullableNumber(row.span_count),
  status: stringValue(row.status) as PrivacyClassificationResultStatus,
  failureCode: nullableString(row.failure_code),
  createdAt: iso(row.created_at),
  readyAt: nullableIso(row.ready_at),
  invalidatedAt: nullableIso(row.invalidated_at),
  invalidationReasonCode: nullableString(row.invalidation_reason_code)
});

const mapSanitizedArtifact = (
  row: Row
): PrivacySanitizedSourceArtifactRecord => ({
  id: stringValue(row.id),
  shareGrantId: stringValue(row.share_grant_id),
  sourceArtifactId: stringValue(row.source_artifact_id),
  ownerUserId: stringValue(row.owner_user_id),
  teamId: stringValue(row.team_id),
  teamWorkspaceId: stringValue(row.team_workspace_id),
  classifierGenerationId: stringValue(row.classifier_generation_id),
  classifierHash: stringValue(row.classifier_hash),
  effectivePolicyHash: stringValue(row.effective_policy_hash),
  sourceFrontierHash: stringValue(row.source_frontier_hash),
  sourceFrontierCursor: numberValue(row.source_frontier_cursor),
  sourceSegmentCount: numberValue(row.source_segment_count),
  sourceClosureHash: nullableString(row.source_closure_hash),
  ownerManifestFingerprint: stringValue(row.owner_manifest_fingerprint),
  metadataBindingHash: nullableString(row.metadata_binding_hash),
  artifactBindingHash: nullableString(row.artifact_binding_hash),
  chunkCount: numberValue(row.chunk_count),
  sanitizedByteCount: numberValue(row.sanitized_byte_count),
  format: stringValue(row.format),
  formatVersion: numberValue(row.format_version),
  status: stringValue(
    row.status
  ) as PrivacySanitizedSourceArtifactRecord["status"],
  failureCode: nullableString(row.failure_code),
  createdAt: iso(row.created_at),
  readyAt: nullableIso(row.ready_at),
  invalidatedAt: nullableIso(row.invalidated_at),
  invalidationReasonCode: nullableString(row.invalidation_reason_code)
});

const mapSanitizedChunk = (row: Row): PrivacySanitizedSourceChunkRecord => ({
  id: stringValue(row.id),
  artifactId: stringValue(row.artifact_id),
  classificationResultId: stringValue(row.classification_result_id),
  chunkIndex: numberValue(row.chunk_index),
  sourceStartByte: numberValue(row.source_start_byte),
  sourceEndByte: numberValue(row.source_end_byte),
  sanitizedByteLength: numberValue(row.sanitized_byte_length),
  ownerChunkFingerprint: stringValue(row.owner_chunk_fingerprint),
  payloadBindingHash: stringValue(row.payload_binding_hash)
});

const validatePolicyBinding = (policy: PrivacyContentPolicyRecord): void => {
  const expected = privacyContentPolicyHash({
    labels: policy.labels,
    replacementContractVersion: policy.replacementContractVersion
  });
  if (!safeHashEqual(expected, policy.policyHash)) {
    throw new PrivacyClassificationMismatchError(
      `Privacy ${policy.scope} policy hash mismatch`
    );
  }
};

export const resolveMonotonicPrivacyPolicySet = (
  policies: readonly PrivacyContentPolicyRecord[]
): EffectivePrivacyContentPolicy => {
  for (const policy of policies) validatePolicyBinding(policy);
  const ordered = [...policies].sort(
    (left, right) =>
      ["deployment", "source_owner", "team", "workspace"].indexOf(left.scope) -
      ["deployment", "source_owner", "team", "workspace"].indexOf(right.scope)
  );
  const labels = resolveEffectivePrivacyPolicy(
    ...ordered.map((policy) => policy.labels)
  );
  const effectivePolicyHash = createHash("sha256")
    .update(
      canonicalJson({
        replacementContractVersion: PRIVACY_REPLACEMENT_CONTRACT_VERSION,
        policies: ordered.map((policy) => ({
          scope: policy.scope,
          policyId: policy.policyId,
          version: policy.version,
          policyHash: policy.policyHash
        })),
        labels
      })
    )
    .digest("hex");
  return { labels, effectivePolicyHash, policies: ordered };
};

const policySubject = (
  scope: PrivacyContentPolicyScope,
  subject: PrivacyContentPolicySubject
): [string | null, string | null, string | null] => {
  const owner = subject.sourceOwnerUserId ?? null;
  const team = subject.teamId ?? null;
  const workspace = subject.teamWorkspaceId ?? null;
  const valid =
    (scope === "deployment" && !owner && !team && !workspace) ||
    (scope === "source_owner" && Boolean(owner) && !team && !workspace) ||
    (scope === "team" && !owner && Boolean(team) && !workspace) ||
    (scope === "workspace" && !owner && Boolean(team) && Boolean(workspace));
  if (!valid) throw new TypeError(`Invalid ${scope} privacy policy subject`);
  return [owner, team, workspace];
};

const selectClassificationResult = `
  select
    r.id, r.owner_user_id, r.classifier_generation_id, r.classifier_hash,
    r.owner_content_fingerprint, r.input_byte_length, r.payload_binding_hash,
    r.span_count, r.status, r.failure_code, r.created_at, r.ready_at,
    r.invalidated_at, r.invalidation_reason_code
  from privacy_classification_results r
`;

const selectSanitizedArtifact = `
  select
    a.id, a.share_grant_id, a.source_artifact_id, a.owner_user_id, a.team_id,
    a.team_workspace_id, a.classifier_generation_id, a.classifier_hash,
    a.effective_policy_hash, a.source_frontier_hash,
    a.source_frontier_cursor, a.source_segment_count, a.source_closure_hash,
    a.owner_manifest_fingerprint, a.metadata_binding_hash,
    a.artifact_binding_hash, a.chunk_count, a.sanitized_byte_count,
    a.format, a.format_version, a.status, a.failure_code, a.created_at,
    a.ready_at, a.invalidated_at, a.invalidation_reason_code
  from privacy_sanitized_source_artifacts a
`;

export interface PrivacyClassificationRepository {
  getActiveClassifierGeneration(): Promise<PrivacyClassifierGenerationRecord | null>;
  getLocalDeploymentIdentityId(): Promise<string | null>;
  registerClassifierGeneration(input: {
    version: number;
    classifierHash?: string;
    modelKey: string;
    modelRevision: string;
    artifactSha256: string;
    tokenizerSha256: string;
    decoderSha256: string;
    calibrationSha256: string;
    deterministicDetectorVersion: string;
    inputContractVersion?: string;
  }): Promise<PrivacyClassifierGenerationRecord>;
  activateClassifierGeneration(
    generationId: string
  ): Promise<PrivacyClassifierGenerationRecord>;
  createContentPolicyVersion(input: {
    scope: PrivacyContentPolicyScope;
    subject: PrivacyContentPolicySubject;
    labels: PrivacyLabelPolicy;
    expectedPreviousVersion: number;
    policyId?: string;
    effectiveAt?: Date;
    replacementContractVersion?: string;
  }): Promise<PrivacyContentPolicyRecord>;
  resolveEffectiveContentPolicy(
    subject: PrivacyContentPolicySubject,
    options?: { at?: Date }
  ): Promise<EffectivePrivacyContentPolicy>;
  listSourceMaterializationTargets(input: {
    limit: number;
  }): Promise<PrivacySourceMaterializationTarget[]>;
  findReadySanitizedSourceArtifact(input: {
    actor: ActorContext;
    shareGrantId: string;
    sourceArtifactId: string;
    teamId: string;
    teamWorkspaceId: string;
    classifierHash: string;
    effectivePolicyHash: string;
    sourceFrontierHash: string;
  }): Promise<PrivacySanitizedSourceArtifactRecord | null>;
  findCachedClassification(input: {
    actor: ActorContext;
    classifierHash: string;
    fields: Array<{ path: string; text: string }>;
  }): Promise<PrivacyClassificationResultRecord | null>;
  getOrCreateStructuralClassificationBinding(input: {
    actor: ActorContext;
    provider: EnvelopeEncryptionProvider;
    classifierHash: string;
  }): Promise<PrivacyClassificationResultRecord>;
  storeClassificationResult(input: {
    actor: ActorContext;
    provider: EnvelopeEncryptionProvider;
    fields: Array<{ path: string; text: string }>;
    response: PrivacyClassificationResponse;
  }): Promise<PrivacyClassificationResultRecord>;
  readClassificationResult(input: {
    actor: ActorContext;
    provider: EnvelopeEncryptionProvider;
    resultId: string;
    expectedFields?: Array<{ path: string; text: string }>;
    expectedClassifierHash?: string;
  }): Promise<DecryptedPrivacyClassificationResult | null>;
  invalidateClassificationResult(input: {
    actor: ActorContext;
    resultId: string;
    reasonCode: string;
  }): Promise<boolean>;
  storeSanitizedSourceArtifact(input: {
    actor: ActorContext;
    provider: EnvelopeEncryptionProvider;
    shareGrantId: string;
    sourceArtifactId: string;
    teamId: string;
    teamWorkspaceId: string;
    classifierHash: string;
    effectivePolicyHash: string;
    sourceFrontierHash: string;
    sourceFrontierCursor: number;
    sourceSegmentCount: number;
    sourceClosureHash?: string | null;
    format: string;
    formatVersion: number;
    metadata: unknown;
    chunks: Array<{
      classificationResultId: string;
      sourceStartByte: number;
      sourceEndByte: number;
      text: string;
    }>;
  }): Promise<PrivacySanitizedSourceArtifactRecord>;
  readLatestSanitizedSourceArtifactByGrant(input: {
    actor: ActorContext;
    provider: EnvelopeEncryptionProvider;
    shareGrantId: string;
  }): Promise<DecryptedPrivacySanitizedSourceArtifact | null>;
  readLatestSanitizedSourceManifestByGrant(input: {
    actor: ActorContext;
    shareGrantId: string;
  }): Promise<PrivacySanitizedSourceManifest | null>;
  readSanitizedSourceChunkByGrant(input: {
    actor: ActorContext;
    provider: EnvelopeEncryptionProvider;
    shareGrantId: string;
    sanitizedArtifactId: string;
    chunkId: string;
  }): Promise<DecryptedPrivacySanitizedSourceChunk | null>;
  invalidateSanitizedSourceArtifact(input: {
    actor: ActorContext;
    artifactId: string;
    reasonCode: string;
  }): Promise<boolean>;
}

export const createPrivacyClassificationRepository = (
  pool: pg.Pool,
  options: { fingerprintKey: string | Uint8Array }
): PrivacyClassificationRepository => {
  const key = fingerprintKey(options.fingerprintKey);
  const validatedFields = (
    fields: Array<{ path: string; text: string }>
  ): Array<{ path: string; text: string }> => {
    if (
      fields.length < 1 ||
      fields.length > PRIVACY_CLASSIFICATION_AGGREGATE_FIELD_LIMIT
    ) {
      throw new TypeError(
        `Privacy classification field count must be between 1 and ${PRIVACY_CLASSIFICATION_AGGREGATE_FIELD_LIMIT}`
      );
    }
    const parsed = fields.map((field) =>
      privacyClassificationFieldRequestSchema.parse(field)
    );
    if (new Set(parsed.map((field) => field.path)).size !== parsed.length) {
      throw new TypeError("Privacy field paths must be distinct");
    }
    return parsed;
  };
  const ownerFieldsFingerprint = (
    ownerUserId: string,
    fields: Array<{ path: string; text: string }>
  ): string =>
    keyedHash(key, "privacy-fields", ownerUserId, canonicalJson(fields));

  const withTransaction = async <T>(
    operation: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  };

  const findCachedWith = async (
    queryable: Queryable,
    actor: ActorContext,
    classifierHash: string,
    fingerprint: string
  ): Promise<PrivacyClassificationResultRecord | null> => {
    const result = await queryable.query<Row>(
      `
        ${selectClassificationResult}
        join privacy_classifier_generations g
          on g.id = r.classifier_generation_id
         and g.classifier_hash = r.classifier_hash
         and g.status in ('active','retired')
        where r.owner_user_id = $1
          and r.classifier_hash = $2
          and r.owner_content_fingerprint = $3
          and r.status = 'ready'
          and r.invalidated_at is null
        limit 1
      `,
      [actor.userId, classifierHash, fingerprint]
    );
    return result.rows[0] ? mapClassificationResult(result.rows[0]) : null;
  };

  const readCurrentSanitizedManifestWithClient = async (
    client: pg.PoolClient,
    input: {
      actor: ActorContext;
      shareGrantId: string;
      sanitizedArtifactId?: string;
    }
  ): Promise<PrivacySanitizedSourceManifest | null> => {
    const access = await client.query<Row>(
      `select source_grant.owner_user_id, source_grant.team_id,
              source_grant.team_workspace_id
         from team_conversation_source_grants source_grant
         join team_memory_share_grants share_grant
           on share_grant.id=source_grant.share_grant_id
          and share_grant.owner_user_id=source_grant.owner_user_id
          and share_grant.team_id=source_grant.team_id
          and share_grant.team_workspace_id=source_grant.team_workspace_id
          and share_grant.lifecycle='active' and share_grant.revoked_at is null
          and share_grant.personal_deleted_at is null
         join source_owner_representation_consents consent
           on consent.id=share_grant.consent_id
          and consent.state='active' and consent.revoked_at is null
          and (consent.expires_at is null or consent.expires_at > now())
         join users source_owner on source_owner.id=source_grant.owner_user_id
          and source_owner.disabled_at is null and source_owner.deleted_at is null
         join teams team on team.id=source_grant.team_id
          and team.lifecycle='active'
          and team.entitlement_status in ('active','grace')
         join team_workspaces workspace
           on workspace.id=source_grant.team_workspace_id
          and workspace.team_id=source_grant.team_id
          and workspace.lifecycle='active' and workspace.archived_at is null
         join team_memberships membership
           on membership.team_id=source_grant.team_id
          and membership.user_id=$2
          and membership.status='enabled' and membership.disabled_at is null
         join users viewer on viewer.id=membership.user_id
          and viewer.disabled_at is null and viewer.deleted_at is null
         join team_workspace_access_grants workspace_access
           on workspace_access.team_workspace_id=source_grant.team_workspace_id
          and workspace_access.team_id=source_grant.team_id
          and workspace_access.user_id=$2
          and workspace_access.access in ('read','write')
          and workspace_access.disabled_at is null
        where source_grant.share_grant_id=$1
          and source_grant.lifecycle='active' and source_grant.revoked_at is null
        limit 1`,
      [input.shareGrantId, input.actor.userId]
    );
    const authorized = access.rows[0];
    if (!authorized) return null;
    const ownerUserId = stringValue(authorized.owner_user_id);
    const teamId = stringValue(authorized.team_id);
    const teamWorkspaceId = stringValue(authorized.team_workspace_id);
    const generationResult = await client.query<Row>(
      "select * from privacy_classifier_generations where status='active' limit 1"
    );
    if (!generationResult.rows[0]) return null;
    const generation = mapClassifierGeneration(generationResult.rows[0]);
    const policyResult = await client.query<Row>(
      `select policy.*
         from privacy_content_policies policy
         join deployment_identities deployment
           on deployment.id=policy.deployment_identity_id
          and deployment.locality='local' and deployment.disabled_at is null
        where policy.status='active' and policy.effective_at <= now()
          and (
            (policy.scope='deployment' and policy.source_owner_user_id is null
              and policy.team_id is null and policy.team_workspace_id is null)
            or (policy.scope='source_owner' and policy.source_owner_user_id=$1
              and policy.team_id is null and policy.team_workspace_id is null)
            or (policy.scope='team' and policy.source_owner_user_id is null
              and policy.team_id=$2 and policy.team_workspace_id is null)
            or (policy.scope='workspace' and policy.source_owner_user_id is null
              and policy.team_id=$2 and policy.team_workspace_id=$3)
          )
        order by policy.version desc`,
      [ownerUserId, teamId, teamWorkspaceId]
    );
    const policies = policyResult.rows.map(mapPolicy);
    if (!policies.some((policy) => policy.scope === "deployment")) return null;
    const effectivePolicy = resolveMonotonicPrivacyPolicySet(policies);
    const artifactResult = await client.query<Row>(
      `${selectSanitizedArtifact}
       join team_conversation_source_grants source_grant
         on source_grant.share_grant_id=a.share_grant_id
        and source_grant.share_grant_id=$1
        and source_grant.owner_user_id=a.owner_user_id
        and source_grant.team_id=a.team_id
        and source_grant.team_workspace_id=a.team_workspace_id
        and source_grant.lifecycle='active' and source_grant.revoked_at is null
      where a.classifier_generation_id=$2 and a.classifier_hash=$3
        and a.effective_policy_hash=$4
        and ($5::uuid is null or a.id=$5)
        and a.status='ready' and a.invalidated_at is null
        and (
          (source_grant.mode='snapshot'
            and a.source_artifact_id=source_grant.artifact_id
            and a.source_frontier_cursor=source_grant.maximum_source_offset
            and a.source_segment_count=source_grant.maximum_segment_index + 1)
          or (source_grant.mode='continuous'
            and a.source_artifact_id=(
              select candidate.id
                from conversation_source_artifacts candidate
               where candidate.owner_user_id=source_grant.owner_user_id
                 and candidate.session_id=source_grant.session_id
                 and candidate.logical_source_id=source_grant.logical_source_id
                 and candidate.source_component_id='main'
                 and candidate.source_component_role='primary'
                 and candidate.lifecycle='finalized'
               order by candidate.source_created_at desc, candidate.id desc
               limit 1
            ))
        )
      order by a.source_frontier_cursor desc, a.ready_at desc, a.id desc
      limit 1`,
      [
        input.shareGrantId,
        generation.id,
        generation.classifierHash,
        effectivePolicy.effectivePolicyHash,
        input.sanitizedArtifactId ?? null
      ]
    );
    if (!artifactResult.rows[0]) return null;
    const record = mapSanitizedArtifact(artifactResult.rows[0]);
    if (!record.metadataBindingHash || !record.artifactBindingHash) {
      throw new PrivacyClassificationMismatchError(
        "Sanitized source artifact is missing ready-state bindings"
      );
    }
    const chunkResult = await client.query<Row>(
      `select id, artifact_id, classification_result_id, chunk_index,
              source_start_byte, source_end_byte, sanitized_byte_length,
              owner_chunk_fingerprint, payload_binding_hash
         from privacy_sanitized_source_chunks
        where artifact_id=$1 and invalidated_at is null
        order by chunk_index asc`,
      [record.id]
    );
    const chunks = chunkResult.rows.map(mapSanitizedChunk);
    const totalBytes = chunks.reduce(
      (sum, chunk) => sum + chunk.sanitizedByteLength,
      0
    );
    const expectedArtifactBinding = bindingHash(
      key,
      record.ownerUserId,
      "privacy-sanitized-artifact",
      {
        artifactId: record.id,
        ownerManifestFingerprint: record.ownerManifestFingerprint,
        metadataBindingHash: record.metadataBindingHash,
        chunkBindings: chunks.map((chunk) => chunk.payloadBindingHash)
      }
    );
    if (
      chunks.length !== record.chunkCount ||
      totalBytes !== record.sanitizedByteCount ||
      !safeHashEqual(expectedArtifactBinding, record.artifactBindingHash)
    ) {
      throw new PrivacyClassificationMismatchError(
        "Sanitized source artifact binding mismatch"
      );
    }
    return { record, chunks };
  };

  const decryptSanitizedChunkWithClient = async (
    client: pg.PoolClient,
    provider: EnvelopeEncryptionProvider,
    artifact: PrivacySanitizedSourceArtifactRecord,
    chunk: PrivacySanitizedSourceChunkRecord
  ): Promise<string> => {
    const plaintext =
      await decryptTeamEncryptedFieldAfterAuthorizationWithClient(
        client,
        provider,
        {
          sourceTable: SANITIZED_CHUNK_SOURCE,
          sourceId: chunk.id,
          sourceColumn: SANITIZED_CHUNK_COLUMN,
          teamId: artifact.teamId,
          teamWorkspaceId: artifact.teamWorkspaceId
        }
      );
    if (typeof plaintext !== "string") {
      throw new PrivacyClassificationUnavailableError(
        "Encrypted sanitized source chunk is missing"
      );
    }
    const expectedFingerprint = keyedHash(
      key,
      "privacy-sanitized-chunk",
      artifact.ownerUserId,
      canonicalJson({ chunkIndex: chunk.chunkIndex, text: plaintext })
    );
    const expectedBinding = bindingHash(
      key,
      artifact.ownerUserId,
      "privacy-sanitized-chunk-binding",
      {
        artifactId: artifact.id,
        id: chunk.id,
        chunkIndex: chunk.chunkIndex,
        classificationResultId: chunk.classificationResultId,
        sourceStartByte: chunk.sourceStartByte,
        sourceEndByte: chunk.sourceEndByte,
        sanitizedByteLength: chunk.sanitizedByteLength,
        ownerChunkFingerprint: chunk.ownerChunkFingerprint,
        text: plaintext
      }
    );
    if (
      Buffer.byteLength(plaintext, "utf8") !== chunk.sanitizedByteLength ||
      !safeHashEqual(expectedFingerprint, chunk.ownerChunkFingerprint) ||
      !safeHashEqual(expectedBinding, chunk.payloadBindingHash)
    ) {
      throw new PrivacyClassificationMismatchError(
        "Sanitized source chunk binding mismatch"
      );
    }
    return plaintext;
  };

  return {
    async getActiveClassifierGeneration() {
      const result = await pool.query<Row>(
        "select * from privacy_classifier_generations where status='active' limit 1"
      );
      return result.rows[0] ? mapClassifierGeneration(result.rows[0]) : null;
    },

    async getLocalDeploymentIdentityId() {
      const result = await pool.query<Row>(
        `select id from deployment_identities
          where locality='local' and disabled_at is null
          limit 1`
      );
      return result.rows[0] ? stringValue(result.rows[0].id) : null;
    },

    async registerClassifierGeneration(input) {
      if (!Number.isSafeInteger(input.version) || input.version <= 0) {
        throw new TypeError("Classifier generation version must be positive");
      }
      for (const [label, value] of [
        ["artifactSha256", input.artifactSha256],
        ["tokenizerSha256", input.tokenizerSha256],
        ["decoderSha256", input.decoderSha256],
        ["calibrationSha256", input.calibrationSha256]
      ] as const) {
        assertSha256(value, label);
      }
      const inputContractVersion =
        input.inputContractVersion ?? PRIVACY_CLASSIFICATION_CONTRACT_VERSION;
      const computedHash = privacyClassifierHash({
        version: input.version,
        modelKey: input.modelKey,
        modelRevision: input.modelRevision,
        artifactSha256: input.artifactSha256,
        tokenizerSha256: input.tokenizerSha256,
        decoderSha256: input.decoderSha256,
        calibrationSha256: input.calibrationSha256,
        deterministicDetectorVersion: input.deterministicDetectorVersion,
        inputContractVersion
      });
      if (
        input.classifierHash &&
        !safeHashEqual(input.classifierHash, computedHash)
      ) {
        throw new PrivacyClassificationMismatchError(
          "Classifier generation hash does not match immutable components"
        );
      }
      const result = await pool.query<Row>(
        `
          insert into privacy_classifier_generations (
            version, classifier_hash, model_key, model_revision,
            artifact_sha256, tokenizer_sha256, decoder_sha256,
            calibration_sha256, deterministic_detector_version,
            input_contract_version, status
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'staged')
          on conflict (classifier_hash) do update
          set classifier_hash = excluded.classifier_hash
          where privacy_classifier_generations.version = excluded.version
            and privacy_classifier_generations.model_key = excluded.model_key
            and privacy_classifier_generations.model_revision = excluded.model_revision
            and privacy_classifier_generations.artifact_sha256 = excluded.artifact_sha256
            and privacy_classifier_generations.tokenizer_sha256 = excluded.tokenizer_sha256
            and privacy_classifier_generations.decoder_sha256 = excluded.decoder_sha256
            and privacy_classifier_generations.calibration_sha256 = excluded.calibration_sha256
            and privacy_classifier_generations.deterministic_detector_version = excluded.deterministic_detector_version
            and privacy_classifier_generations.input_contract_version = excluded.input_contract_version
          returning *
        `,
        [
          input.version,
          computedHash,
          input.modelKey,
          input.modelRevision,
          input.artifactSha256,
          input.tokenizerSha256,
          input.decoderSha256,
          input.calibrationSha256,
          input.deterministicDetectorVersion,
          inputContractVersion
        ]
      );
      if (!result.rows[0]) {
        throw new PrivacyClassificationConflictError(
          "Classifier hash is already bound to different immutable components"
        );
      }
      return mapClassifierGeneration(result.rows[0]);
    },

    async activateClassifierGeneration(generationId) {
      return withTransaction(async (client) => {
        const target = await client.query<Row>(
          "select * from privacy_classifier_generations where id=$1 for update",
          [generationId]
        );
        const row = target.rows[0];
        if (!row)
          throw new PrivacyClassificationConflictError(
            "Classifier generation not found"
          );
        const current = mapClassifierGeneration(row);
        if (current.status === "revoked" || current.status === "retired") {
          throw new PrivacyClassificationConflictError(
            `Cannot activate ${current.status} classifier generation`
          );
        }
        if (current.status === "active") return current;
        await client.query(
          `update privacy_classifier_generations
             set status='retired', retired_at=now()
           where status='active' and id<>$1`,
          [generationId]
        );
        const activated = await client.query<Row>(
          `update privacy_classifier_generations
             set status='active', activated_at=now()
           where id=$1 and status='staged'
           returning *`,
          [generationId]
        );
        if (!activated.rows[0]) {
          throw new PrivacyClassificationConflictError(
            "Classifier generation activation raced with another transition"
          );
        }
        return mapClassifierGeneration(activated.rows[0]);
      });
    },

    async createContentPolicyVersion(input) {
      if (input.effectiveAt && input.effectiveAt.getTime() > Date.now()) {
        throw new TypeError(
          "Future privacy content policy activation is not supported"
        );
      }
      const [sourceOwnerUserId, teamId, teamWorkspaceId] = policySubject(
        input.scope,
        input.subject
      );
      const labels = privacyLabelPolicySchema.parse(input.labels);
      const replacementContractVersion =
        input.replacementContractVersion ??
        PRIVACY_REPLACEMENT_CONTRACT_VERSION;
      const policyHash = privacyContentPolicyHash({
        labels,
        replacementContractVersion
      });
      return withTransaction(async (client) => {
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [
            canonicalJson([
              input.subject.deploymentIdentityId,
              input.scope,
              sourceOwnerUserId,
              teamId,
              teamWorkspaceId
            ])
          ]
        );
        const priorResult = await client.query<Row>(
          `
            select * from privacy_content_policies
            where deployment_identity_id=$1
              and scope=$2
              and source_owner_user_id is not distinct from $3::uuid
              and team_id is not distinct from $4::uuid
              and team_workspace_id is not distinct from $5::uuid
            order by version desc
            limit 1
            for update
          `,
          [
            input.subject.deploymentIdentityId,
            input.scope,
            sourceOwnerUserId,
            teamId,
            teamWorkspaceId
          ]
        );
        const prior = priorResult.rows[0]
          ? mapPolicy(priorResult.rows[0])
          : null;
        const actualPreviousVersion = prior?.version ?? 0;
        if (actualPreviousVersion !== input.expectedPreviousVersion) {
          throw new PrivacyClassificationConflictError(
            `Expected privacy policy version ${input.expectedPreviousVersion}, found ${actualPreviousVersion}`
          );
        }
        const policyId = prior?.policyId ?? input.policyId ?? randomUUID();
        if (prior && input.policyId && input.policyId !== prior.policyId) {
          throw new PrivacyClassificationConflictError(
            "Privacy policy identity cannot change between versions"
          );
        }
        if (prior?.status === "active") {
          await client.query(
            `update privacy_content_policies
                set status='superseded', superseded_at=now()
              where id=$1 and status='active'`,
            [prior.id]
          );
        }
        const inserted = await client.query<Row>(
          `
            insert into privacy_content_policies (
              policy_id, version, scope, deployment_identity_id,
              source_owner_user_id, team_id, team_workspace_id, labels,
              replacement_contract_version, policy_hash, status, effective_at
            ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'active',$11)
            returning *
          `,
          [
            policyId,
            actualPreviousVersion + 1,
            input.scope,
            input.subject.deploymentIdentityId,
            sourceOwnerUserId,
            teamId,
            teamWorkspaceId,
            JSON.stringify(labels),
            replacementContractVersion,
            policyHash,
            input.effectiveAt ?? new Date()
          ]
        );
        return mapPolicy(inserted.rows[0]!);
      });
    },

    async resolveEffectiveContentPolicy(subject, resolutionOptions = {}) {
      const at = resolutionOptions.at ?? new Date();
      const result = await pool.query<Row>(
        `
          select * from privacy_content_policies
          where deployment_identity_id=$1
            and status='active'
            and effective_at <= $5
            and (
              (scope='deployment' and source_owner_user_id is null and team_id is null and team_workspace_id is null)
              or (scope='source_owner' and source_owner_user_id=$2 and team_id is null and team_workspace_id is null)
              or (scope='team' and source_owner_user_id is null and team_id=$3 and team_workspace_id is null)
              or (scope='workspace' and source_owner_user_id is null and team_id=$3 and team_workspace_id=$4)
            )
          order by version desc
        `,
        [
          subject.deploymentIdentityId,
          subject.sourceOwnerUserId ?? null,
          subject.teamId ?? null,
          subject.teamWorkspaceId ?? null,
          at
        ]
      );
      const policies = result.rows.map(mapPolicy);
      if (!policies.some((policy) => policy.scope === "deployment")) {
        throw new PrivacyClassificationUnavailableError(
          "Active deployment privacy content policy is required"
        );
      }
      if (
        new Set(policies.map((policy) => policy.scope)).size !== policies.length
      ) {
        throw new PrivacyClassificationMismatchError(
          "Multiple active privacy policies resolved for one scope"
        );
      }
      return resolveMonotonicPrivacyPolicySet(policies);
    },

    async listSourceMaterializationTargets(input) {
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100
      ) {
        throw new TypeError(
          "Privacy materialization target limit must be between 1 and 100"
        );
      }
      const result = await pool.query<Row>(
        `select source_grant.share_grant_id, source_grant.owner_user_id,
                source_grant.team_id, source_grant.team_workspace_id,
                source_grant.mode, artifact.id as source_artifact_id,
                artifact.source_kind, artifact.artifact_format,
                artifact.artifact_format_version,
                frontier.source_frontier_cursor,
                frontier.source_segment_count,
                frontier.through_segment_index,
                frontier.head_content_digest,
                case
                  when artifact.lifecycle='finalized'
                   and frontier.source_frontier_cursor=artifact.provider_cursor_offset
                   and frontier.through_segment_index=artifact.current_journal_sequence
                  then artifact.closure_hash
                  else null
                end as source_closure_hash
           from team_conversation_source_grants source_grant
           join team_memory_share_grants share_grant
             on share_grant.id=source_grant.share_grant_id
            and share_grant.owner_user_id=source_grant.owner_user_id
            and share_grant.team_id=source_grant.team_id
            and share_grant.team_workspace_id=source_grant.team_workspace_id
            and share_grant.lifecycle='active'
            and share_grant.revoked_at is null
            and share_grant.personal_deleted_at is null
           join source_owner_representation_consents consent
             on consent.id=share_grant.consent_id
            and consent.state='active' and consent.revoked_at is null
            and (consent.expires_at is null or consent.expires_at > now())
           join users source_owner on source_owner.id=source_grant.owner_user_id
            and source_owner.disabled_at is null and source_owner.deleted_at is null
           join teams team on team.id=source_grant.team_id
            and team.lifecycle='active'
            and team.entitlement_status in ('active','grace')
           join team_memberships membership
             on membership.team_id=source_grant.team_id
            and membership.user_id=source_grant.owner_user_id
            and membership.status='enabled' and membership.disabled_at is null
           join team_workspaces workspace
             on workspace.id=source_grant.team_workspace_id
            and workspace.team_id=source_grant.team_id
            and workspace.lifecycle='active' and workspace.archived_at is null
           join team_workspace_access_grants workspace_access
             on workspace_access.team_workspace_id=source_grant.team_workspace_id
            and workspace_access.team_id=source_grant.team_id
            and workspace_access.user_id=source_grant.owner_user_id
            and workspace_access.access='write'
            and workspace_access.can_share_owned_memory=true
            and workspace_access.disabled_at is null
           join lateral (
             select candidate.*
               from conversation_source_artifacts candidate
              where candidate.owner_user_id=source_grant.owner_user_id
                and candidate.session_id=source_grant.session_id
                and candidate.logical_source_id=source_grant.logical_source_id
                and candidate.source_component_id='main'
                and candidate.source_component_role='primary'
                and (source_grant.mode='continuous'
                  or candidate.id=source_grant.artifact_id)
                and candidate.lifecycle='finalized'
                and exists (
                  select 1
                    from unnest($2::text[], $3::text[], $4::integer[])
                      supported(source_kind, artifact_format, artifact_format_version)
                   where supported.source_kind=candidate.source_kind
                     and supported.artifact_format=candidate.artifact_format
                     and supported.artifact_format_version=candidate.artifact_format_version
                )
              order by candidate.source_created_at desc, candidate.id desc
              limit 1
           ) artifact on true
           join lateral (
             select count(*)::integer as source_segment_count,
                    max(segment.segment_index)::integer as through_segment_index,
                    max(segment.source_end_offset)::bigint as source_frontier_cursor,
                    (array_agg(segment.content_digest
                      order by segment.segment_index desc))[1] as head_content_digest
               from conversation_source_segments segment
              where segment.artifact_id=artifact.id
                and (source_grant.mode='continuous' or (
                  segment.segment_index <= source_grant.maximum_segment_index
                  and segment.source_end_offset <= source_grant.maximum_source_offset
                ))
           ) frontier on frontier.source_segment_count > 0
          where source_grant.lifecycle='active'
            and source_grant.revoked_at is null
            and (source_grant.mode='continuous' or (
              frontier.through_segment_index=source_grant.maximum_segment_index
              and frontier.source_frontier_cursor=source_grant.maximum_source_offset
            ))
          order by source_grant.updated_at, source_grant.share_grant_id
          limit $1`,
        [
          input.limit,
          privacyMaterializationSourceAdapters.map(
            (adapter) => adapter.sourceKind
          ),
          privacyMaterializationSourceAdapters.map(
            (adapter) => adapter.artifactFormat
          ),
          privacyMaterializationSourceAdapters.map(
            (adapter) => adapter.artifactFormatVersion
          )
        ]
      );
      return result.rows.map((row) => ({
        shareGrantId: stringValue(row.share_grant_id),
        ownerUserId: stringValue(row.owner_user_id),
        teamId: stringValue(row.team_id),
        teamWorkspaceId: stringValue(row.team_workspace_id),
        mode: stringValue(row.mode) as "snapshot" | "continuous",
        sourceArtifactId: stringValue(row.source_artifact_id),
        sourceKind: stringValue(row.source_kind),
        artifactFormat: stringValue(row.artifact_format),
        artifactFormatVersion: numberValue(row.artifact_format_version),
        sourceFrontierCursor: numberValue(row.source_frontier_cursor),
        sourceSegmentCount: numberValue(row.source_segment_count),
        throughSegmentIndex: numberValue(row.through_segment_index),
        headContentDigest: stringValue(row.head_content_digest),
        sourceClosureHash: nullableString(row.source_closure_hash)
      }));
    },

    async findReadySanitizedSourceArtifact(input) {
      for (const [label, value] of [
        ["classifierHash", input.classifierHash],
        ["effectivePolicyHash", input.effectivePolicyHash],
        ["sourceFrontierHash", input.sourceFrontierHash]
      ] as const)
        assertSha256(value, label);
      const result = await pool.query<Row>(
        `${selectSanitizedArtifact}
          join team_conversation_source_grants source_grant
            on source_grant.share_grant_id=a.share_grant_id
           and source_grant.share_grant_id=$8
           and source_grant.owner_user_id=a.owner_user_id
           and source_grant.team_id=a.team_id
           and source_grant.team_workspace_id=a.team_workspace_id
           and source_grant.lifecycle='active' and source_grant.revoked_at is null
          join team_memory_share_grants share_grant
            on share_grant.id=source_grant.share_grant_id
           and share_grant.owner_user_id=source_grant.owner_user_id
           and share_grant.team_id=source_grant.team_id
           and share_grant.team_workspace_id=source_grant.team_workspace_id
           and share_grant.lifecycle='active' and share_grant.revoked_at is null
           and share_grant.personal_deleted_at is null
          join source_owner_representation_consents consent
            on consent.id=share_grant.consent_id
           and consent.state='active' and consent.revoked_at is null
           and (consent.expires_at is null or consent.expires_at > now())
          join teams team on team.id=source_grant.team_id
           and team.lifecycle='active'
           and team.entitlement_status in ('active','grace')
          join team_workspaces workspace
            on workspace.id=source_grant.team_workspace_id
           and workspace.team_id=source_grant.team_id
           and workspace.lifecycle='active' and workspace.archived_at is null
          join team_memberships membership
            on membership.team_id=source_grant.team_id
           and membership.user_id=$7
           and membership.status='enabled' and membership.disabled_at is null
          join team_workspace_access_grants workspace_access
            on workspace_access.team_workspace_id=source_grant.team_workspace_id
           and workspace_access.team_id=source_grant.team_id
           and workspace_access.user_id=$7
           and workspace_access.access in ('read','write')
           and workspace_access.disabled_at is null
          where a.source_artifact_id=$1 and a.team_id=$2
            and a.team_workspace_id=$3 and a.classifier_hash=$4
            and a.effective_policy_hash=$5 and a.source_frontier_hash=$6
            and a.status='ready' and a.invalidated_at is null
            and (
              (source_grant.mode='snapshot'
                and a.source_artifact_id=source_grant.artifact_id
                and a.source_frontier_cursor=source_grant.maximum_source_offset
                and a.source_segment_count=source_grant.maximum_segment_index + 1)
              or (source_grant.mode='continuous'
                and a.source_artifact_id=(
                  select candidate.id
                    from conversation_source_artifacts candidate
                   where candidate.owner_user_id=source_grant.owner_user_id
                     and candidate.session_id=source_grant.session_id
                     and candidate.logical_source_id=source_grant.logical_source_id
                     and candidate.source_component_id='main'
                     and candidate.source_component_role='primary'
                     and candidate.lifecycle='finalized'
                   order by candidate.source_created_at desc, candidate.id desc
                   limit 1
                ))
            )
          limit 1`,
        [
          input.sourceArtifactId,
          input.teamId,
          input.teamWorkspaceId,
          input.classifierHash,
          input.effectivePolicyHash,
          input.sourceFrontierHash,
          input.actor.userId,
          input.shareGrantId
        ]
      );
      return result.rows[0] ? mapSanitizedArtifact(result.rows[0]) : null;
    },

    async findCachedClassification(input) {
      assertSha256(input.classifierHash, "classifierHash");
      const fields = validatedFields(input.fields);
      const fingerprint = ownerFieldsFingerprint(input.actor.userId, fields);
      return findCachedWith(
        pool,
        input.actor,
        input.classifierHash,
        fingerprint
      );
    },

    async getOrCreateStructuralClassificationBinding(input) {
      assertSha256(input.classifierHash, "classifierHash");
      const emptyFields: Array<{ path: string; text: string }> = [];
      const fingerprint = ownerFieldsFingerprint(
        input.actor.userId,
        emptyFields
      );
      const existing = await findCachedWith(
        pool,
        input.actor,
        input.classifierHash,
        fingerprint
      );
      if (existing) return existing;
      return withTransaction(async (client) => {
        const generationResult = await client.query<Row>(
          `select * from privacy_classifier_generations
            where classifier_hash=$1 and status='active'
            limit 1 for share`,
          [input.classifierHash]
        );
        if (!generationResult.rows[0]) {
          throw new PrivacyClassificationUnavailableError(
            "Active classifier generation is unavailable"
          );
        }
        const generation = mapClassifierGeneration(generationResult.rows[0]);
        const resultId = randomUUID();
        const reserved = await client.query<Row>(
          `insert into privacy_classification_results (
             id, owner_user_id, classifier_generation_id, classifier_hash,
             owner_content_fingerprint, input_byte_length, status
           ) values ($1,$2,$3,$4,$5,$6,'pending')
           on conflict do nothing
           returning *`,
          [
            resultId,
            input.actor.userId,
            generation.id,
            generation.classifierHash,
            fingerprint,
            0
          ]
        );
        if (!reserved.rows[0]) {
          const cached = await findCachedWith(
            client,
            input.actor,
            input.classifierHash,
            fingerprint
          );
          if (cached) return cached;
          throw new PrivacyClassificationConflictError(
            "Structural classification binding is already pending"
          );
        }
        const payload: ClassificationPayload = {
          version: 1,
          resultId,
          ownerUserId: input.actor.userId,
          ownerContentFingerprint: fingerprint,
          classifierGenerationId: generation.id,
          classifierHash: generation.classifierHash,
          inputByteLength: 0,
          fields: []
        };
        const payloadBindingHash = bindingHash(
          key,
          input.actor.userId,
          "privacy-classification-payload",
          payload
        );
        await upsertEncryptedFieldPayloadWithClient(
          client,
          input.actor,
          input.provider,
          {
            sourceTable: CLASSIFICATION_SOURCE,
            sourceId: resultId,
            sourceColumn: CLASSIFICATION_PAYLOAD_COLUMN,
            plaintext: payload,
            plaintextContentType: "application/json",
            rowFamily: CLASSIFICATION_SOURCE,
            scope: { objectClass: "privacy_structural_source_binding" },
            aad: {
              classifierGenerationId: generation.id,
              classifierHash: generation.classifierHash,
              ownerContentFingerprint: fingerprint,
              payloadBindingHash
            }
          }
        );
        const ready = await client.query<Row>(
          `update privacy_classification_results
            set status='ready', payload_binding_hash=$2, span_count=0,
                  ready_at=now()
            where id=$1 and owner_user_id=$3 and status='pending'
            returning *`,
          [resultId, payloadBindingHash, input.actor.userId]
        );
        if (!ready.rows[0]) {
          throw new PrivacyClassificationConflictError(
            "Structural classification binding could not transition to ready"
          );
        }
        return mapClassificationResult(ready.rows[0]);
      });
    },

    async storeClassificationResult(input) {
      const fields = validatedFields(input.fields);
      const response = privacyClassificationAggregateResponseSchema.parse(
        input.response
      );
      if (response.fields.length !== fields.length) {
        throw new PrivacyClassificationMismatchError(
          "Classifier response field count does not match the request"
        );
      }
      const payloadFields = fields.map((field, index) => {
        const classified = response.fields[index];
        const inputSha256 = createHash("sha256")
          .update(field.text, "utf8")
          .digest("hex");
        const inputByteLength = Buffer.byteLength(field.text, "utf8");
        if (
          !classified ||
          classified.path !== field.path ||
          !safeHashEqual(classified.inputSha256, inputSha256) ||
          classified.inputByteLength !== inputByteLength
        ) {
          throw new PrivacyClassificationMismatchError(
            `Classifier response does not match field ${field.path}`
          );
        }
        return {
          path: field.path,
          inputSha256,
          inputByteLength,
          spans: classified.spans
        };
      });
      const inputByteLength = payloadFields.reduce(
        (sum, field) => sum + field.inputByteLength,
        0
      );
      const spanCount = payloadFields.reduce(
        (sum, field) => sum + field.spans.length,
        0
      );
      const fingerprint = ownerFieldsFingerprint(input.actor.userId, fields);
      const existing = await findCachedWith(
        pool,
        input.actor,
        response.classifier.classifierHash,
        fingerprint
      );
      if (existing) return existing;

      return withTransaction(async (client) => {
        const generationResult = await client.query<Row>(
          `select * from privacy_classifier_generations
            where classifier_hash=$1 and status='active'
            limit 1 for share`,
          [response.classifier.classifierHash]
        );
        if (!generationResult.rows[0]) {
          throw new PrivacyClassificationUnavailableError(
            "Active classifier generation does not match the response"
          );
        }
        const generation = mapClassifierGeneration(generationResult.rows[0]);
        if (
          generation.modelKey !== response.classifier.modelKey ||
          generation.modelRevision !== response.classifier.modelRevision ||
          generation.inputContractVersion !== response.inputContractVersion
        ) {
          throw new PrivacyClassificationMismatchError(
            "Classifier response metadata does not match the active generation"
          );
        }
        const resultId = randomUUID();
        const reserved = await client.query<Row>(
          `
            insert into privacy_classification_results (
              id, owner_user_id, classifier_generation_id, classifier_hash,
              owner_content_fingerprint, input_byte_length, status
            ) values ($1,$2,$3,$4,$5,$6,'pending')
            on conflict do nothing
            returning *
          `,
          [
            resultId,
            input.actor.userId,
            generation.id,
            generation.classifierHash,
            fingerprint,
            inputByteLength
          ]
        );
        if (!reserved.rows[0]) {
          const cached = await findCachedWith(
            client,
            input.actor,
            response.classifier.classifierHash,
            fingerprint
          );
          if (cached) return cached;
          throw new PrivacyClassificationConflictError(
            "Classification for this owner content is already pending"
          );
        }
        const payload: ClassificationPayload = {
          version: 1,
          resultId,
          ownerUserId: input.actor.userId,
          ownerContentFingerprint: fingerprint,
          classifierGenerationId: generation.id,
          classifierHash: generation.classifierHash,
          inputByteLength,
          fields: payloadFields
        };
        const payloadBindingHash = bindingHash(
          key,
          input.actor.userId,
          "privacy-classification-payload",
          payload
        );
        await upsertEncryptedFieldPayloadWithClient(
          client,
          input.actor,
          input.provider,
          {
            sourceTable: CLASSIFICATION_SOURCE,
            sourceId: resultId,
            sourceColumn: CLASSIFICATION_PAYLOAD_COLUMN,
            plaintext: payload,
            plaintextContentType: "application/json",
            rowFamily: CLASSIFICATION_SOURCE,
            scope: { objectClass: "privacy_classification_result" },
            aad: {
              classifierGenerationId: generation.id,
              classifierHash: generation.classifierHash,
              ownerContentFingerprint: fingerprint,
              payloadBindingHash
            }
          }
        );
        const ready = await client.query<Row>(
          `
            update privacy_classification_results
               set status='ready', payload_binding_hash=$2, span_count=$3,
                   ready_at=now()
             where id=$1 and owner_user_id=$4 and status='pending'
             returning *
          `,
          [resultId, payloadBindingHash, spanCount, input.actor.userId]
        );
        if (!ready.rows[0]) {
          throw new PrivacyClassificationConflictError(
            "Classification result could not transition to ready"
          );
        }
        return mapClassificationResult(ready.rows[0]);
      });
    },

    async readClassificationResult(input) {
      const result = await pool.query<Row>(
        `
          ${selectClassificationResult}
          join privacy_classifier_generations g
            on g.id=r.classifier_generation_id
           and g.classifier_hash=r.classifier_hash
           and g.status in ('active','retired')
          where r.id=$1 and r.owner_user_id=$2
            and r.status='ready' and r.invalidated_at is null
          limit 1
        `,
        [input.resultId, input.actor.userId]
      );
      if (!result.rows[0]) return null;
      const record = mapClassificationResult(result.rows[0]);
      if (
        input.expectedClassifierHash &&
        !safeHashEqual(input.expectedClassifierHash, record.classifierHash)
      ) {
        throw new PrivacyClassificationMismatchError(
          "Classification result uses an unexpected classifier generation"
        );
      }
      const decrypted = await decryptAuthorizedEncryptedFieldPayloadWithClient(
        pool,
        input.actor,
        input.provider,
        {
          sourceTable: CLASSIFICATION_SOURCE,
          sourceId: record.id,
          sourceColumn: CLASSIFICATION_PAYLOAD_COLUMN
        }
      );
      if (!decrypted) {
        throw new PrivacyClassificationUnavailableError(
          "Encrypted classification payload is missing"
        );
      }
      const envelope = decrypted.record.envelope;
      const identityMatches =
        decrypted.record.ownerUserId === input.actor.userId &&
        decrypted.record.sourceTable === CLASSIFICATION_SOURCE &&
        decrypted.record.sourceId === record.id &&
        decrypted.record.sourceColumn === CLASSIFICATION_PAYLOAD_COLUMN &&
        envelope.provenance.sourceTable === CLASSIFICATION_SOURCE &&
        envelope.provenance.sourceId === record.id &&
        envelope.provenance.sourceColumn === CLASSIFICATION_PAYLOAD_COLUMN &&
        envelope.aad.ownerUserId === input.actor.userId &&
        envelope.aad.sourceTable === CLASSIFICATION_SOURCE &&
        envelope.aad.sourceId === record.id &&
        envelope.aad.sourceColumn === CLASSIFICATION_PAYLOAD_COLUMN &&
        envelope.aad.classifierGenerationId === record.classifierGenerationId &&
        envelope.aad.classifierHash === record.classifierHash &&
        envelope.aad.ownerContentFingerprint ===
          record.ownerContentFingerprint &&
        envelope.aad.payloadBindingHash === record.payloadBindingHash;
      if (!identityMatches || !record.payloadBindingHash) {
        throw new PrivacyClassificationMismatchError();
      }
      const payload = decrypted.plaintext as Partial<ClassificationPayload>;
      if (!Array.isArray(payload.fields)) {
        throw new PrivacyClassificationMismatchError(
          "Encrypted classification fields are missing"
        );
      }
      const paths = new Set<string>();
      const parsedFields = payload.fields.map((field) => {
        if (
          typeof field !== "object" ||
          field === null ||
          typeof field.path !== "string" ||
          !field.path ||
          typeof field.inputSha256 !== "string" ||
          !SHA256_PATTERN.test(field.inputSha256) ||
          !Number.isSafeInteger(field.inputByteLength) ||
          field.inputByteLength < 0 ||
          paths.has(field.path)
        ) {
          throw new PrivacyClassificationMismatchError(
            "Encrypted classification field binding is invalid"
          );
        }
        paths.add(field.path);
        return {
          path: field.path,
          inputSha256: field.inputSha256,
          inputByteLength: field.inputByteLength,
          spans: privacyDetectedSpanSchema.array().parse(field.spans)
        };
      });
      const parsedInputByteLength = parsedFields.reduce(
        (sum, field) => sum + field.inputByteLength,
        0
      );
      const parsedSpanCount = parsedFields.reduce(
        (sum, field) => sum + field.spans.length,
        0
      );
      const payloadMatches =
        payload.version === 1 &&
        payload.resultId === record.id &&
        payload.ownerUserId === record.ownerUserId &&
        payload.ownerContentFingerprint === record.ownerContentFingerprint &&
        payload.classifierGenerationId === record.classifierGenerationId &&
        payload.classifierHash === record.classifierHash &&
        payload.inputByteLength === record.inputByteLength &&
        parsedInputByteLength === record.inputByteLength &&
        parsedSpanCount === record.spanCount &&
        safeHashEqual(
          bindingHash(
            key,
            record.ownerUserId,
            "privacy-classification-payload",
            payload
          ),
          record.payloadBindingHash
        );
      if (!payloadMatches) throw new PrivacyClassificationMismatchError();
      if (input.expectedFields !== undefined) {
        const expectedFields = validatedFields(input.expectedFields);
        const expectedFingerprint = ownerFieldsFingerprint(
          input.actor.userId,
          expectedFields
        );
        const expectedMatch =
          expectedFields.length === parsedFields.length &&
          expectedFields.every((field, index) => {
            const parsed = parsedFields[index];
            return (
              parsed?.path === field.path &&
              safeHashEqual(
                createHash("sha256").update(field.text, "utf8").digest("hex"),
                parsed.inputSha256
              ) &&
              Buffer.byteLength(field.text, "utf8") === parsed.inputByteLength
            );
          });
        if (
          !safeHashEqual(expectedFingerprint, record.ownerContentFingerprint) ||
          !expectedMatch
        ) {
          throw new PrivacyClassificationMismatchError(
            "Cached classification does not match the expected source fields"
          );
        }
      }
      return { record, fields: parsedFields };
    },

    async invalidateClassificationResult(input) {
      if (!input.reasonCode.trim())
        throw new TypeError("Invalidation reason code is required");
      return withTransaction(async (client) => {
        const invalidated = await client.query<Row>(
          `
            update privacy_classification_results
               set status='invalidated', invalidated_at=now(),
                   invalidation_reason_code=$3
             where id=$1 and owner_user_id=$2
               and status in ('pending','ready') and invalidated_at is null
             returning id
          `,
          [input.resultId, input.actor.userId, input.reasonCode]
        );
        if (!invalidated.rows[0]) return false;
        await client.query(
          `update encrypted_field_payloads
              set invalidated_at=now(), invalidation_reason=$4, updated_at=now()
            where owner_user_id=$1 and source_table=$2 and source_id=$3
              and source_column=$5 and invalidated_at is null`,
          [
            input.actor.userId,
            CLASSIFICATION_SOURCE,
            input.resultId,
            input.reasonCode,
            CLASSIFICATION_PAYLOAD_COLUMN
          ]
        );
        return true;
      });
    },

    async storeSanitizedSourceArtifact(input) {
      assertSha256(input.classifierHash, "classifierHash");
      assertSha256(input.effectivePolicyHash, "effectivePolicyHash");
      assertSha256(input.sourceFrontierHash, "sourceFrontierHash");
      if (input.sourceClosureHash) {
        assertSha256(input.sourceClosureHash, "sourceClosureHash");
      }
      if (
        !Number.isSafeInteger(input.sourceFrontierCursor) ||
        input.sourceFrontierCursor < 0 ||
        !Number.isSafeInteger(input.sourceSegmentCount) ||
        input.sourceSegmentCount < 0
      ) {
        throw new TypeError(
          "Source frontier cursor and segment count must be non-negative integers"
        );
      }
      if (
        !input.format.trim() ||
        !Number.isSafeInteger(input.formatVersion) ||
        input.formatVersion <= 0
      ) {
        throw new TypeError(
          "Sanitized source format and positive version are required"
        );
      }
      let priorEnd = -1;
      for (const chunk of input.chunks) {
        if (
          !Number.isSafeInteger(chunk.sourceStartByte) ||
          !Number.isSafeInteger(chunk.sourceEndByte) ||
          chunk.sourceStartByte < 0 ||
          chunk.sourceEndByte <= chunk.sourceStartByte ||
          chunk.sourceStartByte < priorEnd ||
          chunk.sourceEndByte > input.sourceFrontierCursor
        ) {
          throw new TypeError(
            "Sanitized source chunks must have ordered byte ranges"
          );
        }
        priorEnd = chunk.sourceEndByte;
      }
      const artifactId = randomUUID();
      const metadataBindingHash = bindingHash(
        key,
        input.actor.userId,
        "privacy-sanitized-metadata",
        { shareGrantId: input.shareGrantId, metadata: input.metadata }
      );
      const chunks = input.chunks.map((chunk, chunkIndex) => {
        const id = randomUUID();
        const ownerChunkFingerprint = keyedHash(
          key,
          "privacy-sanitized-chunk",
          input.actor.userId,
          canonicalJson({ chunkIndex, text: chunk.text })
        );
        const sanitizedByteLength = Buffer.byteLength(chunk.text, "utf8");
        const payloadBindingHash = bindingHash(
          key,
          input.actor.userId,
          "privacy-sanitized-chunk-binding",
          {
            artifactId,
            id,
            chunkIndex,
            classificationResultId: chunk.classificationResultId,
            sourceStartByte: chunk.sourceStartByte,
            sourceEndByte: chunk.sourceEndByte,
            sanitizedByteLength,
            ownerChunkFingerprint,
            text: chunk.text
          }
        );
        return {
          ...chunk,
          id,
          chunkIndex,
          sanitizedByteLength,
          ownerChunkFingerprint,
          payloadBindingHash
        };
      });
      const ownerManifestFingerprint = bindingHash(
        key,
        input.actor.userId,
        "privacy-sanitized-manifest",
        {
          shareGrantId: input.shareGrantId,
          sourceArtifactId: input.sourceArtifactId,
          sourceFrontierHash: input.sourceFrontierHash,
          sourceFrontierCursor: input.sourceFrontierCursor,
          sourceSegmentCount: input.sourceSegmentCount,
          sourceClosureHash: input.sourceClosureHash ?? null,
          classifierHash: input.classifierHash,
          effectivePolicyHash: input.effectivePolicyHash,
          metadataBindingHash,
          chunks: chunks.map((chunk) => ({
            id: chunk.id,
            chunkIndex: chunk.chunkIndex,
            classificationResultId: chunk.classificationResultId,
            sourceStartByte: chunk.sourceStartByte,
            sourceEndByte: chunk.sourceEndByte,
            sanitizedByteLength: chunk.sanitizedByteLength,
            ownerChunkFingerprint: chunk.ownerChunkFingerprint,
            payloadBindingHash: chunk.payloadBindingHash
          }))
        }
      );
      const artifactBindingHash = bindingHash(
        key,
        input.actor.userId,
        "privacy-sanitized-artifact",
        {
          artifactId,
          ownerManifestFingerprint,
          metadataBindingHash,
          chunkBindings: chunks.map((chunk) => chunk.payloadBindingHash)
        }
      );
      const sanitizedByteCount = chunks.reduce(
        (sum, chunk) => sum + chunk.sanitizedByteLength,
        0
      );
      return withTransaction(async (client) => {
        const policyResult = await client.query<Row>(
          `select policy.*
             from privacy_content_policies policy
             join deployment_identities deployment
               on deployment.id=policy.deployment_identity_id
              and deployment.locality='local' and deployment.disabled_at is null
            where policy.status='active' and policy.effective_at <= now()
              and (
                (policy.scope='deployment' and policy.source_owner_user_id is null
                  and policy.team_id is null and policy.team_workspace_id is null)
                or (policy.scope='source_owner' and policy.source_owner_user_id=$1
                  and policy.team_id is null and policy.team_workspace_id is null)
                or (policy.scope='team' and policy.source_owner_user_id is null
                  and policy.team_id=$2 and policy.team_workspace_id is null)
                or (policy.scope='workspace' and policy.source_owner_user_id is null
                  and policy.team_id=$2 and policy.team_workspace_id=$3)
              )
            order by policy.version desc`,
          [input.actor.userId, input.teamId, input.teamWorkspaceId]
        );
        const policies = policyResult.rows.map(mapPolicy);
        if (!policies.some((policy) => policy.scope === "deployment")) {
          throw new PrivacyClassificationUnavailableError(
            "Active deployment privacy content policy is required"
          );
        }
        if (
          !safeHashEqual(
            resolveMonotonicPrivacyPolicySet(policies).effectivePolicyHash,
            input.effectivePolicyHash
          )
        ) {
          throw new PrivacyClassificationUnavailableError(
            "Sanitized source policy is no longer current"
          );
        }
        const authority = await client.query<Row>(
          `
            select
              g.id as classifier_generation_id,
              source.closure_hash,
              coalesce(frontier.source_frontier_cursor, 0)::bigint as source_frontier_cursor,
              coalesce(frontier.source_segment_count, 0)::integer as source_segment_count,
              frontier.head_content_digest
            from conversation_source_artifacts source
            join privacy_classifier_generations g
              on g.classifier_hash=$6 and g.status in ('active','retired')
            join team_conversation_source_grants source_grant
              on source_grant.share_grant_id=$7
             and source_grant.owner_user_id=source.owner_user_id
             and source_grant.session_id=source.session_id
             and source_grant.logical_source_id=source.logical_source_id
             and source_grant.team_id=$3
             and source_grant.team_workspace_id=$4
             and source_grant.lifecycle='active' and source_grant.revoked_at is null
            join team_memory_share_grants share_grant
              on share_grant.id=source_grant.share_grant_id
             and share_grant.owner_user_id=source_grant.owner_user_id
             and share_grant.team_id=source_grant.team_id
             and share_grant.team_workspace_id=source_grant.team_workspace_id
             and share_grant.lifecycle='active' and share_grant.revoked_at is null
             and share_grant.personal_deleted_at is null
            join source_owner_representation_consents consent
              on consent.id=share_grant.consent_id
             and consent.state='active' and consent.revoked_at is null
             and (consent.expires_at is null or consent.expires_at > now())
            join teams t on t.id=$3 and t.lifecycle='active'
             and t.entitlement_status in ('active','grace')
            join team_workspaces w
              on w.id=$4 and w.team_id=t.id and w.lifecycle='active'
             and w.archived_at is null
            join team_memberships membership
              on membership.team_id=t.id and membership.user_id=$1
             and membership.status='enabled' and membership.disabled_at is null
            join team_workspace_access_grants workspace_access
              on workspace_access.team_workspace_id=w.id
             and workspace_access.team_id=t.id
             and workspace_access.user_id=$1
             and workspace_access.disabled_at is null
             and workspace_access.access='write'
             and workspace_access.can_share_owned_memory=true
            left join lateral (
              select
                count(*)::integer as source_segment_count,
                max(segment.source_end_offset)::bigint as source_frontier_cursor,
                (array_agg(segment.content_digest order by segment.segment_index desc))[1]
                  as head_content_digest
              from conversation_source_segments segment
              where segment.artifact_id=source.id
                and (source_grant.mode='continuous' or (
                  segment.segment_index <= source_grant.maximum_segment_index
                  and segment.source_end_offset <= source_grant.maximum_source_offset
                ))
            ) frontier on true
            where source.id=$2 and source.owner_user_id=$1
              and source.source_component_id='main'
              and source.source_component_role='primary'
              and source.lifecycle='finalized'
              and (
                (source_grant.mode='snapshot'
                  and source.id=source_grant.artifact_id
                  and frontier.source_frontier_cursor=source_grant.maximum_source_offset
                  and frontier.source_segment_count=source_grant.maximum_segment_index + 1)
                or (source_grant.mode='continuous' and source.id=(
                  select candidate.id
                    from conversation_source_artifacts candidate
                   where candidate.owner_user_id=source_grant.owner_user_id
                     and candidate.session_id=source_grant.session_id
                     and candidate.logical_source_id=source_grant.logical_source_id
                     and candidate.source_component_id='main'
                     and candidate.source_component_role='primary'
                     and candidate.lifecycle='finalized'
                   order by candidate.source_created_at desc, candidate.id desc
                   limit 1
                ))
              )
              and ($5::text is null or (
                source.lifecycle='finalized' and source.closure_hash=$5
              ))
            limit 1
          `,
          [
            input.actor.userId,
            input.sourceArtifactId,
            input.teamId,
            input.teamWorkspaceId,
            input.sourceClosureHash ?? null,
            input.classifierHash,
            input.shareGrantId
          ]
        );
        if (!authority.rows[0]) {
          throw new PrivacyClassificationUnavailableError(
            "Sanitized source prerequisites are not active and authorized"
          );
        }
        const classifierGenerationId = stringValue(
          authority.rows[0].classifier_generation_id
        );
        const authoritativeCursor = numberValue(
          authority.rows[0].source_frontier_cursor
        );
        const authoritativeSegmentCount = numberValue(
          authority.rows[0].source_segment_count
        );
        const authoritativeFrontierHash = privacySourceFrontierHash({
          sourceArtifactId: input.sourceArtifactId,
          sourceFrontierCursor: authoritativeCursor,
          sourceSegmentCount: authoritativeSegmentCount,
          headContentDigest: nullableString(
            authority.rows[0].head_content_digest
          )
        });
        if (
          authoritativeCursor !== input.sourceFrontierCursor ||
          authoritativeSegmentCount !== input.sourceSegmentCount ||
          !safeHashEqual(authoritativeFrontierHash, input.sourceFrontierHash)
        ) {
          throw new PrivacyClassificationMismatchError(
            "Sanitized source frontier does not match committed source segments"
          );
        }
        const classificationResultIds = [
          ...new Set(chunks.map((chunk) => chunk.classificationResultId))
        ];
        if (classificationResultIds.length > 0) {
          const classifications = await client.query<{ valid_count: number }>(
            `select count(*)::integer as valid_count
               from privacy_classification_results
              where id=any($1::uuid[])
                and owner_user_id=$2
                and classifier_generation_id=$3
                and classifier_hash=$4
                and status='ready'
                and invalidated_at is null`,
            [
              classificationResultIds,
              input.actor.userId,
              classifierGenerationId,
              input.classifierHash
            ]
          );
          if (
            Number(classifications.rows[0]?.valid_count ?? -1) !==
            classificationResultIds.length
          ) {
            throw new PrivacyClassificationMismatchError(
              "Sanitized source chunks require matching ready classification results"
            );
          }
        }
        const inserted = await client.query<Row>(
          `
            insert into privacy_sanitized_source_artifacts (
              id, share_grant_id, source_artifact_id, owner_user_id, team_id,
              team_workspace_id,
              classifier_generation_id, classifier_hash, effective_policy_hash,
              source_frontier_hash, source_frontier_cursor,
              source_segment_count, source_closure_hash,
              owner_manifest_fingerprint, format, format_version, status
            ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending')
            on conflict do nothing
            returning *
          `,
          [
            artifactId,
            input.shareGrantId,
            input.sourceArtifactId,
            input.actor.userId,
            input.teamId,
            input.teamWorkspaceId,
            classifierGenerationId,
            input.classifierHash,
            input.effectivePolicyHash,
            input.sourceFrontierHash,
            input.sourceFrontierCursor,
            input.sourceSegmentCount,
            input.sourceClosureHash ?? null,
            ownerManifestFingerprint,
            input.format,
            input.formatVersion
          ]
        );
        if (!inserted.rows[0]) {
          throw new PrivacyClassificationConflictError(
            "An active sanitized source artifact already exists for this binding"
          );
        }
        await upsertEncryptedFieldPayloadWithClient(
          client,
          input.actor,
          input.provider,
          {
            sourceTable: SANITIZED_ARTIFACT_SOURCE,
            sourceId: artifactId,
            sourceColumn: SANITIZED_METADATA_COLUMN,
            plaintext: input.metadata,
            visibility: "team",
            teamId: input.teamId,
            teamWorkspaceId: input.teamWorkspaceId,
            plaintextContentType: "application/json",
            rowFamily: SANITIZED_ARTIFACT_SOURCE,
            scope: {
              teamId: input.teamId,
              workspaceId: input.teamWorkspaceId,
              objectClass: "privacy_sanitized_source_metadata"
            },
            aad: {
              shareGrantId: input.shareGrantId,
              metadataBindingHash,
              artifactBindingHash,
              ownerManifestFingerprint
            }
          }
        );
        for (const chunk of chunks) {
          await upsertEncryptedFieldPayloadWithClient(
            client,
            input.actor,
            input.provider,
            {
              sourceTable: SANITIZED_CHUNK_SOURCE,
              sourceId: chunk.id,
              sourceColumn: SANITIZED_CHUNK_COLUMN,
              plaintext: chunk.text,
              visibility: "team",
              teamId: input.teamId,
              teamWorkspaceId: input.teamWorkspaceId,
              plaintextContentType: "text/plain",
              rowFamily: SANITIZED_CHUNK_SOURCE,
              scope: {
                teamId: input.teamId,
                workspaceId: input.teamWorkspaceId,
                objectClass: "privacy_sanitized_source_chunk"
              },
              aad: {
                artifactId,
                chunkIndex: chunk.chunkIndex,
                classificationResultId: chunk.classificationResultId,
                ownerChunkFingerprint: chunk.ownerChunkFingerprint,
                payloadBindingHash: chunk.payloadBindingHash
              }
            }
          );
          await client.query(
            `insert into privacy_sanitized_source_chunks (
               id, artifact_id, classification_result_id, chunk_index,
               source_start_byte, source_end_byte, sanitized_byte_length,
               owner_chunk_fingerprint, payload_binding_hash
             ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              chunk.id,
              artifactId,
              chunk.classificationResultId,
              chunk.chunkIndex,
              chunk.sourceStartByte,
              chunk.sourceEndByte,
              chunk.sanitizedByteLength,
              chunk.ownerChunkFingerprint,
              chunk.payloadBindingHash
            ]
          );
        }
        const ready = await client.query<Row>(
          `update privacy_sanitized_source_artifacts
              set status='ready', metadata_binding_hash=$2,
                  artifact_binding_hash=$3, chunk_count=$4,
                  sanitized_byte_count=$5, ready_at=now()
            where id=$1 and status='pending'
            returning *`,
          [
            artifactId,
            metadataBindingHash,
            artifactBindingHash,
            chunks.length,
            sanitizedByteCount
          ]
        );
        const superseded = await client.query<{ id: string }>(
          `update privacy_sanitized_source_artifacts
              set status='invalidated', invalidated_at=now(),
                  invalidation_reason_code='superseded_materialization'
            where id<>$1 and share_grant_id=$2
              and source_artifact_id=$3 and owner_user_id=$4
              and team_id=$5 and team_workspace_id=$6
              and status in ('pending','ready') and invalidated_at is null
            returning id`,
          [
            artifactId,
            input.shareGrantId,
            input.sourceArtifactId,
            input.actor.userId,
            input.teamId,
            input.teamWorkspaceId
          ]
        );
        const supersededIds = superseded.rows.map((row) => row.id);
        if (supersededIds.length > 0) {
          const invalidatedChunks = await client.query<{ id: string }>(
            `update privacy_sanitized_source_chunks
                set invalidated_at=now(),
                    invalidation_reason_code='superseded_materialization'
              where artifact_id=any($1::uuid[]) and invalidated_at is null
              returning id`,
            [supersededIds]
          );
          await client.query(
            `update encrypted_field_payloads
                set invalidated_at=now(),
                    invalidation_reason='superseded_materialization',
                    updated_at=now()
              where invalidated_at is null and (
                (source_table=$1 and source_id=any($2::uuid[]))
                or (source_table=$3 and source_id=any($4::uuid[]))
              )`,
            [
              SANITIZED_ARTIFACT_SOURCE,
              supersededIds,
              SANITIZED_CHUNK_SOURCE,
              invalidatedChunks.rows.map((row) => row.id)
            ]
          );
        }
        await client.query(
          `select pg_notify(
             'koed_team_conversation_source',
             json_build_object(
               'shareGrantId', $1::uuid,
               'reason', 'sanitized_ready'
             )::text
           )`,
          [input.shareGrantId]
        );
        return mapSanitizedArtifact(ready.rows[0]!);
      });
    },

    async readLatestSanitizedSourceManifestByGrant(input) {
      return withTransaction(async (client) => {
        await client.query("set transaction isolation level repeatable read");
        return readCurrentSanitizedManifestWithClient(client, input);
      });
    },

    async readSanitizedSourceChunkByGrant(input) {
      return withTransaction(async (client) => {
        await client.query("set transaction isolation level repeatable read");
        const manifest = await readCurrentSanitizedManifestWithClient(client, {
          actor: input.actor,
          shareGrantId: input.shareGrantId,
          sanitizedArtifactId: input.sanitizedArtifactId
        });
        if (!manifest) return null;
        const chunk = manifest.chunks.find(
          (candidate) => candidate.id === input.chunkId
        );
        if (!chunk) return null;
        const text = await decryptSanitizedChunkWithClient(
          client,
          input.provider,
          manifest.record,
          chunk
        );
        return { artifact: manifest.record, chunk: { record: chunk, text } };
      });
    },

    async readLatestSanitizedSourceArtifactByGrant(input) {
      return withTransaction(async (client) => {
        await client.query("set transaction isolation level repeatable read");
        const access = await client.query<Row>(
          `select source_grant.owner_user_id, source_grant.team_id,
                  source_grant.team_workspace_id
             from team_conversation_source_grants source_grant
             join team_memory_share_grants share_grant
               on share_grant.id=source_grant.share_grant_id
              and share_grant.owner_user_id=source_grant.owner_user_id
              and share_grant.team_id=source_grant.team_id
              and share_grant.team_workspace_id=source_grant.team_workspace_id
              and share_grant.lifecycle='active' and share_grant.revoked_at is null
              and share_grant.personal_deleted_at is null
             join source_owner_representation_consents consent
               on consent.id=share_grant.consent_id
              and consent.state='active' and consent.revoked_at is null
              and (consent.expires_at is null or consent.expires_at > now())
             join teams team on team.id=source_grant.team_id
              and team.lifecycle='active'
              and team.entitlement_status in ('active','grace')
             join team_workspaces workspace
               on workspace.id=source_grant.team_workspace_id
              and workspace.team_id=source_grant.team_id
              and workspace.lifecycle='active' and workspace.archived_at is null
             join team_memberships membership
               on membership.team_id=source_grant.team_id
              and membership.user_id=$2
              and membership.status='enabled' and membership.disabled_at is null
             join team_workspace_access_grants workspace_access
               on workspace_access.team_workspace_id=source_grant.team_workspace_id
              and workspace_access.team_id=source_grant.team_id
              and workspace_access.user_id=$2
              and workspace_access.access in ('read','write')
              and workspace_access.disabled_at is null
            where source_grant.share_grant_id=$1
              and source_grant.lifecycle='active' and source_grant.revoked_at is null
            limit 1`,
          [input.shareGrantId, input.actor.userId]
        );
        const authorized = access.rows[0];
        if (!authorized) return null;
        const ownerUserId = stringValue(authorized.owner_user_id);
        const teamId = stringValue(authorized.team_id);
        const teamWorkspaceId = stringValue(authorized.team_workspace_id);
        const generationResult = await client.query<Row>(
          "select * from privacy_classifier_generations where status='active' limit 1"
        );
        if (!generationResult.rows[0]) return null;
        const generation = mapClassifierGeneration(generationResult.rows[0]);
        const policyResult = await client.query<Row>(
          `select policy.*
             from privacy_content_policies policy
             join deployment_identities deployment
               on deployment.id=policy.deployment_identity_id
              and deployment.locality='local' and deployment.disabled_at is null
            where policy.status='active' and policy.effective_at <= now()
              and (
                (policy.scope='deployment' and policy.source_owner_user_id is null
                  and policy.team_id is null and policy.team_workspace_id is null)
                or (policy.scope='source_owner' and policy.source_owner_user_id=$1
                  and policy.team_id is null and policy.team_workspace_id is null)
                or (policy.scope='team' and policy.source_owner_user_id is null
                  and policy.team_id=$2 and policy.team_workspace_id is null)
                or (policy.scope='workspace' and policy.source_owner_user_id is null
                  and policy.team_id=$2 and policy.team_workspace_id=$3)
              )
            order by policy.version desc`,
          [ownerUserId, teamId, teamWorkspaceId]
        );
        const policies = policyResult.rows.map(mapPolicy);
        if (!policies.some((policy) => policy.scope === "deployment")) {
          return null;
        }
        const effectivePolicy = resolveMonotonicPrivacyPolicySet(policies);
        const result = await client.query<Row>(
          `${selectSanitizedArtifact}
           join team_conversation_source_grants source_grant
             on source_grant.share_grant_id=a.share_grant_id
            and source_grant.share_grant_id=$1
            and source_grant.owner_user_id=a.owner_user_id
            and source_grant.team_id=a.team_id
            and source_grant.team_workspace_id=a.team_workspace_id
            and source_grant.lifecycle='active' and source_grant.revoked_at is null
          where a.classifier_generation_id=$2 and a.classifier_hash=$3
            and a.effective_policy_hash=$4
            and a.status='ready' and a.invalidated_at is null
            and (
              (source_grant.mode='snapshot'
                and a.source_artifact_id=source_grant.artifact_id
                and a.source_frontier_cursor=source_grant.maximum_source_offset
                and a.source_segment_count=source_grant.maximum_segment_index + 1)
              or (source_grant.mode='continuous'
                and a.source_artifact_id=(
                  select candidate.id
                    from conversation_source_artifacts candidate
                   where candidate.owner_user_id=source_grant.owner_user_id
                     and candidate.session_id=source_grant.session_id
                     and candidate.logical_source_id=source_grant.logical_source_id
                     and candidate.source_component_id='main'
                     and candidate.source_component_role='primary'
                     and candidate.lifecycle='finalized'
                   order by candidate.source_created_at desc, candidate.id desc
                   limit 1
                ))
            )
          order by a.source_frontier_cursor desc, a.ready_at desc, a.id desc
          limit 1`,
          [
            input.shareGrantId,
            generation.id,
            generation.classifierHash,
            effectivePolicy.effectivePolicyHash
          ]
        );
        if (!result.rows[0]) return null;
        const record = mapSanitizedArtifact(result.rows[0]);
        if (!record.metadataBindingHash || !record.artifactBindingHash) {
          throw new PrivacyClassificationMismatchError(
            "Sanitized source artifact is missing ready-state bindings"
          );
        }
        const metadata =
          await decryptTeamEncryptedFieldAfterAuthorizationWithClient(
            client,
            input.provider,
            {
              sourceTable: SANITIZED_ARTIFACT_SOURCE,
              sourceId: record.id,
              sourceColumn: SANITIZED_METADATA_COLUMN,
              teamId: record.teamId,
              teamWorkspaceId: record.teamWorkspaceId
            }
          );
        if (metadata === null) {
          throw new PrivacyClassificationUnavailableError(
            "Encrypted sanitized source metadata is missing"
          );
        }
        const chunkResult = await client.query<Row>(
          `select id, artifact_id, classification_result_id, chunk_index,
                source_start_byte, source_end_byte, sanitized_byte_length,
                owner_chunk_fingerprint, payload_binding_hash
           from privacy_sanitized_source_chunks
          where artifact_id=$1 and invalidated_at is null
          order by chunk_index asc`,
          [record.id]
        );
        const chunks: DecryptedPrivacySanitizedSourceArtifact["chunks"] = [];
        for (const row of chunkResult.rows) {
          const chunk = mapSanitizedChunk(row);
          const plaintext =
            await decryptTeamEncryptedFieldAfterAuthorizationWithClient(
              client,
              input.provider,
              {
                sourceTable: SANITIZED_CHUNK_SOURCE,
                sourceId: chunk.id,
                sourceColumn: SANITIZED_CHUNK_COLUMN,
                teamId: record.teamId,
                teamWorkspaceId: record.teamWorkspaceId
              }
            );
          if (typeof plaintext !== "string") {
            throw new PrivacyClassificationUnavailableError(
              "Encrypted sanitized source chunk is missing"
            );
          }
          const expectedFingerprint = keyedHash(
            key,
            "privacy-sanitized-chunk",
            record.ownerUserId,
            canonicalJson({ chunkIndex: chunk.chunkIndex, text: plaintext })
          );
          const expectedBinding = bindingHash(
            key,
            record.ownerUserId,
            "privacy-sanitized-chunk-binding",
            {
              artifactId: record.id,
              id: chunk.id,
              chunkIndex: chunk.chunkIndex,
              classificationResultId: chunk.classificationResultId,
              sourceStartByte: chunk.sourceStartByte,
              sourceEndByte: chunk.sourceEndByte,
              sanitizedByteLength: chunk.sanitizedByteLength,
              ownerChunkFingerprint: chunk.ownerChunkFingerprint,
              text: plaintext
            }
          );
          if (
            Buffer.byteLength(plaintext, "utf8") !==
              chunk.sanitizedByteLength ||
            !safeHashEqual(expectedFingerprint, chunk.ownerChunkFingerprint) ||
            !safeHashEqual(expectedBinding, chunk.payloadBindingHash)
          ) {
            throw new PrivacyClassificationMismatchError(
              "Sanitized source chunk binding mismatch"
            );
          }
          chunks.push({ record: chunk, text: plaintext });
        }
        const expectedMetadataBinding = bindingHash(
          key,
          record.ownerUserId,
          "privacy-sanitized-metadata",
          { shareGrantId: record.shareGrantId, metadata }
        );
        const expectedArtifactBinding = bindingHash(
          key,
          record.ownerUserId,
          "privacy-sanitized-artifact",
          {
            artifactId: record.id,
            ownerManifestFingerprint: record.ownerManifestFingerprint,
            metadataBindingHash: record.metadataBindingHash,
            chunkBindings: chunks.map(
              (chunk) => chunk.record.payloadBindingHash
            )
          }
        );
        const totalBytes = chunks.reduce(
          (sum, chunk) => sum + chunk.record.sanitizedByteLength,
          0
        );
        if (
          chunks.length !== record.chunkCount ||
          totalBytes !== record.sanitizedByteCount ||
          !safeHashEqual(expectedMetadataBinding, record.metadataBindingHash) ||
          !safeHashEqual(expectedArtifactBinding, record.artifactBindingHash)
        ) {
          throw new PrivacyClassificationMismatchError(
            "Sanitized source artifact binding mismatch"
          );
        }
        return { record, metadata, chunks };
      });
    },

    async invalidateSanitizedSourceArtifact(input) {
      if (!input.reasonCode.trim())
        throw new TypeError("Invalidation reason code is required");
      return withTransaction(async (client) => {
        const result = await client.query<Row>(
          `update privacy_sanitized_source_artifacts
              set status='invalidated', invalidated_at=now(),
                  invalidation_reason_code=$3
            where id=$1 and owner_user_id=$2
              and status in ('pending','ready') and invalidated_at is null
            returning id`,
          [input.artifactId, input.actor.userId, input.reasonCode]
        );
        if (!result.rows[0]) return false;
        await client.query(
          `update privacy_sanitized_source_chunks
              set invalidated_at=now(), invalidation_reason_code=$2
            where artifact_id=$1 and invalidated_at is null`,
          [input.artifactId, input.reasonCode]
        );
        await client.query(
          `update encrypted_field_payloads
              set invalidated_at=now(), invalidation_reason=$3, updated_at=now()
            where ((source_table=$1 and source_id=$2)
              or (source_table=$4 and source_id in (
                select id from privacy_sanitized_source_chunks where artifact_id=$2
              ))) and invalidated_at is null`,
          [
            SANITIZED_ARTIFACT_SOURCE,
            input.artifactId,
            input.reasonCode,
            SANITIZED_CHUNK_SOURCE
          ]
        );
        return true;
      });
    }
  };
};
