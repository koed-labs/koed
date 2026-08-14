import { describe, expect, it, vi } from "vitest";
import type { EmbeddingCapacityRepository } from "@koed/db";
import { createEmbeddingCapacityService } from "./embedding-capacity-service.js";
import { resolveWorkerEnv } from "./env-config.js";

const env = resolveWorkerEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test",
  EMBEDDING_MODEL: "qwen3-0.6b",
  EMBEDDING_SERVICE_URL: "http://embedding.test",
  EMBEDDING_SERVICE_TOKEN: "internal-secret"
});

const logger = {
  info: vi.fn(),
  warn: vi.fn()
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

const identity = {
  schemaVersion: 1,
  modelKey: "qwen3-0.6b",
  dimensions: 1024,
  runtimeKind: "llama-server",
  runtimeVersion: "test-runtime",
  backendClass: "cpu",
  hardwareFingerprint: "b".repeat(64),
  acceleratorFingerprint: null,
  settingsFingerprint: "c".repeat(64),
  runtimeSettings: { llamaNThreads: 4, llamaParallel: 1 }
};

const createRepository = () =>
  ({
    tryAcquireCalibrationLease: vi.fn().mockResolvedValue({
      release: vi.fn().mockResolvedValue(undefined)
    }),
    getActiveProfile: vi.fn().mockResolvedValue(null),
    getLatestUsableProfile: vi.fn().mockResolvedValue(null),
    listActiveUsableProfiles: vi.fn().mockResolvedValue([]),
    replaceActiveProfile: vi.fn().mockImplementation(async (profile) => ({
      id: "profile-1",
      ...profile,
      failureCode: profile.failureCode ?? null,
      calibratedAt: new Date().toISOString(),
      invalidatedAt: null,
      invalidationReason: null
    })),
    invalidateProfilesExcept: vi.fn().mockResolvedValue(0),
    heartbeatProfile: vi.fn().mockResolvedValue(true),
    recordTelemetry: vi.fn(),
    getRollingTelemetry: vi.fn(),
    getCumulativeTelemetry: vi.fn(),
    getSemanticBacklog: vi.fn()
  }) as unknown as EmbeddingCapacityRepository;

const successfulFetch = vi
  .fn()
  .mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/capacity/identity")) return jsonResponse(identity);
    if (url.endsWith("/embed")) {
      return jsonResponse({
        model: "qwen3-0.6b",
        dimensions: 1024,
        measuredTokens: 100,
        vectors: [Array(1024).fill(0.01)],
        chunks: [
          {
            inputIndex: 0,
            chunkIndex: 0,
            chunkCount: 1,
            tokenCount: 100,
            text: "synthetic fixture",
            vector: Array(1024).fill(0.01)
          }
        ]
      });
    }
    return jsonResponse({}, 404);
  });

describe("embedding capacity service", () => {
  it("creates a quick profile through the production adapter contract", async () => {
    const repository = createRepository();
    const service = createEmbeddingCapacityService({
      env,
      repository,
      logger,
      fetchFn: successfulFetch
    });

    const profile = await service.calibrate("quick");

    expect(profile).toMatchObject({
      poolKey: "default",
      capacityContractRevision: "embedding-capacity-v1",
      state: "usable",
      calibrationMode: "quick",
      backendClass: "cpu",
      sampleCount: 4,
      testedConcurrency: 1,
      measuredTokenCount: 400
    });
    expect(profile.sampleMeasurements).toHaveLength(4);
    expect(
      profile.sampleMeasurements.map((sample) => sample.targetTokenClass)
    ).toEqual([512, 1024, 2048, 4096]);
    expect(profile.profileKey).toMatch(/^[0-9a-f]{64}$/);
    expect(repository.invalidateProfilesExcept).toHaveBeenCalledWith(
      "default",
      profile.profileKey,
      "capacity_identity_changed"
    );
    expect(repository.replaceActiveProfile).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(
        vi
          .mocked(repository.replaceActiveProfile)
          .mock.calls.map(([input]) => input)
      )
    ).not.toContain("synthetic fixture");
    service.stop();
  });

  it("calibrates from chunk token counts when usage metadata is absent", async () => {
    const repository = createRepository();
    const fetchFn = vi
      .fn()
      .mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/capacity/identity")) {
          return jsonResponse(identity);
        }
        return jsonResponse({
          model: "qwen3-0.6b",
          dimensions: 1024,
          measuredTokens: null,
          vectors: [Array(1024).fill(0.01)],
          chunks: [
            {
              inputIndex: 0,
              chunkIndex: 0,
              chunkCount: 1,
              tokenCount: 100,
              text: "synthetic fixture",
              vector: Array(1024).fill(0.01)
            }
          ]
        });
      });
    const service = createEmbeddingCapacityService({
      env,
      repository,
      logger,
      fetchFn
    });

    await expect(service.calibrate("quick")).resolves.toMatchObject({
      measuredTokenCount: 400,
      sampleCount: 4,
      state: "usable"
    });
    service.stop();
  });

  it("uses the refined profile mode without changing profile identity", async () => {
    const repository = createRepository();
    const service = createEmbeddingCapacityService({
      env,
      repository,
      logger,
      fetchFn: successfulFetch
    });

    const quick = await service.calibrate("quick");
    const refined = await service.calibrate("refined");

    expect(refined.profileKey).toBe(quick.profileKey);
    expect(refined).toMatchObject({
      calibrationMode: "refined",
      sampleCount: 12,
      testedConcurrency: 2,
      measuredTokenCount: 1200
    });
    service.stop();
  });

  it.each([
    ["hardware", { hardwareFingerprint: "d".repeat(64) }],
    ["runtime settings", { settingsFingerprint: "e".repeat(64) }],
    ["runtime version", { runtimeVersion: "changed-runtime" }]
  ])("changes profile identity when %s changes", async (_label, change) => {
    const firstRepository = createRepository();
    const secondRepository = createRepository();
    const first = createEmbeddingCapacityService({
      env,
      repository: firstRepository,
      logger,
      fetchFn: successfulFetch
    });
    const changedFetch = vi
      .fn()
      .mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/capacity/identity")) {
          return jsonResponse({ ...identity, ...change });
        }
        return successfulFetch(input);
      });
    const second = createEmbeddingCapacityService({
      env,
      repository: secondRepository,
      logger,
      fetchFn: changedFetch
    });

    const [firstProfile, secondProfile] = await Promise.all([
      first.calibrate("quick"),
      second.calibrate("quick")
    ]);

    expect(secondProfile.profileKey).not.toBe(firstProfile.profileKey);
    expect(secondRepository.invalidateProfilesExcept).toHaveBeenCalledWith(
      "default",
      secondProfile.profileKey,
      "capacity_identity_changed"
    );
    first.stop();
    second.stop();
  });

  it("does not duplicate automatic calibration within one worker pool", async () => {
    const repository = createRepository();
    vi.mocked(repository.tryAcquireCalibrationLease).mockResolvedValue(null);
    const fetchFn = vi
      .fn()
      .mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/capacity/identity")) {
          return jsonResponse(identity);
        }
        throw new Error("automatic calibration must not reach the adapter");
      });
    const service = createEmbeddingCapacityService({
      env,
      repository,
      logger,
      fetchFn,
      refinedDelayMs: 60_000
    });

    service.start();
    await vi.waitFor(() =>
      expect(repository.tryAcquireCalibrationLease).toHaveBeenCalledWith(
        "default"
      )
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(repository.replaceActiveProfile).not.toHaveBeenCalled();
    service.stop();
  });

  it("rejects a non-CPU identity without an accelerator fingerprint", async () => {
    const service = createEmbeddingCapacityService({
      env,
      repository: createRepository(),
      logger,
      fetchFn: vi.fn().mockResolvedValue(
        jsonResponse({
          ...identity,
          backendClass: "cuda",
          acceleratorFingerprint: null
        })
      )
    });

    await expect(service.profileKey()).rejects.toThrow(
      "Embedding capacity identity is invalid"
    );
    service.stop();
  });

  it("fails historical readiness closed when no usable profile exists", async () => {
    const repository = createRepository();
    const service = createEmbeddingCapacityService({
      env,
      repository,
      logger,
      fetchFn: vi.fn().mockResolvedValue(jsonResponse({}, 503))
    });

    await expect(service.hasUsableProfile()).resolves.toBe(false);
    service.stop();
  });

  it.each([
    ["model", { modelKey: "different-model" }],
    ["dimensions", { dimensions: 384 }]
  ])(
    "rejects a service identity with mismatched %s",
    async (_label, change) => {
      const repository = createRepository();
      const service = createEmbeddingCapacityService({
        env,
        repository,
        logger,
        fetchFn: vi.fn().mockResolvedValue(
          jsonResponse({
            ...identity,
            ...change
          })
        )
      });

      await expect(service.profileKey()).rejects.toThrow(
        "does not match the configured embedding contract"
      );
      await expect(service.hasUsableProfile()).resolves.toBe(false);
      expect(repository.heartbeatProfile).not.toHaveBeenCalled();
      service.stop();
    }
  );

  it("recovers when the embedding identity is unavailable during startup", async () => {
    const repository = createRepository();
    let identityAttempts = 0;
    const fetchFn = vi
      .fn()
      .mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/capacity/identity")) {
          identityAttempts += 1;
          return identityAttempts === 1
            ? jsonResponse({}, 503)
            : jsonResponse(identity);
        }
        return successfulFetch(input);
      });
    const service = createEmbeddingCapacityService({
      env,
      repository,
      logger,
      fetchFn,
      startupRetryMs: 1,
      refinedDelayMs: 60_000
    });

    service.start();

    await vi.waitFor(() =>
      expect(repository.replaceActiveProfile).toHaveBeenCalled()
    );
    expect(identityAttempts).toBeGreaterThanOrEqual(2);
    expect(repository.heartbeatProfile).toHaveBeenCalled();
    service.stop();
  });
});
