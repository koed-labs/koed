import path from "node:path";
import type pg from "pg";
import { createDb } from "./connection.js";
import { createCapturedSessionRepository } from "./captured-session-repository.js";
import { createConversationItemRepository } from "./conversation-item-repository.js";
import { createSettingsRepository } from "./settings-repository.js";
import { currentEmbeddingConfig } from "./embedding-coverage.js";
import type {
  ActorContext,
  HistoricalImportBatchWriteInput,
  HistoricalImportBatchWriteResult,
  HistoricalImportRunDetail,
  HistoricalImportRunRecord,
  HistoricalImportSourceIdentity,
  HistoricalImportSourceObservationInput,
  HistoricalImportSourceRecord,
  HistoricalImportState,
  LiveTranscriptCursorAdvanceInput
} from "./types.js";

export interface HistoricalImportRepository {
  createHistoricalImportRun(
    actor: ActorContext
  ): Promise<HistoricalImportRunRecord>;
  listHistoricalImportRuns(
    actor: ActorContext,
    input?: { limit?: number }
  ): Promise<HistoricalImportRunRecord[]>;
  getHistoricalImportRun(
    actor: ActorContext,
    runId: string
  ): Promise<HistoricalImportRunDetail | null>;
  createHistoricalImportSource(
    actor: ActorContext,
    input: CreateHistoricalImportSourceInput
  ): Promise<HistoricalImportSourceRecord | null>;
  transitionHistoricalImportRun(
    actor: ActorContext,
    input: TransitionHistoricalImportRunInput
  ): Promise<HistoricalImportRunRecord | null>;
  transitionHistoricalImportSource(
    actor: ActorContext,
    input: TransitionHistoricalImportSourceInput
  ): Promise<HistoricalImportSourceRecord | null>;
  advanceHistoricalImportSource(
    actor: ActorContext,
    input: AdvanceHistoricalImportSourceInput
  ): Promise<HistoricalImportSourceRecord | null>;
  advanceLiveTranscriptCursor(
    actor: ActorContext,
    input: LiveTranscriptCursorAdvanceInput
  ): Promise<HistoricalImportSourceRecord>;
  ingestHistoricalImportBatch(
    actor: ActorContext,
    input: HistoricalImportBatchWriteInput
  ): Promise<HistoricalImportBatchWriteResult>;
  getHistoricalImportSource(
    actor: ActorContext,
    sourceId: string
  ): Promise<HistoricalImportSourceRecord | null>;
  getHistoricalImportSourceByIdentity(
    actor: ActorContext,
    identity: HistoricalImportSourceIdentity
  ): Promise<HistoricalImportSourceRecord | null>;
  observeHistoricalImportSource(
    actor: ActorContext,
    input: HistoricalImportSourceObservationInput
  ): Promise<HistoricalImportSourceRecord | null>;
  listHistoricalImportSourcesNeedingLcmFinalization(): Promise<
    Array<{ sourceId: string; ownerUserId: string; sessionId: string }>
  >;
}

type CreateHistoricalImportSourceInput = {
  runId: string;
  aiClient: string;
  sourceKind: string;
  sourceSessionId: string;
  sourceFingerprint: string;
  registrationFrontierOffset: number;
  registrationPrefixHash: string;
  localSourcePath: string;
  sourceSizeBytes: number;
  sourceModifiedAt?: string;
  sourceEventFrom?: string;
  sourceEventTo?: string;
  discoveredRecordCount?: number;
  detectedProject?: Record<string, unknown>;
};

type TransitionHistoricalImportRunInput = {
  runId: string;
  expectedState: HistoricalImportState;
  state: HistoricalImportState;
  failureReason?: string | null;
  nextRetryAt?: string | null;
};

type TransitionHistoricalImportSourceInput = {
  sourceId: string;
  expectedState: HistoricalImportState;
  state: HistoricalImportState;
  failureReason?: string | null;
  nextRetryAt?: string | null;
};

type AdvanceHistoricalImportSourceInput = {
  sourceId: string;
  expectedCheckpointOffset: number;
  expectedCheckpointHash?: string | null;
  checkpointOffset: number;
  checkpointLine: number;
  checkpointHash: string;
  sourceSizeBytes: number;
  importedRecordCount: number;
  skippedRecordCount?: number;
  malformedRecordCount?: number;
  sourceEventFrom?: string;
  sourceEventTo?: string;
};

type RunRow = {
  id: string;
  owner_user_id: string;
  state: HistoricalImportState;
  source_count: number;
  completed_source_count: number;
  failed_source_count: number;
  skipped_source_count: number;
  discovered_record_count: number;
  imported_record_count: number;
  skipped_record_count: number;
  scanned_byte_count: string | number;
  retry_count: number;
  failure_reason: string | null;
  next_retry_at: Date | null;
  discovered_at: Date;
  eligible_at: Date | null;
  queued_at: Date | null;
  import_started_at: Date | null;
  paused_at: Date | null;
  skipped_at: Date | null;
  completed_at: Date | null;
  failed_at: Date | null;
  last_attempt_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type SourceRow = {
  id: string;
  run_id: string;
  owner_user_id: string;
  state: HistoricalImportState;
  ai_client: string;
  source_kind: string;
  source_session_id: string;
  source_fingerprint: string;
  registration_frontier_offset: string | number;
  registration_prefix_hash: string;
  local_source_path: string;
  redacted_source_label: string;
  checkpoint_offset: string | number;
  checkpoint_line: number;
  checkpoint_hash: string | null;
  historical_imported_ranges: Array<{
    fromOffset: number;
    toOffset: number;
    checkpointHash: string;
  }>;
  live_cursor_offset: string | number;
  live_cursor_line: number;
  live_cursor_hash: string | null;
  source_size_bytes: string | number | null;
  source_modified_at: Date | null;
  source_event_from: Date | null;
  source_event_to: Date | null;
  discovered_record_count: number;
  imported_record_count: number;
  skipped_record_count: number;
  malformed_record_count: number;
  raw_ingested_record_count: number;
  projected_record_count: number;
  embedding_eligible_event_count: number;
  embedded_event_count: number;
  lcm_eligible_event_count: number;
  lcm_completed_event_count: number;
  retry_count: number;
  failure_reason: string | null;
  next_retry_at: Date | null;
  detected_project: Record<string, unknown>;
  discovered_at: Date;
  eligible_at: Date | null;
  queued_at: Date | null;
  import_started_at: Date | null;
  paused_at: Date | null;
  skipped_at: Date | null;
  completed_at: Date | null;
  failed_at: Date | null;
  last_observed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

const mapRun = (row: RunRow): HistoricalImportRunRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  state: row.state,
  sourceCount: row.source_count,
  completedSourceCount: row.completed_source_count,
  failedSourceCount: row.failed_source_count,
  skippedSourceCount: row.skipped_source_count,
  discoveredRecordCount: row.discovered_record_count,
  importedRecordCount: row.imported_record_count,
  skippedRecordCount: row.skipped_record_count,
  scannedByteCount: Number(row.scanned_byte_count),
  retryCount: row.retry_count,
  failureReason: row.failure_reason,
  nextRetryAt: iso(row.next_retry_at),
  discoveredAt: row.discovered_at.toISOString(),
  eligibleAt: iso(row.eligible_at),
  queuedAt: iso(row.queued_at),
  importStartedAt: iso(row.import_started_at),
  pausedAt: iso(row.paused_at),
  skippedAt: iso(row.skipped_at),
  completedAt: iso(row.completed_at),
  failedAt: iso(row.failed_at),
  lastAttemptAt: iso(row.last_attempt_at),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString()
});

const mapSource = (row: SourceRow): HistoricalImportSourceRecord => ({
  id: row.id,
  runId: row.run_id,
  ownerUserId: row.owner_user_id,
  state: row.state,
  aiClient: row.ai_client,
  sourceKind: row.source_kind,
  sourceSessionId: row.source_session_id,
  sourceFingerprint: row.source_fingerprint,
  registrationFrontierOffset: Number(row.registration_frontier_offset),
  registrationPrefixHash: row.registration_prefix_hash,
  localSourcePath: row.local_source_path,
  redactedSourceLabel: row.redacted_source_label,
  checkpointOffset: Number(row.checkpoint_offset),
  checkpointLine: row.checkpoint_line,
  checkpointHash: row.checkpoint_hash,
  historicalImportedRanges: row.historical_imported_ranges,
  liveCursorOffset: Number(row.live_cursor_offset),
  liveCursorLine: row.live_cursor_line,
  liveCursorHash: row.live_cursor_hash,
  sourceSizeBytes:
    row.source_size_bytes === null ? null : Number(row.source_size_bytes),
  sourceModifiedAt: iso(row.source_modified_at),
  sourceEventFrom: iso(row.source_event_from),
  sourceEventTo: iso(row.source_event_to),
  discoveredRecordCount: row.discovered_record_count,
  importedRecordCount: row.imported_record_count,
  skippedRecordCount: row.skipped_record_count,
  malformedRecordCount: row.malformed_record_count,
  rawIngestedRecordCount: row.raw_ingested_record_count,
  projectedRecordCount: row.projected_record_count,
  embeddingEligibleEventCount: row.embedding_eligible_event_count,
  embeddedEventCount: row.embedded_event_count,
  lcmEligibleEventCount: row.lcm_eligible_event_count,
  lcmCompletedEventCount: row.lcm_completed_event_count,
  rawIngested:
    Number(row.checkpoint_offset) === Number(row.registration_frontier_offset),
  projected:
    Number(row.checkpoint_offset) ===
      Number(row.registration_frontier_offset) &&
    row.projected_record_count >= row.raw_ingested_record_count,
  partiallyEmbedded:
    row.embedded_event_count > 0 &&
    row.embedded_event_count < row.embedding_eligible_event_count,
  fullyEmbedded:
    row.embedding_eligible_event_count === row.embedded_event_count,
  semanticReady:
    Number(row.checkpoint_offset) ===
      Number(row.registration_frontier_offset) &&
    row.projected_record_count >= row.raw_ingested_record_count &&
    row.embedding_eligible_event_count === row.embedded_event_count,
  lcmComplete: row.lcm_eligible_event_count === row.lcm_completed_event_count,
  retryCount: row.retry_count,
  failureReason: row.failure_reason,
  nextRetryAt: iso(row.next_retry_at),
  detectedProject: row.detected_project,
  discoveredAt: row.discovered_at.toISOString(),
  eligibleAt: iso(row.eligible_at),
  queuedAt: iso(row.queued_at),
  importStartedAt: iso(row.import_started_at),
  pausedAt: iso(row.paused_at),
  skippedAt: iso(row.skipped_at),
  completedAt: iso(row.completed_at),
  failedAt: iso(row.failed_at),
  lastObservedAt: iso(row.last_observed_at),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString()
});

const allowedTransitions: Record<
  HistoricalImportState,
  HistoricalImportState[]
> = {
  discovered: ["eligible", "paused", "skipped", "failed"],
  eligible: ["queued", "paused", "skipped", "failed"],
  queued: ["importing", "paused", "skipped", "failed"],
  importing: ["paused", "completed", "failed"],
  paused: ["eligible", "queued", "importing", "skipped", "failed"],
  skipped: ["eligible"],
  completed: [],
  failed: ["queued", "skipped"]
};

export const validateHistoricalImportTransition = (
  from: HistoricalImportState,
  to: HistoricalImportState
): void => {
  if (!allowedTransitions[from].includes(to)) {
    throw Object.assign(
      new Error(`Invalid historical import transition: ${from} -> ${to}`),
      { statusCode: 409 }
    );
  }
};

const validateTransitionFailure = (input: {
  state: HistoricalImportState;
  failureReason?: string | null;
}): void => {
  if (input.state === "failed" && !input.failureReason?.trim()) {
    throw Object.assign(
      new Error("Failed import state requires failure reason"),
      { statusCode: 400 }
    );
  }
  if (
    input.failureReason &&
    !/^[a-z0-9_.:-]{1,128}$/.test(input.failureReason)
  ) {
    throw Object.assign(
      new Error("Import failure reason must be a safe code"),
      {
        statusCode: 400
      }
    );
  }
};

const sourceLabel = (localSourcePath: string): string => {
  const normalized = localSourcePath.replaceAll("\\", "/");
  const basename = path.posix.basename(normalized);
  return basename && basename !== "." ? `…/${basename}` : "…/Codex history";
};

const refreshRunCounters = async (
  pool: pg.Pool,
  ownerUserId: string,
  runId: string
): Promise<void> => {
  await pool.query(
    `
      update historical_import_runs r set
        source_count = stats.source_count,
        completed_source_count = stats.completed_source_count,
        failed_source_count = stats.failed_source_count,
        skipped_source_count = stats.skipped_source_count,
        discovered_record_count = stats.discovered_record_count,
        imported_record_count = stats.imported_record_count,
        skipped_record_count = stats.skipped_record_count,
        scanned_byte_count = stats.scanned_byte_count,
        updated_at = now()
      from (
        select count(*)::int source_count,
          count(*) filter (where state = 'completed')::int completed_source_count,
          count(*) filter (where state = 'failed')::int failed_source_count,
          count(*) filter (where state = 'skipped')::int skipped_source_count,
          coalesce(sum(discovered_record_count), 0)::int discovered_record_count,
          coalesce(sum(imported_record_count), 0)::int imported_record_count,
          coalesce(sum(skipped_record_count), 0)::int skipped_record_count,
          coalesce(sum(checkpoint_offset), 0)::bigint scanned_byte_count
        from historical_import_sources
        where run_id = $2 and owner_user_id = $1
      ) stats
      where r.id = $2 and r.owner_user_id = $1
    `,
    [ownerUserId, runId]
  );
};

const getRun = async (
  pool: pg.Pool,
  actor: ActorContext,
  runId: string
): Promise<HistoricalImportRunRecord | null> => {
  const result = await pool.query<RunRow>(
    "select * from historical_import_runs where id = $2 and owner_user_id = $1",
    [actor.userId, runId]
  );
  return result.rows[0] ? mapRun(result.rows[0]) : null;
};

const getSource = async (
  pool: pg.Pool,
  actor: ActorContext,
  sourceId: string
): Promise<HistoricalImportSourceRecord | null> => {
  await refreshSourceProgress(pool, actor.userId, sourceId);
  const result = await pool.query<SourceRow>(
    "select * from historical_import_sources where id = $2 and owner_user_id = $1",
    [actor.userId, sourceId]
  );
  return result.rows[0] ? mapSource(result.rows[0]) : null;
};

const getSourceByIdentity = async (
  pool: pg.Pool,
  actor: ActorContext,
  identity: HistoricalImportSourceIdentity
): Promise<HistoricalImportSourceRecord | null> => {
  const result = await pool.query<SourceRow>(
    `select * from historical_import_sources
     where owner_user_id = $1 and ai_client = $2 and source_kind = $3
       and source_session_id = $4`,
    [
      actor.userId,
      identity.aiClient,
      identity.sourceKind,
      identity.sourceSessionId
    ]
  );
  return result.rows[0] ? mapSource(result.rows[0]) : null;
};

const observeSource = async (
  pool: pg.Pool,
  actor: ActorContext,
  input: HistoricalImportSourceObservationInput
): Promise<HistoricalImportSourceRecord | null> => {
  const result = await pool.query<SourceRow>(
    `update historical_import_sources
     set local_source_path = $3,
         redacted_source_label = $4,
         source_size_bytes = $5,
         source_modified_at = $6,
         last_observed_at = now(),
         updated_at = now()
     where id = $2 and owner_user_id = $1
       and $5 >= greatest(
         registration_frontier_offset, checkpoint_offset, live_cursor_offset,
         coalesce(source_size_bytes, 0)
       )
     returning *`,
    [
      actor.userId,
      input.sourceId,
      input.localSourcePath,
      sourceLabel(input.localSourcePath),
      input.sourceSizeBytes,
      input.sourceModifiedAt ?? null
    ]
  );
  return result.rows[0] ? mapSource(result.rows[0]) : null;
};

const refreshSourceProgress = async (
  pool: pg.Pool,
  ownerUserId: string,
  sourceId: string
): Promise<void> => {
  const embedding = currentEmbeddingConfig();
  await pool.query(
    `with source as (
       select id, owner_user_id, source_session_id, imported_record_count
       from historical_import_sources where id = $2 and owner_user_id = $1
     ), progress as (
       select source.id, source.imported_record_count,
         (select count(*)::int from conversation_items ci
          join sessions s on s.id = ci.session_id
          where s.owner_user_id = source.owner_user_id
            and s.external_session_id = source.source_session_id
            and exists (
              select 1 from conversation_item_observations observation
              where observation.conversation_item_id = ci.id
                and observation.source_transport = 'historical_import'
            )
            and (ci.projected_at is not null or ci.projection_status = 'raw_only'))
          + (select count(*)::int from conversation_item_observations observation
             where observation.owner_user_id = source.owner_user_id
               and observation.external_session_id = source.source_session_id
               and observation.source_transport = 'historical_import'
               and observation.conversation_item_id is null
               and observation.ingestion_status = 'identity_unresolved') projected_count,
         (select count(*)::int from memory_events me
          join sessions s on s.id = me.session_id
          where s.owner_user_id = source.owner_user_id
            and s.external_session_id = source.source_session_id
            and exists (
              select 1 from memory_event_sources mes
              join conversation_item_observations observation
                on observation.conversation_item_id = mes.conversation_item_id
              where mes.memory_event_id = me.id
                and observation.source_transport = 'historical_import'
            )
            and me.invalidated_at is null and me.personal_deleted_at is null
            and me.include_in_embedding) embedding_eligible_count,
         (select count(*)::int from memory_events me
          join sessions s on s.id = me.session_id
          where s.owner_user_id = source.owner_user_id
            and s.external_session_id = source.source_session_id
            and exists (
              select 1 from memory_event_sources mes
              join conversation_item_observations observation
                on observation.conversation_item_id = mes.conversation_item_id
              where mes.memory_event_id = me.id
                and observation.source_transport = 'historical_import'
            )
            and me.invalidated_at is null and me.personal_deleted_at is null
            and me.include_in_embedding
            and exists (
              select 1 from memory_embeddings emb
              join ${embedding.table} vector
                on vector.memory_embedding_id = emb.id
              where emb.memory_event_id = me.id
                and emb.invalidated_at is null
                and emb.personal_deleted_at is null
                and emb.embedding_model = $3
                and emb.embedding_dimensions = $4
                and emb.embedding_version = $5
                and emb.source_hash = me.source_hash
              group by emb.memory_event_id, emb.source_hash
              having count(*) = max(emb.source_chunk_count)
                and count(distinct emb.source_chunk_index) = max(emb.source_chunk_count)
                and min(emb.source_chunk_index) = 0
                and max(emb.source_chunk_index) = max(emb.source_chunk_count) - 1
                and min(emb.source_chunk_count) = max(emb.source_chunk_count)
            )) embedded_count,
         (select count(*)::int from memory_events me
          join sessions s on s.id = me.session_id
          where s.owner_user_id = source.owner_user_id
            and s.external_session_id = source.source_session_id
            and exists (
              select 1 from memory_event_sources mes
              join conversation_item_observations observation
                on observation.conversation_item_id = mes.conversation_item_id
              where mes.memory_event_id = me.id
                and observation.source_transport = 'historical_import'
            )
            and me.invalidated_at is null and me.include_in_lcm) lcm_eligible_count,
         (select count(distinct me.id)::int from memory_events me
          join sessions s on s.id = me.session_id
          join memory_node_sources mns on mns.memory_event_id = me.id
          join memory_nodes mn on mn.id = mns.memory_node_id
            and mn.invalidated_at is null and mn.summary_model is not null
          where s.owner_user_id = source.owner_user_id
            and s.external_session_id = source.source_session_id
            and exists (
              select 1 from memory_event_sources mes
              join conversation_item_observations observation
                on observation.conversation_item_id = mes.conversation_item_id
              where mes.memory_event_id = me.id
                and observation.source_transport = 'historical_import'
            )
            and me.invalidated_at is null and me.include_in_lcm) lcm_completed_count
       from source
     )
     update historical_import_sources his set
       raw_ingested_record_count = progress.imported_record_count,
       projected_record_count = progress.projected_count,
       embedding_eligible_event_count = progress.embedding_eligible_count,
       embedded_event_count = progress.embedded_count,
       lcm_eligible_event_count = progress.lcm_eligible_count,
       lcm_completed_event_count = progress.lcm_completed_count
     from progress where his.id = progress.id`,
    [
      ownerUserId,
      sourceId,
      embedding.model,
      embedding.dimensions,
      embedding.version
    ]
  );
};

const transitionTimestampSql = `
  eligible_at = case when $4 = 'eligible' then now() else eligible_at end,
  queued_at = case when $4 = 'queued' then now() else queued_at end,
  import_started_at = case when $4 = 'importing' then coalesce(import_started_at, now()) else import_started_at end,
  paused_at = case when $4 = 'paused' then now() else paused_at end,
  skipped_at = case when $4 = 'skipped' then now() else skipped_at end,
  completed_at = case when $4 = 'completed' then now() else completed_at end,
  failed_at = case when $4 = 'failed' then now() else failed_at end
`;

const projectPolicyId = (
  source: HistoricalImportSourceRecord
): string | undefined => {
  for (const key of ["projectId", "path", "cwd"] as const) {
    const value = source.detectedProject[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
};

const capturedProjectProvenance = (
  project: Record<string, unknown>
): Record<string, unknown> =>
  Object.fromEntries(
    ["name", "branch", "ref", "fingerprint"]
      .filter((key) => project[key] !== undefined)
      .map((key) => [key, project[key]])
  );

const policyBlockedError = (): Error & { statusCode: number } =>
  Object.assign(
    new Error("Historical import blocked by effective Capture Policy"),
    { statusCode: 409 }
  );

const withTransaction = async <T>(
  pool: pg.Pool,
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

const lockImportOwner = (client: pg.PoolClient, ownerUserId: string) =>
  client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `historical-import-owner:${ownerUserId}`
  ]);

const lockCapturePolicy = (client: pg.PoolClient, ownerUserId: string) =>
  client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `capture-policy:${ownerUserId}`
  ]);

const requireWritableRun = async (
  client: pg.PoolClient,
  actor: ActorContext,
  runId: string
): Promise<void> => {
  const result = await client.query(
    `select 1 from historical_import_runs
     where id = $2 and owner_user_id = $1
       and state in ('queued', 'importing')`,
    [actor.userId, runId]
  );
  if (result.rowCount === 0) {
    throw Object.assign(new Error("Historical import run is not writable"), {
      statusCode: 409
    });
  }
};

const requireSourceForUpdate = async (
  client: pg.PoolClient,
  actor: ActorContext,
  sourceId: string
): Promise<HistoricalImportSourceRecord> => {
  const result = await client.query<SourceRow>(
    `select * from historical_import_sources
     where id = $2 and owner_user_id = $1 for update`,
    [actor.userId, sourceId]
  );
  if (!result.rows[0]) {
    throw Object.assign(new Error("Historical import source not found"), {
      statusCode: 404
    });
  }
  return mapSource(result.rows[0]);
};

const validateBatchCheckpoint = (
  source: HistoricalImportSourceRecord,
  input: HistoricalImportBatchWriteInput
): "write" | "replay" => {
  if (
    source.checkpointOffset === input.checkpointOffset &&
    source.checkpointLine === input.checkpointLine &&
    source.checkpointHash === input.checkpointHash &&
    input.checkpointOffset > input.expectedCheckpointOffset
  ) {
    return "replay";
  }
  if (input.sourceSizeBytes < (source.sourceSizeBytes ?? 0)) {
    throw Object.assign(new Error("Historical import checkpoint conflict"), {
      statusCode: 409
    });
  }
  if (
    !["queued", "importing"].includes(source.state) ||
    source.checkpointOffset !== input.expectedCheckpointOffset ||
    source.checkpointHash !== (input.expectedCheckpointHash ?? null) ||
    input.checkpointLine < source.checkpointLine ||
    input.checkpointOffset <= input.expectedCheckpointOffset ||
    input.checkpointOffset > input.sourceSizeBytes ||
    input.checkpointOffset > source.registrationFrontierOffset ||
    (input.checkpointOffset === source.registrationFrontierOffset &&
      input.checkpointHash !== source.registrationPrefixHash) ||
    input.sourceSizeBytes < source.liveCursorOffset
  ) {
    throw Object.assign(new Error("Historical import checkpoint conflict"), {
      statusCode: 409
    });
  }
  return "write";
};

const requireImportPolicy = async (
  client: pg.PoolClient,
  actor: ActorContext,
  source: HistoricalImportSourceRecord
) => {
  const policy = await createSettingsRepository(
    createDb(client)
  ).getEffectiveCapturePolicy(actor, {
    projectId: projectPolicyId(source),
    threadId: source.sourceSessionId
  });
  if (
    policy.visibility !== "personal" ||
    policy.captureState !== "enabled" ||
    policy.paused
  ) {
    throw policyBlockedError();
  }
  return policy;
};

const createImportedSession = (
  client: pg.PoolClient,
  actor: ActorContext,
  source: HistoricalImportSourceRecord,
  capturedProject: Record<string, unknown>,
  observedAt: string
) =>
  createCapturedSessionRepository(client as unknown as pg.Pool, {
    transactionClient: client
  }).createCapturedSession(actor, {
    externalSessionId: source.sourceSessionId,
    sourceRuntime: "codex",
    captureMethod: "api",
    idempotencyKey: `historical-import-session:${actor.userId}:${source.sourceKind}:${source.sourceSessionId}`,
    sourceKind: source.sourceKind,
    sourceAdapterVersion: "codex-transcript-v1",
    sourceFingerprint: source.sourceFingerprint,
    capturedProject,
    importObservedAt: observedAt,
    metadata: {
      sourceTransport: "historical_import",
      historicalImportSourceId: source.id,
      capturedProjectProvenanceStoredSeparately: true
    }
  });

const importedItem = (
  item: HistoricalImportBatchWriteInput["items"][number],
  source: HistoricalImportSourceRecord,
  sessionId: string,
  capturedProject: Record<string, unknown>,
  observedAt: string
) => ({
  ...item,
  visibility: "personal" as const,
  sessionId,
  turnId: undefined,
  sourceKind: source.sourceKind,
  sourceAdapterVersion: "codex-transcript-v1",
  sourceTransport: "historical_import" as const,
  externalSessionId: source.sourceSessionId,
  externalThreadId: source.sourceSessionId,
  sourcePath: undefined,
  importObservedAt: observedAt,
  sourceFingerprint: source.sourceFingerprint,
  capturedProject,
  projectionStatus: item.projectionStatus ?? ("pending" as const),
  projectionVersion: item.projectionVersion ?? "codex-transcript-v1",
  metadata: {
    ...(item.metadata ?? {}),
    historicalImportRunId: source.runId,
    historicalImportSourceId: source.id,
    sourceFingerprint: source.sourceFingerprint
  }
});

const createImportedConversationItems = async (
  client: pg.PoolClient,
  actor: ActorContext,
  source: HistoricalImportSourceRecord,
  input: HistoricalImportBatchWriteInput
) => {
  const observedAt = new Date().toISOString();
  const capturedProject = capturedProjectProvenance(source.detectedProject);
  const pool = client as unknown as pg.Pool;
  const session = await createImportedSession(
    client,
    actor,
    source,
    capturedProject,
    observedAt
  );
  const items = input.items.map((item) =>
    importedItem(item, source, session.id, capturedProject, observedAt)
  );
  return createConversationItemRepository(pool, {
    transactionClient: client
  }).createConversationItems(actor, { items });
};

const upsertSourceWithClient = (
  client: pg.PoolClient,
  actor: ActorContext,
  input: CreateHistoricalImportSourceInput
) =>
  client.query<SourceRow>(
    `insert into historical_import_sources (
       run_id, owner_user_id, ai_client, source_kind, source_session_id,
       source_fingerprint, registration_frontier_offset,
       registration_prefix_hash, live_cursor_offset, live_cursor_hash,
       local_source_path, redacted_source_label,
       source_size_bytes, source_modified_at, source_event_from,
       source_event_to, discovered_record_count, detected_project
     )
     select r.id, r.owner_user_id, $3, $4, $5, $6, $7::bigint, $8::text,
       $7::bigint, case when $7::bigint = 0 then null else $8::text end, $9, $10,
       $11, $12, $13, $14, $15, $16
     from historical_import_runs r
     where r.id = $2 and r.owner_user_id = $1
       and r.state in ('discovered', 'eligible', 'queued', 'importing', 'paused')
     on conflict (owner_user_id, ai_client, source_kind, source_session_id)
     do update set
       local_source_path = excluded.local_source_path,
       redacted_source_label = excluded.redacted_source_label,
       source_size_bytes = greatest(
         historical_import_sources.source_size_bytes,
         excluded.source_size_bytes
       ),
       source_modified_at = coalesce(
         excluded.source_modified_at,
         historical_import_sources.source_modified_at
       ),
       last_observed_at = now(),
       updated_at = now()
     where historical_import_sources.source_fingerprint = excluded.source_fingerprint
       and historical_import_sources.registration_frontier_offset = excluded.registration_frontier_offset
       and historical_import_sources.registration_prefix_hash = excluded.registration_prefix_hash
       and excluded.source_size_bytes >= greatest(
         historical_import_sources.checkpoint_offset,
         historical_import_sources.live_cursor_offset,
         historical_import_sources.registration_frontier_offset
       )
     returning *`,
    [
      actor.userId,
      input.runId,
      input.aiClient,
      input.sourceKind,
      input.sourceSessionId,
      input.sourceFingerprint,
      input.registrationFrontierOffset,
      input.registrationPrefixHash,
      input.localSourcePath,
      sourceLabel(input.localSourcePath),
      input.sourceSizeBytes ?? null,
      input.sourceModifiedAt ?? null,
      input.sourceEventFrom ?? null,
      input.sourceEventTo ?? null,
      input.discoveredRecordCount ?? 0,
      input.detectedProject ?? {}
    ]
  );

const advanceSourceWithClient = async (
  client: pg.PoolClient,
  actor: ActorContext,
  input: AdvanceHistoricalImportSourceInput
): Promise<HistoricalImportSourceRecord | null> => {
  const result = await client.query<SourceRow>(
    `update historical_import_sources set
       state = 'importing', checkpoint_offset = $4, checkpoint_line = $5,
       checkpoint_hash = $6, source_size_bytes = $7,
       historical_imported_ranges = historical_imported_ranges ||
         jsonb_build_array(jsonb_build_object(
           'fromOffset', $3::bigint, 'toOffset', $4::bigint,
           'checkpointHash', $6::text
         )),
       imported_record_count = imported_record_count + $8,
       raw_ingested_record_count = raw_ingested_record_count + $8,
       skipped_record_count = skipped_record_count + $9,
       malformed_record_count = malformed_record_count + $10,
       source_event_from = least(source_event_from, $11),
       source_event_to = greatest(source_event_to, $12),
       import_started_at = coalesce(import_started_at, now()),
       last_observed_at = now(), updated_at = now()
     where owner_user_id = $1 and id = $2 and checkpoint_offset = $3
       and checkpoint_hash is not distinct from $13
       and $4 <= registration_frontier_offset
       and ($4 < registration_frontier_offset or $6 = registration_prefix_hash)
       and $7 >= live_cursor_offset
       and $7 >= coalesce(source_size_bytes, 0)
       and state in ('queued', 'importing') returning *`,
    [
      actor.userId,
      input.sourceId,
      input.expectedCheckpointOffset,
      input.checkpointOffset,
      input.checkpointLine,
      input.checkpointHash,
      input.sourceSizeBytes,
      input.importedRecordCount,
      input.skippedRecordCount ?? 0,
      input.malformedRecordCount ?? 0,
      input.sourceEventFrom ?? null,
      input.sourceEventTo ?? null,
      input.expectedCheckpointHash ?? null
    ]
  );
  return result.rows[0] ? mapSource(result.rows[0]) : null;
};

const createRunRecord = async (pool: pg.Pool, actor: ActorContext) => {
  const result = await pool.query<RunRow>(
    "insert into historical_import_runs (owner_user_id) values ($1) returning *",
    [actor.userId]
  );
  return mapRun(result.rows[0]!);
};

const listRunRecords = async (
  pool: pg.Pool,
  actor: ActorContext,
  input: { limit?: number } = {}
) => {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const result = await pool.query<RunRow>(
    `select * from historical_import_runs
     where owner_user_id = $1 order by updated_at desc, id desc limit $2`,
    [actor.userId, limit]
  );
  return result.rows.map(mapRun);
};

const getRunDetail = async (
  pool: pg.Pool,
  actor: ActorContext,
  runId: string
): Promise<HistoricalImportRunDetail | null> => {
  const run = await getRun(pool, actor, runId);
  if (!run) {
    return null;
  }
  const sourceIds = await pool.query<{ id: string }>(
    `select id from historical_import_sources
     where run_id = $2 and owner_user_id = $1`,
    [actor.userId, runId]
  );
  await Promise.all(
    sourceIds.rows.map((source) =>
      refreshSourceProgress(pool, actor.userId, source.id)
    )
  );
  const sources = await pool.query<SourceRow>(
    `select * from historical_import_sources
     where run_id = $2 and owner_user_id = $1 order by discovered_at, id`,
    [actor.userId, runId]
  );
  return { ...run, sources: sources.rows.map(mapSource) };
};

const createSourceRecord = (
  pool: pg.Pool,
  actor: ActorContext,
  input: CreateHistoricalImportSourceInput
) =>
  withTransaction(pool, async (client) => {
    await lockImportOwner(client, actor.userId);
    const result = await upsertSourceWithClient(client, actor, input);
    const source = result.rows[0] ? mapSource(result.rows[0]) : null;
    if (source && source.runId !== input.runId) {
      throw Object.assign(
        new Error("Historical import source belongs to another run"),
        { statusCode: 409 }
      );
    }
    if (source) {
      await refreshRunCounters(
        client as unknown as pg.Pool,
        actor.userId,
        source.runId
      );
    }
    return source;
  });

const transitionRunRecord = (
  pool: pg.Pool,
  actor: ActorContext,
  input: TransitionHistoricalImportRunInput
) => {
  validateHistoricalImportTransition(input.expectedState, input.state);
  validateTransitionFailure(input);
  return withTransaction(pool, async (client) => {
    await lockImportOwner(client, actor.userId);
    const result = await client.query<RunRow>(
      `update historical_import_runs set state = $4::historical_import_state,
         failure_reason = $5, next_retry_at = $6,
         retry_count = retry_count +
           case when state = 'failed' and $4 = 'queued' then 1 else 0 end,
         last_attempt_at = case when $4 in ('queued', 'importing') then now() else last_attempt_at end,
         ${transitionTimestampSql}, updated_at = now()
       where owner_user_id = $1 and id = $2 and state = $3
         and ($4::text <> 'completed' or (
           failed_source_count = 0
           and source_count = completed_source_count + skipped_source_count
         ))
       returning *`,
      [
        actor.userId,
        input.runId,
        input.expectedState,
        input.state,
        input.failureReason ?? null,
        input.nextRetryAt ?? null
      ]
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  });
};

const transitionSourceRecord = (
  pool: pg.Pool,
  actor: ActorContext,
  input: TransitionHistoricalImportSourceInput
) => {
  validateHistoricalImportTransition(input.expectedState, input.state);
  validateTransitionFailure(input);
  return withTransaction(pool, async (client) => {
    await lockImportOwner(client, actor.userId);
    if (input.state === "completed") {
      await refreshSourceProgress(
        client as unknown as pg.Pool,
        actor.userId,
        input.sourceId
      );
    }
    const result = await client.query<SourceRow>(
      `update historical_import_sources set state = $4::historical_import_state,
         failure_reason = $5, next_retry_at = $6,
         retry_count = retry_count +
           case when state = 'failed' and $4 = 'queued' then 1 else 0 end,
         ${transitionTimestampSql}, updated_at = now()
       where owner_user_id = $1 and id = $2 and state = $3
         and ($4::text <> 'completed' or (
           checkpoint_offset = registration_frontier_offset
           and projected_record_count >= raw_ingested_record_count
           and embedded_event_count = embedding_eligible_event_count
           and lcm_completed_event_count = lcm_eligible_event_count
         ))
       returning *`,
      [
        actor.userId,
        input.sourceId,
        input.expectedState,
        input.state,
        input.failureReason ?? null,
        input.nextRetryAt ?? null
      ]
    );
    const source = result.rows[0] ? mapSource(result.rows[0]) : null;
    if (source) {
      await refreshRunCounters(
        client as unknown as pg.Pool,
        actor.userId,
        source.runId
      );
    }
    return source;
  });
};

const advanceSourceRecord = (
  pool: pg.Pool,
  actor: ActorContext,
  input: AdvanceHistoricalImportSourceInput
) => {
  if (
    input.checkpointOffset <= input.expectedCheckpointOffset ||
    input.sourceSizeBytes < input.checkpointOffset
  ) {
    throw Object.assign(new Error("Historical import checkpoint is invalid"), {
      statusCode: 409
    });
  }
  return withTransaction(pool, async (client) => {
    await lockImportOwner(client, actor.userId);
    const source = await advanceSourceWithClient(client, actor, input);
    if (!source) {
      throw Object.assign(new Error("Historical import checkpoint conflict"), {
        statusCode: 409
      });
    }
    await refreshRunCounters(
      client as unknown as pg.Pool,
      actor.userId,
      source.runId
    );
    return source;
  });
};

const advanceLiveCursorRecord = (
  pool: pg.Pool,
  actor: ActorContext,
  input: LiveTranscriptCursorAdvanceInput
): Promise<HistoricalImportSourceRecord> =>
  withTransaction(pool, async (client) => {
    await lockImportOwner(client, actor.userId);
    const source = await requireSourceForUpdate(client, actor, input.sourceId);
    const expectedHash = input.expectedCursorHash ?? null;
    if (
      source.liveCursorOffset === input.cursorOffset &&
      source.liveCursorLine === input.cursorLine &&
      source.liveCursorHash === input.cursorHash &&
      input.cursorOffset > input.expectedCursorOffset
    ) {
      return source;
    }
    if (input.sourceSizeBytes < (source.sourceSizeBytes ?? 0)) {
      throw Object.assign(new Error("Live transcript cursor conflict"), {
        statusCode: 409
      });
    }
    if (
      source.liveCursorOffset !== input.expectedCursorOffset ||
      source.liveCursorHash !== expectedHash ||
      input.cursorOffset <= input.expectedCursorOffset ||
      input.cursorOffset < source.registrationFrontierOffset ||
      input.cursorOffset > input.sourceSizeBytes ||
      input.sourceSizeBytes < source.checkpointOffset ||
      input.sourceSizeBytes < (source.sourceSizeBytes ?? 0)
    ) {
      throw Object.assign(new Error("Live transcript cursor conflict"), {
        statusCode: 409
      });
    }
    const result = await client.query<SourceRow>(
      `update historical_import_sources set
         live_cursor_offset = $4, live_cursor_line = $5,
         live_cursor_hash = $6, source_size_bytes = $7,
         last_observed_at = now(), updated_at = now()
       where owner_user_id = $1 and id = $2
         and live_cursor_offset = $3
         and live_cursor_hash is not distinct from $8
         and checkpoint_offset <= $7
         and $7 >= coalesce(source_size_bytes, 0)
       returning *`,
      [
        actor.userId,
        input.sourceId,
        input.expectedCursorOffset,
        input.cursorOffset,
        input.cursorLine,
        input.cursorHash,
        input.sourceSizeBytes,
        expectedHash
      ]
    );
    if (!result.rows[0]) {
      throw Object.assign(new Error("Live transcript cursor conflict"), {
        statusCode: 409
      });
    }
    return mapSource(result.rows[0]);
  });

const batchSourceEventRange = (
  input: HistoricalImportBatchWriteInput
): { sourceEventFrom?: string; sourceEventTo?: string } => {
  const eventTimes = [
    input.sourceEventFrom,
    input.sourceEventTo,
    ...input.items.map((item) => item.eventTime)
  ].filter((value): value is string => Boolean(value));
  if (eventTimes.length === 0) {
    return {};
  }
  const ordered = [...eventTimes].sort(
    (left, right) => Date.parse(left) - Date.parse(right)
  );
  return {
    sourceEventFrom: ordered[0],
    sourceEventTo: ordered.at(-1)
  };
};

const listSourcesNeedingLcmFinalization = async (
  pool: pg.Pool
): Promise<
  Array<{ sourceId: string; ownerUserId: string; sessionId: string }>
> => {
  const candidates = await pool.query<{
    id: string;
    owner_user_id: string;
  }>(
    `select id, owner_user_id
     from historical_import_sources
     where state = 'importing'
       and checkpoint_offset = registration_frontier_offset`
  );
  await Promise.all(
    candidates.rows.map((source) =>
      refreshSourceProgress(pool, source.owner_user_id, source.id)
    )
  );
  const result = await pool.query<{
    id: string;
    owner_user_id: string;
    session_id: string;
  }>(
    `select source.id, source.owner_user_id, captured_session.id as session_id
     from historical_import_sources source
     join sessions captured_session
       on captured_session.owner_user_id = source.owner_user_id
      and captured_session.external_session_id = source.source_session_id
     where source.state = 'importing'
       and source.checkpoint_offset = source.registration_frontier_offset
       and source.projected_record_count >= source.raw_ingested_record_count
       and source.embedded_event_count = source.embedding_eligible_event_count
       and source.lcm_completed_event_count < source.lcm_eligible_event_count`
  );
  return result.rows.map((source) => ({
    sourceId: source.id,
    ownerUserId: source.owner_user_id,
    sessionId: source.session_id
  }));
};

const ingestBatchRecord = (
  pool: pg.Pool,
  actor: ActorContext,
  input: HistoricalImportBatchWriteInput
): Promise<HistoricalImportBatchWriteResult> =>
  withTransaction(pool, async (client) => {
    await lockCapturePolicy(client, actor.userId);
    await lockImportOwner(client, actor.userId);
    const source = await requireSourceForUpdate(client, actor, input.sourceId);
    const checkpointAction = validateBatchCheckpoint(source, input);
    const policy = await requireImportPolicy(client, actor, source);
    if (checkpointAction === "replay") {
      return { items: [], source, policy, replayed: true };
    }
    await requireWritableRun(client, actor, source.runId);
    const items = await createImportedConversationItems(
      client,
      actor,
      source,
      input
    );
    const updated = await advanceSourceWithClient(client, actor, {
      ...input,
      ...batchSourceEventRange(input),
      importedRecordCount: input.items.length
    });
    if (!updated) {
      throw Object.assign(new Error("Historical import checkpoint conflict"), {
        statusCode: 409
      });
    }
    await refreshRunCounters(
      client as unknown as pg.Pool,
      actor.userId,
      source.runId
    );
    return { items, source: updated, policy, replayed: false };
  });

export const createHistoricalImportRepository = (
  pool: pg.Pool
): HistoricalImportRepository => ({
  createHistoricalImportRun: (actor) => createRunRecord(pool, actor),
  listHistoricalImportRuns: (actor, input) =>
    listRunRecords(pool, actor, input),
  getHistoricalImportRun: (actor, runId) => getRunDetail(pool, actor, runId),
  createHistoricalImportSource: (actor, input) =>
    createSourceRecord(pool, actor, input),
  transitionHistoricalImportRun: (actor, input) =>
    transitionRunRecord(pool, actor, input),
  transitionHistoricalImportSource: (actor, input) =>
    transitionSourceRecord(pool, actor, input),
  advanceHistoricalImportSource: (actor, input) =>
    advanceSourceRecord(pool, actor, input),
  advanceLiveTranscriptCursor: (actor, input) =>
    advanceLiveCursorRecord(pool, actor, input),
  ingestHistoricalImportBatch: (actor, input) =>
    ingestBatchRecord(pool, actor, input),
  getHistoricalImportSource: (actor, sourceId) =>
    getSource(pool, actor, sourceId),
  getHistoricalImportSourceByIdentity: (actor, identity) =>
    getSourceByIdentity(pool, actor, identity),
  observeHistoricalImportSource: (actor, input) =>
    observeSource(pool, actor, input),
  listHistoricalImportSourcesNeedingLcmFinalization: () =>
    listSourcesNeedingLcmFinalization(pool)
});
