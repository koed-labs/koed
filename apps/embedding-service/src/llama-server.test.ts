import { EventEmitter } from "node:events";

import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  LlamaServerClient,
  llamaServerArgs,
  llamaServerEnvironment,
  tokenPieceText
} from "./llama-server.js";
import { testConfig, testLogger } from "./test-helpers.js";
import { resolveAcceleration } from "./acceleration.js";

describe("llama-server adapter helpers", () => {
  it("decodes token pieces from llama-server responses", () => {
    expect(tokenPieceText("hello")).toBe("hello");
    expect(tokenPieceText([99, 97, 102, 195, 169])).toBe("café");
    expect(tokenPieceText({ value: "x" })).toBe("[object Object]");
  });

  it("derives llama-server library path from configured binary", () => {
    expect(
      llamaServerEnvironment("/runtime/llama.cpp/llama-server", {})
    ).toEqual(
      expect.objectContaining({
        LD_LIBRARY_PATH: "/runtime/llama.cpp",
        DYLD_LIBRARY_PATH: "/runtime/llama.cpp",
        LLAMA_ARG_UI: "false"
      })
    );
    expect(
      llamaServerEnvironment("/runtime/llama.cpp/llama-server", {
        LD_LIBRARY_PATH: "/existing",
        LLAMA_ARG_UI: "true"
      })
    ).toEqual(
      expect.objectContaining({
        LD_LIBRARY_PATH: "/runtime/llama.cpp:/existing",
        DYLD_LIBRARY_PATH: "/runtime/llama.cpp",
        LLAMA_ARG_UI: "false"
      })
    );
  });

  it("uses arguments supported by the pinned and current llama-server builds", () => {
    const config = testConfig();
    const args = llamaServerArgs(
      {
        name: "embedding",
        modelPath: config.modelPath!,
        port: config.embeddingServerPort,
        pooling: "last",
        embedding: true,

        nCtx: config.llamaNCtx,
        nThreads: config.llamaNThreads,
        nBatch: config.llamaNBatch,
        nUbatch: config.llamaNUbatch,
        parallel: config.llamaParallel,
        promptCacheEnabled: false,
        accelerationPolicy: "cpu",
        accelerationDevice: null
      },
      resolveAcceleration("cpu", [])
    );

    expect(args).toContain("--embedding");
    expect(args).not.toContain("--sleep-idle-seconds");
    expect(args).not.toContain("--no-ui");
    expect(args).not.toContain("--embd-normalize");
  });

  it("unloads accelerated models after the configured idle period", () => {
    const config = testConfig();
    const options = {
      name: "embedding" as const,
      modelPath: config.modelPath!,
      port: config.embeddingServerPort,
      pooling: "last" as const,
      embedding: true,

      nCtx: config.llamaNCtx,
      nThreads: config.llamaNThreads,
      nBatch: config.llamaNBatch,
      nUbatch: config.llamaNUbatch,
      parallel: config.llamaParallel,
      promptCacheEnabled: false,
      accelerationPolicy: "cuda" as const,
      accelerationDevice: null,
      gpuIdleUnloadSeconds: 120
    };
    const cuda = resolveAcceleration("cuda", [
      { id: "CUDA0", backend: "cuda" }
    ]);

    expect(llamaServerArgs(options, cuda)).toEqual(
      expect.arrayContaining(["--sleep-idle-seconds", "120"])
    );
    expect(
      llamaServerArgs({ ...options, gpuIdleUnloadSeconds: 0 }, cuda)
    ).not.toContain("--sleep-idle-seconds");
  });

  it("waits for the llama-server child to exit during shutdown", async () => {
    const childState = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdout: null,
      stderr: null,
      kill: vi.fn((signal: NodeJS.Signals) => {
        if (signal === "SIGTERM") {
          setTimeout(() => {
            childState.signalCode = signal;
            childState.emit("exit", null, signal);
          }, 10);
        }
        return true;
      })
    });
    const child = childState as unknown as ChildProcess;
    const config = testConfig();
    const client = new LlamaServerClient(
      config,
      testLogger(),
      {
        name: "embedding",
        modelPath: config.modelPath!,
        port: config.embeddingServerPort,
        pooling: "last",
        embedding: true,

        nCtx: config.llamaNCtx,
        nThreads: config.llamaNThreads,
        nBatch: config.llamaNBatch,
        nUbatch: config.llamaNUbatch,
        parallel: config.llamaParallel,
        promptCacheEnabled: false,
        accelerationPolicy: "cpu",
        accelerationDevice: null
      },
      async () =>
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        }),
      (() => child) as typeof import("node:child_process").spawn
    );

    await client.start();
    await client.stop();

    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.signalCode).toBe("SIGTERM");
    expect(client.isRunning()).toBe(false);
  });

  it("launches a discovered CUDA device with full offload", async () => {
    const spawnedArgs: string[][] = [];
    const childState = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdout: null,
      stderr: null,
      kill: vi.fn((signal: NodeJS.Signals) => {
        childState.signalCode = signal;
        childState.emit("exit", null, signal);
        return true;
      })
    });
    const config = testConfig({ embeddingAccelerationPolicy: "cuda" });
    const client = new LlamaServerClient(
      config,
      testLogger(),
      {
        name: "embedding",
        modelPath: config.modelPath!,
        port: config.embeddingServerPort,
        pooling: "last",
        embedding: true,

        nCtx: config.llamaNCtx,
        nThreads: config.llamaNThreads,
        nBatch: config.llamaNBatch,
        nUbatch: config.llamaNUbatch,
        parallel: config.llamaParallel,
        promptCacheEnabled: false,
        accelerationPolicy: "cuda",
        accelerationDevice: null
      },
      async () =>
        new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
      ((_command, args) => {
        if (!Array.isArray(args)) throw new Error("spawn args are required");
        spawnedArgs.push([...args]);
        return childState as unknown as ChildProcess;
      }) as typeof import("node:child_process").spawn,
      async () => ({
        listing: "Available devices:\n  CUDA0: test GPU",
        devices: [{ id: "CUDA0", backend: "cuda" }]
      })
    );

    await client.start();

    expect(spawnedArgs[0]).toEqual(
      expect.arrayContaining([
        "--device",
        "CUDA0",
        "--n-gpu-layers",
        "all",
        "--fit",
        "off"
      ])
    );
    expect(client.acceleration()).toMatchObject({
      backend: "cuda",
      device: "CUDA0",
      gpuLayers: "all"
    });
    await client.stop();
  });

  it("does not silently fall back when CUDA is explicitly required", async () => {
    const config = testConfig({ embeddingAccelerationPolicy: "cuda" });
    const spawner = vi.fn();
    const client = new LlamaServerClient(
      config,
      testLogger(),
      {
        name: "embedding",
        modelPath: config.modelPath!,
        port: config.embeddingServerPort,
        pooling: "last",
        embedding: true,

        nCtx: config.llamaNCtx,
        nThreads: config.llamaNThreads,
        nBatch: config.llamaNBatch,
        nUbatch: config.llamaNUbatch,
        parallel: config.llamaParallel,
        promptCacheEnabled: false,
        accelerationPolicy: "cuda",
        accelerationDevice: null
      },
      globalThis.fetch.bind(globalThis),
      spawner as typeof import("node:child_process").spawn,
      async () => ({ listing: "Available devices:\n  BLAS: CPU", devices: [] })
    );

    await expect(client.start()).rejects.toThrow(
      "cuda acceleration was required"
    );
    expect(spawner).not.toHaveBeenCalled();
  });

  it("falls back to CPU after an automatic CUDA startup failure", async () => {
    const spawnedArgs: string[][] = [];
    const failedChild = Object.assign(new EventEmitter(), {
      exitCode: 1 as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdout: null,
      stderr: null,
      kill: vi.fn(() => true)
    });
    const cpuChild = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdout: null,
      stderr: null,
      kill: vi.fn((signal: NodeJS.Signals) => {
        cpuChild.signalCode = signal;
        cpuChild.emit("exit", null, signal);
        return true;
      })
    });
    const children = [failedChild, cpuChild];
    const config = testConfig({ embeddingAccelerationPolicy: "auto" });
    const client = new LlamaServerClient(
      config,
      testLogger(),
      {
        name: "embedding",
        modelPath: config.modelPath!,
        port: config.embeddingServerPort,
        pooling: "last",
        embedding: true,

        nCtx: config.llamaNCtx,
        nThreads: config.llamaNThreads,
        nBatch: config.llamaNBatch,
        nUbatch: config.llamaNUbatch,
        parallel: config.llamaParallel,
        promptCacheEnabled: false,
        accelerationPolicy: "auto",
        accelerationDevice: null
      },
      async () =>
        new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
      ((_command, args) => {
        if (!Array.isArray(args)) throw new Error("spawn args are required");
        spawnedArgs.push([...args]);
        return children.shift() as unknown as ChildProcess;
      }) as typeof import("node:child_process").spawn,
      async () => ({
        listing: "Available devices:\n  CUDA0: test GPU",
        devices: [{ id: "CUDA0", backend: "cuda" }]
      }),
      { platform: "linux", arch: "x64" }
    );

    await client.start();

    expect(spawnedArgs).toHaveLength(2);
    expect(spawnedArgs[0]).toContain("CUDA0");
    expect(spawnedArgs[1]).toEqual(
      expect.arrayContaining(["--n-gpu-layers", "0"])
    );
    expect(client.acceleration()).toMatchObject({
      backend: "cpu",
      fallbackReason: "cuda_startup_failed"
    });
    await client.stop();
  });
});
