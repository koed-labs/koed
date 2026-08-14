import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createDbPool,
  createEmbeddingCapacityRepository,
  runDbMigrations,
  type EmbeddingCapacityProfileInput
} from "../src/index.js";

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

const profile = (
  profileKey: string,
  calibrationMode: "quick" | "refined",
  poolKey = "test-pool"
): EmbeddingCapacityProfileInput => ({
  poolKey,
  profileKey,
  profileVersion: "koed-embedding-capacity-v1",
  capacityContractRevision: "embedding-capacity-v1",
  state: "usable",
  calibrationMode,
  modelKey: "qwen3-0.6b",
  modelArtifactHash: "a".repeat(64),
  embeddingDimensions: 1024,
  tokenizer: "qwen3",
  inputTransform: "query-document-v1",
  pooling: "last-token",
  normalization: "l2",
  runtimeKind: "llama-server",
  runtimeVersion: "test-runtime",
  backendClass: "cpu",
  hardwareFingerprint: "b".repeat(64),
  settingsFingerprint: "c".repeat(64),
  runtimeSettings: { threads: 4, parallel: 1 },
  sampleMeasurements: [
    { targetTokenClass: 512, measuredTokenCount: 500, durationMs: 100 },
    { targetTokenClass: 1024, measuredTokenCount: 1_000, durationMs: 200 },
    { targetTokenClass: 2048, measuredTokenCount: 2_000, durationMs: 400 },
    { targetTokenClass: 4096, measuredTokenCount: 4_000, durationMs: 800 }
  ],
  testedConcurrency: calibrationMode === "quick" ? 1 : 2,
  sampleCount: 4,
  measuredTokenCount: 7_500,
  durationMs: 1_500,
  measuredTokensPerSecond: 5_000,
  p50LatencyMs: 300,
  p95LatencyMs: 800
});

describeDb("embedding capacity repository", () => {
  beforeAll(async () => {
    const pool = createDbPool();
    try {
      await runDbMigrations(pool);
    } finally {
      await pool.end();
    }
  });

  it("replaces active profiles transactionally and retains bounded samples", async () => {
    const pool = createDbPool();
    const repository = createEmbeddingCapacityRepository(pool);
    const profileKey = Buffer.from(randomUUID()).toString("hex").slice(0, 64);
    try {
      const quick = await repository.replaceActiveProfile(
        profile(profileKey, "quick"),
        "quick_profile_replaced"
      );
      const refined = await repository.replaceActiveProfile(
        profile(profileKey, "refined"),
        "refined_profile_replaced"
      );

      expect(refined.id).not.toBe(quick.id);
      await expect(repository.getActiveProfile(profileKey)).resolves.toEqual(
        expect.objectContaining({
          id: refined.id,
          calibrationMode: "refined",
          sampleMeasurements: profile(profileKey, "refined").sampleMeasurements
        })
      );
      const rows = await pool.query<{
        invalidated_at: Date | null;
        invalidation_reason: string | null;
      }>(
        `select invalidated_at, invalidation_reason
           from embedding_capacity_profiles
          where profile_key = $1
          order by calibrated_at asc`,
        [profileKey]
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0]?.invalidated_at).toBeInstanceOf(Date);
      expect(rows.rows[0]?.invalidation_reason).toBe(
        "refined_profile_replaced"
      );
      expect(rows.rows[1]?.invalidated_at).toBeNull();
    } finally {
      await pool.query(
        "delete from embedding_capacity_profiles where profile_key = $1",
        [profileKey]
      );
      await pool.end();
    }
  });

  it("isolates profile invalidation and calibration leases by worker pool", async () => {
    const pool = createDbPool();
    const repository = createEmbeddingCapacityRepository(pool);
    const firstKey = Buffer.from(randomUUID()).toString("hex").slice(0, 64);
    const secondKey = Buffer.from(randomUUID()).toString("hex").slice(0, 64);
    try {
      await repository.replaceActiveProfile(
        profile(firstKey, "quick", "pool-a"),
        "initial"
      );
      await repository.replaceActiveProfile(
        profile(secondKey, "quick", "pool-b"),
        "initial"
      );
      await repository.invalidateProfilesExcept(
        "pool-a",
        "f".repeat(64),
        "identity_changed"
      );

      const active = await repository.listActiveUsableProfiles();
      expect(active).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ poolKey: "pool-b", profileKey: secondKey })
        ])
      );
      expect(active).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ poolKey: "pool-a", profileKey: firstKey })
        ])
      );

      const firstLease = await repository.tryAcquireCalibrationLease("pool-a");
      expect(firstLease).not.toBeNull();
      await expect(
        repository.tryAcquireCalibrationLease("pool-a")
      ).resolves.toBeNull();
      const otherPoolLease =
        await repository.tryAcquireCalibrationLease("pool-b");
      expect(otherPoolLease).not.toBeNull();
      await firstLease?.release();
      await otherPoolLease?.release();
    } finally {
      await pool.query(
        "delete from embedding_capacity_profiles where pool_key in ('pool-a','pool-b')"
      );
      await pool.end();
    }
  });

  it("aggregates durable telemetry windows and cumulative outcomes", async () => {
    const pool = createDbPool();
    const repository = createEmbeddingCapacityRepository(pool);
    await pool.query("delete from embedding_telemetry_minute_buckets");
    let eventId: string | null = null;
    let userId: string | null = null;
    try {
      const user = await pool.query<{ id: string }>(
        "insert into users (email) values ($1) returning id",
        [`capacity-${randomUUID()}@example.com`]
      );
      userId = user.rows[0]!.id;
      const event = await pool.query<{ id: string }>(
        `insert into memory_events (
           owner_user_id, visibility, event_type, capture_method, created_at
         ) values (
           $1, 'personal', 'captured', 'api', date_trunc('minute', now()) - interval '30 seconds'
         ) returning id`,
        [userId]
      );
      eventId = event.rows[0]!.id;
      const observedAt = new Date(Date.now() - 60_000);
      await repository.recordTelemetry({
        queueName: "memory-embed",
        sourceClass: "memory_event",
        outcome: "completed",
        eventCount: 1,
        chunkCount: 2,
        measuredTokenCount: 900,
        queueWaitMs: 20,
        executionMs: 80,
        endToEndMs: 100,
        observedAt
      });
      await repository.recordTelemetry({
        queueName: "lcm-compact",
        sourceClass: "lcm_compaction",
        outcome: "completed",
        eventCount: 1,
        executionMs: 10,
        observedAt
      });
      await repository.recordTelemetry({
        queueName: "memory-embed",
        sourceClass: "memory_event",
        outcome: "completed",
        eventCount: 1,
        chunkCount: 1,
        measuredTokenCount: 300,
        queueWaitMs: 30,
        executionMs: 70,
        endToEndMs: 100,
        observedAt
      });
      await repository.recordTelemetry({
        queueName: "memory-embed",
        sourceClass: "memory_event",
        outcome: "retry",
        eventCount: 1,
        observedAt
      });

      const cumulative = await repository.getCumulativeTelemetry();
      expect(cumulative).toContainEqual({
        queueName: "memory-embed",
        sourceClass: "memory_event",
        outcome: "completed",
        eventCount: 2,
        chunkCount: 3,
        measuredTokenCount: 1_200,
        queueWaitMsTotal: 50,
        queueWaitSampleCount: 2,
        executionMsTotal: 150,
        executionSampleCount: 2,
        endToEndMsTotal: 200,
        endToEndSampleCount: 2
      });
      expect(cumulative).toContainEqual(
        expect.objectContaining({ outcome: "retry", eventCount: 1 })
      );
      const rolling = await repository.getRollingTelemetry();
      expect(rolling.map((window) => window.windowMinutes)).toEqual([1, 5, 15]);
      expect(rolling[0]).toMatchObject({
        eventCount: 2,
        memoryEventCount: 2,
        memoryNodeCount: 0,
        messageCount: 0,
        lcmCompactionCount: 1,
        chunkCount: 3,
        measuredTokenCount: 1_200,
        retries: 1,
        failures: 0,
        eventsPerMinute: 2,
        memoryEventsPerMinute: 2,
        lcmCompactionsPerMinute: 1
      });
      expect(rolling[0]!.arrivalEventCount).toBeGreaterThanOrEqual(1);
      expect(rolling[0]!.arrivalsPerMinute).toBe(rolling[0]!.arrivalEventCount);
    } finally {
      if (eventId)
        await pool.query("delete from memory_events where id = $1", [eventId]);
      if (userId) await pool.query("delete from users where id = $1", [userId]);
      await pool.query("delete from embedding_telemetry_minute_buckets");
      await pool.end();
    }
  });

  it("does not add telemetry contention to Memory Event insertion", async () => {
    const pool = createDbPool();
    try {
      const trigger = await pool.query<{ enabled: string }>(
        `select tgenabled as enabled
           from pg_trigger
          where tgname = 'memory_events_projection_telemetry_trigger'
            and not tgisinternal`
      );
      expect(trigger.rows).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it("expires usable capacity when its worker pool stops heartbeating", async () => {
    const pool = createDbPool();
    const repository = createEmbeddingCapacityRepository(pool);
    const profileKey = createHash("sha256").update(randomUUID()).digest("hex");
    try {
      await repository.replaceActiveProfile(
        profile(profileKey, "quick", "retired-pool"),
        "initial"
      );
      await pool.query(
        `update embedding_capacity_profiles
            set updated_at = now() - interval '10 minutes'
          where profile_key = $1 and invalidated_at is null`,
        [profileKey]
      );

      await expect(repository.getActiveProfile(profileKey)).resolves.toBeNull();
      await expect(repository.listActiveUsableProfiles()).resolves.not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ profileKey, poolKey: "retired-pool" })
        ])
      );
      await expect(repository.heartbeatProfile(profileKey)).resolves.toBe(true);
      await expect(repository.getActiveProfile(profileKey)).resolves.toEqual(
        expect.objectContaining({ profileKey, poolKey: "retired-pool" })
      );
    } finally {
      await pool.query(
        "delete from embedding_capacity_profiles where profile_key = $1",
        [profileKey]
      );
      await pool.end();
    }
  });
});
