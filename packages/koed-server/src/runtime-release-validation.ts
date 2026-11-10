import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { collectLocalModelStatus } from "./local-models-runtime.js";
import type { KoedServerPaths } from "./paths.js";
import {
  nativeCommand,
  requestProbeEmbeddings,
  withNativeProbe,
  type ProbeContext
} from "./native-validation-process.js";
import { compareNativeVersions } from "./native-runtime-catalog.js";
import { resolveNvidiaSmi } from "./nvidia-smi.js";

const minimumDriver = "550.54.14";
const minimumCosine = 0.999;
const inputs = [
  "The train arrives at noon.",
  "A red kite is flying over the lake.",
  "Measure twice, cut once."
];

class NativeValidationError extends Error {
  constructor(
    readonly reason: string,
    message: string
  ) {
    super(message);
  }
}

export async function checkCudaHost(
  signal: AbortSignal,
  nvidiaSmi = resolveNvidiaSmi()
) {
  const context: ProbeContext = {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    signal
  };
  let driverVersion: string;
  try {
    if (!nvidiaSmi) throw new Error("NVIDIA driver tools are not available.");
    const output = await nativeCommand(
      nvidiaSmi,
      ["--query-gpu=driver_version", "--format=csv,noheader"],
      context
    );
    const versions = new Set(output.split(/\r?\n/).map((row) => row.trim()));
    driverVersion = [...versions][0] ?? "";
    if (
      versions.size !== 1 ||
      !/^\d{1,4}\.\d{1,4}(\.\d{1,4})?$/.test(driverVersion)
    )
      throw new Error("No consistent NVIDIA driver version was reported.");
  } catch (error) {
    context.signal.throwIfAborted();
    throw new NativeValidationError(
      "cuda_device_unavailable",
      `Cannot query the NVIDIA GPU driver: ${message(error)}`
    );
  }
  const [major, minor, patch = 0] = driverVersion.split(".").map(Number);
  if (compareNativeVersions(`${major}.${minor}.${patch}`, minimumDriver) < 0)
    throw new NativeValidationError(
      "cuda_driver_too_old",
      `NVIDIA driver ${driverVersion} is older than required ${minimumDriver}.`
    );
  // Ask the host loader to load the driver in a disposable copy of Node. The
  // linker may ignore a failed preload with exit code 0, so check the load map.
  const loaded = await nativeCommand(
    process.execPath,
    [
      "-p",
      String.raw`process.report.getReport().sharedObjects.some(p => /\/libcuda\.so(?:\.\d+)*$/.test(p))`
    ],
    {
      ...context,
      // Desktop also calls this probe from Electron main. Its executable must
      // run as Node, just as it does for the private server supervisor.
      env: {
        ...context.env,
        ELECTRON_RUN_AS_NODE: "1",
        LD_PRELOAD: "libcuda.so.1"
      }
    }
  );
  if (loaded !== "true")
    throw new NativeValidationError(
      "cuda_driver_library_unavailable",
      "The host loader could not load libcuda.so.1."
    );
  return driverVersion;
}

async function discover(root: string, context: ProbeContext) {
  const driverVersion = await checkCudaHost(context.signal);
  const binary = resolve(root, "llama.cpp/cuda/llama-server");
  try {
    const listing = await nativeCommand(binary, ["--list-devices"], {
      ...context,
      env: { ...context.env, LD_LIBRARY_PATH: dirname(binary) }
    });
    const match = /^\s*(CUDA\d+):[ \t]+([^\r\n]+)/m.exec(listing);
    if (!match) throw new Error("The staged binary listed no CUDA device.");
    return { driverVersion, device: match[1]!, description: match[2]!.trim() };
  } catch (error) {
    context.signal.throwIfAborted();
    throw new NativeValidationError(
      "cuda_device_unavailable",
      `CUDA device discovery failed: ${message(error)}`
    );
  }
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const responseSchema = z.object({
  data: z
    .array(
      z.object({
        index: z.number().int(),
        embedding: z.array(z.number().finite()).min(1)
      })
    )
    .length(inputs.length)
});
function vectors(body: unknown) {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success)
    throw new NativeValidationError(
      "vector_agreement_failed",
      "Expected one finite, nonempty embedding per test input."
    );
  const rows = parsed.data.data.sort((a, b) => a.index - b.index);
  if (rows.some((row, index) => row.index !== index))
    throw new NativeValidationError(
      "vector_agreement_failed",
      "The embedding response did not identify each input exactly once."
    );
  return rows.map((row) => row.embedding);
}

async function embed(
  root: string,
  model: string,
  device: string | null,
  context: ProbeContext
) {
  const backend = device ? "cuda" : "cpu";
  const binary = resolve(root, `llama.cpp/${backend}/llama-server`);
  const socket = join(context.cwd, `${backend}.sock`);
  const args = [
    "--model",
    model,
    "--alias",
    "qualification",
    "--embedding",
    "--pooling",
    "last",
    "--ctx-size",
    "2048",
    "--batch-size",
    "512",
    "--ubatch-size",
    "512",
    "--parallel",
    "1",
    "--threads",
    "2",
    "--threads-batch",
    "2",
    "--n-gpu-layers",
    device ? "all" : "0",
    "--device",
    device ?? "none",
    "--fit",
    "off",
    "--host",
    socket,
    "-lv",
    "4"
  ];
  let offloaded = false,
    allocationFailed = false;
  return withNativeProbe(
    binary,
    args,
    { ...context, env: { ...context.env, LD_LIBRARY_PATH: dirname(binary) } },
    async (probe) => {
      try {
        const result = vectors(
          await requestProbeEmbeddings(socket, inputs, probe.lifetime)
        );
        if (device && !offloaded)
          throw new NativeValidationError(
            "cuda_offload_unconfirmed",
            "The staged server did not confirm GPU layer offload."
          );
        return result;
      } catch (error) {
        context.signal.throwIfAborted();
        if (probe.lifetime.aborted) await probe.closed;
        const log = probe.log();
        if (device && allocationFailed)
          throw new NativeValidationError(
            "cuda_memory_pressure",
            "CUDA ran out of VRAM during validation. Check nvidia-smi for competing GPU workloads and retry."
          );
        if (error instanceof NativeValidationError) throw error;
        throw new NativeValidationError(
          "inference_failed",
          `${backend.toUpperCase()} embedding probe failed: ${message(error)} ${log.slice(-650).trim()}`
        );
      }
    },
    (tail) => {
      offloaded ||= /offloaded [1-9]\d*\/\d+ layers to GPU/i.test(tail);
      allocationFailed ||=
        /out of memory|cudaErrorMemoryAllocation|cudaMalloc.*fail/i.test(tail);
    }
  );
}

function compare(cpu: number[][], gpu: number[][]) {
  const dimensions = cpu[0]!.length;
  return cpu.map((left, i) => {
    const right = gpu[i]!;
    if (left.length !== dimensions || right.length !== dimensions)
      throw new NativeValidationError(
        "vector_agreement_failed",
        `Embedding dimensions differ for input ${i + 1}.`
      );
    let dot = 0,
      normA = 0,
      normB = 0;
    for (let j = 0; j < dimensions; j++) {
      const a = left[j]!,
        b = right[j]!;
      dot += a * b;
      normA += a * a;
      normB += b * b;
    }
    const cosine = dot / (Math.sqrt(normA) * Math.sqrt(normB));
    if (!Number.isFinite(cosine) || cosine < minimumCosine)
      throw new NativeValidationError(
        "vector_agreement_failed",
        `CPU/GPU agreement failed for input ${i + 1}: cosine ${cosine}; required ${minimumCosine}.`
      );
    return { dimensions, cosine };
  });
}

// The caller holds withStoppedRuntime for the entire staged validation and,
// during install, until the selection swap. This function never activates it.
export async function validateStagedCuda(
  paths: KoedServerPaths,
  root: string,
  environment: NodeJS.ProcessEnv,
  options: { signal: AbortSignal; requireModel?: boolean }
) {
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(120_000)
  ]);
  // A short absolute name also fits the Linux sockaddr_un length limit.
  const cwd = mkdtempSync("/tmp/koed-native-probe-");
  try {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      HOME: cwd,
      TMPDIR: cwd
    };
    for (const key of ["CUDA_VISIBLE_DEVICES", "CUDA_DEVICE_ORDER"])
      if (environment[key] !== undefined) env[key] = environment[key];
    const context = { cwd, env, signal };
    const device = await discover(root, context);
    const model = await collectLocalModelStatus(
      paths,
      "embedding",
      environment,
      signal
    );
    signal.throwIfAborted();
    if (model.state === "missing" && !options.requireModel)
      return {
        ok: true,
        scope: "device-only",
        ...device,
        message:
          "CUDA device discovery passed. Install the embedding model for inference validation."
      };
    if (model.state !== "installed")
      throw new NativeValidationError(`model_${model.state}`, model.message);
    const cpu = await embed(root, model.modelPath, null, context);
    const gpu = await embed(root, model.modelPath, device.device, context);
    const agreement = compare(cpu, gpu);
    signal.throwIfAborted();
    return {
      ok: true,
      scope: "inference",
      ...device,
      modelSha256: model.sha256,
      minimumCosine,
      agreement,
      message:
        "CUDA device discovery, GPU offload and CPU/GPU embedding agreement passed."
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
