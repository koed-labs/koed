import type pg from "pg";
import { createHash } from "node:crypto";
import type { EnvelopeEncryptionProvider } from "@koed/shared";
import {
  decryptAuthorizedEncryptedFieldPayloadWithClient,
  upsertEncryptedFieldPayloadWithClient,
  type EncryptedFieldSourceTable
} from "./encrypted-payload-repository.js";
import type {
  ActorContext,
  CuratedMemoryAssertionRecord,
  CuratedMemoryAssertionStatus,
  CuratedMemoryProposalOperation,
  CuratedMemoryProposalRecord,
  CuratedMemoryProposalStatus,
  CuratedMemorySensitivity,
  CuratedMemorySourceRecord,
  CuratedMemoryTopicRecord,
  Visibility
} from "./types.js";

export interface CuratedMemoryRepositoryContext {
  pool: pg.Pool;
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  onCuratedMemoryChanged?: (
    actor: ActorContext,
    client: pg.PoolClient
  ) => Promise<void>;
}

export type CuratedMemoryEncryptedSourceTable = Extract<
  EncryptedFieldSourceTable,
  | "curated_memory_assertions"
  | "curated_memory_proposals"
  | "curated_memory_sources"
  | "curated_memory_topics"
>;

export const ENCRYPTED_CURATED_MEMORY_TEXT = "[koed encrypted curated memory]";
export const encryptedCuratedMemoryJson = { contentEncrypted: true };

const deploymentProfile = (): string =>
  process.env.KOED_DEPLOYMENT_PROFILE?.trim().toLowerCase() ?? "";

export const protectedCuratedMemoryPayloadsRequired = (): boolean => {
  const profile = deploymentProfile();
  const releaseStage =
    process.env.KOED_MANAGED_CLOUD_RELEASE_STAGE?.trim().toLowerCase() ?? "";
  if (
    [
      "koed_managed_cloud",
      "koed-managed-cloud",
      "cloud",
      "team_self_hosted",
      "team-self-hosted",
      "private_vps",
      "private-vps"
    ].includes(profile)
  ) {
    return true;
  }
  return (
    ["koed_managed_cloud", "koed-managed-cloud", "cloud"].includes(profile) &&
    ["paid", "production"].includes(releaseStage)
  );
};

export const requireEncryptionProvider = (
  provider: EnvelopeEncryptionProvider | undefined
): EnvelopeEncryptionProvider => {
  if (!provider) {
    throw new Error(
      "Envelope encryption provider is required when plaintext Curated Memory storage is disabled"
    );
  }
  return provider;
};

export const persistCuratedMemoryPayload = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider | undefined,
  input: {
    sourceTable: CuratedMemoryEncryptedSourceTable;
    sourceId: string;
    plaintext: Record<string, unknown>;
  }
): Promise<void> => {
  if (!protectedCuratedMemoryPayloadsRequired()) {
    return;
  }
  await upsertEncryptedFieldPayloadWithClient(
    client,
    actor,
    requireEncryptionProvider(provider),
    {
      sourceTable: input.sourceTable,
      sourceId: input.sourceId,
      sourceColumn: "payload",
      plaintext: input.plaintext,
      visibility: "personal",
      rowFamily: "curated_memory",
      scope: {
        tenantId: actor.userId,
        objectClass: input.sourceTable
      },
      aad: { curatedMemoryId: input.sourceId }
    }
  );
};

export const decryptCuratedMemoryPayload = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider | undefined,
  sourceTable: CuratedMemoryEncryptedSourceTable,
  sourceId: string
): Promise<Record<string, unknown> | null> => {
  if (!protectedCuratedMemoryPayloadsRequired()) {
    return null;
  }
  const decrypted = await decryptAuthorizedEncryptedFieldPayloadWithClient(
    client,
    actor,
    requireEncryptionProvider(provider),
    { sourceTable, sourceId, sourceColumn: "payload" }
  );
  if (
    !decrypted?.plaintext ||
    typeof decrypted.plaintext !== "object" ||
    Array.isArray(decrypted.plaintext)
  ) {
    throw new Error(
      `Encrypted Curated Memory payload is missing for ${sourceId}`
    );
  }
  return decrypted.plaintext as Record<string, unknown>;
};

export const iso = (value: Date | string | null | undefined): string | null =>
  value instanceof Date ? value.toISOString() : value ? String(value) : null;

export const jsonRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const normalized = (value: string): string =>
  value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

export const normalizedDedupeKey = (value: string): string =>
  createHash("sha256").update(normalized(value)).digest("hex");

export const dedupeStrings = (values: string[] | undefined): string[] => [
  ...new Set(
    (values ?? [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  )
];

export const positiveLimit = (
  value: number | undefined,
  fallback = 50
): number =>
  Number.isInteger(value) && value !== undefined && value > 0
    ? Math.min(value, 250)
    : fallback;

export const visibilityError = (
  message: string
): Error & { statusCode: number } =>
  Object.assign(new Error(message), { statusCode: 404 });

export type TopicRow = {
  id: string;
  owner_user_id: string;
  visibility: Visibility;
  title: string;
  normalized_title: string;
  created_at: Date;
  updated_at: Date;
};

export type SourceRow = {
  id: string;
  assertion_id: string;
  source_type: CuratedMemorySourceRecord["sourceType"];
  source_role: CuratedMemorySourceRecord["sourceRole"];
  conversation_item_id: string | null;
  memory_event_id: string | null;
  lcm_node_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
};

export type AssertionRow = {
  id: string;
  owner_user_id: string;
  visibility: Visibility;
  topic_id: string | null;
  topic_title: string | null;
  assertion_text: string;
  normalized_assertion: string;
  status: CuratedMemoryAssertionStatus;
  sensitivity: CuratedMemorySensitivity;
  confidence: number;
  tags: string[];
  metadata: Record<string, unknown> | null;
  expires_at: Date | null;
  observed_at: Date;
  supersedes_assertion_id: string | null;
  superseded_by_assertion_id: string | null;
  conflict_with_assertion_id: string | null;
  created_by_model: string | null;
  created_by_prompt_version: string | null;
  created_at: Date;
  updated_at: Date;
  suppressed_at: Date | null;
  suppression_reason: string | null;
  last_reconciled_at: Date | null;
  reconciliation_status: string;
};

export type ProposalRow = {
  id: string;
  owner_user_id: string;
  visibility: Visibility;
  proposed_claim: string;
  proposed_topic: string | null;
  rationale: string | null;
  tags: string[];
  sensitivity_hint: CuratedMemorySensitivity | null;
  expires_at_hint: Date | null;
  evidence_conversation_item_ids: string[];
  evidence_memory_event_ids: string[];
  operation: CuratedMemoryProposalOperation;
  target_assertion_id: string | null;
  status: CuratedMemoryProposalStatus;
  decision_reason: string | null;
  assertion_id: string | null;
  worker_result: Record<string, unknown> | null;
  processing_started_at: Date | null;
  processing_lease_until: Date | null;
  attempt_count: number;
  last_error_message: string | null;
  created_by_model: string | null;
  created_by_prompt_version: string | null;
  created_at: Date;
  updated_at: Date;
  decided_at: Date | null;
};

const stringValue = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

const nullableStringValue = (
  value: unknown,
  fallback: string | null
): string | null =>
  typeof value === "string" ? value : value === null ? null : fallback;

const stringArrayValue = (value: unknown, fallback: string[]): string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : fallback;

export const recordValue = (
  value: unknown,
  fallback: Record<string, unknown> | null
): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : value === null
      ? null
      : fallback;

export const hydrateTopicRow = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider | undefined,
  row: TopicRow
): Promise<TopicRow> => {
  const payload = await decryptCuratedMemoryPayload(
    client,
    actor,
    provider,
    "curated_memory_topics",
    row.id
  );
  return payload
    ? {
        ...row,
        title: stringValue(payload.title, row.title),
        normalized_title: stringValue(
          payload.normalizedTitle,
          row.normalized_title
        )
      }
    : row;
};

export const hydrateSourceRow = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider | undefined,
  row: SourceRow
): Promise<SourceRow> => {
  const payload = await decryptCuratedMemoryPayload(
    client,
    actor,
    provider,
    "curated_memory_sources",
    row.id
  );
  return payload
    ? {
        ...row,
        metadata: recordValue(payload.metadata, row.metadata)
      }
    : row;
};

export const hydrateProposalRow = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider | undefined,
  row: ProposalRow
): Promise<ProposalRow> => {
  const payload = await decryptCuratedMemoryPayload(
    client,
    actor,
    provider,
    "curated_memory_proposals",
    row.id
  );
  return payload
    ? {
        ...row,
        proposed_claim: stringValue(payload.proposedClaim, row.proposed_claim),
        proposed_topic: nullableStringValue(
          payload.proposedTopic,
          row.proposed_topic
        ),
        rationale: nullableStringValue(payload.rationale, row.rationale),
        tags: stringArrayValue(payload.tags, row.tags),
        expires_at_hint:
          typeof payload.expiresAt === "string"
            ? new Date(payload.expiresAt)
            : row.expires_at_hint,
        decision_reason: nullableStringValue(
          payload.decisionReason,
          row.decision_reason
        ),
        worker_result: recordValue(payload.workerResult, row.worker_result)
      }
    : row;
};

export const hydrateAssertionRow = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider | undefined,
  row: AssertionRow
): Promise<AssertionRow> => {
  const payload = await decryptCuratedMemoryPayload(
    client,
    actor,
    provider,
    "curated_memory_assertions",
    row.id
  );
  let topicTitle = row.topic_title;
  if (payload && row.topic_id) {
    const topicPayload = await decryptCuratedMemoryPayload(
      client,
      actor,
      provider,
      "curated_memory_topics",
      row.topic_id
    );
    topicTitle = nullableStringValue(topicPayload?.title, topicTitle);
  }
  return payload
    ? {
        ...row,
        topic_title: topicTitle,
        assertion_text: stringValue(payload.assertionText, row.assertion_text),
        normalized_assertion: stringValue(
          payload.normalizedAssertion,
          row.normalized_assertion
        ),
        tags: stringArrayValue(payload.tags, row.tags),
        metadata: recordValue(payload.metadata, row.metadata),
        suppression_reason: nullableStringValue(
          payload.suppressionReason,
          row.suppression_reason
        )
      }
    : row;
};

export const mapTopic = (row: TopicRow): CuratedMemoryTopicRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  visibility: row.visibility,
  title: row.title,
  normalizedTitle: row.normalized_title,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString()
});

export const mapSource = (row: SourceRow): CuratedMemorySourceRecord => ({
  id: row.id,
  assertionId: row.assertion_id,
  sourceType: row.source_type,
  sourceRole: row.source_role,
  conversationItemId: row.conversation_item_id,
  memoryEventId: row.memory_event_id,
  lcmNodeId: row.lcm_node_id,
  metadata: jsonRecord(row.metadata),
  createdAt: row.created_at.toISOString()
});

export const mapProposal = (row: ProposalRow): CuratedMemoryProposalRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  visibility: row.visibility,
  proposedClaim: row.proposed_claim,
  proposedTopic: row.proposed_topic,
  rationale: row.rationale,
  tags: row.tags ?? [],
  sensitivityHint: row.sensitivity_hint,
  expiresAt: iso(row.expires_at_hint),
  evidenceConversationItemIds: row.evidence_conversation_item_ids ?? [],
  evidenceMemoryEventIds: row.evidence_memory_event_ids ?? [],
  operation: row.operation,
  targetAssertionId: row.target_assertion_id,
  status: row.status,
  decisionReason: row.decision_reason,
  assertionId: row.assertion_id,
  workerResult: row.worker_result ? jsonRecord(row.worker_result) : null,
  processingStartedAt: iso(row.processing_started_at),
  processingLeaseUntil: iso(row.processing_lease_until),
  attemptCount: Number(row.attempt_count),
  lastErrorMessage: row.last_error_message,
  createdByModel: row.created_by_model,
  createdByPromptVersion: row.created_by_prompt_version,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  decidedAt: iso(row.decided_at)
});

export const mapAssertion = (
  row: AssertionRow,
  sources: CuratedMemorySourceRecord[] = []
): CuratedMemoryAssertionRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  visibility: row.visibility,
  topicId: row.topic_id,
  topicTitle: row.topic_title,
  assertionText: row.assertion_text,
  normalizedAssertion: normalized(row.assertion_text),
  status: row.status,
  sensitivity: row.sensitivity,
  confidence: row.confidence,
  tags: row.tags ?? [],
  metadata: jsonRecord(row.metadata),
  expiresAt: iso(row.expires_at),
  observedAt: row.observed_at.toISOString(),
  supersedesAssertionId: row.supersedes_assertion_id,
  supersededByAssertionId: row.superseded_by_assertion_id,
  conflictWithAssertionId: row.conflict_with_assertion_id,
  createdByModel: row.created_by_model,
  createdByPromptVersion: row.created_by_prompt_version,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  suppressedAt: iso(row.suppressed_at),
  suppressionReason: row.suppression_reason,
  lastReconciledAt: iso(row.last_reconciled_at),
  reconciliationStatus: row.reconciliation_status,
  sources
});

export const assertionSelect = `
  cma.id,
  cma.owner_user_id,
  cma.visibility,
  cma.topic_id,
  cmt.title as topic_title,
  cma.assertion_text,
  cma.normalized_assertion,
  cma.status,
  cma.sensitivity,
  cma.confidence,
  cma.tags,
  cma.metadata,
  cma.expires_at,
  cma.observed_at,
  cma.supersedes_assertion_id,
  cma.superseded_by_assertion_id,
  cma.conflict_with_assertion_id,
  cma.created_by_model,
  cma.created_by_prompt_version,
  cma.created_at,
  cma.updated_at,
  cma.suppressed_at,
  cma.suppression_reason,
  cma.last_reconciled_at,
  cma.reconciliation_status
`;

export const proposalSelect = `
  id,
  owner_user_id,
  visibility,
  proposed_claim,
  proposed_topic,
  rationale,
  tags,
  sensitivity_hint,
  expires_at_hint,
  evidence_conversation_item_ids,
  evidence_memory_event_ids,
  operation,
  target_assertion_id,
  status,
  decision_reason,
  assertion_id,
  worker_result,
  processing_started_at,
  processing_lease_until,
  attempt_count,
  last_error_message,
  created_by_model,
  created_by_prompt_version,
  created_at,
  updated_at,
  decided_at
`;

export const loadSources = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider | undefined,
  assertionIds: string[]
): Promise<Map<string, CuratedMemorySourceRecord[]>> => {
  if (assertionIds.length === 0) {
    return new Map();
  }
  const rows = await client.query<SourceRow>(
    `
      select *
      from curated_memory_sources
      where assertion_id = any($1::uuid[])
      order by created_at asc, id asc
    `,
    [assertionIds]
  );
  const sources = new Map<string, CuratedMemorySourceRecord[]>();
  for (const row of rows.rows) {
    const mapped = mapSource(
      await hydrateSourceRow(client, actor, provider, row)
    );
    sources.set(mapped.assertionId, [
      ...(sources.get(mapped.assertionId) ?? []),
      mapped
    ]);
  }
  return sources;
};

export const getAssertionByIdWithClient = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider | undefined,
  assertionId: string
): Promise<CuratedMemoryAssertionRecord | null> => {
  const result = await client.query<AssertionRow>(
    `
      select ${assertionSelect}
      from curated_memory_assertions cma
      left join curated_memory_topics cmt on cmt.id = cma.topic_id
      where cma.id = $1
        and cma.owner_user_id = $2
        and cma.visibility = 'personal'
    `,
    [assertionId, actor.userId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  const hydrated = await hydrateAssertionRow(client, actor, provider, row);
  const sources = await loadSources(client, actor, provider, [row.id]);
  return mapAssertion(hydrated, sources.get(row.id) ?? []);
};
