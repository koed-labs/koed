import type pg from "pg";
import { createDb } from "./connection.js";
import { createConversationItemRepository } from "./conversation-item-repository.js";
import { currentEmbeddingConfig } from "./embedding-coverage.js";
import {
  CONSERVATIVE_EMBEDDING_TOKENS_PER_SECOND,
  EMBEDDING_CAPACITY_PROFILE_STALE_AFTER_SECONDS,
  EMBEDDING_CAPACITY_CONTRACT_REVISION
} from "./embedding-capacity-repository.js";
import { createSettingsRepository } from "./settings-repository.js";
import type {
  ActorContext,
  EffectiveCapturePolicy,
  HistoricalImportBatchWriteInput,
  HistoricalImportBatchWriteResult,
  HistoricalImportRunDetail,
  HistoricalImportRunRecord,
  HistoricalImportSourceIdentity,
  HistoricalImportSourceRecord,
  HistoricalImportState
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
  listHistoricalImportSourcesNeedingLcmFinalization(): Promise<
    Array<{ sourceId: string; ownerUserId: string; sessionId: string }>
  >;
  reconcileHistoricalImportCompletion(): Promise<{
    sourcesCompleted: number;
    runsCompleted: number;
  }>;
}

type CreateHistoricalImportSourceInput = {
  runId: string;
  artifactId: string;
  aiClient: string;
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
  artifact_id: string;
  ai_client: string;
  source_kind: string;
  source_adapter_version: string;
  source_session_id: string;
  source_fingerprint: string;
  session_id: string;
  registration_frontier_offset: string | number;
  redacted_source_label: string;
  historical_cursor_offset: string | number;
  historical_cursor_line: number;
  historical_cursor_digest: string | null;
  historical_cursor_parser_state: Record<string, unknown> | null;
  historical_cursor_current_turn_id: string | null;
  provider_cursor_offset: string | number;
  provider_cursor_line: number;
  source_size_bytes: string | number;
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
  embedding_eligible_estimated_token_count: string | number;
  embedded_measured_token_count: string | number;
  pending_embedding_estimated_token_count: string | number;
  queue_ahead_estimated_token_count: string | number;
  capacity_tokens_per_second: number | null;
  capacity_calibration_mode: "quick" | "refined" | null;
  oldest_embedded_source_time: Date | null;
  newest_embedded_source_time: Date | null;
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

const sourceSelect = (): string => {
  const embedding = currentEmbeddingConfig();
  return `
  source.id, source.run_id, source.owner_user_id, source.state,
  source.artifact_id, source.ai_client,
  artifact.source_kind,
  artifact.source_adapter_version,
  artifact.external_session_id as source_session_id,
  artifact.source_fingerprint,
  artifact.session_id,
  artifact.live_start_offset as registration_frontier_offset,
  artifact.redacted_source_label,
  coalesce(historical_cursor.source_offset, artifact.journal_start_offset)
    as historical_cursor_offset,
  coalesce(historical_cursor.source_line, artifact.journal_start_line)
    as historical_cursor_line,
  historical_cursor.last_verified_digest as historical_cursor_digest,
  historical_cursor.parser_state as historical_cursor_parser_state,
  case
    when jsonb_typeof(historical_cursor.parser_state -> 'currentTurnId') = 'string'
     and length(historical_cursor.parser_state ->> 'currentTurnId') between 1 and 512
     and historical_cursor.parser_state ->> 'currentTurnId' !~ '[[:cntrl:]]'
    then historical_cursor.parser_state ->> 'currentTurnId'
    else null
  end as historical_cursor_current_turn_id,
  artifact.provider_cursor_offset,
  artifact.provider_cursor_line,
  artifact.current_source_length as source_size_bytes,
  artifact.source_modified_at,
  source.source_event_from, source.source_event_to,
  source.discovered_record_count, source.imported_record_count,
  source.skipped_record_count, source.malformed_record_count,
  source.raw_ingested_record_count, source.projected_record_count,
  source.embedding_eligible_event_count, source.embedded_event_count,
  source.embedding_eligible_estimated_token_count,
  source.embedded_measured_token_count,
  source.pending_embedding_estimated_token_count,
  coalesce(embedding_position.queue_ahead_estimated_tokens, 0)
    as queue_ahead_estimated_token_count,
  (select sum(profile.measured_tokens_per_second)
     from embedding_capacity_profiles profile
    where profile.state = 'usable'
      and profile.invalidated_at is null
      and profile.updated_at >= now() - make_interval(secs => ${EMBEDDING_CAPACITY_PROFILE_STALE_AFTER_SECONDS})
      and profile.capacity_contract_revision = '${EMBEDDING_CAPACITY_CONTRACT_REVISION}'
      and profile.model_key = '${embedding.model}'
      and profile.embedding_dimensions = ${embedding.dimensions})
    as capacity_tokens_per_second,
  (select case
      when count(*) = 0 then null
      when bool_and(profile.calibration_mode = 'refined') then 'refined'
      else 'quick'
    end
     from embedding_capacity_profiles profile
    where profile.state = 'usable'
      and profile.invalidated_at is null
      and profile.updated_at >= now() - make_interval(secs => ${EMBEDDING_CAPACITY_PROFILE_STALE_AFTER_SECONDS})
      and profile.capacity_contract_revision = '${EMBEDDING_CAPACITY_CONTRACT_REVISION}'
      and profile.model_key = '${embedding.model}'
      and profile.embedding_dimensions = ${embedding.dimensions})
    as capacity_calibration_mode,
  source.oldest_embedded_source_time, source.newest_embedded_source_time,
  source.lcm_eligible_event_count, source.lcm_completed_event_count,
  source.retry_count, source.failure_reason, source.next_retry_at,
  source.detected_project, source.discovered_at, source.eligible_at,
  source.queued_at, source.import_started_at, source.paused_at,
  source.skipped_at, source.completed_at, source.failed_at,
  source.last_observed_at, source.created_at, source.updated_at
`;
};

const SOURCE_JOINS = `
  from historical_import_sources source
  join conversation_source_artifacts artifact
    on artifact.id = source.artifact_id
   and artifact.owner_user_id = source.owner_user_id
  left join conversation_source_consumer_cursors historical_cursor
    on historical_cursor.artifact_id = artifact.id
   and historical_cursor.consumer_kind = 'canonical_historical'
  left join lateral (
    select coalesce(sum(pending.tokens), 0)::bigint
      as queue_ahead_estimated_tokens
    from (
      select greatest(coalesce(event.token_count, 0), 0)::bigint as tokens
      from memory_events event
      left join conversation_projection_processing_outbox processing
        on processing.event_id = event.id
      where event.session_id <> artifact.session_id
        and event.invalidated_at is null
        and event.personal_deleted_at is null
        and event.include_in_embedding
        and not exists (
          select 1
          from memory_embeddings embedding
          where embedding.memory_event_id = event.id
            and embedding.invalidated_at is null
            and embedding.personal_deleted_at is null
            and embedding.source_hash = event.source_hash
          group by embedding.memory_event_id, embedding.source_hash
          having count(*) = max(embedding.source_chunk_count)
            and count(distinct embedding.source_chunk_index) =
              max(embedding.source_chunk_count)
            and min(embedding.source_chunk_index) = 0
            and max(embedding.source_chunk_index) =
              max(embedding.source_chunk_count) - 1
        )
        and (
          coalesce(processing.work_class, 'normal_embedding_lcm') <>
            'historical_import_backfill'
          or coalesce(event.source_event_time, event.captured_at) > (
            select min(coalesce(source_event.source_event_time,
                                source_event.captured_at))
            from memory_events source_event
            where source_event.session_id = artifact.session_id
              and source_event.invalidated_at is null
              and source_event.personal_deleted_at is null
              and source_event.include_in_embedding
              and not exists (
                select 1
                from memory_embeddings source_embedding
                where source_embedding.memory_event_id = source_event.id
                  and source_embedding.invalidated_at is null
                  and source_embedding.personal_deleted_at is null
                  and source_embedding.source_hash = source_event.source_hash
                group by source_embedding.memory_event_id,
                         source_embedding.source_hash
                having count(*) = max(source_embedding.source_chunk_count)
                  and count(distinct source_embedding.source_chunk_index) =
                    max(source_embedding.source_chunk_count)
                  and min(source_embedding.source_chunk_index) = 0
                  and max(source_embedding.source_chunk_index) =
                    max(source_embedding.source_chunk_count) - 1
              )
          )
        )
      union all
      select greatest(coalesce(node.summary_token_estimate,
                               node.source_token_estimate, 0), 0)::bigint
      from memory_nodes node
      where node.invalidated_at is null
        and node.personal_deleted_at is null
        and length(btrim(coalesce(node.summary_text, ''))) > 0
        and not exists (
          select 1
          from memory_embeddings embedding
          where embedding.memory_node_id = node.id
            and embedding.invalidated_at is null
            and embedding.personal_deleted_at is null
            and embedding.source_hash = node.source_hash
          group by embedding.memory_node_id, embedding.source_hash
          having count(*) = max(embedding.source_chunk_count)
            and count(distinct embedding.source_chunk_index) =
              max(embedding.source_chunk_count)
            and min(embedding.source_chunk_index) = 0
            and max(embedding.source_chunk_index) =
              max(embedding.source_chunk_count) - 1
        )
    ) pending
  ) embedding_position on true
`;

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

const mapSource = (row: SourceRow): HistoricalImportSourceRecord => {
  const cursorOffset = Number(row.historical_cursor_offset);
  const frontier = Number(row.registration_frontier_offset);
  const rawIngested = cursorOffset >= frontier;
  const projected =
    rawIngested && row.projected_record_count >= row.raw_ingested_record_count;
  const fullyEmbedded =
    row.embedding_eligible_event_count === row.embedded_event_count;
  const pendingEstimatedTokens = Number(
    row.pending_embedding_estimated_token_count
  );
  const queueAheadEstimatedTokens = Number(
    row.queue_ahead_estimated_token_count
  );
  const capacityRate =
    row.capacity_tokens_per_second ?? CONSERVATIVE_EMBEDDING_TOKENS_PER_SECOND;
  const estimatedCompletionTokens =
    pendingEstimatedTokens > 0
      ? pendingEstimatedTokens + queueAheadEstimatedTokens
      : 0;
  const embeddingEtaLowerSeconds =
    capacityRate && capacityRate > 0
      ? Math.ceil(estimatedCompletionTokens / capacityRate)
      : null;
  const embeddingEtaUpperSeconds =
    capacityRate && capacityRate > 0
      ? Math.ceil(estimatedCompletionTokens / (capacityRate * 0.6))
      : null;
  return {
    id: row.id,
    runId: row.run_id,
    ownerUserId: row.owner_user_id,
    state: row.state,
    artifactId: row.artifact_id,
    aiClient: row.ai_client,
    sourceKind: row.source_kind,
    sourceAdapterVersion: row.source_adapter_version,
    sourceSessionId: row.source_session_id,
    sourceFingerprint: row.source_fingerprint,
    sessionId: row.session_id,
    registrationFrontierOffset: frontier,
    redactedSourceLabel: row.redacted_source_label,
    historicalCursorOffset: cursorOffset,
    historicalCursorLine: row.historical_cursor_line,
    historicalCursorDigest: row.historical_cursor_digest,
    historicalCursorParserState: row.historical_cursor_parser_state ?? {},
    ...(row.historical_cursor_current_turn_id
      ? {
          historicalCursorCurrentTurnId: row.historical_cursor_current_turn_id
        }
      : {}),
    providerCursorOffset: Number(row.provider_cursor_offset),
    providerCursorLine: row.provider_cursor_line,
    sourceSizeBytes: Number(row.source_size_bytes),
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
    embeddingEligibleEstimatedTokenCount: Number(
      row.embedding_eligible_estimated_token_count
    ),
    embeddedMeasuredTokenCount: Number(row.embedded_measured_token_count),
    pendingEmbeddingEstimatedTokenCount: pendingEstimatedTokens,
    embeddingQueueAheadEstimatedTokenCount: queueAheadEstimatedTokens,
    embeddingEtaLowerSeconds,
    embeddingEtaUpperSeconds,
    embeddingEtaConfidence:
      row.capacity_calibration_mode === "refined"
        ? "medium"
        : row.capacity_calibration_mode === "quick"
          ? "low"
          : "conservative",
    oldestEmbeddedSourceTime: iso(row.oldest_embedded_source_time),
    newestEmbeddedSourceTime: iso(row.newest_embedded_source_time),
    lcmEligibleEventCount: row.lcm_eligible_event_count,
    lcmCompletedEventCount: row.lcm_completed_event_count,
    rawIngested,
    projected,
    partiallyEmbedded:
      row.embedded_event_count > 0 &&
      row.embedded_event_count < row.embedding_eligible_event_count,
    fullyEmbedded,
    semanticReady: projected && fullyEmbedded,
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
  };
};

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
      { statusCode: 400 }
    );
  }
};

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
    `capture-policy-owner:${ownerUserId}`
  ]);

const sourceQuery = async (
  client: pg.Pool | pg.PoolClient,
  ownerUserId: string,
  predicate: string,
  values: unknown[]
): Promise<HistoricalImportSourceRecord | null> => {
  const result = await client.query<SourceRow>(
    `select ${sourceSelect()} ${SOURCE_JOINS}
      where source.owner_user_id = $1 and ${predicate}
      limit 1`,
    [ownerUserId, ...values]
  );
  return result.rows[0] ? mapSource(result.rows[0]) : null;
};

const requireSourceForUpdate = async (
  client: pg.PoolClient,
  actor: ActorContext,
  sourceId: string
): Promise<HistoricalImportSourceRecord> => {
  await client.query(
    `select id from historical_import_sources
      where owner_user_id = $1 and id = $2 for update`,
    [actor.userId, sourceId]
  );
  const source = await sourceQuery(client, actor.userId, "source.id = $2", [
    sourceId
  ]);
  if (!source) {
    throw Object.assign(new Error("Historical import source not found"), {
      statusCode: 404
    });
  }
  return source;
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

const refreshRunCounters = async (
  client: pg.Pool | pg.PoolClient,
  ownerUserId: string,
  runId: string
): Promise<void> => {
  await client.query(
    `update historical_import_runs run set
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
       select count(*)::int as source_count,
         count(*) filter (where source.state = 'completed')::int
           as completed_source_count,
         count(*) filter (where source.state = 'failed')::int
           as failed_source_count,
         count(*) filter (where source.state = 'skipped')::int
           as skipped_source_count,
         coalesce(sum(source.discovered_record_count), 0)::int
           as discovered_record_count,
         coalesce(sum(source.imported_record_count), 0)::int
           as imported_record_count,
         coalesce(sum(source.skipped_record_count), 0)::int
           as skipped_record_count,
         coalesce(sum(
           greatest(
             coalesce(cursor.source_offset, artifact.journal_start_offset)
               - artifact.journal_start_offset,
             0
           )
         ), 0)::bigint as scanned_byte_count
       from historical_import_sources source
       join conversation_source_artifacts artifact
         on artifact.id = source.artifact_id
        and artifact.owner_user_id = source.owner_user_id
       left join conversation_source_consumer_cursors cursor
         on cursor.artifact_id = artifact.id
        and cursor.consumer_kind = 'canonical_historical'
       where source.run_id = $2 and source.owner_user_id = $1
     ) stats
     where run.id = $2 and run.owner_user_id = $1`,
    [ownerUserId, runId]
  );
};

const refreshSourceProgress = async (
  client: pg.Pool | pg.PoolClient,
  ownerUserId: string,
  sourceId: string
): Promise<void> => {
  const embedding = currentEmbeddingConfig();
  await client.query(
    `with source_scope as (
       select source.id, artifact.session_id, source.imported_record_count
       from historical_import_sources source
       join conversation_source_artifacts artifact
         on artifact.id = source.artifact_id
        and artifact.owner_user_id = source.owner_user_id
       where source.id = $2 and source.owner_user_id = $1
     ), progress as (
       select scope.id, scope.imported_record_count,
         (select count(*)::int
          from conversation_items item
          where item.session_id = scope.session_id
            and (
              item.projected_at is not null
              or item.projection_status = 'raw_only'
            )
            and exists (
              select 1 from conversation_item_observations observation
              where observation.conversation_item_id = item.id
                and observation.source_transport = 'historical_import'
            )) as projected_count,
         (select count(*)::int
          from memory_events event
          where event.session_id = scope.session_id
            and event.invalidated_at is null
            and event.personal_deleted_at is null
            and event.include_in_embedding
            and exists (
              select 1
              from memory_event_sources event_source
              join conversation_item_observations observation
                on observation.conversation_item_id =
                  event_source.conversation_item_id
              where event_source.memory_event_id = event.id
                and observation.source_transport = 'historical_import'
            )) as embedding_eligible_count,
         (select coalesce(sum(greatest(coalesce(event.token_count, 0), 0)), 0)::bigint
          from memory_events event
          where event.session_id = scope.session_id
            and event.invalidated_at is null
            and event.personal_deleted_at is null
            and event.include_in_embedding
            and exists (
              select 1
              from memory_event_sources event_source
              join conversation_item_observations observation
                on observation.conversation_item_id =
                  event_source.conversation_item_id
              where event_source.memory_event_id = event.id
                and observation.source_transport = 'historical_import'
            )) as embedding_eligible_tokens,
         (select count(*)::int
          from memory_events event
          where event.session_id = scope.session_id
            and event.invalidated_at is null
            and event.personal_deleted_at is null
            and event.include_in_embedding
            and exists (
              select 1
              from memory_event_sources event_source
              join conversation_item_observations observation
                on observation.conversation_item_id =
                  event_source.conversation_item_id
              where event_source.memory_event_id = event.id
                and observation.source_transport = 'historical_import'
            )
            and exists (
              select 1
              from memory_embeddings embedding
              join ${embedding.table} vector
                on vector.memory_embedding_id = embedding.id
              where embedding.memory_event_id = event.id
                and embedding.invalidated_at is null
                and embedding.personal_deleted_at is null
                and embedding.embedding_model = $3
                and embedding.embedding_dimensions = $4
                and embedding.embedding_version = $5
                and embedding.source_hash = event.source_hash
              group by embedding.memory_event_id, embedding.source_hash
              having count(*) = max(embedding.source_chunk_count)
                and count(distinct embedding.source_chunk_index) =
                  max(embedding.source_chunk_count)
                and min(embedding.source_chunk_index) = 0
                and max(embedding.source_chunk_index) =
                  max(embedding.source_chunk_count) - 1
            )) as embedded_count,
         (select coalesce(sum(complete.measured_tokens), 0)::bigint
          from memory_events event
          join lateral (
            select sum(embedding.input_token_count)::bigint as measured_tokens
            from memory_embeddings embedding
            join ${embedding.table} vector on vector.memory_embedding_id = embedding.id
            where embedding.memory_event_id = event.id
              and embedding.invalidated_at is null
              and embedding.personal_deleted_at is null
              and embedding.embedding_model = $3
              and embedding.embedding_dimensions = $4
              and embedding.embedding_version = $5
              and embedding.source_hash = event.source_hash
            group by embedding.memory_event_id, embedding.source_hash
            having count(*) = max(embedding.source_chunk_count)
              and count(distinct embedding.source_chunk_index) = max(embedding.source_chunk_count)
              and min(embedding.source_chunk_index) = 0
              and max(embedding.source_chunk_index) = max(embedding.source_chunk_count) - 1
          ) complete on true
          where event.session_id = scope.session_id
            and event.invalidated_at is null
            and event.personal_deleted_at is null
            and event.include_in_embedding
            and exists (
              select 1
              from memory_event_sources event_source
              join conversation_item_observations observation
                on observation.conversation_item_id = event_source.conversation_item_id
              where event_source.memory_event_id = event.id
                and observation.source_transport = 'historical_import'
            )) as embedded_tokens,
         (select coalesce(sum(greatest(coalesce(event.token_count, 0), 0)), 0)::bigint
          from memory_events event
          where event.session_id = scope.session_id
            and event.invalidated_at is null
            and event.personal_deleted_at is null
            and event.include_in_embedding
            and exists (
              select 1
              from memory_event_sources event_source
              join conversation_item_observations observation
                on observation.conversation_item_id = event_source.conversation_item_id
              where event_source.memory_event_id = event.id
                and observation.source_transport = 'historical_import'
            )
            and not exists (
              select 1
              from memory_embeddings embedding
              join ${embedding.table} vector
                on vector.memory_embedding_id = embedding.id
              where embedding.memory_event_id = event.id
                and embedding.invalidated_at is null
                and embedding.personal_deleted_at is null
                and embedding.embedding_model = $3
                and embedding.embedding_dimensions = $4
                and embedding.embedding_version = $5
                and embedding.source_hash = event.source_hash
              group by embedding.memory_event_id, embedding.source_hash
              having count(*) = max(embedding.source_chunk_count)
                and count(distinct embedding.source_chunk_index) =
                  max(embedding.source_chunk_count)
                and min(embedding.source_chunk_index) = 0
                and max(embedding.source_chunk_index) =
                  max(embedding.source_chunk_count) - 1
            )) as pending_embedding_estimated_tokens,
         (select min(event.source_event_time)
          from memory_events event
          where event.session_id = scope.session_id
            and event.invalidated_at is null
            and event.personal_deleted_at is null
            and event.include_in_embedding
            and exists (
              select 1
              from memory_event_sources event_source
              join conversation_item_observations observation
                on observation.conversation_item_id =
                  event_source.conversation_item_id
              where event_source.memory_event_id = event.id
                and observation.source_transport = 'historical_import'
            )
            and exists (
              select 1
              from memory_embeddings embedding
              join ${embedding.table} vector
                on vector.memory_embedding_id = embedding.id
              where embedding.memory_event_id = event.id
                and embedding.invalidated_at is null
                and embedding.personal_deleted_at is null
                and embedding.embedding_model = $3
                and embedding.embedding_dimensions = $4
                and embedding.embedding_version = $5
                and embedding.source_hash = event.source_hash
              group by embedding.memory_event_id, embedding.source_hash
              having count(*) = max(embedding.source_chunk_count)
                and count(distinct embedding.source_chunk_index) =
                  max(embedding.source_chunk_count)
                and min(embedding.source_chunk_index) = 0
                and max(embedding.source_chunk_index) =
                  max(embedding.source_chunk_count) - 1
            )) as oldest_embedded_source_time,
         (select max(event.source_event_time)
          from memory_events event
          where event.session_id = scope.session_id
            and event.invalidated_at is null
            and event.personal_deleted_at is null
            and event.include_in_embedding
            and exists (
              select 1
              from memory_event_sources event_source
              join conversation_item_observations observation
                on observation.conversation_item_id =
                  event_source.conversation_item_id
              where event_source.memory_event_id = event.id
                and observation.source_transport = 'historical_import'
            )
            and exists (
              select 1
              from memory_embeddings embedding
              join ${embedding.table} vector
                on vector.memory_embedding_id = embedding.id
              where embedding.memory_event_id = event.id
                and embedding.invalidated_at is null
                and embedding.personal_deleted_at is null
                and embedding.embedding_model = $3
                and embedding.embedding_dimensions = $4
                and embedding.embedding_version = $5
                and embedding.source_hash = event.source_hash
              group by embedding.memory_event_id, embedding.source_hash
              having count(*) = max(embedding.source_chunk_count)
                and count(distinct embedding.source_chunk_index) =
                  max(embedding.source_chunk_count)
                and min(embedding.source_chunk_index) = 0
                and max(embedding.source_chunk_index) =
                  max(embedding.source_chunk_count) - 1
            )) as newest_embedded_source_time,
         (select count(*)::int
          from memory_events event
          where event.session_id = scope.session_id
            and event.invalidated_at is null
            and event.include_in_lcm
            and exists (
              select 1
              from memory_event_sources event_source
              join conversation_item_observations observation
                on observation.conversation_item_id =
                  event_source.conversation_item_id
              where event_source.memory_event_id = event.id
                and observation.source_transport = 'historical_import'
            )) as lcm_eligible_count,
         (select count(distinct event.id)::int
          from memory_events event
          join memory_node_sources node_source
            on node_source.memory_event_id = event.id
          join memory_nodes node
            on node.id = node_source.memory_node_id
           and node.invalidated_at is null
           and node.summary_model is not null
          where event.session_id = scope.session_id
            and event.invalidated_at is null
            and event.include_in_lcm
            and exists (
              select 1
              from memory_event_sources event_source
              join conversation_item_observations observation
                on observation.conversation_item_id =
                  event_source.conversation_item_id
              where event_source.memory_event_id = event.id
                and observation.source_transport = 'historical_import'
            )) as lcm_completed_count
       from source_scope scope
     )
     update historical_import_sources source set
       raw_ingested_record_count = progress.imported_record_count,
       projected_record_count = progress.projected_count,
       embedding_eligible_event_count = progress.embedding_eligible_count,
       embedded_event_count = progress.embedded_count,
       embedding_eligible_estimated_token_count = progress.embedding_eligible_tokens,
       embedded_measured_token_count = progress.embedded_tokens,
       pending_embedding_estimated_token_count =
         progress.pending_embedding_estimated_tokens,
       oldest_embedded_source_time = progress.oldest_embedded_source_time,
       newest_embedded_source_time = progress.newest_embedded_source_time,
       lcm_eligible_event_count = progress.lcm_eligible_count,
       lcm_completed_event_count = progress.lcm_completed_count
     from progress where source.id = progress.id`,
    [
      ownerUserId,
      sourceId,
      embedding.model,
      embedding.dimensions,
      embedding.version
    ]
  );
};

const projectPolicyId = (
  source: HistoricalImportSourceRecord
): string | undefined => {
  for (const key of ["projectId", "path", "cwd"] as const) {
    const value = source.detectedProject[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
};

const requireImportPolicy = async (
  client: pg.PoolClient,
  actor: ActorContext,
  source: HistoricalImportSourceRecord
): Promise<EffectiveCapturePolicy> => {
  const policy = await createSettingsRepository(
    createDb(client as unknown as pg.Pool)
  ).getEffectiveCapturePolicy(actor, {
    projectId: projectPolicyId(source),
    threadId: source.sourceSessionId
  });
  if (
    policy.visibility !== "personal" ||
    policy.captureState !== "enabled" ||
    policy.paused
  ) {
    throw Object.assign(
      new Error("Historical import blocked by effective Capture Policy"),
      { statusCode: 409 }
    );
  }
  return policy;
};

const requireWritableRun = async (
  client: pg.PoolClient,
  actor: ActorContext,
  runId: string
): Promise<void> => {
  const result = await client.query(
    `select id from historical_import_runs
      where owner_user_id = $1 and id = $2
        and state in ('queued', 'importing', 'paused')
      for update`,
    [actor.userId, runId]
  );
  if (result.rowCount === 0) {
    throw Object.assign(new Error("Historical import run is not writable"), {
      statusCode: 409
    });
  }
};

const importedItem = (
  item: HistoricalImportBatchWriteInput["items"][number],
  source: HistoricalImportSourceRecord,
  observedAt: string
) => ({
  ...item,
  visibility: "personal" as const,
  sessionId: source.sessionId,
  turnId: undefined,
  sourceKind: source.sourceKind,
  sourceAdapterVersion: source.sourceAdapterVersion,
  sourceTransport: "historical_import" as const,
  externalSessionId: source.sourceSessionId,
  externalThreadId: source.sourceSessionId,
  importObservedAt: observedAt,
  sourceFingerprint: source.sourceFingerprint,
  projectionStatus: item.projectionStatus ?? ("pending" as const),
  projectionVersion: item.projectionVersion ?? source.sourceAdapterVersion,
  metadata: {
    ...(item.metadata ?? {}),
    historicalImportRunId: source.runId,
    historicalImportSourceId: source.id,
    conversationSourceArtifactId: source.artifactId
  }
});

const batchSourceEventRange = (
  input: HistoricalImportBatchWriteInput
): { sourceEventFrom: string | null; sourceEventTo: string | null } => {
  const eventTimes = [
    input.sourceEventFrom,
    input.sourceEventTo,
    ...input.items.map((item) => item.eventTime)
  ].filter((value): value is string => Boolean(value));
  if (eventTimes.length === 0) {
    return { sourceEventFrom: null, sourceEventTo: null };
  }
  const ordered = [...eventTimes].sort(
    (left, right) => Date.parse(left) - Date.parse(right)
  );
  return {
    sourceEventFrom: ordered[0]!,
    sourceEventTo: ordered.at(-1)!
  };
};

const historicalCursor = async (
  client: pg.PoolClient,
  source: HistoricalImportSourceRecord
): Promise<{
  sourceOffset: number;
  sourceLine: number;
  lastVerifiedDigest: string | null;
}> => {
  const result = await client.query<{
    source_offset: string | number;
    source_line: number;
    last_verified_digest: string | null;
  }>(
    `select source_offset, source_line, last_verified_digest
       from conversation_source_consumer_cursors
      where artifact_id = $1 and consumer_kind = 'canonical_historical'
      for update`,
    [source.artifactId]
  );
  return result.rows[0]
    ? {
        sourceOffset: Number(result.rows[0].source_offset),
        sourceLine: result.rows[0].source_line,
        lastVerifiedDigest: result.rows[0].last_verified_digest
      }
    : {
        sourceOffset: source.historicalCursorOffset,
        sourceLine: source.historicalCursorLine,
        lastVerifiedDigest: source.historicalCursorDigest
      };
};

const validateBatchBoundary = async (
  client: pg.PoolClient,
  source: HistoricalImportSourceRecord,
  input: HistoricalImportBatchWriteInput
): Promise<"advance" | "replay"> => {
  const cursor = await historicalCursor(client, source);
  if (
    cursor.sourceOffset === input.sourceOffset &&
    cursor.lastVerifiedDigest === input.lastVerifiedDigest &&
    input.sourceOffset > input.expectedSourceOffset
  ) {
    return "replay";
  }
  if (
    cursor.sourceOffset !== input.expectedSourceOffset ||
    input.sourceOffset <= input.expectedSourceOffset ||
    input.sourceOffset > source.registrationFrontierOffset
  ) {
    throw Object.assign(new Error("Historical import cursor conflict"), {
      statusCode: 409
    });
  }
  const segment = await client.query<{
    source_start_offset: string | number;
    source_end_offset: string | number;
    plaintext_digest: string;
  }>(
    `select source_start_offset, source_end_offset, plaintext_digest
       from conversation_source_segments
      where artifact_id = $1 and segment_index = $2
      limit 1`,
    [source.artifactId, input.segmentIndex]
  );
  const row = segment.rows[0];
  if (
    !row ||
    Number(row.source_start_offset) >= input.sourceOffset ||
    Number(row.source_end_offset) < input.sourceOffset ||
    row.plaintext_digest !== input.lastVerifiedDigest
  ) {
    throw Object.assign(
      new Error("Historical import segment verification failed"),
      { statusCode: 409 }
    );
  }
  return "advance";
};

const createRunRecord = async (
  pool: pg.Pool,
  actor: ActorContext
): Promise<HistoricalImportRunRecord> => {
  const result = await pool.query<RunRow>(
    "insert into historical_import_runs (owner_user_id) values ($1) returning *",
    [actor.userId]
  );
  return mapRun(result.rows[0]!);
};

const createSourceRecord = (
  pool: pg.Pool,
  actor: ActorContext,
  input: CreateHistoricalImportSourceInput
): Promise<HistoricalImportSourceRecord | null> =>
  withTransaction(pool, async (client) => {
    await lockImportOwner(client, actor.userId);
    const result = await client.query<{ id: string }>(
      `insert into historical_import_sources (
         run_id, owner_user_id, artifact_id, ai_client,
         source_event_from, source_event_to, discovered_record_count,
         detected_project, last_observed_at
       )
       select run.id, run.owner_user_id, artifact.id, $4, $5, $6, $7, $8, now()
       from historical_import_runs run
       join conversation_source_artifacts artifact
         on artifact.id = $3
        and artifact.owner_user_id = run.owner_user_id
        and artifact.lifecycle = 'active'
        and (($4 = 'codex' and artifact.source_kind = 'codex')
          or ($4 = 'claude' and artifact.source_kind = 'claude-code')
          or ($4 = 'pi' and artifact.source_kind = 'pi'))
       where run.id = $2 and run.owner_user_id = $1
         and run.state in ('discovered', 'eligible', 'queued', 'importing', 'paused')
       on conflict (owner_user_id, artifact_id)
       do update set
         ai_client = excluded.ai_client,
         last_observed_at = now(),
         updated_at = now()
       where historical_import_sources.run_id = excluded.run_id
       returning id`,
      [
        actor.userId,
        input.runId,
        input.artifactId,
        input.aiClient,
        input.sourceEventFrom ?? null,
        input.sourceEventTo ?? null,
        input.discoveredRecordCount ?? 0,
        input.detectedProject ?? {}
      ]
    );
    const id = result.rows[0]?.id;
    if (!id) return null;
    const source = await sourceQuery(client, actor.userId, "source.id = $2", [
      id
    ]);
    if (source) {
      await refreshRunCounters(client, actor.userId, source.runId);
    }
    return source;
  });

const transitionTimestampSql = `
  eligible_at = case when $4 = 'eligible' then now() else eligible_at end,
  queued_at = case when $4 = 'queued' then now() else queued_at end,
  import_started_at = case
    when $4 = 'importing' then coalesce(import_started_at, now())
    else import_started_at
  end,
  paused_at = case when $4 = 'paused' then now() else paused_at end,
  skipped_at = case when $4 = 'skipped' then now() else skipped_at end,
  completed_at = case when $4 = 'completed' then now() else completed_at end,
  failed_at = case when $4 = 'failed' then now() else failed_at end
`;

const transitionRunRecord = (
  pool: pg.Pool,
  actor: ActorContext,
  input: TransitionHistoricalImportRunInput
): Promise<HistoricalImportRunRecord | null> => {
  validateHistoricalImportTransition(input.expectedState, input.state);
  validateTransitionFailure(input);
  return withTransaction(pool, async (client) => {
    await lockImportOwner(client, actor.userId);
    await refreshRunCounters(client, actor.userId, input.runId);
    const result = await client.query<RunRow>(
      `update historical_import_runs set
         state = $4::historical_import_state,
         failure_reason = $5,
         next_retry_at = $6,
         retry_count = retry_count +
           case when state = 'failed' and $4 = 'queued' then 1 else 0 end,
         last_attempt_at = case
           when $4 in ('queued', 'importing') then now()
           else last_attempt_at
         end,
         ${transitionTimestampSql},
         updated_at = now()
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
): Promise<HistoricalImportSourceRecord | null> => {
  validateHistoricalImportTransition(input.expectedState, input.state);
  validateTransitionFailure(input);
  return withTransaction(pool, async (client) => {
    await lockImportOwner(client, actor.userId);
    if (input.state === "completed") {
      await refreshSourceProgress(client, actor.userId, input.sourceId);
    }
    const source = await requireSourceForUpdate(client, actor, input.sourceId);
    if (
      input.state === "completed" &&
      (!source.rawIngested ||
        !source.projected ||
        !source.fullyEmbedded ||
        !source.lcmComplete)
    ) {
      return null;
    }
    const result = await client.query<{ id: string; run_id: string }>(
      `update historical_import_sources set
         state = $4::historical_import_state,
         failure_reason = $5,
         next_retry_at = $6,
         retry_count = retry_count +
           case when state = 'failed' and $4 = 'queued' then 1 else 0 end,
         ${transitionTimestampSql},
         updated_at = now()
       where owner_user_id = $1 and id = $2 and state = $3
       returning id, run_id`,
      [
        actor.userId,
        input.sourceId,
        input.expectedState,
        input.state,
        input.failureReason ?? null,
        input.nextRetryAt ?? null
      ]
    );
    const row = result.rows[0];
    if (!row) return null;
    await refreshRunCounters(client, actor.userId, row.run_id);
    return sourceQuery(client, actor.userId, "source.id = $2", [row.id]);
  });
};

// Only fields the real Codex/Claude historical adapters ever produce for
// mid-parse resume (see codex-historical-ingestion.ts's parserState() and
// claude-transcript-parser.ts's { currentTurnId }) are safe to persist here.
// This is the write-side counterpart to apps/api's safeParserState(): every
// read path (this repository's own mapSource() included) returns the
// persisted parser_state column verbatim, so anything not filtered out here
// would otherwise be free-form storage for arbitrary, potentially large
// content such as raw transcript text.
const SAFE_HISTORICAL_PARSER_STATE_KEYS = [
  "activeTurnId",
  "currentTurnId",
  "lastEventTime",
  "assistantMessagePreference"
] as const;

const safeHistoricalParserState = (
  state: Record<string, unknown> | undefined
): Record<string, unknown> =>
  Object.fromEntries(
    SAFE_HISTORICAL_PARSER_STATE_KEYS.filter(
      (key) => (state ?? {})[key] !== undefined
    ).map((key) => [key, (state ?? {})[key]])
  );

const ingestBatchRecord = (
  pool: pg.Pool,
  actor: ActorContext,
  input: HistoricalImportBatchWriteInput
): Promise<HistoricalImportBatchWriteResult> =>
  withTransaction(pool, async (client) => {
    await lockCapturePolicy(client, actor.userId);
    await lockImportOwner(client, actor.userId);
    const source = await requireSourceForUpdate(client, actor, input.sourceId);
    const action = await validateBatchBoundary(client, source, input);
    const policy = await requireImportPolicy(client, actor, source);
    if (action === "replay") {
      return { items: [], source, policy, replayed: true };
    }
    await requireWritableRun(client, actor, source.runId);
    if (!["queued", "importing"].includes(source.state)) {
      throw Object.assign(
        new Error("Historical import source is not writable"),
        {
          statusCode: 409
        }
      );
    }
    const observedAt = new Date().toISOString();
    const items = await createConversationItemRepository(
      client as unknown as pg.Pool,
      { transactionClient: client }
    ).createConversationItems(actor, {
      items: input.items.map((item) => importedItem(item, source, observedAt))
    });
    const cursorResult = await client.query(
      `insert into conversation_source_consumer_cursors (
         artifact_id, consumer_kind, segment_index, source_offset,
         source_line, last_verified_digest, parser_state
       ) values ($1, 'canonical_historical', $2, $3, $4, $5, $6)
       on conflict (artifact_id, consumer_kind)
       do update set
         segment_index = excluded.segment_index,
         source_offset = excluded.source_offset,
         source_line = excluded.source_line,
         last_verified_digest = excluded.last_verified_digest,
         parser_state = excluded.parser_state,
         failure_code = null,
         retry_count = 0,
         updated_at = now()
       where conversation_source_consumer_cursors.source_offset = $7
         and excluded.source_offset >
           conversation_source_consumer_cursors.source_offset
       returning artifact_id`,
      [
        source.artifactId,
        input.segmentIndex,
        input.sourceOffset,
        input.sourceLine,
        input.lastVerifiedDigest,
        safeHistoricalParserState(input.parserState),
        input.expectedSourceOffset
      ]
    );
    if (cursorResult.rowCount !== 1) {
      throw Object.assign(new Error("Historical import cursor conflict"), {
        statusCode: 409
      });
    }
    const range = batchSourceEventRange(input);
    await client.query(
      `update historical_import_sources set
         state = 'importing',
         imported_record_count = imported_record_count + $3,
         raw_ingested_record_count = raw_ingested_record_count + $3,
         skipped_record_count = skipped_record_count + $4,
         malformed_record_count = malformed_record_count + $5,
         source_event_from = case
           when $6::timestamptz is null then source_event_from
           when source_event_from is null then $6::timestamptz
           else least(source_event_from, $6::timestamptz)
         end,
         source_event_to = case
           when $7::timestamptz is null then source_event_to
           when source_event_to is null then $7::timestamptz
           else greatest(source_event_to, $7::timestamptz)
         end,
         import_started_at = coalesce(import_started_at, now()),
         last_observed_at = now(),
         updated_at = now()
       where owner_user_id = $1 and id = $2`,
      [
        actor.userId,
        source.id,
        input.items.length,
        input.skippedRecordCount ?? 0,
        input.malformedRecordCount ?? 0,
        range.sourceEventFrom,
        range.sourceEventTo
      ]
    );
    await refreshRunCounters(client, actor.userId, source.runId);
    const updated = await sourceQuery(client, actor.userId, "source.id = $2", [
      source.id
    ]);
    if (!updated) {
      throw new Error("Historical import source disappeared");
    }
    return { items, source: updated, policy, replayed: false };
  });

const listSourcesNeedingLcmFinalization = async (
  pool: pg.Pool
): Promise<
  Array<{ sourceId: string; ownerUserId: string; sessionId: string }>
> => {
  const candidates = await pool.query<{
    id: string;
    owner_user_id: string;
  }>(
    `select source.id, source.owner_user_id
       from historical_import_sources source
       join conversation_source_artifacts artifact
         on artifact.id = source.artifact_id
       left join conversation_source_consumer_cursors cursor
         on cursor.artifact_id = artifact.id
        and cursor.consumer_kind = 'canonical_historical'
      where source.state = 'importing'
        and coalesce(cursor.source_offset, artifact.journal_start_offset)
          >= artifact.live_start_offset`
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
    `select source.id, source.owner_user_id, artifact.session_id
       from historical_import_sources source
       join conversation_source_artifacts artifact
         on artifact.id = source.artifact_id
       left join conversation_source_consumer_cursors cursor
         on cursor.artifact_id = artifact.id
        and cursor.consumer_kind = 'canonical_historical'
      where source.state = 'importing'
        and coalesce(cursor.source_offset, artifact.journal_start_offset)
          >= artifact.live_start_offset
        and source.projected_record_count >= source.raw_ingested_record_count
        and source.embedded_event_count =
          source.embedding_eligible_event_count
        and source.lcm_completed_event_count <
          source.lcm_eligible_event_count`
  );
  return result.rows.map((source) => ({
    sourceId: source.id,
    ownerUserId: source.owner_user_id,
    sessionId: source.session_id
  }));
};

const reconcileHistoricalImportCompletion = async (
  pool: pg.Pool
): Promise<{ sourcesCompleted: number; runsCompleted: number }> => {
  const sourceCandidates = await pool.query<{
    id: string;
    owner_user_id: string;
  }>(
    `select id, owner_user_id
       from historical_import_sources
      where state = 'importing'
      order by updated_at, id
      limit 1000`
  );
  let sourcesCompleted = 0;
  for (const source of sourceCandidates.rows) {
    const completed = await transitionSourceRecord(
      pool,
      { userId: source.owner_user_id },
      {
        sourceId: source.id,
        expectedState: "importing",
        state: "completed"
      }
    );
    if (completed) sourcesCompleted += 1;
  }

  const runCandidates = await pool.query<{
    id: string;
    owner_user_id: string;
  }>(
    `select id, owner_user_id
       from historical_import_runs
      where state = 'importing'
      order by updated_at, id
      limit 1000`
  );
  let runsCompleted = 0;
  for (const run of runCandidates.rows) {
    const completed = await transitionRunRecord(
      pool,
      { userId: run.owner_user_id },
      {
        runId: run.id,
        expectedState: "importing",
        state: "completed"
      }
    );
    if (completed) runsCompleted += 1;
  }
  return { sourcesCompleted, runsCompleted };
};

export const createHistoricalImportRepository = (
  pool: pg.Pool
): HistoricalImportRepository => ({
  createHistoricalImportRun: (actor) => createRunRecord(pool, actor),
  listHistoricalImportRuns: async (actor, input = {}) => {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const result = await pool.query<RunRow>(
      `select * from historical_import_runs
        where owner_user_id = $1
        order by updated_at desc, id desc
        limit $2`,
      [actor.userId, limit]
    );
    return result.rows.map(mapRun);
  },
  getHistoricalImportRun: async (actor, runId) => {
    const run = await getRun(pool, actor, runId);
    if (!run) return null;
    const sourceIds = await pool.query<{ id: string }>(
      `select id from historical_import_sources
        where owner_user_id = $1 and run_id = $2`,
      [actor.userId, runId]
    );
    await Promise.all(
      sourceIds.rows.map((source) =>
        refreshSourceProgress(pool, actor.userId, source.id)
      )
    );
    await refreshRunCounters(pool, actor.userId, runId);
    const refreshedRun = await getRun(pool, actor, runId);
    const sources = await pool.query<SourceRow>(
      `select ${sourceSelect()} ${SOURCE_JOINS}
        where source.owner_user_id = $1 and source.run_id = $2
        order by source.discovered_at, source.id`,
      [actor.userId, runId]
    );
    return {
      ...(refreshedRun ?? run),
      sources: sources.rows.map(mapSource)
    };
  },
  createHistoricalImportSource: (actor, input) =>
    createSourceRecord(pool, actor, input),
  transitionHistoricalImportRun: (actor, input) =>
    transitionRunRecord(pool, actor, input),
  transitionHistoricalImportSource: (actor, input) =>
    transitionSourceRecord(pool, actor, input),
  ingestHistoricalImportBatch: (actor, input) =>
    ingestBatchRecord(pool, actor, input),
  getHistoricalImportSource: async (actor, sourceId) => {
    await refreshSourceProgress(pool, actor.userId, sourceId);
    return sourceQuery(pool, actor.userId, "source.id = $2", [sourceId]);
  },
  getHistoricalImportSourceByIdentity: (actor, identity) =>
    sourceQuery(pool, actor.userId, "source.artifact_id = $2", [
      identity.artifactId
    ]),
  listHistoricalImportSourcesNeedingLcmFinalization: () =>
    listSourcesNeedingLcmFinalization(pool),
  reconcileHistoricalImportCompletion: () =>
    reconcileHistoricalImportCompletion(pool)
});
