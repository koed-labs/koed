import { existsSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectLocalModelStatus } from "./local-models-runtime.js";
import {
  nativeCommand,
  requestProbeEmbeddings,
  withNativeProbe
} from "./native-validation-process.js";
import { resolveKoedServerPaths } from "./paths.js";
import {
  checkCudaHost,
  validateStagedCuda
} from "./runtime-release-validation.js";

vi.mock("./local-models-runtime.js", () => ({
  collectLocalModelStatus: vi.fn()
}));

vi.mock("./native-validation-process.js", () => ({
  nativeCommand: vi.fn(),
  requestProbeEmbeddings: vi.fn(),
  withNativeProbe: vi.fn()
}));

describe("CUDA host driver probe", () => {
  beforeEach(() => vi.resetAllMocks());

  it("loads the driver in Node mode when the host executable is Electron", async () => {
    vi.mocked(nativeCommand)
      .mockResolvedValueOnce("595.91.07")
      .mockResolvedValueOnce("true");
    await expect(checkCudaHost(new AbortController().signal)).resolves.toBe(
      "595.91.07"
    );
    const invocation = vi.mocked(nativeCommand).mock.calls[1];
    expect(invocation?.[0]).toBe(process.execPath);
    expect(invocation?.[1]).toContain("-p");
    expect(invocation?.[2].env).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
      LD_PRELOAD: "libcuda.so.1"
    });
  });

  it("still rejects a driver that the host loader cannot load", async () => {
    vi.mocked(nativeCommand)
      .mockResolvedValueOnce("595.91.07")
      .mockResolvedValueOnce("false");
    await expect(
      checkCudaHost(new AbortController().signal)
    ).rejects.toMatchObject({
      reason: "cuda_driver_library_unavailable"
    });
  });
});

describe("staged CUDA inference admission", () => {
  const paths = resolveKoedServerPaths({ KOED_HOME: "/fixture" });
  const response = (embedding: number[]) => ({
    data: [0, 1, 2].map((index) => ({ index, embedding }))
  });
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(nativeCommand).mockImplementation(async (_binary, args) =>
      args.includes("--list-devices")
        ? "Available devices:\nCUDA0: Synthetic GPU"
        : args.includes("-p")
          ? "true"
          : "595.91.07"
    );
    vi.mocked(collectLocalModelStatus).mockResolvedValue({
      state: "installed",
      message: "Installed",
      modelPath: "/fixture/model.gguf",
      sha256: "a".repeat(64),
      manifest: {
        kind: "embedding",
        key: "fixture",
        filename: "model.gguf",
        modelPath: "/fixture/model.gguf",
        urlEnv: "",
        sha256Env: "",
        pathEnv: ""
      }
    });
    vi.mocked(requestProbeEmbeddings).mockResolvedValue(response([1, 0]));
    vi.mocked(withNativeProbe).mockImplementation(
      async (_binary, _args, context, action, observe) => {
        context.signal.throwIfAborted();
        observe?.("offloaded 28/28 layers to GPU");
        return action({
          closed: Promise.resolve(0),
          lifetime: context.signal,
          log: () => ""
        });
      }
    );
  });
  const validate = (signal = new AbortController().signal) =>
    validateStagedCuda(paths, "/fixture", {}, { signal, requireModel: true });

  it("requires the model even when GPU discovery succeeds", async () => {
    const current = await collectLocalModelStatus(paths, "embedding");
    vi.mocked(collectLocalModelStatus).mockResolvedValue({
      ...current,
      state: "missing",
      message: "Install the embedding model"
    });
    await expect(validate()).rejects.toMatchObject({ reason: "model_missing" });
    expect(withNativeProbe).not.toHaveBeenCalled();
    await expect(
      validateStagedCuda(
        paths,
        "/fixture",
        {},
        { signal: new AbortController().signal }
      )
    ).resolves.toMatchObject({ scope: "device-only" });
  });

  it("admits matching embeddings only after the staged GPU confirms offload", async () => {
    await expect(validate()).resolves.toMatchObject({
      scope: "inference",
      agreement: [
        { dimensions: 2, cosine: 1 },
        { dimensions: 2, cosine: 1 },
        { dimensions: 2, cosine: 1 }
      ]
    });
    const calls = vi.mocked(withNativeProbe).mock.calls;
    expect(calls.map((call) => call[0])).toEqual([
      "/fixture/llama.cpp/cpu/llama-server",
      "/fixture/llama.cpp/cuda/llama-server"
    ]);
    expect(existsSync(calls[0]![2].cwd)).toBe(false);
  });

  it.each([
    ["different dimensions", [1, 0, 0]],
    ["different semantics", [0, 1]],
    ["nonfinite values", [Number.NaN, 0]],
    ["zero norm", [0, 0]]
  ] as const)(
    "rejects %s instead of admitting CUDA",
    async (_case, embedding) => {
      vi.mocked(requestProbeEmbeddings)
        .mockResolvedValueOnce(response([1, 0]))
        .mockResolvedValueOnce(response([...embedding]));
      await expect(validate()).rejects.toMatchObject({
        reason: "vector_agreement_failed"
      });
    }
  );

  it("rejects a successful GPU response without confirmed offload", async () => {
    vi.mocked(withNativeProbe).mockImplementation(
      async (_binary, _args, context, action) =>
        action({
          closed: Promise.resolve(0),
          lifetime: context.signal,
          log: () => ""
        })
    );
    await expect(validate()).rejects.toMatchObject({
      reason: "cuda_offload_unconfirmed"
    });
  });

  it("propagates cancellation during a probe and never begins the second probe", async () => {
    const abort = new AbortController();
    vi.mocked(requestProbeEmbeddings).mockImplementationOnce(async () => {
      abort.abort();
      throw abort.signal.reason;
    });
    await expect(validate(abort.signal)).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(withNativeProbe).toHaveBeenCalledTimes(1);
    expect(existsSync(vi.mocked(withNativeProbe).mock.calls[0]![2].cwd)).toBe(
      false
    );
  });
});
