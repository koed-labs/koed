import { performance } from "node:perf_hooks";
import { ClassificationError } from "./errors.js";
import { maskClassification } from "./masking.js";
import {
  observeCudaAccelerator,
  platformPrivacyProviderCandidates,
  type PrivacyRuntimePreference,
  type PrivacyRuntimeProvider,
  type SharedAcceleratorObservation
} from "./provider.js";
import type {
  PrivacyRuntimeAdapter,
  RawPrivacyClassification
} from "./runtime.js";

export type LoadablePrivacyRuntime = PrivacyRuntimeAdapter & {
  load(): Promise<void>;
};

export type PrivacyRuntimeFactory = (
  provider: PrivacyRuntimeProvider
) => LoadablePrivacyRuntime;

export interface PrivacyProviderCalibration {
  provider: PrivacyRuntimeProvider;
  measuredAt: string;
  sampleTokens: number;
  durationMs: number;
  sampleCount: number;
  warmTokensPerSecond: number;
}

export interface PrivacyRuntimeStatus {
  component: "privacy_filter";
  requestedProvider: PrivacyRuntimePreference;
  activeProvider: PrivacyRuntimeProvider;
  candidateProviders: PrivacyRuntimeProvider[];
  verifiedProviders: PrivacyRuntimeProvider[];
  switchState: "ready" | "switching";
  drainingProviders: PrivacyRuntimeProvider[];
  acceleratorIdleUnloadSeconds: number;
  acceleratorResident: boolean;
  fallbackReason?:
    | "accelerator_pressure"
    | "provider_initialization_failed"
    | "provider_parity_failed"
    | "insufficient_measured_benefit"
    | "provider_runtime_failed";
  lastFailure?: {
    provider: PrivacyRuntimeProvider;
    code:
      | "provider_initialization_failed"
      | "provider_parity_failed"
      | "provider_unavailable"
      | "provider_runtime_failed";
    observedAt: string;
  };
  calibrations: PrivacyProviderCalibration[];
  sharedAccelerator?: SharedAcceleratorObservation;
}

export class PrivacyProviderSwitchError extends Error {
  constructor(
    readonly code:
      | "provider_initialization_failed"
      | "provider_parity_failed"
      | "provider_unavailable",
    readonly provider: PrivacyRuntimeProvider
  ) {
    super(`Privacy runtime provider ${provider} could not be activated`);
    this.name = "PrivacyProviderSwitchError";
  }
}

interface RuntimeSlot {
  runtime: LoadablePrivacyRuntime;
  inFlight: number;
  retired: boolean;
  disposed: boolean;
}

const PARITY_CORPUS = [
  "Ada Example can be reached at ada@example.test or +1 202-555-0147.",
  "The meeting is in Example City on 12 March 2026 from host 10.20.30.40.",
  "api_key=synthetic_value_1234567890"
] as const;

const CALIBRATION_TEXT =
  "Synthetic project discussion covered implementation details, testing results, and next actions. ".repeat(
    40
  );

export type ParityBaseline = Array<{ maskedText: string; spans: string }>;

const parityOutput = async (
  runtime: PrivacyRuntimeAdapter,
  corpus: readonly string[] = PARITY_CORPUS
): Promise<ParityBaseline> => {
  const output: ParityBaseline = [];
  for (const text of corpus) {
    const masked = maskClassification(text, await runtime.classify(text));
    output.push({
      maskedText: masked.maskedText,
      spans: JSON.stringify(masked.spans)
    });
  }
  return output;
};

const equivalentMasking = async (
  baseline: ParityBaseline,
  runtime: PrivacyRuntimeAdapter
): Promise<boolean> =>
  JSON.stringify(await parityOutput(runtime)) === JSON.stringify(baseline);

const calibrate = async (
  runtime: PrivacyRuntimeAdapter,
  now: () => Date
): Promise<PrivacyProviderCalibration> => {
  await runtime.classify(CALIBRATION_TEXT);
  const samples: Array<{ durationMs: number; tokens: number }> = [];
  for (let index = 0; index < 2; index += 1) {
    const startedAt = performance.now();
    const result = await runtime.classify(CALIBRATION_TEXT);
    samples.push({
      durationMs: Math.max(1, performance.now() - startedAt),
      tokens: result.tokenOffsets.length
    });
  }
  const durations = samples
    .map((sample) => sample.durationMs)
    .sort((left, right) => left - right);
  const durationMs =
    durations.reduce((total, duration) => total + duration, 0) /
    durations.length;
  const sampleTokens = samples[0]?.tokens ?? 0;
  return {
    provider: runtime.provider,
    measuredAt: now().toISOString(),
    sampleTokens,
    durationMs: Math.round(durationMs),
    sampleCount: samples.length,
    warmTokensPerSecond: Number(
      (sampleTokens / (durationMs / 1_000)).toFixed(1)
    )
  };
};

const loadCandidate = async (
  factory: PrivacyRuntimeFactory,
  provider: PrivacyRuntimeProvider
): Promise<LoadablePrivacyRuntime> => {
  const runtime = factory(provider);
  try {
    await runtime.load();
    return runtime;
  } catch {
    await runtime.dispose?.().catch(() => undefined);
    throw new PrivacyProviderSwitchError(
      "provider_initialization_failed",
      provider
    );
  }
};

export interface PrivacyValidationCache {
  read(runtime: PrivacyRuntimeAdapter): Promise<
    | {
        baseline: ParityBaseline;
        providers: PrivacyRuntimeProvider[];
        calibrations: PrivacyProviderCalibration[];
      }
    | undefined
  >;
  write(
    runtime: PrivacyRuntimeAdapter,
    value: {
      baseline: ParityBaseline;
      providers: PrivacyRuntimeProvider[];
      calibrations: PrivacyProviderCalibration[];
    }
  ): Promise<void>;
}

export interface PrivacyRuntimeManagerOptions {
  validationCache?: PrivacyValidationCache;
  preference: PrivacyRuntimePreference;
  factory: PrivacyRuntimeFactory;
  candidateProviders?: PrivacyRuntimeProvider[];
  observeCuda?: () => Promise<SharedAcceleratorObservation>;
  now?: () => Date;
  minimumAutoSpeedupRatio?: number;
  acceleratorIdleUnloadSeconds?: number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

export class PrivacyRuntimeManager implements PrivacyRuntimeAdapter {
  readonly modelId: string;
  readonly modelRevision: string;
  readonly classifierHash: string;
  private active: RuntimeSlot;
  private requestedProvider: PrivacyRuntimePreference;
  private switchState: "ready" | "switching" = "ready";
  private switchTail: Promise<PrivacyRuntimeStatus>;
  private readonly verified = new Set<PrivacyRuntimeProvider>();
  private readonly calibrations = new Map<
    PrivacyRuntimeProvider,
    PrivacyProviderCalibration
  >();
  private readonly retired = new Set<RuntimeSlot>();
  private fallbackReason: PrivacyRuntimeStatus["fallbackReason"];
  private sharedAccelerator?: SharedAcceleratorObservation;
  private lastFailure?: PrivacyRuntimeStatus["lastFailure"];
  private idleTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private idleUnloadPromise: Promise<void> | undefined;
  private acceleratorIdleUnloaded = false;
  private autoCalibrationTimer:
    | ReturnType<typeof globalThis.setTimeout>
    | undefined;

  private constructor(
    runtime: LoadablePrivacyRuntime,
    private readonly parityBaseline: ParityBaseline,
    private readonly options: Required<
      Pick<
        PrivacyRuntimeManagerOptions,
        | "factory"
        | "candidateProviders"
        | "observeCuda"
        | "now"
        | "minimumAutoSpeedupRatio"
        | "acceleratorIdleUnloadSeconds"
        | "setTimeout"
        | "clearTimeout"
      >
    > & {
      preference: PrivacyRuntimePreference;
      validationCache?: PrivacyValidationCache;
    }
  ) {
    this.active = {
      runtime,
      inFlight: 0,
      retired: false,
      disposed: false
    };
    this.requestedProvider = options.preference;
    this.switchTail = Promise.resolve(this.status());
    this.modelId = runtime.modelId;
    this.modelRevision = runtime.modelRevision;
    this.classifierHash = runtime.classifierHash;
    this.verified.add(runtime.provider);
  }

  static async create(
    options: PrivacyRuntimeManagerOptions
  ): Promise<PrivacyRuntimeManager> {
    const resolved = {
      ...options,
      candidateProviders:
        options.candidateProviders ?? platformPrivacyProviderCandidates(),
      observeCuda: options.observeCuda ?? observeCudaAccelerator,
      now: options.now ?? (() => new Date()),
      minimumAutoSpeedupRatio: options.minimumAutoSpeedupRatio ?? 1.15,
      acceleratorIdleUnloadSeconds: options.acceleratorIdleUnloadSeconds ?? 300,
      setTimeout: options.setTimeout ?? globalThis.setTimeout,
      clearTimeout: options.clearTimeout ?? globalThis.clearTimeout
    };
    const cpu = await loadCandidate(resolved.factory, "cpu");
    const cached = await options.validationCache
      ?.read(cpu)
      .catch(() => undefined);
    let parityBaseline: ParityBaseline;
    let cacheMatches = false;
    try {
      if (cached) {
        const smoke = await parityOutput(cpu, PARITY_CORPUS.slice(0, 1));
        cacheMatches =
          JSON.stringify(smoke[0]) === JSON.stringify(cached.baseline[0]);
      }
      parityBaseline =
        cacheMatches && cached ? cached.baseline : await parityOutput(cpu);
    } catch (error) {
      await cpu.dispose?.();
      throw error;
    }
    const manager = new PrivacyRuntimeManager(cpu, parityBaseline, resolved);
    if (cacheMatches && cached) {
      for (const provider of cached.providers) manager.verified.add(provider);
      for (const calibration of cached.calibrations)
        manager.calibrations.set(calibration.provider, calibration);
    }
    await manager.saveValidation();
    if (resolved.candidateProviders.includes("cuda")) {
      manager.sharedAccelerator = await resolved.observeCuda();
    }
    if (options.preference !== "cpu") {
      try {
        await manager.switchProvider(options.preference, true);
      } catch (error) {
        await manager.dispose();
        throw error;
      }
    }
    manager.scheduleIdleUnload();
    manager.scheduleAutoCalibration();
    return manager;
  }

  get provider(): PrivacyRuntimeProvider {
    return this.active.runtime.provider;
  }

  isReady(): boolean {
    return this.active.runtime.isReady() || this.acceleratorIdleUnloaded;
  }

  async classify(text: string): Promise<RawPrivacyClassification> {
    this.cancelIdleUnload();
    await this.idleUnloadPromise;
    const slot = this.active;
    slot.inFlight += 1;
    try {
      try {
        return await slot.runtime.classify(text);
      } catch (error) {
        if (
          slot !== this.active ||
          slot.runtime.provider === "cpu" ||
          error instanceof ClassificationError
        ) {
          throw error;
        }
        const requestedProvider = this.requestedProvider;
        this.recordFailure(slot.runtime.provider, "provider_runtime_failed");
        try {
          await this.switchProvider("cpu");
          this.requestedProvider = requestedProvider;
          this.fallbackReason = "provider_runtime_failed";
          this.recordFailure(slot.runtime.provider, "provider_runtime_failed");
          return await this.classify(text);
        } catch {
          this.requestedProvider = requestedProvider;
          this.fallbackReason = "provider_runtime_failed";
          throw error;
        }
      }
    } finally {
      slot.inFlight -= 1;
      if (slot.retired && slot.inFlight === 0) {
        void this.disposeSlot(slot);
      }
      if (slot === this.active && slot.runtime.isReady()) {
        this.acceleratorIdleUnloaded = false;
      }
      if (slot === this.active) this.scheduleIdleUnload();
    }
  }

  status(): PrivacyRuntimeStatus {
    return {
      component: "privacy_filter",
      requestedProvider: this.requestedProvider,
      activeProvider: this.provider,
      candidateProviders: [...this.options.candidateProviders],
      verifiedProviders: [...this.verified],
      switchState: this.switchState,
      drainingProviders: [...this.retired]
        .filter((slot) => !slot.disposed)
        .map((slot) => slot.runtime.provider),
      acceleratorIdleUnloadSeconds: this.options.acceleratorIdleUnloadSeconds,
      acceleratorResident:
        this.provider !== "cpu" && this.active.runtime.isReady(),
      ...(this.fallbackReason ? { fallbackReason: this.fallbackReason } : {}),
      ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
      calibrations: [...this.calibrations.values()],
      ...(this.sharedAccelerator
        ? { sharedAccelerator: this.sharedAccelerator }
        : {})
    };
  }

  switchProvider(
    preference: PrivacyRuntimePreference,
    initial = false
  ): Promise<PrivacyRuntimeStatus> {
    this.cancelAutoCalibration();
    const run = async (): Promise<PrivacyRuntimeStatus> => {
      this.cancelIdleUnload();
      await this.idleUnloadPromise;
      this.switchState = "switching";
      this.requestedProvider = preference;
      try {
        await this.performSwitch(preference, initial);
      } finally {
        this.switchState = "ready";
      }
      this.scheduleIdleUnload();
      return this.status();
    };
    const previous = this.switchTail.catch(() => this.status());
    const next = previous.then(run);
    this.switchTail = next;
    return next;
  }

  async refreshAcceleratorObservation(): Promise<PrivacyRuntimeStatus> {
    if (this.options.candidateProviders.includes("cuda")) {
      this.sharedAccelerator = await this.options.observeCuda();
    }
    return this.status();
  }

  private async performSwitch(
    preference: PrivacyRuntimePreference,
    initial: boolean
  ): Promise<PrivacyRuntimeStatus> {
    this.fallbackReason = undefined;
    let target: PrivacyRuntimeProvider =
      preference === "auto" ? "cpu" : preference;
    if (preference === "auto") {
      const accelerator = this.options.candidateProviders.find(
        (provider) => provider !== "cpu"
      );
      if (accelerator === "cuda") {
        this.sharedAccelerator = await this.options.observeCuda();
        if (
          !this.sharedAccelerator.capacityAvailable ||
          this.sharedAccelerator.contentionLikely
        ) {
          this.fallbackReason = "accelerator_pressure";
        } else {
          target = accelerator;
        }
      } else if (accelerator) {
        target = accelerator;
      }
      const targetCalibration = this.calibrations.get(target);
      const cpuCalibration = this.calibrations.get("cpu");
      if (
        initial &&
        target !== "cpu" &&
        (!targetCalibration || !cpuCalibration)
      ) {
        target = "cpu";
      }
      if (
        target !== "cpu" &&
        targetCalibration &&
        cpuCalibration &&
        targetCalibration.warmTokensPerSecond <
          cpuCalibration.warmTokensPerSecond *
            this.options.minimumAutoSpeedupRatio
      ) {
        target = "cpu";
        this.fallbackReason = "insufficient_measured_benefit";
      }
    }
    if (!initial && preference === "auto" && !this.calibrations.has("cpu")) {
      const cpu =
        this.provider === "cpu"
          ? this.active.runtime
          : await loadCandidate(this.options.factory, "cpu");
      try {
        this.calibrations.set("cpu", await calibrate(cpu, this.options.now));
        await this.saveValidation();
      } finally {
        if (cpu !== this.active.runtime) await cpu.dispose?.();
      }
    }
    // Deferred auto calibration and explicit controls can measure providers.
    // Initial readiness never waits for a benchmark.
    if (
      !initial &&
      preference === "auto" &&
      target === this.provider &&
      target !== "cpu" &&
      !this.calibrations.has(target)
    ) {
      this.calibrations.set(
        target,
        await calibrate(this.active.runtime, this.options.now)
      );
      await this.saveValidation();
      return this.performSwitch(preference, false);
    }
    if (target === this.provider) return this.status();
    if (!this.options.candidateProviders.includes(target)) {
      if (preference === "auto") return this.status();
      this.recordFailure(target, "provider_unavailable");
      throw new PrivacyProviderSwitchError("provider_unavailable", target);
    }
    if (target === "cuda") {
      this.sharedAccelerator = await this.options.observeCuda();
    }

    let candidate: LoadablePrivacyRuntime;
    try {
      candidate = await loadCandidate(this.options.factory, target);
    } catch (error) {
      this.recordFailure(target, "provider_initialization_failed");
      if (preference === "auto" && initial) {
        this.fallbackReason = "provider_initialization_failed";
        return this.status();
      }
      throw error;
    }
    if (
      candidate.modelId !== this.modelId ||
      candidate.modelRevision !== this.modelRevision ||
      candidate.classifierHash !== this.classifierHash
    ) {
      await candidate.dispose?.();
      this.verified.delete(target);
      this.calibrations.delete(target);
      await this.saveValidation();
      this.recordFailure(target, "provider_parity_failed");
      throw new PrivacyProviderSwitchError("provider_parity_failed", target);
    }
    const parityMatches = await (
      this.verified.has(target)
        ? parityOutput(candidate, PARITY_CORPUS.slice(0, 1)).then(
            (output) =>
              JSON.stringify(output[0]) ===
              JSON.stringify(this.parityBaseline[0])
          )
        : equivalentMasking(this.parityBaseline, candidate)
    ).catch(() => false);
    if (!parityMatches) {
      await candidate.dispose?.();
      this.verified.delete(target);
      this.calibrations.delete(target);
      await this.saveValidation();
      this.recordFailure(target, "provider_parity_failed");
      if (preference === "auto" && initial) {
        this.fallbackReason = "provider_parity_failed";
        return this.status();
      }
      throw new PrivacyProviderSwitchError("provider_parity_failed", target);
    }

    const calibration =
      initial || preference !== "auto"
        ? this.calibrations.get(target)
        : await calibrate(candidate, this.options.now);
    if (calibration) this.calibrations.set(target, calibration);
    this.verified.add(target);
    await this.saveValidation();
    if (preference === "auto") {
      const cpuCalibration = this.calibrations.get("cpu");
      if (
        target !== "cpu" &&
        cpuCalibration &&
        calibration &&
        calibration.warmTokensPerSecond <
          cpuCalibration.warmTokensPerSecond *
            this.options.minimumAutoSpeedupRatio
      ) {
        await candidate.dispose?.();
        this.fallbackReason = "insufficient_measured_benefit";
        return this.status();
      }
    }

    const previous = this.active;
    this.active = {
      runtime: candidate,
      inFlight: 0,
      retired: false,
      disposed: false
    };
    this.acceleratorIdleUnloaded = false;
    previous.retired = true;
    this.lastFailure = undefined;
    this.retired.add(previous);
    if (previous.inFlight === 0) await this.disposeSlot(previous);
    return this.status();
  }

  private async saveValidation(): Promise<void> {
    await this.options.validationCache
      ?.write(this, {
        baseline: this.parityBaseline,
        providers: [...this.verified],
        calibrations: [...this.calibrations.values()]
      })
      .catch(() => undefined);
  }

  private async disposeSlot(slot: RuntimeSlot): Promise<void> {
    if (slot.disposed || slot.inFlight > 0) return;
    slot.disposed = true;
    this.retired.delete(slot);
    await slot.runtime.dispose?.();
  }

  private scheduleAutoCalibration(): void {
    const accelerator = this.options.candidateProviders.find(
      (provider) => provider !== "cpu"
    );
    if (
      this.requestedProvider !== "auto" ||
      !accelerator ||
      (this.calibrations.has("cpu") && this.calibrations.has(accelerator))
    )
      return;
    // Release CPU readiness before optional accelerator work. This uses the
    // same switch queue as provider controls, so a later explicit choice wins.
    this.autoCalibrationTimer = this.options.setTimeout(() => {
      this.autoCalibrationTimer = undefined;
      if (this.requestedProvider !== "auto") return;
      void this.switchProvider("auto").catch(() => {
        this.fallbackReason =
          this.lastFailure?.code === "provider_parity_failed"
            ? "provider_parity_failed"
            : "provider_initialization_failed";
      });
    }, 0);
    this.autoCalibrationTimer.unref?.();
  }

  private cancelAutoCalibration(): void {
    if (this.autoCalibrationTimer === undefined) return;
    this.options.clearTimeout(this.autoCalibrationTimer);
    this.autoCalibrationTimer = undefined;
  }

  private cancelIdleUnload(): void {
    if (this.idleTimer === undefined) return;
    this.options.clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdleUnload(): void {
    this.cancelIdleUnload();
    if (
      this.provider === "cpu" ||
      this.options.acceleratorIdleUnloadSeconds === 0 ||
      !this.active.runtime.isReady()
    ) {
      return;
    }
    this.idleTimer = this.options.setTimeout(() => {
      this.idleTimer = undefined;
      const slot = this.active;
      if (slot.runtime.provider === "cpu" || slot.retired) return;
      if (slot.inFlight > 0) {
        this.scheduleIdleUnload();
        return;
      }
      const unloading = slot.runtime.unload?.();
      if (!unloading) return;
      this.idleUnloadPromise = unloading;
      void unloading
        .then(() => {
          if (slot === this.active && !slot.runtime.isReady()) {
            this.acceleratorIdleUnloaded = true;
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (this.idleUnloadPromise === unloading) {
            this.idleUnloadPromise = undefined;
          }
        });
    }, this.options.acceleratorIdleUnloadSeconds * 1_000);
    this.idleTimer.unref?.();
  }

  private recordFailure(
    provider: PrivacyRuntimeProvider,
    code: NonNullable<PrivacyRuntimeStatus["lastFailure"]>["code"]
  ): void {
    this.lastFailure = {
      provider,
      code,
      observedAt: this.options.now().toISOString()
    };
  }

  async dispose(): Promise<void> {
    this.cancelAutoCalibration();
    this.cancelIdleUnload();
    await this.idleUnloadPromise;
    await this.switchTail.catch(() => undefined);
    this.cancelIdleUnload();
    const slots = [this.active, ...this.retired];
    await Promise.all(
      slots.map(async (slot) => {
        while (slot.inFlight > 0) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await this.disposeSlot(slot);
      })
    );
  }
}
