import { existsSync } from "node:fs";
import type { AccelerationHardware } from "./acceleration-contract.js";
import { nativeCommand } from "./native-validation-process.js";
import { checkCudaHost } from "./runtime-release-validation.js";
import { getNativeRuntimeCatalog } from "./native-runtime-catalog.js";

interface NvidiaDevice {
  index: string;
  uuid: string;
  name: string;
  memoryBytes: number;
  architecture: number;
}

const unavailable = (
  reason: string,
  state: AccelerationHardware["state"] = "unavailable"
): AccelerationHardware => ({
  state,
  backend: null,
  name: "CPU processing",
  memoryBytes: null,
  reason,
  verification: "none"
});

export function parseNvidiaDevices(output: string): NvidiaDevice[] {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  return lines.map((line) => {
    const [index, uuid, name, memory, capability, ...extra] = line
      .split(",")
      .map((value) => value.trim());
    if (
      extra.length ||
      !/^\d+$/.test(index ?? "") ||
      !/^GPU-[a-f0-9-]+$/i.test(uuid ?? "") ||
      !name ||
      name.length > 180 ||
      !/^\d+$/.test(memory ?? "") ||
      !/^\d+\.\d$/.test(capability ?? "")
    )
      throw new Error("NVIDIA device information was incomplete.");
    return {
      index: index!,
      uuid: uuid!,
      name,
      memoryBytes: Number(memory) * 1024 * 1024,
      architecture: Math.round(Number(capability) * 10)
    };
  });
}

// nvidia-smi indices need not match CUDA's enumeration. UUID masks can be
// resolved before the add-on exists; ambiguous ordinal masks stay unknown until
// executable discovery during installation. Never silently ignore a device mask.
export function visibleNvidiaDevices(
  devices: NvidiaDevice[],
  mask: string | undefined
): NvidiaDevice[] | null {
  if (mask === undefined) return devices;
  if (!mask.trim() || mask.trim() === "-1") return [];
  const visible: NvidiaDevice[] = [];
  for (const token of mask.split(",").map((part) => part.trim())) {
    if (devices.length === 1 && token === "0") {
      visible.push(devices[0]!);
      continue;
    }
    if (!token.startsWith("GPU-")) return null;
    const matches = devices.filter((device) => device.uuid.startsWith(token));
    if (matches.length !== 1 || visible.includes(matches[0]!)) return null;
    visible.push(matches[0]!);
  }
  return visible;
}

export async function inspectAccelerationHardware(
  environment: NodeJS.ProcessEnv,
  dependencies: {
    platform?: NodeJS.Platform;
    arch?: string;
    libc?: string;
    exists?: typeof existsSync;
    command?: typeof nativeCommand;
    checkCuda?: typeof checkCudaHost;
    architectures?: readonly number[];
  } = {}
): Promise<AccelerationHardware> {
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  if (platform === "darwin" && arch === "arm64")
    return {
      state: "available",
      backend: "metal",
      name: "Apple Silicon",
      memoryBytes: null,
      reason: "Metal is available on this Mac.",
      verification: "host"
    };
  if (platform !== "linux" || arch !== "x64")
    return unavailable(
      "This device uses CPU processing. GPU acceleration is supported on Apple Silicon and compatible Linux NVIDIA devices.",
      "unsupported"
    );
  const libc =
    dependencies.libc ??
    (
      process.report.getReport() as {
        header?: { glibcVersionRuntime?: string };
      }
    ).header?.glibcVersionRuntime ??
    "";
  const [major, minor] = libc.split(".").map(Number);
  if (!(major! > 2 || (major === 2 && minor! >= 35)))
    return unavailable(
      "The optional CUDA package requires glibc 2.35 or later.",
      "unsupported"
    );
  if (
    environment.CUDA_VISIBLE_DEVICES !== undefined &&
    ["", "-1"].includes(environment.CUDA_VISIBLE_DEVICES.trim())
  )
    return unavailable(
      "GPU devices are hidden by the Operator's CUDA_VISIBLE_DEVICES setting."
    );
  if (!(dependencies.exists ?? existsSync)("/usr/bin/nvidia-smi"))
    return unavailable(
      "NVIDIA driver tools are not available. CPU processing is ready to use."
    );
  const signal = AbortSignal.timeout(15_000);
  try {
    const output = await (dependencies.command ?? nativeCommand)(
      "/usr/bin/nvidia-smi",
      [
        "--query-gpu=index,uuid,name,memory.total,compute_cap",
        "--format=csv,noheader,nounits"
      ],
      {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        signal
      }
    );
    const devices = visibleNvidiaDevices(
      parseNvidiaDevices(output),
      environment.CUDA_VISIBLE_DEVICES
    );
    if (devices === null)
      return unavailable(
        "The configured GPU visibility could not be mapped safely. Ask the Operator to use GPU UUIDs, then check again.",
        "unknown"
      );
    if (!devices.length)
      return unavailable("No visible NVIDIA GPU was detected.");
    let architectures = dependencies.architectures;
    if (!architectures) {
      try {
        architectures = getNativeRuntimeCatalog().cuda?.cuda.architectures;
      } catch {
        /* Package inspection separately reports a missing catalog. */
      }
    }
    if (
      devices.some(
        (device) =>
          !(architectures ?? [75, 80, 86, 89, 90]).includes(device.architecture)
      )
    )
      return unavailable(
        "A visible GPU is outside the CUDA package's supported architectures.",
        "unsupported"
      );
    await (dependencies.checkCuda ?? checkCudaHost)(signal);
    return {
      state: "available",
      backend: "cuda",
      name: devices.map((device) => device.name).join(" · "),
      memoryBytes: devices.length === 1 ? devices[0]!.memoryBytes : null,
      verification: "host",
      reason:
        "Compatible NVIDIA hardware detected. CUDA still requires package and embedding verification."
    };
  } catch (error) {
    const reason = (error as { reason?: string }).reason;
    if (reason === "cuda_driver_too_old")
      return unavailable(
        "The NVIDIA driver needs an update before CUDA can be enabled. Driver 550.54.14 or later is required."
      );
    if (reason === "cuda_driver_library_unavailable")
      return unavailable(
        "The NVIDIA driver library is unavailable. CPU processing can still be used."
      );
    return unavailable(
      "Hardware detection could not finish. Check again, or continue with CPU.",
      "unknown"
    );
  }
}
