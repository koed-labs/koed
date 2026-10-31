import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ComponentVariant } from "./component-contract.js";

export interface PrivacyDownloadCompatibility {
  variant?: ComponentVariant;
  target: "macos-arm64" | "linux-x64" | "unsupported";
  compatible: boolean;
  reason: string;
  observedAt: string;
  gpuIndex?: number;
  computeCapability?: string;
  driverVersion?: string;
  cudaRuntimeVersion?: number;
  cudnnMajor?: number;
}

// Pinned onnxruntime-node 1.24.3 uses the CUDA 12.8 / cuDNN 9 provider.
// Conservative toolkit-driver floor avoids relying on PTX minor compatibility.
export const PRIVACY_CUDA_REQUIREMENTS = Object.freeze({
  onnxVersion: "1.24.3",
  minimumDriver: "570.26",
  minimumCudaRuntime: 12080,
  maximumCudaRuntimeExclusive: 13000,
  cudnnMajor: 9,
  libraries: [
    "libcublasLt.so.12",
    "libcublas.so.12",
    "libcudnn.so.9",
    "libcufft.so.11",
    "libcurand.so.10",
    "libcudart.so.12",
    "libz.so.1"
  ]
});

const hostLibraryProbe = `import ctypes, json
libraries = ${JSON.stringify(PRIVACY_CUDA_REQUIREMENTS.libraries)}
loaded = {}
for name in libraries:
    try:
        loaded[name] = ctypes.CDLL(name)
    except OSError:
        print(json.dumps({"missingLibrary": name}))
        raise SystemExit(0)
version = ctypes.c_int()
if loaded["libcudart.so.12"].cudaRuntimeGetVersion(ctypes.byref(version)) != 0:
    print(json.dumps({"error": "cuda_runtime_version_unavailable"}))
    raise SystemExit(0)
major = ctypes.c_int()
if loaded["libcudnn.so.9"].cudnnGetProperty(0, ctypes.byref(major)) != 0:
    print(json.dumps({"error": "cudnn_version_unavailable"}))
    raise SystemExit(0)
print(json.dumps({"cudaRuntimeVersion": version.value, "cudnnMajor": major.value}))
`;

type ProbeRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal }
) => Promise<string>;
const execute = promisify(execFile);
const defaultRunner: ProbeRunner = async (command, args, options) =>
  (
    await execute(command, args, {
      encoding: "utf8",
      timeout: options.timeoutMs,
      maxBuffer: 32 * 1024,
      killSignal: "SIGKILL",
      ...(options.signal ? { signal: options.signal } : {})
    })
  ).stdout;
const atLeast = (actual: string, minimum: string): boolean => {
  const left = actual.split(".").map(Number);
  const right = minimum.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] ?? 0) !== (right[i] ?? 0))
      return (left[i] ?? 0) > (right[i] ?? 0);
  }
  return true;
};

export async function probePrivacyDownloadCompatibility(
  input: {
    platform?: string;
    architecture?: string;
    preference?: string;
    environment?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    run?: ProbeRunner;
    budgetMs?: number;
  } = {}
): Promise<PrivacyDownloadCompatibility> {
  const platform = input.platform ?? process.platform;
  const architecture = input.architecture ?? process.arch;
  const observedAt = new Date().toISOString();
  if (
    (platform === "darwin" || platform === "macos") &&
    architecture === "arm64"
  )
    return {
      target: "macos-arm64",
      compatible: true,
      reason: "macos_provider_selection_unchanged",
      observedAt
    };
  if (platform !== "linux" || architecture !== "x64")
    return {
      target: "unsupported",
      compatible: false,
      reason: "unsupported_target",
      observedAt
    };
  const base = {
    target: "linux-x64" as const,
    variant: "cpu" as const,
    compatible: false,
    observedAt
  };
  if (input.preference?.trim().toLowerCase() === "cpu")
    return { ...base, reason: "explicit_cpu_preference" };
  const environment = input.environment ?? process.env;
  if (
    (environment.CUDA_VISIBLE_DEVICES !== undefined &&
      environment.CUDA_VISIBLE_DEVICES.trim() !== "0") ||
    (environment.NVIDIA_VISIBLE_DEVICES !== undefined &&
      !["all", "0"].includes(environment.NVIDIA_VISIBLE_DEVICES.trim()))
  )
    return { ...base, reason: "inconclusive_device_visibility" };
  const deadline =
    Date.now() + Math.min(5000, Math.max(1, input.budgetMs ?? 5000));
  const run = async (command: string, args: string[]) => {
    input.signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("probe_timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const output = await Promise.race([
        (input.run ?? defaultRunner)(command, args, {
          timeoutMs: remaining,
          ...(input.signal ? { signal: input.signal } : {})
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("probe_timeout")),
            remaining
          );
        })
      ]);
      if (Buffer.byteLength(output) > 32 * 1024)
        throw new Error("probe_output_limit");
      return output;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  let device: Partial<PrivacyDownloadCompatibility> = {};
  try {
    const output = await run("nvidia-smi", [
      "--query-gpu=index,driver_version,compute_cap",
      "--format=csv,noheader,nounits"
    ]);
    // nvidia-smi indices need not match CUDA's default order on heterogeneous
    // multi-GPU hosts. Do not assert compatibility for an unidentified device.
    if (output.trim().split(/\r?\n/).length > 1)
      return { ...base, reason: "inconclusive_multiple_gpu_mapping" };
    const row = output
      .trim()
      .split(/\r?\n/)[0]
      ?.split(",")
      .map((part) => part.trim());
    if (
      !row ||
      row.length !== 3 ||
      row[0] !== "0" ||
      !/^\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/.test(row[1] ?? "") ||
      !/^\d{1,2}\.\d$/.test(row[2] ?? "")
    )
      return {
        ...base,
        reason: output.trim() ? "inconclusive_gpu_probe" : "no_visible_gpu"
      };
    device = {
      gpuIndex: 0,
      driverVersion: row[1]!,
      computeCapability: row[2]!
    };
    if (!atLeast(row[1]!, PRIVACY_CUDA_REQUIREMENTS.minimumDriver))
      return { ...base, ...device, reason: "incompatible_driver" };
    if (!/^[6-9]\.\d$/.test(row[2]!))
      return { ...base, ...device, reason: "unsupported_compute_capability" };
    const libraries: unknown = JSON.parse(
      await run("python3", ["-c", hostLibraryProbe])
    );
    if (!libraries || typeof libraries !== "object")
      return { ...base, ...device, reason: "inconclusive_library_probe" };
    const values = libraries as Record<string, unknown>;
    if (typeof values.missingLibrary === "string")
      return {
        ...base,
        ...device,
        reason: `missing_library:${values.missingLibrary}`
      };
    if (
      !Number.isSafeInteger(values.cudaRuntimeVersion) ||
      !Number.isSafeInteger(values.cudnnMajor)
    )
      return { ...base, ...device, reason: "inconclusive_library_versions" };
    const versions = {
      cudaRuntimeVersion: Number(values.cudaRuntimeVersion),
      cudnnMajor: Number(values.cudnnMajor)
    };
    if (
      versions.cudaRuntimeVersion <
        PRIVACY_CUDA_REQUIREMENTS.minimumCudaRuntime ||
      versions.cudaRuntimeVersion >=
        PRIVACY_CUDA_REQUIREMENTS.maximumCudaRuntimeExclusive ||
      versions.cudnnMajor !== PRIVACY_CUDA_REQUIREMENTS.cudnnMajor
    )
      return {
        ...base,
        ...device,
        ...versions,
        reason: "incompatible_cuda_libraries"
      };
    return {
      ...base,
      ...device,
      ...versions,
      variant: "cuda",
      compatible: true,
      reason: "cuda_compatibility_established"
    };
  } catch (error) {
    input.signal?.throwIfAborted();
    const value = error as NodeJS.ErrnoException & { killed?: boolean };
    return {
      ...base,
      ...device,
      reason:
        value.message === "probe_timeout" || value.killed
          ? "probe_timeout"
          : value.code === "ENOENT"
            ? "probe_tool_unavailable"
            : "inconclusive_probe"
    };
  }
}
