import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  accelerationInstallError,
  createAccelerationInstaller
} from "./acceleration-installation.js";
import {
  installReleaseRuntime,
  collectReleaseRuntimeStatus
} from "./runtime-release.js";
import { collectLocalModelStatus } from "./local-models-runtime.js";
import { resolveKoedServerPaths } from "./paths.js";
import type { AccelerationSnapshot } from "./acceleration-contract.js";

vi.mock("./runtime-release.js", () => ({
  installReleaseRuntime: vi.fn(),
  collectReleaseRuntimeStatus: vi.fn()
}));
vi.mock("./local-models-runtime.js", () => ({
  collectLocalModelStatus: vi.fn()
}));

function fixture() {
  const snapshot: AccelerationSnapshot = {
    configurationRevision: "a".repeat(64),
    observedAt: "2026-11-09T00:00:00Z",
    revision: "a".repeat(64),
    runtimeEpoch: "stopped",
    preference: "cpu",
    recommendedPreference: "cpu",
    effectivePolicy: "cpu",
    source: "saved",
    readOnlyReason: null,
    hardware: {
      state: "available",
      backend: "cuda",
      name: "Test GPU",
      memoryBytes: null,
      reason: "Detected",
      verification: "host"
    },
    cuda: {
      state: "missing",
      validation: "unknown",
      selectionId: null,
      canInstall: true,
      downloadBytes: 300,
      requiredFreeBytes: 900,
      availableFreeBytes: 1000,
      reason: "Download required"
    },
    model: {
      key: "embedding",
      label: "Embedding model",
      filename: "model.gguf",
      present: true
    },
    embedding: { state: "stopped", backend: null, fallbackReason: null },
    privacy: { state: "absent", provider: null, fallbackReason: null }
  };
  const inspector = {
    inspect: vi.fn(async () => structuredClone(snapshot)),
    invalidate: vi.fn()
  };
  const paths = resolveKoedServerPaths({ KOED_HOME: "/fixture" });
  const manager = createAccelerationInstaller(
    { paths, environment: () => ({ KOED_HOME: "/fixture" }) },
    inspector
  );
  const publish = vi.fn();
  const signal = new AbortController();
  const run = (mode = "cuda") =>
    manager.install(
      { mode, expectedRevision: "a".repeat(64) },
      signal.signal,
      publish
    );
  return { snapshot, inspector, manager, run, publish, signal };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(collectLocalModelStatus).mockResolvedValue({
    state: "installed"
  } as Awaited<ReturnType<typeof collectLocalModelStatus>>);
  vi.mocked(installReleaseRuntime).mockImplementation(
    async (_paths, options = {}) => {
      await options.assertConfiguration?.();
      options.progress?.({
        phase: "cuda.tar.gz",
        transferredBytes: 50,
        totalBytes: 300
      });
      await options.assertConfiguration?.();
      options.phase?.("inference");
      return {
        ok: true,
        provider: "release",
        state: "installed",
        changed: true,
        selectionId: "b".repeat(64),
        coreId: "c".repeat(64),
        cudaId: "d".repeat(64),
        executionPolicy: "cpu",
        downloadedBytes: 300,
        message: "Installed",
        validation: { ok: true, scope: "inference", message: "Verified" }
      } as Awaited<ReturnType<typeof installReleaseRuntime>>;
    }
  );
});

describe("Desktop native installation boundary", () => {
  it("requires model inference for CUDA and returns only scoped progress and status", async () => {
    const f = fixture();
    const result = await f.run();
    expect(vi.mocked(installReleaseRuntime).mock.calls[0]?.[1]).toMatchObject({
      cuda: "with",
      requireModel: true,
      signal: f.signal.signal
    });
    expect(f.inspector.inspect).toHaveBeenCalledTimes(3);
    expect(result.validation).toBe("inference");
    expect(result.snapshot.cuda.validation).toBe("inference");
    expect(f.publish).toHaveBeenCalledWith({
      phase: "downloading",
      completedBytes: 50,
      totalBytes: 300,
      message: "Downloading the reviewed runtime…"
    });
  });
  it("preserves retained CUDA when only the CPU core is requested and does not require an embedding download", async () => {
    const f = fixture();
    await f.run("core");
    expect(vi.mocked(installReleaseRuntime).mock.calls[0]?.[1]).toMatchObject({
      cuda: "preserve",
      requireModel: false
    });
    expect(collectLocalModelStatus).not.toHaveBeenCalled();
  });
  it.each(["stale", "readonly", "hardware", "model", "cancelled"])(
    "rejects %s before any download progress",
    async (problem) => {
      const f = fixture();
      if (problem === "stale") f.snapshot.revision = "f".repeat(64);
      if (problem === "readonly") f.snapshot.readOnlyReason = "Foreign owner";
      if (problem === "hardware") f.snapshot.hardware.state = "unavailable";
      if (problem === "model")
        vi.mocked(collectLocalModelStatus).mockResolvedValue({
          state: "missing"
        } as Awaited<ReturnType<typeof collectLocalModelStatus>>);
      if (problem === "cancelled") f.signal.abort();
      await expect(f.run()).rejects.toThrow();
      expect(f.publish).not.toHaveBeenCalled();
    }
  );
  it("checks configuration again after staged acquisition", async () => {
    const f = fixture();
    f.publish.mockImplementation(() => {
      f.snapshot.revision = "b".repeat(64);
    });
    await expect(f.run()).rejects.toThrow("changed");
  });
  it("rejects renderer-supplied artifacts and authority", async () => {
    const f = fixture();
    await expect(
      f.manager.install(
        {
          mode: "cuda",
          expectedRevision: "a".repeat(64),
          url: "https://untrusted.invalid",
          capability: {}
        },
        f.signal.signal,
        f.publish
      )
    ).rejects.toThrow();
    expect(installReleaseRuntime).not.toHaveBeenCalled();
  });
  it("does not return raw subprocess output on failure", async () => {
    const f = fixture();
    vi.mocked(installReleaseRuntime).mockRejectedValue(
      new Error("CUDA driver failed: secret subprocess output /private/path")
    );
    await expect(f.run()).rejects.toThrow("NVIDIA driver");
    await expect(f.run()).rejects.not.toThrow("secret");
  });
  it("classifies native validation failures by reason before message keywords", () => {
    const native = (reason: string, message: string) =>
      Object.assign(new Error(message), { reason });
    expect(
      accelerationInstallError(
        native(
          "inference_failed",
          "CUDA embedding probe failed: llama_model_loader: loaded meta data"
        )
      )
    ).toContain("Runtime verification could not finish");
    expect(
      accelerationInstallError(
        native(
          "cuda_device_unavailable",
          "Cannot query the NVIDIA GPU driver: Make sure that the latest NVIDIA driver is installed and running."
        )
      )
    ).toContain("NVIDIA driver");
    expect(
      accelerationInstallError(
        new Error("Staged native probe failed.", {
          cause: native("cuda_memory_pressure", "Check the model")
        })
      )
    ).toContain("graphics memory");
    expect(
      accelerationInstallError(
        new Error(
          "Make sure that the latest NVIDIA driver is installed and running."
        )
      )
    ).toContain("NVIDIA driver");
    expect(
      accelerationInstallError(
        new Error("Runtime ownership or configuration is read-only.")
      )
    ).toContain("stopped and owned");
  });
  it("keeps an admitted compatible older core usable", () => {
    const f = fixture();
    vi.mocked(collectReleaseRuntimeStatus).mockReturnValue({
      ok: true,
      state: "outdated",
      message: "Update available"
    } as ReturnType<typeof collectReleaseRuntimeStatus>);
    expect(f.manager.runtimeStatus()).toMatchObject({
      ok: true,
      state: "outdated"
    });
  });
});
