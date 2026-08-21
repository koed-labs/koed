import { describe, expect, it } from "vitest";
import { DeterministicPrivacyRuntime } from "./runtime.js";
import {
  PrivacyProviderSwitchError,
  PrivacyRuntimeManager,
  type LoadablePrivacyRuntime
} from "./runtime-manager.js";
import type { PrivacyRuntimeProvider } from "./provider.js";

class FakeRuntime implements LoadablePrivacyRuntime {
  readonly modelId = "openai/privacy-filter";
  readonly modelRevision = "pinned";
  readonly classifierHash = "a".repeat(64);
  private loaded = false;
  disposed = false;
  unloadCount = 0;
  releaseHold?: () => void;
  releaseUnload?: () => void;

  constructor(
    readonly provider: PrivacyRuntimeProvider,
    private readonly options: {
      failLoad?: boolean;
      parityMismatch?: boolean;
      calibrationDelayMs?: number;
      holdText?: string;
      failText?: string;
      holdUnload?: boolean;
    } = {}
  ) {}

  async load(): Promise<void> {
    if (this.options.failLoad) throw new Error("synthetic load failure");
    this.loaded = true;
  }

  isReady(): boolean {
    return this.loaded && !this.disposed;
  }

  async classify(text: string) {
    if (!this.isReady()) await this.load();
    if (text === this.options.failText) {
      throw new Error("synthetic provider inference failure");
    }
    if (text === this.options.holdText) {
      await new Promise<void>((resolve) => {
        this.releaseHold = resolve;
      });
    }
    if (text.startsWith("Synthetic project discussion")) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.options.calibrationDelayMs ?? 0)
      );
    }
    const deterministic = new DeterministicPrivacyRuntime();
    if (this.options.parityMismatch && text.length > 0) {
      deterministic.setDetections(text, [
        { label: "private_person", start: 0, end: 1 }
      ]);
    }
    return deterministic.classify(text);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.loaded = false;
  }

  async unload(): Promise<void> {
    this.unloadCount += 1;
    if (this.options.holdUnload) {
      await new Promise<void>((resolve) => {
        this.releaseUnload = resolve;
      });
    }
    this.loaded = false;
  }
}

const normalCuda = async () => ({
  provider: "cuda" as const,
  observedAt: "2026-08-13T00:00:00.000Z",
  capacityAvailable: true,
  totalMemoryMiB: 16384,
  usedMemoryMiB: 1024,
  freeMemoryMiB: 15360,
  utilizationPercent: 5,
  pressure: "normal" as const,
  contentionLikely: false
});

describe("Privacy Filter runtime manager", () => {
  it("starts on CPU without treating platform candidates as verified", async () => {
    const manager = await PrivacyRuntimeManager.create({
      preference: "cpu",
      candidateProviders: ["cuda", "cpu"],
      factory: (provider) => new FakeRuntime(provider),
      observeCuda: normalCuda
    });
    expect(manager.status()).toMatchObject({
      component: "privacy_filter",
      requestedProvider: "cpu",
      activeProvider: "cpu",
      candidateProviders: ["cuda", "cpu"],
      verifiedProviders: ["cpu"],
      switchState: "ready"
    });
    await manager.dispose();
  });

  it("activates a verified explicit CUDA provider", async () => {
    const manager = await PrivacyRuntimeManager.create({
      preference: "cpu",
      candidateProviders: ["cuda", "cpu"],
      factory: (provider) => new FakeRuntime(provider),
      observeCuda: normalCuda
    });
    const status = await manager.switchProvider("cuda");
    expect(status.activeProvider).toBe("cuda");
    expect(status.verifiedProviders).toEqual(
      expect.arrayContaining(["cpu", "cuda"])
    );
    expect(status.calibrations.map((entry) => entry.provider)).toEqual(
      expect.arrayContaining(["cpu", "cuda"])
    );
    await manager.dispose();
  });

  it("unloads an idle accelerator and reloads it on the next request", async () => {
    let scheduled: (() => void) | undefined;
    let cuda!: FakeRuntime;
    const manager = await PrivacyRuntimeManager.create({
      preference: "cuda",
      candidateProviders: ["cuda", "cpu"],
      factory: (provider) => {
        const runtime = new FakeRuntime(provider);
        if (provider === "cuda") cuda = runtime;
        return runtime;
      },
      observeCuda: normalCuda,
      acceleratorIdleUnloadSeconds: 300,
      setTimeout: ((callback: () => void) => {
        scheduled = callback;
        return { unref: () => undefined };
      }) as unknown as typeof globalThis.setTimeout,
      clearTimeout: (() => undefined) as typeof globalThis.clearTimeout
    });

    expect(manager.status()).toMatchObject({
      activeProvider: "cuda",
      acceleratorIdleUnloadSeconds: 300,
      acceleratorResident: true
    });
    scheduled?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(cuda.unloadCount).toBe(1);
    expect(manager.isReady()).toBe(true);
    expect(manager.status().acceleratorResident).toBe(false);

    await manager.classify("wake");
    expect(manager.status().acceleratorResident).toBe(true);
    await manager.dispose();
  });

  it("keeps an accelerator resident when idle unloading is disabled", async () => {
    let scheduled = false;
    const manager = await PrivacyRuntimeManager.create({
      preference: "cuda",
      candidateProviders: ["cuda", "cpu"],
      factory: (provider) => new FakeRuntime(provider),
      observeCuda: normalCuda,
      acceleratorIdleUnloadSeconds: 0,
      setTimeout: (() => {
        scheduled = true;
        return { unref: () => undefined };
      }) as unknown as typeof globalThis.setTimeout
    });
    expect(scheduled).toBe(false);
    expect(manager.status()).toMatchObject({
      acceleratorIdleUnloadSeconds: 0,
      acceleratorResident: true
    });
    await manager.dispose();
  });

  it("serializes a request that arrives while idle unloading is in progress", async () => {
    let scheduled: (() => void) | undefined;
    let cuda!: FakeRuntime;
    const manager = await PrivacyRuntimeManager.create({
      preference: "cuda",
      candidateProviders: ["cuda", "cpu"],
      factory: (provider) => {
        const runtime = new FakeRuntime(provider, {
          holdUnload: provider === "cuda"
        });
        if (provider === "cuda") cuda = runtime;
        return runtime;
      },
      observeCuda: normalCuda,
      acceleratorIdleUnloadSeconds: 300,
      setTimeout: ((callback: () => void) => {
        scheduled = callback;
        return { unref: () => undefined };
      }) as unknown as typeof globalThis.setTimeout,
      clearTimeout: (() => undefined) as typeof globalThis.clearTimeout
    });

    scheduled?.();
    await new Promise((resolve) => setImmediate(resolve));
    let completed = false;
    const classification = manager
      .classify("arrived during unload")
      .then(() => {
        completed = true;
      });
    await new Promise((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    cuda.releaseUnload?.();
    await classification;
    expect(completed).toBe(true);
    expect(manager.status().acceleratorResident).toBe(true);
    await manager.dispose();
  });

  it("keeps CPU when auto observes contention", async () => {
    let cudaCreated = false;
    const manager = await PrivacyRuntimeManager.create({
      preference: "auto",
      candidateProviders: ["cuda", "cpu"],
      factory: (provider) => {
        if (provider === "cuda") cudaCreated = true;
        return new FakeRuntime(provider);
      },
      observeCuda: async () => ({
        ...(await normalCuda()),
        utilizationPercent: 95,
        pressure: "elevated",
        contentionLikely: true
      })
    });
    expect(cudaCreated).toBe(false);
    expect(manager.status()).toMatchObject({
      activeProvider: "cpu",
      fallbackReason: "accelerator_pressure"
    });
    await manager.dispose();
  });

  it("keeps the active provider after load or parity failure", async () => {
    const runtimes: FakeRuntime[] = [];
    let failLoad = true;
    let mismatch = false;
    const manager = await PrivacyRuntimeManager.create({
      preference: "cpu",
      candidateProviders: ["cuda", "cpu"],
      factory: (provider) => {
        const runtime = new FakeRuntime(provider, {
          failLoad: provider === "cuda" && failLoad,
          parityMismatch: provider === "cuda" && mismatch
        });
        runtimes.push(runtime);
        return runtime;
      },
      observeCuda: normalCuda
    });
    await expect(manager.switchProvider("cuda")).rejects.toMatchObject({
      code: "provider_initialization_failed"
    } satisfies Partial<PrivacyProviderSwitchError>);
    expect(manager.provider).toBe("cpu");

    failLoad = false;
    mismatch = true;
    await expect(manager.switchProvider("cuda")).rejects.toMatchObject({
      code: "provider_parity_failed"
    } satisfies Partial<PrivacyProviderSwitchError>);
    expect(manager.provider).toBe("cpu");
    expect(runtimes.at(-1)?.disposed).toBe(true);
    await manager.dispose();
  });

  it("auto selects CPU when measured accelerator benefit is insufficient", async () => {
    const manager = await PrivacyRuntimeManager.create({
      preference: "auto",
      candidateProviders: ["cuda", "cpu"],
      factory: (provider) =>
        new FakeRuntime(provider, {
          calibrationDelayMs: provider === "cuda" ? 8 : 0
        }),
      observeCuda: normalCuda,
      minimumAutoSpeedupRatio: 1.15
    });
    expect(manager.status()).toMatchObject({
      activeProvider: "cpu",
      fallbackReason: "insufficient_measured_benefit"
    });
    await manager.dispose();
  });

  it("auto switches an explicitly active accelerator back to CPU when it is slower", async () => {
    const manager = await PrivacyRuntimeManager.create({
      preference: "cpu",
      candidateProviders: ["cuda", "cpu"],
      factory: (provider) =>
        new FakeRuntime(provider, {
          calibrationDelayMs: provider === "cuda" ? 8 : 0
        }),
      observeCuda: normalCuda,
      minimumAutoSpeedupRatio: 1.15
    });
    expect((await manager.switchProvider("cuda")).activeProvider).toBe("cuda");
    expect(await manager.switchProvider("auto")).toMatchObject({
      requestedProvider: "auto",
      activeProvider: "cpu",
      fallbackReason: "insufficient_measured_benefit"
    });
    await manager.dispose();
  });

  it("atomically switches new work and drains an in-flight provider", async () => {
    let cpu!: FakeRuntime;
    let cuda!: FakeRuntime;
    const manager = await PrivacyRuntimeManager.create({
      preference: "cpu",
      candidateProviders: ["cuda", "cpu"],
      factory: (provider) => {
        const runtime = new FakeRuntime(provider, {
          holdText: provider === "cpu" ? "hold" : undefined
        });
        if (provider === "cpu") cpu = runtime;
        else cuda = runtime;
        return runtime;
      },
      observeCuda: normalCuda
    });
    const held = manager.classify("hold");
    await Promise.resolve();
    const switched = await manager.switchProvider("cuda");
    expect(switched.activeProvider).toBe("cuda");
    expect(switched.drainingProviders).toContain("cpu");
    expect(cpu.disposed).toBe(false);
    await manager.classify("new work");
    expect(cuda.isReady()).toBe(true);

    cpu.releaseHold?.();
    await held;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cpu.disposed).toBe(true);
    expect(manager.status().drainingProviders).toEqual([]);
    await manager.dispose();
  });

  it("falls back to CPU and retries after an active accelerator inference failure", async () => {
    const manager = await PrivacyRuntimeManager.create({
      preference: "cpu",
      candidateProviders: ["cuda", "cpu"],
      factory: (provider) =>
        new FakeRuntime(provider, {
          failText: provider === "cuda" ? "runtime failure" : undefined
        }),
      observeCuda: normalCuda
    });
    await manager.switchProvider("cuda");

    const result = await manager.classify("runtime failure");
    expect(result.decodedText).toBe("runtime failure");
    expect(manager.status()).toMatchObject({
      requestedProvider: "cuda",
      activeProvider: "cpu",
      fallbackReason: "provider_runtime_failed",
      lastFailure: {
        provider: "cuda",
        code: "provider_runtime_failed"
      }
    });
    await manager.dispose();
  });
});
