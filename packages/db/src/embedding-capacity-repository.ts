import type pg from "pg";

export const CONSERVATIVE_EMBEDDING_TOKENS_PER_SECOND = 5;
export const EMBEDDING_CAPACITY_CONTRACT_REVISION = "embedding-capacity-v1";
export const EMBEDDING_CAPACITY_PROFILE_STALE_AFTER_SECONDS = 120;

export type EmbeddingBackendClass = "cpu" | "metal" | "cuda" | "unknown";
export type EmbeddingCalibrationMode = "quick" | "refined";
export type EmbeddingCapacityProfileState = "usable" | "failed";

export interface EmbeddingCapacitySampleMeasurement {
  targetTokenClass: number;
  measuredTokenCount: number;
  durationMs: number;
}

export interface EmbeddingCapacityProfileInput {
  poolKey: string;
  profileKey: string;
  profileVersion: string;
  capacityContractRevision: string;
  state: EmbeddingCapacityProfileState;
  calibrationMode: EmbeddingCalibrationMode;
  modelKey: string;
  modelArtifactHash: string;
  embeddingDimensions: number;
  tokenizer: string;
  inputTransform: string;
  pooling: string;
  normalization: string;
  runtimeKind: string;
  runtimeVersion: string | null;
  backendClass: EmbeddingBackendClass;
  hardwareFingerprint: string;
  settingsFingerprint: string;
  runtimeSettings: Record<string, string | number | boolean | null>;
  sampleMeasurements: EmbeddingCapacitySampleMeasurement[];
  testedConcurrency: number;
  sampleCount: number;
  measuredTokenCount: number;
  durationMs: number;
  measuredTokensPerSecond: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  failureCode?: string | null;
}

export interface EmbeddingCapacityProfileRecord extends EmbeddingCapacityProfileInput {
  id: string;
  calibratedAt: string;
  invalidatedAt: string | null;
  invalidationReason: string | null;
}

export type EmbeddingTelemetryQueueName =
  | "projection"
  | "memory-embed"
  | "lcm-embed"
  | "lcm-compact"
  | "direct";
export type EmbeddingTelemetrySourceClass =
  | "memory_event"
  | "memory_node"
  | "message"
  | "lcm_compaction";
export type EmbeddingTelemetryOutcome =
  | "created"
  | "completed"
  | "skipped"
  | "retry"
  | "failed";

export interface EmbeddingTelemetryObservation {
  observedAt?: Date;
  queueName: EmbeddingTelemetryQueueName;
  sourceClass: EmbeddingTelemetrySourceClass;
  outcome: EmbeddingTelemetryOutcome;
  eventCount?: number;
  chunkCount?: number;
  measuredTokenCount?: number;
  queueWaitMs?: number;
  executionMs?: number;
  endToEndMs?: number;
}

export interface EmbeddingTelemetryWindow {
  windowMinutes: 1 | 5 | 15;
  arrivalEventCount: number;
  eventCount: number;
  memoryEventCount: number;
  memoryNodeCount: number;
  messageCount: number;
  lcmCompactionCount: number;
  chunkCount: number;
  measuredTokenCount: number;
  retries: number;
  failures: number;
  arrivalsPerMinute: number;
  eventsPerMinute: number;
  memoryEventsPerMinute: number;
  memoryNodesPerMinute: number;
  messagesPerMinute: number;
  lcmCompactionsPerMinute: number;
  measuredTokensPerSecond: number;
  averageQueueWaitMs: number | null;
  averageExecutionMs: number | null;
  averageEndToEndMs: number | null;
}

export interface EmbeddingSemanticBacklog {
  pendingMemoryEvents: number;
  pendingMemoryNodes: number;
  pendingMessages: number;
  pendingEstimatedTokens: number;
  completedMeasuredTokens: number;
}

export interface EmbeddingTelemetryCumulative {
  queueName: EmbeddingTelemetryQueueName;
  sourceClass: EmbeddingTelemetrySourceClass;
  outcome: EmbeddingTelemetryOutcome;
  eventCount: number;
  chunkCount: number;
  measuredTokenCount: number;
  queueWaitMsTotal: number;
  queueWaitSampleCount: number;
  executionMsTotal: number;
  executionSampleCount: number;
  endToEndMsTotal: number;
  endToEndSampleCount: number;
}

export interface EmbeddingCapacityRepository {
  tryAcquireCalibrationLease(poolKey: string): Promise<{
    release(): Promise<void>;
  } | null>;
  getActiveProfile(
    profileKey: string
  ): Promise<EmbeddingCapacityProfileRecord | null>;
  getLatestUsableProfile(): Promise<EmbeddingCapacityProfileRecord | null>;
  listActiveUsableProfiles(input?: {
    modelKey?: string;
    embeddingDimensions?: number;
    capacityContractRevision?: string;
  }): Promise<EmbeddingCapacityProfileRecord[]>;
  replaceActiveProfile(
    input: EmbeddingCapacityProfileInput,
    invalidationReason: string
  ): Promise<EmbeddingCapacityProfileRecord>;
  invalidateProfilesExcept(
    poolKey: string,
    profileKey: string,
    reason: string
  ): Promise<number>;
  heartbeatProfile(profileKey: string): Promise<boolean>;
  recordTelemetry(input: EmbeddingTelemetryObservation): Promise<void>;
  getRollingTelemetry(): Promise<EmbeddingTelemetryWindow[]>;
  getCumulativeTelemetry(): Promise<EmbeddingTelemetryCumulative[]>;
  getSemanticBacklog(input: {
    model: string;
    dimensions: number;
    version: string;
  }): Promise<EmbeddingSemanticBacklog>;
}

type ProfileRow = {
  id: string;
  pool_key: string;
  profile_key: string;
  profile_version: string;
  capacity_contract_revision: string;
  state: EmbeddingCapacityProfileState;
  calibration_mode: EmbeddingCalibrationMode;
  model_key: string;
  model_artifact_hash: string;
  embedding_dimensions: number;
  tokenizer: string;
  input_transform: string;
  pooling: string;
  normalization: string;
  runtime_kind: string;
  runtime_version: string | null;
  backend_class: EmbeddingBackendClass;
  hardware_fingerprint: string;
  settings_fingerprint: string;
  runtime_settings: Record<string, string | number | boolean | null>;
  sample_measurements: EmbeddingCapacitySampleMeasurement[];
  tested_concurrency: number;
  sample_count: number;
  measured_token_count: string | number;
  duration_ms: string | number;
  measured_tokens_per_second: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  failure_code: string | null;
  calibrated_at: Date;
  invalidated_at: Date | null;
  invalidation_reason: string | null;
};

const mapProfile = (row: ProfileRow): EmbeddingCapacityProfileRecord => ({
  id: row.id,
  poolKey: row.pool_key,
  profileKey: row.profile_key,
  profileVersion: row.profile_version,
  capacityContractRevision: row.capacity_contract_revision,
  state: row.state,
  calibrationMode: row.calibration_mode,
  modelKey: row.model_key,
  modelArtifactHash: row.model_artifact_hash,
  embeddingDimensions: row.embedding_dimensions,
  tokenizer: row.tokenizer,
  inputTransform: row.input_transform,
  pooling: row.pooling,
  normalization: row.normalization,
  runtimeKind: row.runtime_kind,
  runtimeVersion: row.runtime_version,
  backendClass: row.backend_class,
  hardwareFingerprint: row.hardware_fingerprint,
  settingsFingerprint: row.settings_fingerprint,
  runtimeSettings: row.runtime_settings,
  sampleMeasurements: row.sample_measurements,
  testedConcurrency: row.tested_concurrency,
  sampleCount: row.sample_count,
  measuredTokenCount: Number(row.measured_token_count),
  durationMs: Number(row.duration_ms),
  measuredTokensPerSecond: row.measured_tokens_per_second,
  p50LatencyMs: row.p50_latency_ms,
  p95LatencyMs: row.p95_latency_ms,
  failureCode: row.failure_code,
  calibratedAt: row.calibrated_at.toISOString(),
  invalidatedAt: row.invalidated_at?.toISOString() ?? null,
  invalidationReason: row.invalidation_reason
});

const nonNegative = (value: number | undefined): number =>
  Number.isFinite(value) && value !== undefined && value >= 0
    ? Math.floor(value)
    : 0;

export const createEmbeddingCapacityRepository = (
  pool: pg.Pool
): EmbeddingCapacityRepository => ({
  async tryAcquireCalibrationLease(poolKey) {
    const client = await pool.connect();
    try {
      const result = await client.query<{ acquired: boolean }>(
        "select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired",
        [`embedding-capacity-calibration:${poolKey}`]
      );
      if (!result.rows[0]?.acquired) {
        client.release();
        return null;
      }
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          try {
            await client.query(
              "select pg_advisory_unlock(hashtextextended($1, 0))",
              [`embedding-capacity-calibration:${poolKey}`]
            );
          } finally {
            client.release();
          }
        }
      };
    } catch (error) {
      client.release(true);
      throw error;
    }
  },

  async getActiveProfile(profileKey) {
    const result = await pool.query<ProfileRow>(
      `select * from embedding_capacity_profiles
       where profile_key = $1 and invalidated_at is null
         and updated_at >= now() - make_interval(secs => $2)
       limit 1`,
      [profileKey, EMBEDDING_CAPACITY_PROFILE_STALE_AFTER_SECONDS]
    );
    return result.rows[0] ? mapProfile(result.rows[0]) : null;
  },

  async getLatestUsableProfile() {
    const result = await pool.query<ProfileRow>(
      `select * from embedding_capacity_profiles
       where state = 'usable' and invalidated_at is null
         and updated_at >= now() - make_interval(secs => $1)
       order by calibrated_at desc limit 1`,
      [EMBEDDING_CAPACITY_PROFILE_STALE_AFTER_SECONDS]
    );
    return result.rows[0] ? mapProfile(result.rows[0]) : null;
  },

  async listActiveUsableProfiles(input = {}) {
    const result = await pool.query<ProfileRow>(
      `select * from embedding_capacity_profiles
       where state = 'usable' and invalidated_at is null
         and updated_at >= now() - make_interval(secs => $4)
         and ($1::text is null or model_key = $1)
         and ($2::int is null or embedding_dimensions = $2)
         and ($3::text is null or capacity_contract_revision = $3)
       order by pool_key, calibrated_at desc`,
      [
        input.modelKey ?? null,
        input.embeddingDimensions ?? null,
        input.capacityContractRevision ?? null,
        EMBEDDING_CAPACITY_PROFILE_STALE_AFTER_SECONDS
      ]
    );
    return result.rows.map(mapProfile);
  },

  async replaceActiveProfile(input, invalidationReason) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`embedding-capacity-profile:${input.profileKey}`]
      );
      await client.query(
        `update embedding_capacity_profiles
         set invalidated_at = now(), invalidation_reason = $2, updated_at = now()
         where profile_key = $1 and invalidated_at is null`,
        [input.profileKey, invalidationReason]
      );
      const result = await client.query<ProfileRow>(
        `insert into embedding_capacity_profiles (
           pool_key, profile_key, profile_version, capacity_contract_revision,
           state, calibration_mode,
           model_key, model_artifact_hash, embedding_dimensions, tokenizer,
           input_transform, pooling, normalization, runtime_kind,
           runtime_version, backend_class, hardware_fingerprint,
           settings_fingerprint, runtime_settings, sample_measurements,
           tested_concurrency,
           sample_count, measured_token_count, duration_ms,
           measured_tokens_per_second, p50_latency_ms, p95_latency_ms,
           failure_code
         ) values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14, $15, $16, $17, $18, $19::jsonb, $20::jsonb, $21, $22, $23,
           $24, $25, $26, $27, $28
         ) returning *`,
        [
          input.poolKey,
          input.profileKey,
          input.profileVersion,
          input.capacityContractRevision,
          input.state,
          input.calibrationMode,
          input.modelKey,
          input.modelArtifactHash,
          input.embeddingDimensions,
          input.tokenizer,
          input.inputTransform,
          input.pooling,
          input.normalization,
          input.runtimeKind,
          input.runtimeVersion,
          input.backendClass,
          input.hardwareFingerprint,
          input.settingsFingerprint,
          JSON.stringify(input.runtimeSettings),
          JSON.stringify(input.sampleMeasurements),
          input.testedConcurrency,
          input.sampleCount,
          input.measuredTokenCount,
          input.durationMs,
          input.measuredTokensPerSecond,
          input.p50LatencyMs,
          input.p95LatencyMs,
          input.failureCode ?? null
        ]
      );
      await client.query("commit");
      return mapProfile(result.rows[0]!);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async invalidateProfilesExcept(poolKey, profileKey, reason) {
    const result = await pool.query(
      `update embedding_capacity_profiles
       set invalidated_at = now(), invalidation_reason = $3, updated_at = now()
       where pool_key = $1 and invalidated_at is null and profile_key <> $2`,
      [poolKey, profileKey, reason]
    );
    return result.rowCount ?? 0;
  },

  async heartbeatProfile(profileKey) {
    const result = await pool.query(
      `update embedding_capacity_profiles
          set updated_at = now()
        where profile_key = $1 and state = 'usable' and invalidated_at is null`,
      [profileKey]
    );
    return (result.rowCount ?? 0) > 0;
  },

  async recordTelemetry(input) {
    const observedAt = input.observedAt ?? new Date();
    const queueWaitMs = nonNegative(input.queueWaitMs);
    const executionMs = nonNegative(input.executionMs);
    const endToEndMs = nonNegative(input.endToEndMs);
    await pool.query(
      `insert into embedding_telemetry_minute_buckets (
         bucket_start, queue_name, source_class, outcome, event_count,
         chunk_count, measured_token_count, queue_wait_ms_total,
         queue_wait_sample_count, execution_ms_total, execution_sample_count,
         end_to_end_ms_total, end_to_end_sample_count
       ) values (
         date_trunc('minute', $1::timestamptz), $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13
       ) on conflict (bucket_start, queue_name, source_class, outcome)
       do update set
         event_count = embedding_telemetry_minute_buckets.event_count + excluded.event_count,
         chunk_count = embedding_telemetry_minute_buckets.chunk_count + excluded.chunk_count,
         measured_token_count = embedding_telemetry_minute_buckets.measured_token_count + excluded.measured_token_count,
         queue_wait_ms_total = embedding_telemetry_minute_buckets.queue_wait_ms_total + excluded.queue_wait_ms_total,
         queue_wait_sample_count = embedding_telemetry_minute_buckets.queue_wait_sample_count + excluded.queue_wait_sample_count,
         execution_ms_total = embedding_telemetry_minute_buckets.execution_ms_total + excluded.execution_ms_total,
         execution_sample_count = embedding_telemetry_minute_buckets.execution_sample_count + excluded.execution_sample_count,
         end_to_end_ms_total = embedding_telemetry_minute_buckets.end_to_end_ms_total + excluded.end_to_end_ms_total,
         end_to_end_sample_count = embedding_telemetry_minute_buckets.end_to_end_sample_count + excluded.end_to_end_sample_count,
         updated_at = now()`,
      [
        observedAt.toISOString(),
        input.queueName,
        input.sourceClass,
        input.outcome,
        nonNegative(input.eventCount),
        nonNegative(input.chunkCount),
        nonNegative(input.measuredTokenCount),
        queueWaitMs,
        input.queueWaitMs === undefined ? 0 : 1,
        executionMs,
        input.executionMs === undefined ? 0 : 1,
        endToEndMs,
        input.endToEndMs === undefined ? 0 : 1
      ]
    );
  },

  async getRollingTelemetry() {
    const result = await pool.query<{
      window_minutes: number;
      arrival_event_count: string;
      event_count: string;
      memory_event_count: string;
      memory_node_count: string;
      message_count: string;
      lcm_compaction_count: string;
      chunk_count: string;
      measured_token_count: string;
      retries: string;
      failures: string;
      queue_wait_ms_total: string;
      queue_wait_samples: string;
      execution_ms_total: string;
      execution_samples: string;
      end_to_end_ms_total: string;
      end_to_end_samples: string;
    }>(
      `with windows(window_minutes) as (values (1), (5), (15))
       select windows.window_minutes,
         (select count(*) from memory_events event
           where event.created_at >= date_trunc('minute', now()) - make_interval(mins => windows.window_minutes)
             and event.created_at < date_trunc('minute', now()))::text as arrival_event_count,
         coalesce(sum(bucket.event_count) filter (where bucket.outcome = 'completed' and bucket.source_class <> 'lcm_compaction'), 0)::text as event_count,
         coalesce(sum(bucket.event_count) filter (where bucket.outcome = 'completed' and bucket.source_class = 'memory_event'), 0)::text as memory_event_count,
         coalesce(sum(bucket.event_count) filter (where bucket.outcome = 'completed' and bucket.source_class = 'memory_node'), 0)::text as memory_node_count,
         coalesce(sum(bucket.event_count) filter (where bucket.outcome = 'completed' and bucket.source_class = 'message'), 0)::text as message_count,
         coalesce(sum(bucket.event_count) filter (where bucket.outcome = 'completed' and bucket.source_class = 'lcm_compaction'), 0)::text as lcm_compaction_count,
         coalesce(sum(bucket.chunk_count) filter (where bucket.outcome = 'completed' and bucket.source_class <> 'lcm_compaction'), 0)::text as chunk_count,
         coalesce(sum(bucket.measured_token_count) filter (where bucket.outcome = 'completed' and bucket.source_class <> 'lcm_compaction'), 0)::text as measured_token_count,
         coalesce(sum(bucket.event_count) filter (where bucket.outcome = 'retry'), 0)::text as retries,
         coalesce(sum(bucket.event_count) filter (where bucket.outcome = 'failed'), 0)::text as failures,
         coalesce(sum(bucket.queue_wait_ms_total), 0)::text as queue_wait_ms_total,
         coalesce(sum(bucket.queue_wait_sample_count), 0)::text as queue_wait_samples,
         coalesce(sum(bucket.execution_ms_total), 0)::text as execution_ms_total,
         coalesce(sum(bucket.execution_sample_count), 0)::text as execution_samples,
         coalesce(sum(bucket.end_to_end_ms_total), 0)::text as end_to_end_ms_total,
         coalesce(sum(bucket.end_to_end_sample_count), 0)::text as end_to_end_samples
       from windows
       left join embedding_telemetry_minute_buckets bucket
         on bucket.bucket_start >= date_trunc('minute', now()) - make_interval(mins => windows.window_minutes)
        and bucket.bucket_start < date_trunc('minute', now())
       group by windows.window_minutes order by windows.window_minutes`,
      []
    );
    return result.rows.map((row) => {
      const minutes = row.window_minutes as 1 | 5 | 15;
      const arrivalEventCount = Number(row.arrival_event_count);
      const eventCount = Number(row.event_count);
      const memoryEventCount = Number(row.memory_event_count);
      const memoryNodeCount = Number(row.memory_node_count);
      const messageCount = Number(row.message_count);
      const lcmCompactionCount = Number(row.lcm_compaction_count);
      const measuredTokenCount = Number(row.measured_token_count);
      const queueSamples = Number(row.queue_wait_samples);
      const executionSamples = Number(row.execution_samples);
      const endToEndSamples = Number(row.end_to_end_samples);
      return {
        windowMinutes: minutes,
        arrivalEventCount,
        eventCount,
        memoryEventCount,
        memoryNodeCount,
        messageCount,
        lcmCompactionCount,
        chunkCount: Number(row.chunk_count),
        measuredTokenCount,
        retries: Number(row.retries),
        failures: Number(row.failures),
        arrivalsPerMinute: arrivalEventCount / minutes,
        eventsPerMinute: eventCount / minutes,
        memoryEventsPerMinute: memoryEventCount / minutes,
        memoryNodesPerMinute: memoryNodeCount / minutes,
        messagesPerMinute: messageCount / minutes,
        lcmCompactionsPerMinute: lcmCompactionCount / minutes,
        measuredTokensPerSecond: measuredTokenCount / (minutes * 60),
        averageQueueWaitMs:
          queueSamples > 0
            ? Number(row.queue_wait_ms_total) / queueSamples
            : null,
        averageExecutionMs:
          executionSamples > 0
            ? Number(row.execution_ms_total) / executionSamples
            : null,
        averageEndToEndMs:
          endToEndSamples > 0
            ? Number(row.end_to_end_ms_total) / endToEndSamples
            : null
      };
    });
  },

  async getCumulativeTelemetry() {
    const result = await pool.query<{
      queue_name: EmbeddingTelemetryQueueName;
      source_class: EmbeddingTelemetrySourceClass;
      outcome: EmbeddingTelemetryOutcome;
      event_count: string;
      chunk_count: string;
      measured_token_count: string;
      queue_wait_ms_total: string;
      queue_wait_sample_count: string;
      execution_ms_total: string;
      execution_sample_count: string;
      end_to_end_ms_total: string;
      end_to_end_sample_count: string;
    }>(
      `with telemetry as (
       select queue_name, source_class, outcome,
         sum(event_count)::text as event_count,
         sum(chunk_count)::text as chunk_count,
         sum(measured_token_count)::text as measured_token_count,
         sum(queue_wait_ms_total)::text as queue_wait_ms_total,
         sum(queue_wait_sample_count)::text as queue_wait_sample_count,
         sum(execution_ms_total)::text as execution_ms_total,
         sum(execution_sample_count)::text as execution_sample_count,
         sum(end_to_end_ms_total)::text as end_to_end_ms_total,
         sum(end_to_end_sample_count)::text as end_to_end_sample_count
       from embedding_telemetry_minute_buckets
       group by queue_name, source_class, outcome
       union all
       select 'projection', 'memory_event', 'created', count(*)::text,
         '0', '0', '0', '0', '0', '0', '0', '0'
       from memory_events
      ) select * from telemetry order by queue_name, source_class, outcome`
    );
    return result.rows.map((row) => ({
      queueName: row.queue_name,
      sourceClass: row.source_class,
      outcome: row.outcome,
      eventCount: Number(row.event_count),
      chunkCount: Number(row.chunk_count),
      measuredTokenCount: Number(row.measured_token_count),
      queueWaitMsTotal: Number(row.queue_wait_ms_total),
      queueWaitSampleCount: Number(row.queue_wait_sample_count),
      executionMsTotal: Number(row.execution_ms_total),
      executionSampleCount: Number(row.execution_sample_count),
      endToEndMsTotal: Number(row.end_to_end_ms_total),
      endToEndSampleCount: Number(row.end_to_end_sample_count)
    }));
  },

  async getSemanticBacklog(input) {
    const result = await pool.query<{
      pending_memory_events: string;
      pending_memory_nodes: string;
      pending_messages: string;
      pending_estimated_tokens: string;
      completed_measured_tokens: string;
    }>(
      `with complete as (
         select memory_event_id, memory_node_id, message_id,
                sum(input_token_count)::bigint as measured_tokens
         from memory_embeddings
         where invalidated_at is null and personal_deleted_at is null
           and embedding_model = $1 and embedding_dimensions = $2
           and embedding_version = $3
         group by memory_event_id, memory_node_id, message_id, source_hash
         having count(*) = max(source_chunk_count)
           and count(distinct source_chunk_index) = max(source_chunk_count)
           and min(source_chunk_index) = 0
           and max(source_chunk_index) = max(source_chunk_count) - 1
       ), pending_events as (
         select event.id, greatest(coalesce(event.token_count, 0), 0)::bigint as tokens
         from memory_events event
         where event.invalidated_at is null and event.personal_deleted_at is null
           and event.include_in_embedding and pds_session_recall_ready(event.session_id)
           and not exists (select 1 from complete where memory_event_id = event.id)
       ), pending_nodes as (
         select node.id, greatest(coalesce(node.summary_token_estimate, node.source_token_estimate, 0), 0)::bigint as tokens
         from memory_nodes node
         where node.invalidated_at is null and node.personal_deleted_at is null
           and length(btrim(coalesce(node.summary_text, ''))) > 0
           and not exists (select 1 from complete where memory_node_id = node.id)
       )
       select
         (select count(*) from pending_events)::text as pending_memory_events,
         (select count(*) from pending_nodes)::text as pending_memory_nodes,
         0::text as pending_messages,
         ((select coalesce(sum(tokens), 0) from pending_events) +
          (select coalesce(sum(tokens), 0) from pending_nodes))::text as pending_estimated_tokens,
         coalesce((select sum(measured_tokens) from complete), 0)::text as completed_measured_tokens`,
      [input.model, input.dimensions, input.version]
    );
    const row = result.rows[0]!;
    return {
      pendingMemoryEvents: Number(row.pending_memory_events),
      pendingMemoryNodes: Number(row.pending_memory_nodes),
      pendingMessages: Number(row.pending_messages),
      pendingEstimatedTokens: Number(row.pending_estimated_tokens),
      completedMeasuredTokens: Number(row.completed_measured_tokens)
    };
  }
});
