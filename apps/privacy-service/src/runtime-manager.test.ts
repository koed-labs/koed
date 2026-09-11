import { describe, expect, it, vi } from "vitest";
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
      parityMismatchText?: string;
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
    if (
      (this.options.parityMismatch && text.length > 0) ||
      text === this.options.parityMismatchText
    ) {
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
    expect(status.calibrations).toEqual([]);
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
    await manager.switchProvider("auto");
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

describe("Privacy Filter startup validation cache", () => {
  it("never benchmarks startup and checks the full corpus on cached boots", async () => {
    let saved: Awaited<
      ReturnType<import("./runtime-manager.js").PrivacyValidationCache["read"]>
    >;
    const cache: import("./runtime-manager.js").PrivacyValidationCache = {
      read: async () => saved,
      write: async (_runtime, value) => {
        saved = value;
      }
    };
    const texts: string[] = [];
    const factory = (provider: PrivacyRuntimeProvider) => {
      const runtime = new FakeRuntime(provider);
      const classify = runtime.classify.bind(runtime);
      runtime.classify = async (text) => {
        texts.push(text);
        return classify(text);
      };
      return runtime;
    };
    const options = {
      preference: "auto" as const,
      candidateProviders: ["cpu", "coreml"] as PrivacyRuntimeProvider[],
      factory,
      validationCache: cache
    };
    const cold = await PrivacyRuntimeManager.create(options);
    expect(texts).toHaveLength(3);
    expect(cold.status().calibrations).toEqual([]);
    expect(cold.provider).toBe("cpu");
    await cold.dispose();
    texts.length = 0;
    const warm = await PrivacyRuntimeManager.create(options);
    expect(texts).toHaveLength(3);
    expect(warm.status().calibrations).toEqual([]);
    await warm.dispose();
  });

  it.each(["coreml", "cuda", "dml"] as const)(
    "calibrates fresh auto %s after readiness and reuses its measurements on restart",
    async (accelerator) => {
      let saved: Awaited<
        ReturnType<
          import("./runtime-manager.js").PrivacyValidationCache["read"]
        >
      >;
      let calibrationStarted = false;
      let releaseCalibration!: () => void;
      const calibrationGate = new Promise<void>((resolve) => {
        releaseCalibration = resolve;
      });
      const texts: string[] = [];
      const options = {
        preference: "auto" as const,
        candidateProviders: ["cpu", accelerator] as PrivacyRuntimeProvider[],
        observeCuda: normalCuda,
        minimumAutoSpeedupRatio: 0,
        acceleratorIdleUnloadSeconds: 0,
        validationCache: {
          read: async () => saved,
          write: async (
            _runtime: unknown,
            value: NonNullable<typeof saved>
          ) => {
            saved = value;
          }
        },
        factory: (provider: PrivacyRuntimeProvider) => {
          const runtime = new FakeRuntime(provider);
          const classify = runtime.classify.bind(runtime);
          runtime.classify = async (text) => {
            texts.push(text);
            if (
              text.startsWith("Synthetic project discussion") &&
              !calibrationStarted
            ) {
              calibrationStarted = true;
              await calibrationGate;
            }
            return classify(text);
          };
          return runtime;
        }
      };
      const manager = await PrivacyRuntimeManager.create(options);
      expect(manager.provider).toBe("cpu");
      expect(manager.isReady()).toBe(true);
      expect(calibrationStarted).toBe(false);
      await vi.waitFor(() => expect(calibrationStarted).toBe(true));
      try {
        expect(manager.isReady()).toBe(true);
        expect((await manager.classify("foreground request")).decodedText).toBe(
          "foreground request"
        );
      } finally {
        releaseCalibration();
      }
      await vi.waitFor(() => expect(manager.provider).toBe(accelerator));
      expect(saved?.calibrations.map((item) => item.provider)).toEqual([
        "cpu",
        accelerator
      ]);
      await manager.dispose();
      texts.length = 0;
      const warm = await PrivacyRuntimeManager.create(options);
      expect(warm.provider).toBe(accelerator);
      expect(
        texts.some((text) => text.startsWith("Synthetic project discussion"))
      ).toBe(false);
      await warm.dispose();
    }
  );

  it("keeps CPU ready when deferred auto validation rejects an accelerator", async () => {
    const manager = await PrivacyRuntimeManager.create({
      preference: "auto",
      candidateProviders: ["cpu", "coreml"],
      factory: (provider) =>
        new FakeRuntime(provider, { parityMismatch: provider === "coreml" })
    });
    await vi.waitFor(() =>
      expect(manager.status().lastFailure?.code).toBe("provider_parity_failed")
    );
    expect(manager.provider).toBe("cpu");
    expect(manager.isReady()).toBe(true);
    await manager.dispose();
  });

  it("cancels deferred calibration when the Operator selects CPU or shuts down", async () => {
    for (const action of ["cpu", "dispose"] as const) {
      const factory = vi.fn(
        (provider: PrivacyRuntimeProvider) => new FakeRuntime(provider)
      );
      const clearTimeout = vi.fn<typeof globalThis.clearTimeout>();
      const manager = await PrivacyRuntimeManager.create({
        preference: "auto",
        candidateProviders: ["cpu", "coreml"],
        factory,
        setTimeout: (() => ({
          unref: () => undefined
        })) as unknown as typeof globalThis.setTimeout,
        clearTimeout
      });
      if (action === "cpu") await manager.switchProvider("cpu");
      await manager.dispose();
      expect(clearTimeout).toHaveBeenCalledOnce();
      expect(factory).toHaveBeenCalledTimes(1);
    }
  });

  it("uses cached auto measurements without recalibrating either provider", async () => {
    let saved: Awaited<
      ReturnType<import("./runtime-manager.js").PrivacyValidationCache["read"]>
    >;
    const cache: import("./runtime-manager.js").PrivacyValidationCache = {
      read: async () => saved,
      write: async (_runtime, value) => {
        saved = value;
      }
    };
    const options = {
      candidateProviders: ["cpu", "coreml"] as PrivacyRuntimeProvider[],
      validationCache: cache,
      factory: (p: PrivacyRuntimeProvider) => new FakeRuntime(p)
    };
    const first = await PrivacyRuntimeManager.create({
      ...options,
      preference: "coreml"
    });
    await first.dispose();
    saved!.calibrations = ["cpu", "coreml"].map((provider) => ({
      provider: provider as PrivacyRuntimeProvider,
      measuredAt: new Date().toISOString(),
      sampleTokens: 100,
      durationMs: 100,
      sampleCount: 2,
      warmTokensPerSecond: provider === "cpu" ? 100 : 200
    }));
    const expected = structuredClone(saved!.calibrations);
    const second = await PrivacyRuntimeManager.create({
      ...options,
      preference: "auto"
    });
    expect(second.provider).toBe("coreml");
    expect(second.status().calibrations).toEqual(expected);
    await second.dispose();
  });

  it("discards cached measurements when CPU diverges only on the credential fixture", async () => {
    let saved: Awaited<
      ReturnType<import("./runtime-manager.js").PrivacyValidationCache["read"]>
    >;
    const options = {
      preference: "cpu" as const,
      candidateProviders: ["cpu"] as PrivacyRuntimeProvider[],
      validationCache: {
        read: async () => saved,
        write: async (_runtime: unknown, value: NonNullable<typeof saved>) => {
          saved = value;
        }
      }
    };
    const first = await PrivacyRuntimeManager.create({
      ...options,
      factory: (p) => new FakeRuntime(p)
    });
    await first.dispose();
    const baseline = structuredClone(saved!.baseline);
    saved!.providers.push("coreml");
    saved!.calibrations = [
      {
        provider: "cpu",
        measuredAt: new Date().toISOString(),
        sampleTokens: 100,
        durationMs: 100,
        sampleCount: 2,
        warmTokensPerSecond: 100
      }
    ];
    const second = await PrivacyRuntimeManager.create({
      ...options,
      factory: (p) =>
        new FakeRuntime(p, {
          parityMismatchText: "api_key=synthetic_value_1234567890"
        })
    });
    expect(saved!.baseline[0]).toEqual(baseline[0]);
    expect(saved!.baseline[2]).not.toEqual(baseline[2]);
    expect(second.status().calibrations).toEqual([]);
    expect(second.status().verifiedProviders).toEqual(["cpu"]);
    await second.dispose();
  });

  it("does not report cached providers as verified before activation", async () => {
    let saved: Awaited<
      ReturnType<import("./runtime-manager.js").PrivacyValidationCache["read"]>
    >;
    const options = {
      factory: (p: PrivacyRuntimeProvider) => new FakeRuntime(p),
      candidateProviders: ["cpu", "coreml"] as PrivacyRuntimeProvider[],
      validationCache: {
        read: async () => saved,
        write: async (_runtime: unknown, value: NonNullable<typeof saved>) => {
          saved = value;
        }
      }
    };
    const first = await PrivacyRuntimeManager.create({
      ...options,
      preference: "coreml"
    });
    await first.dispose();
    const second = await PrivacyRuntimeManager.create({
      ...options,
      preference: "cpu"
    });
    expect(second.status().verifiedProviders).toEqual(["cpu"]);
    await second.dispose();
  });

  it("rejects a cached accelerator that matches the first fixture but fails the credential fixture", async () => {
    let saved: Awaited<
      ReturnType<import("./runtime-manager.js").PrivacyValidationCache["read"]>
    >;
    const cache: import("./runtime-manager.js").PrivacyValidationCache = {
      read: async () => saved,
      write: async (_runtime, value) => {
        saved = value;
      }
    };
    const options = {
      preference: "coreml" as const,
      candidateProviders: ["cpu", "coreml"] as PrivacyRuntimeProvider[],
      validationCache: cache
    };
    const first = await PrivacyRuntimeManager.create({
      ...options,
      factory: (p) => new FakeRuntime(p)
    });
    expect(first.status().calibrations).toEqual([]);
    await first.dispose();
    await expect(
      PrivacyRuntimeManager.create({
        ...options,
        factory: (p) =>
          new FakeRuntime(p, {
            parityMismatchText:
              p === "coreml" ? "api_key=synthetic_value_1234567890" : undefined
          })
      })
    ).rejects.toMatchObject({ code: "provider_parity_failed" });
    expect(saved?.providers).toEqual(["cpu"]);
  });
});
