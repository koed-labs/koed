import { randomUUID } from "node:crypto";
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
  processingEpoch: "embedding-capacity-v1",
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
    try {
      await repository.recordTelemetry({
        queueName: "projection",
        sourceClass: "memory_event",
        outcome: "created",
        eventCount: 2
      });
      await repository.recordTelemetry({
        queueName: "memory-embed",
        sourceClass: "memory_event",
        outcome: "completed",
        eventCount: 1,
        chunkCount: 2,
        measuredTokenCount: 900,
        queueWaitMs: 20,
        executionMs: 80,
        endToEndMs: 100
      });
      await repository.recordTelemetry({
        queueName: "lcm-compact",
        sourceClass: "lcm_compaction",
        outcome: "completed",
        eventCount: 1,
        executionMs: 10
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
        endToEndMs: 100
      });
      await repository.recordTelemetry({
        queueName: "memory-embed",
        sourceClass: "memory_event",
        outcome: "retry",
        eventCount: 1
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
        arrivalEventCount: 2,
        eventCount: 2,
        memoryEventCount: 2,
        memoryNodeCount: 0,
        messageCount: 0,
        lcmCompactionCount: 1,
        chunkCount: 3,
        measuredTokenCount: 1_200,
        retries: 1,
        failures: 0,
        arrivalsPerMinute: 2,
        eventsPerMinute: 2,
        memoryEventsPerMinute: 2,
        lcmCompactionsPerMinute: 1
      });
    } finally {
      await pool.query("delete from embedding_telemetry_minute_buckets");
      await pool.end();
    }
  });

  it("installs projection telemetry as a database-side invariant", async () => {
    const pool = createDbPool();
    try {
      const trigger = await pool.query<{ enabled: string }>(
        `select tgenabled as enabled
           from pg_trigger
          where tgname = 'memory_events_projection_telemetry_trigger'
            and not tgisinternal`
      );
      expect(trigger.rows).toEqual([{ enabled: "O" }]);
    } finally {
      await pool.end();
    }
  });
});
