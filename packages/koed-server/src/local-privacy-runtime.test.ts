import { resolve } from "node:path";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  truncateSync
} from "node:fs";
import { PINNED_PRIVACY_MODEL_REVISION } from "@koed-labs/shared";
import { resolveKoedServerPaths } from "./paths.js";
import { writePrivacyInstallationRecord } from "./privacy-installation-record.js";
import { describe, expect, it, vi } from "vitest";
import {
  collectLocalPrivacyRuntimeHealthStatus,
  startLocalPrivacyRuntime,
  localPrivacyEnv
} from "./local-privacy-runtime.js";
import type { KoedServerPaths } from "./paths.js";
import type { KoedAppRuntime } from "./app-runtime.js";
import * as privacyModelRuntime from "./privacy-model-runtime.js";
import {
  PRIVACY_MODEL_FILES,
  resolvePrivacyModelPaths
} from "./privacy-model-runtime.js";
import type { ChildProcess } from "node:child_process";

describe("native Privacy Filter Service runtime", () => {
  it("rejects an already aborted startup before model verification or spawn", async () => {
    const paths = resolveKoedServerPaths({
      KOED_HOME: "/nonexistent-privacy-test"
    });
    const controller = new AbortController();
    const reason = new Error("startup cancelled");
    controller.abort(reason);
    const spawn = vi.fn();

    await expect(
      startLocalPrivacyRuntime(
        paths,
        {},
        {
          existsSync: () => true,
          spawn,
          signal: controller.signal
        }
      )
    ).rejects.toBe(reason);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("interrupts model hashing on abort without spawning a child", async () => {
    mkdirSync("../../scratch", { recursive: true });
    const root = mkdtempSync(resolve("../../scratch/privacy-abort-"));
    try {
      const paths = resolveKoedServerPaths({ KOED_HOME: root });
      const blobs = resolvePrivacyModelPaths(paths).blobsDir;
      mkdirSync(blobs, { recursive: true });
      const blob = resolve(blobs, PRIVACY_MODEL_FILES[0]!.sha256);
      closeSync(openSync(blob, "w"));
      truncateSync(blob, 64 * 1024 * 1024);
      const controller = new AbortController();
      const spawn = vi.fn();
      const pending = startLocalPrivacyRuntime(
        paths,
        {},
        {
          existsSync: () => true,
          spawn,
          signal: controller.signal
        }
      );
      setImmediate(() => controller.abort());
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("does not spawn when cancellation arrives as verification completes", async () => {
    const controller = new AbortController();
    const spawn = vi.fn();
    const status = vi
      .spyOn(privacyModelRuntime, "collectPrivacyModelStatus")
      .mockImplementation(async () => {
        controller.abort();
        return {
          ok: true,
          state: "installed",
          message: "verified",
          modelPath: "/models",
          files: []
        };
      });
    try {
      await expect(
        startLocalPrivacyRuntime(
          resolveKoedServerPaths({ KOED_HOME: "/privacy-test" }),
          {},
          { existsSync: () => true, spawn, signal: controller.signal }
        )
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      status.mockRestore();
    }
  });

  it("returns ownership of a child even if cancellation happens during spawn", async () => {
    const controller = new AbortController();
    const child = { pid: 123 } as ChildProcess;
    const status = vi
      .spyOn(privacyModelRuntime, "collectPrivacyModelStatus")
      .mockResolvedValue({
        ok: true,
        state: "installed",
        message: "verified",
        modelPath: "/models",
        files: []
      });
    try {
      const result = await startLocalPrivacyRuntime(
        resolveKoedServerPaths({ KOED_HOME: "/privacy-test" }),
        {},
        {
          existsSync: () => true,
          signal: controller.signal,
          spawn: () => {
            controller.abort();
            return child;
          }
        }
      );
      expect(result.process).toBe(child);
      expect(result.ok).toBe(true);
    } finally {
      status.mockRestore();
    }
  });

  it("retains verified CPU fallback only for the matching CUDA generation and preserves explicit controls", () => {
    mkdirSync("scratch", { recursive: true });
    const root = mkdtempSync(resolve("scratch/privacy-cpu-record-"));
    try {
      const paths = resolveKoedServerPaths({ KOED_HOME: root });
      const generationId = "a".repeat(64),
        manifestDigest = "b".repeat(64);
      writePrivacyInstallationRecord(paths, {
        schemaVersion: 1,
        generationId,
        manifestDigest,
        variant: "cuda",
        modelRevision: PINNED_PRIVACY_MODEL_REVISION,
        verifiedAt: new Date().toISOString(),
        compatibility: {
          variant: "cuda",
          target: "linux-x64",
          compatible: true,
          reason: "fixture",
          observedAt: new Date().toISOString()
        },
        verification: {
          requestedProvider: "cuda",
          activeProvider: "cpu",
          executedProviders: ["CPUExecutionProvider"],
          proof: "onnx-execution-profile",
          maskingSha256: "c".repeat(64),
          fallbackReason: "cuda_initialization_or_inference_failed"
        }
      });
      const runtime = {
        kind: "packaged",
        generationId,
        privacyManifestDigest: manifestDigest,
        privacyVariant: "cuda"
      } as KoedAppRuntime;
      expect(localPrivacyEnv(paths, {}, runtime).PRIVACY_RUNTIME_PROVIDER).toBe(
        "cpu"
      );
      expect(
        localPrivacyEnv(paths, { PRIVACY_RUNTIME_PROVIDER: "cuda" }, runtime)
          .PRIVACY_RUNTIME_PROVIDER
      ).toBe("cuda");
      expect(
        localPrivacyEnv(
          paths,
          {},
          { ...runtime, privacyManifestDigest: "d".repeat(64) }
        ).PRIVACY_RUNTIME_PROVIDER
      ).toBe("auto");
      expect(
        localPrivacyEnv(paths, {}, { ...runtime, privacyVariant: undefined })
          .PRIVACY_RUNTIME_PROVIDER
      ).toBe("auto");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("wires a credential-free local URL and KOED_HOME model cache", () => {
    const paths = {
      koedHome: "/koed",
      modelsDir: "/koed/models"
    } as KoedServerPaths;
    expect(
      localPrivacyEnv(paths, {
        PRIVACY_SERVICE_HOST: "127.0.0.1",
        PRIVACY_SERVICE_PORT: "48092"
      })
    ).toEqual({
      PRIVACY_SERVICE_HOST: "127.0.0.1",
      PRIVACY_SERVICE_PORT: "48092",
      PRIVACY_SERVICE_URL: "http://127.0.0.1:48092",
      PRIVACY_RUNTIME_PROVIDER: "auto",
      PRIVACY_GPU_IDLE_UNLOAD_SECONDS: "300",
      KOED_PRIVACY_TRANSFORMERS_CACHE: resolve(
        "/koed/models/privacy/transformers-cache"
      )
    });
  });

  it("inherits the product hardware preference unless the service is overridden", () => {
    const paths = {
      koedHome: "/koed",
      modelsDir: "/koed/models"
    } as KoedServerPaths;
    expect(
      localPrivacyEnv(paths, { KOED_HARDWARE_ACCELERATION: "cpu" })
        .PRIVACY_RUNTIME_PROVIDER
    ).toBe("cpu");
    expect(
      localPrivacyEnv(paths, {
        KOED_HARDWARE_ACCELERATION: "cpu",
        PRIVACY_RUNTIME_PROVIDER: "cuda"
      }).PRIVACY_RUNTIME_PROVIDER
    ).toBe("cuda");
  });

  it("collects live startup health without requiring model files", async () => {
    const paths = {
      koedHome: "/koed",
      modelsDir: "/koed/models",
      repoRoot: "/repo"
    } as KoedServerPaths;

    await expect(
      collectLocalPrivacyRuntimeHealthStatus(
        paths,
        { PRIVACY_SERVICE_PORT: "48092" },
        {
          existsSync: () => true,
          fetch: async () =>
            new Response(JSON.stringify({ status: "ok" }), {
              status: 200,
              headers: { "content-type": "application/json" }
            })
        }
      )
    ).resolves.toMatchObject({
      state: "healthy",
      details: { healthUrl: "http://127.0.0.1:48092/health" }
    });
  });

  it("uses privacy service entry from selected generation instead of base root", async () => {
    const paths = {
      koedHome: "/koed",
      modelsDir: "/koed/models",
      repoRoot: "/repo"
    } as KoedServerPaths;
    const checkedPaths: string[] = [];
    const runtime = {
      kind: "packaged",
      root: "/generation/base",
      privacyServiceEntry: "/generation/privacy/privacy-service/dist/index.js"
    } as KoedAppRuntime;

    await collectLocalPrivacyRuntimeHealthStatus(
      paths,
      {},
      {
        appRuntime: runtime,
        existsSync: (path) => {
          checkedPaths.push(String(path));
          return true;
        },
        fetch: async () =>
          new Response(JSON.stringify({ status: "ok" }), { status: 200 })
      }
    );

    expect(checkedPaths).toContain(runtime.privacyServiceEntry);
    expect(checkedPaths).not.toContain(
      "/generation/base/privacy-service/dist/index.js"
    );
  });

  it("does not request accelerator diagnostics during startup health polling", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: "ok" }), { status: 200 })
      );
    const status = await collectLocalPrivacyRuntimeHealthStatus(
      {
        koedHome: "/koed",
        modelsDir: "/koed/models",
        repoRoot: "/repo"
      } as KoedServerPaths,
      { PRIVACY_RUNTIME_CONTROL_TOKEN: "test-control-token" },
      { existsSync: () => true, fetch: fetcher }
    );
    expect(status.state).toBe("healthy");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toMatch(/\/health$/);
  });

  it("returns a loading status when a health request exceeds its deadline", async () => {
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    try {
      const pending = collectLocalPrivacyRuntimeHealthStatus(
        {
          koedHome: "/koed",
          modelsDir: "/koed/models",
          repoRoot: "/repo"
        } as KoedServerPaths,
        {},
        {
          existsSync: () => true,
          fetch: async (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => reject(new Error("Health request timed out")),
                { once: true }
              );
            })
        }
      );
      expect(timeout).toHaveBeenCalledWith(5_000);
      controller.abort();
      await expect(pending).resolves.toMatchObject({ state: "starting" });
    } finally {
      timeout.mockRestore();
    }
  });
});
