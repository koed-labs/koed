import { execFile } from "node:child_process";
import { arch, platform } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";

export type AccelerationPolicy = "auto" | "cpu" | "metal" | "cuda";
export type AccelerationBackend = "cpu" | "metal" | "cuda";

export interface LlamaDevice {
  id: string;
  backend: Exclude<AccelerationBackend, "cpu"> | "cpu";
}

export interface ResolvedAcceleration {
  policy: AccelerationPolicy;
  backend: AccelerationBackend;
  device: string | null;
  gpuLayers: "0" | "all";
  fallbackReason: string | null;
  deviceListing: string | null;
}

const execFileAsync = promisify(execFile);
const deviceDiscoveryTimeoutMs = 30_000;

const discoveryEnvironment = (
  llamaServerBinary: string,
  policy: AccelerationPolicy
): NodeJS.ProcessEnv => {
  const llamaDir = dirname(llamaServerBinary);
  const existing = process.env.LD_LIBRARY_PATH?.trim();
  const existingDyld = process.env.DYLD_LIBRARY_PATH?.trim();
  return {
    ...process.env,
    LLAMA_ARG_UI: "false",
    KOED_LLAMA_SERVER_BACKEND: policy,
    LD_LIBRARY_PATH: existing ? `${llamaDir}:${existing}` : llamaDir,
    DYLD_LIBRARY_PATH: existingDyld ? `${llamaDir}:${existingDyld}` : llamaDir
  };
};

export const parseLlamaDevices = (listing: string): LlamaDevice[] => {
  const devices = new Map<string, LlamaDevice>();
  for (const line of listing.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9_.-]*):\s+/.exec(line);
    if (!match?.[1]) continue;
    const id = match[1];
    const normalized = id.toLowerCase();
    const backend = normalized.startsWith("cuda")
      ? "cuda"
      : normalized.startsWith("metal") || normalized.startsWith("mtl")
        ? "metal"
        : "cpu";
    devices.set(id, { id, backend });
  }
  return [...devices.values()];
};

export const listLlamaDevices = async (
  llamaServerBinary: string,
  policy: AccelerationPolicy = "auto"
): Promise<{ listing: string; devices: LlamaDevice[] }> => {
  const output = await execFileAsync(llamaServerBinary, ["--list-devices"], {
    encoding: "utf8",
    env: discoveryEnvironment(llamaServerBinary, policy),
    timeout: deviceDiscoveryTimeoutMs,
    maxBuffer: 1024 * 1024
  });
  const listing = `${output.stdout}\n${output.stderr}`.trim();
  return { listing, devices: parseLlamaDevices(listing) };
};

const chooseDevice = (
  backend: "metal" | "cuda",
  devices: LlamaDevice[],
  requestedDevice: string | null
): string | null => {
  if (requestedDevice) {
    const match = devices.find((device) => device.id === requestedDevice);
    return match?.backend === backend ? match.id : null;
  }
  return devices.find((device) => device.backend === backend)?.id ?? null;
};

export const resolveAcceleration = (
  policy: AccelerationPolicy,
  devices: LlamaDevice[],
  requestedDevice: string | null = null,
  host: { platform: NodeJS.Platform; arch: string } = {
    platform: platform(),
    arch: arch()
  },
  deviceListing: string | null = null
): ResolvedAcceleration => {
  const requestedBackend =
    policy === "auto"
      ? host.platform === "darwin" && host.arch === "arm64"
        ? "metal"
        : host.platform === "linux"
          ? "cuda"
          : "cpu"
      : policy;

  if (requestedBackend === "cpu") {
    return {
      policy,
      backend: "cpu",
      device: null,
      gpuLayers: "0",
      fallbackReason: null,
      deviceListing
    };
  }

  const device = chooseDevice(requestedBackend, devices, requestedDevice);
  if (device) {
    return {
      policy,
      backend: requestedBackend,
      device,
      gpuLayers: "all",
      fallbackReason: null,
      deviceListing
    };
  }
  if (policy !== "auto") {
    const requested = requestedDevice
      ? ` device ${JSON.stringify(requestedDevice)}`
      : "";
    throw new Error(
      `${requestedBackend} acceleration was required, but llama-server did not report a compatible${requested} device`
    );
  }
  return {
    policy,
    backend: "cpu",
    device: null,
    gpuLayers: "0",
    fallbackReason: `${requestedBackend}_device_unavailable`,
    deviceListing
  };
};

export const accelerationArgs = (
  acceleration: ResolvedAcceleration
): string[] => {
  if (acceleration.backend === "cpu") {
    return ["--n-gpu-layers", "0"];
  }
  return [
    "--device",
    acceleration.device!,
    "--n-gpu-layers",
    "all",
    "--fit",
    "off"
  ];
};

export const accelerationDescription = (
  acceleration: ResolvedAcceleration
): string =>
  `${acceleration.backend};runtime=llama.cpp;n-gpu-layers=${acceleration.gpuLayers}`;

export const cpuFallback = (
  policy: AccelerationPolicy,
  reason: string,
  deviceListing: string | null
): ResolvedAcceleration => ({
  policy,
  backend: "cpu",
  device: null,
  gpuLayers: "0",
  fallbackReason: reason,
  deviceListing
});
