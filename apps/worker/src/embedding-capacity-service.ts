import { createHash } from "node:crypto";
import type {
  EmbeddingCalibrationMode,
  EmbeddingCapacityProfileInput,
  EmbeddingCapacityRepository
} from "@koed/db";
import { EMBEDDING_CAPACITY_PROCESSING_EPOCH } from "@koed/db";
import { fetchBoundedJsonObject } from "@koed/shared";
import { Agent } from "undici";
import { embedTexts } from "./embedding-workflow.js";
import type { WorkerEnvConfig } from "./env-config.js";

const PROFILE_VERSION = "koed-embedding-capacity-v1";
const IDENTITY_MAX_BYTES = 64 * 1024;
const QUICK_TOKEN_CLASSES = [512, 1024, 2048, 4096] as const;

type CapacityIdentity = {
  schemaVersion: 1;
  modelKey: string;
  dimensions: number;
  runtimeKind: string;
  runtimeVersion: string;
  backendClass: "cpu" | "metal" | "cuda" | "unknown";
  hardwareFingerprint: string;
  settingsFingerprint: string;
  runtimeSettings: Record<string, string | number | boolean | null>;
};

interface CapacityLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface EmbeddingCapacityService {
  profileKey(): Promise<string>;
  hasUsableProfile(): Promise<boolean>;
  calibrate(
    mode: EmbeddingCalibrationMode
  ): Promise<EmbeddingCapacityProfileInput>;
  start(): void;
  stop(): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const sha256 = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const safeIdentity = (payload: unknown): CapacityIdentity => {
  if (!isRecord(payload) || !isRecord(payload.runtimeSettings)) {
    throw new Error("Embedding capacity identity is invalid");
  }
  const backendClass = payload.backendClass;
  if (
    payload.schemaVersion !== 1 ||
    typeof payload.modelKey !== "string" ||
    !Number.isSafeInteger(payload.dimensions) ||
    typeof payload.runtimeKind !== "string" ||
    typeof payload.runtimeVersion !== "string" ||
    !["cpu", "metal", "cuda", "unknown"].includes(String(backendClass)) ||
    typeof payload.hardwareFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(payload.hardwareFingerprint) ||
    typeof payload.settingsFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(payload.settingsFingerprint)
  ) {
    throw new Error("Embedding capacity identity is invalid");
  }
  return payload as unknown as CapacityIdentity;
};

const syntheticText = (targetClass: number, variant: number): string => {
  const vocabulary = [
    "system",
    "memory",
    "project",
    "decision",
    "context",
    "result",
    "workflow",
    "evidence",
    "timeline",
    "implementation",
    "review",
    "constraint"
  ];
  return Array.from(
    { length: Math.max(32, Math.floor(targetClass * 0.72)) },
    (_, index) => vocabulary[(index + variant) % vocabulary.length]
  ).join(" ");
};

const percentile = (values: number[], quantile: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)
  ]!;
};

export const createEmbeddingCapacityService = (config: {
  env: WorkerEnvConfig;
  repository: EmbeddingCapacityRepository;
  logger: CapacityLogger;
  fetchFn?: typeof fetch;
  refinedDelayMs?: number;
}): EmbeddingCapacityService => {
  const fetchFn = config.fetchFn ?? fetch;
  const dispatcher = new Agent({
    connectTimeout: 10_000,
    headersTimeout: config.env.embeddingRequestTimeoutMs,
    bodyTimeout: config.env.embeddingRequestTimeoutMs
  });
  let stopped = false;
  let refinedTimer: ReturnType<typeof setTimeout> | null = null;
  let identityPromise: Promise<CapacityIdentity> | null = null;

  const identity = (): Promise<CapacityIdentity> => {
    identityPromise ??= (async () => {
      const { response, payload } = await fetchBoundedJsonObject(
        fetchFn,
        `${config.env.embeddingServiceUrl.replace(/\/+$/, "")}/capacity/identity`,
        {
          headers: config.env.embeddingServiceToken
            ? { "x-koed-embedding-token": config.env.embeddingServiceToken }
            : {},
          dispatcher
        } as RequestInit & { dispatcher: Agent },
        {
          timeoutMs: Math.min(config.env.embeddingRequestTimeoutMs, 30_000),
          maxBytes: IDENTITY_MAX_BYTES
        }
      );
      if (!response.ok) {
        throw new Error(
          `Embedding capacity identity failed with ${response.status}`
        );
      }
      return safeIdentity(payload);
    })();
    return identityPromise;
  };

  const profileKey = async (): Promise<string> => {
    const current = await identity();
    return sha256({
      profileVersion: PROFILE_VERSION,
      processingEpoch: EMBEDDING_CAPACITY_PROCESSING_EPOCH,
      poolKey: config.env.embeddingPoolKey,
      modelKey: config.env.embeddingVersion,
      modelArtifactHash: config.env.embeddingModelArtifactHash,
      dimensions: config.env.embeddingDimensions,
      tokenizer: config.env.embeddingTokenizer,
      inputTransform: config.env.embeddingInputTransform,
      pooling: config.env.embeddingPooling,
      normalization: config.env.embeddingNormalization,
      runtimeKind: current.runtimeKind,
      runtimeVersion: current.runtimeVersion,
      backendClass: current.backendClass,
      hardwareFingerprint: current.hardwareFingerprint,
      settingsFingerprint: current.settingsFingerprint
    });
  };

  const calibrate = async (
    mode: EmbeddingCalibrationMode
  ): Promise<EmbeddingCapacityProfileInput> => {
    const current = await identity();
    const key = await profileKey();
    await config.repository.invalidateProfilesExcept(
      config.env.embeddingPoolKey,
      key,
      "capacity_identity_changed"
    );
    const repetitions = mode === "quick" ? 1 : 3;
    const testedConcurrency = mode === "quick" ? 1 : 2;
    const samples = QUICK_TOKEN_CLASSES.flatMap((tokenClass) =>
      Array.from({ length: repetitions }, (_, variant) => ({
        tokenClass,
        variant,
        text: syntheticText(tokenClass, variant)
      }))
    );
    const latencies: number[] = [];
    const sampleMeasurements: EmbeddingCapacityProfileInput["sampleMeasurements"] =
      [];
    let measuredTokenCount = 0;
    const startedAt = performance.now();
    for (let offset = 0; offset < samples.length; offset += testedConcurrency) {
      const batch = samples.slice(offset, offset + testedConcurrency);
      await Promise.all(
        batch.map(async (sample) => {
          const sampleStartedAt = performance.now();
          const response = await embedTexts([sample.text], {
            env: config.env,
            fetchFn,
            dispatcher
          });
          const durationMs = performance.now() - sampleStartedAt;
          latencies.push(durationMs);
          measuredTokenCount += response.measuredTokens;
          sampleMeasurements.push({
            targetTokenClass: sample.tokenClass,
            measuredTokenCount: response.measuredTokens,
            durationMs
          });
        })
      );
    }
    const durationMs = Math.max(1, Math.round(performance.now() - startedAt));
    const profile: EmbeddingCapacityProfileInput = {
      poolKey: config.env.embeddingPoolKey,
      profileKey: key,
      profileVersion: PROFILE_VERSION,
      processingEpoch: EMBEDDING_CAPACITY_PROCESSING_EPOCH,
      state: "usable",
      calibrationMode: mode,
      modelKey: config.env.embeddingVersion,
      modelArtifactHash: config.env.embeddingModelArtifactHash,
      embeddingDimensions: config.env.embeddingDimensions,
      tokenizer: config.env.embeddingTokenizer,
      inputTransform: config.env.embeddingInputTransform,
      pooling: config.env.embeddingPooling,
      normalization: config.env.embeddingNormalization,
      runtimeKind: current.runtimeKind,
      runtimeVersion: current.runtimeVersion,
      backendClass: current.backendClass,
      hardwareFingerprint: current.hardwareFingerprint,
      settingsFingerprint: current.settingsFingerprint,
      runtimeSettings: current.runtimeSettings,
      sampleMeasurements: sampleMeasurements.sort(
        (left, right) => left.targetTokenClass - right.targetTokenClass
      ),
      testedConcurrency,
      sampleCount: samples.length,
      measuredTokenCount,
      durationMs,
      measuredTokensPerSecond: measuredTokenCount / (durationMs / 1000),
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95)
    };
    await config.repository.replaceActiveProfile(
      profile,
      mode === "quick" ? "quick_profile_replaced" : "refined_profile_replaced"
    );
    return profile;
  };

  const runCalibration = async (mode: EmbeddingCalibrationMode) => {
    const lease = await config.repository
      .tryAcquireCalibrationLease(config.env.embeddingPoolKey)
      .catch(() => null);
    if (!lease) {
      config.logger.info(
        {
          event: { name: "embedding.capacity.calibration_skipped" },
          mode,
          reason: "pool_calibration_in_progress"
        },
        "embedding capacity calibration already runs for this pool"
      );
      return;
    }
    try {
      const profile = await calibrate(mode);
      config.logger.info(
        {
          event: { name: "embedding.capacity.calibrated" },
          mode,
          backendClass: profile.backendClass,
          measuredTokensPerSecond: profile.measuredTokensPerSecond
        },
        "embedding capacity profile calibrated"
      );
    } catch (error) {
      try {
        const current = await identity();
        const key = await profileKey();
        const existing = await config.repository.getActiveProfile(key);
        if (existing?.state !== "usable") {
          await config.repository.replaceActiveProfile(
            {
              poolKey: config.env.embeddingPoolKey,
              profileKey: key,
              profileVersion: PROFILE_VERSION,
              processingEpoch: EMBEDDING_CAPACITY_PROCESSING_EPOCH,
              state: "failed",
              calibrationMode: mode,
              modelKey: config.env.embeddingVersion,
              modelArtifactHash: config.env.embeddingModelArtifactHash,
              embeddingDimensions: config.env.embeddingDimensions,
              tokenizer: config.env.embeddingTokenizer,
              inputTransform: config.env.embeddingInputTransform,
              pooling: config.env.embeddingPooling,
              normalization: config.env.embeddingNormalization,
              runtimeKind: current.runtimeKind,
              runtimeVersion: current.runtimeVersion,
              backendClass: current.backendClass,
              hardwareFingerprint: current.hardwareFingerprint,
              settingsFingerprint: current.settingsFingerprint,
              runtimeSettings: current.runtimeSettings,
              sampleMeasurements: [],
              testedConcurrency: mode === "quick" ? 1 : 2,
              sampleCount: 1,
              measuredTokenCount: 0,
              durationMs: 0,
              measuredTokensPerSecond: 0,
              p50LatencyMs: 0,
              p95LatencyMs: 0,
              failureCode: "calibration_failed"
            },
            "failed_profile_replaced"
          );
        }
      } catch {
        // Identity failures cannot be associated with a safe profile key.
      }
      config.logger.warn(
        {
          event: { name: "embedding.capacity.calibration_failed" },
          mode,
          error: error instanceof Error ? error.message : String(error)
        },
        "embedding capacity calibration failed"
      );
    } finally {
      await lease.release();
    }
  };

  return {
    profileKey,
    async hasUsableProfile() {
      try {
        const profile = await config.repository.getActiveProfile(
          await profileKey()
        );
        return profile?.state === "usable";
      } catch {
        return false;
      }
    },
    calibrate,
    start() {
      void (async () => {
        const existing = await config.repository
          .getActiveProfile(await profileKey())
          .catch(() => null);
        if (existing?.state !== "usable") await runCalibration("quick");
      })().then(() => {
        if (stopped) return;
        refinedTimer = setTimeout(
          () => void runCalibration("refined"),
          config.refinedDelayMs ?? 30 * 60_000
        );
        refinedTimer.unref?.();
      });
    },
    stop() {
      stopped = true;
      if (refinedTimer) clearTimeout(refinedTimer);
      void dispatcher.close();
    }
  };
};
