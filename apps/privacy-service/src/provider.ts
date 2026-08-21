import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

export const PRIVACY_RUNTIME_PROVIDERS = [
  "cpu",
  "cuda",
  "coreml",
  "dml"
] as const;

export type PrivacyRuntimeProvider = (typeof PRIVACY_RUNTIME_PROVIDERS)[number];
export type PrivacyRuntimePreference = "auto" | PrivacyRuntimeProvider;

export const parsePrivacyRuntimePreference = (
  value: string | undefined
): PrivacyRuntimePreference => {
  const normalized = value?.trim().toLowerCase() || "cpu";
  if (
    normalized === "auto" ||
    PRIVACY_RUNTIME_PROVIDERS.includes(
      normalized as (typeof PRIVACY_RUNTIME_PROVIDERS)[number]
    )
  ) {
    return normalized as PrivacyRuntimePreference;
  }
  throw new Error(
    `PRIVACY_RUNTIME_PROVIDER must be one of auto, ${PRIVACY_RUNTIME_PROVIDERS.join(", ")}`
  );
};

export const platformPrivacyProviderCandidates = (
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch
): PrivacyRuntimeProvider[] => {
  const candidates: PrivacyRuntimeProvider[] = [];
  if (platform === "linux" && architecture === "x64") candidates.push("cuda");
  if (platform === "darwin") candidates.push("coreml");
  if (platform === "win32") candidates.push("dml");
  candidates.push("cpu");
  return candidates;
};

export interface SharedAcceleratorObservation {
  provider: "cuda";
  observedAt: string;
  capacityAvailable: boolean;
  totalMemoryMiB?: number;
  usedMemoryMiB?: number;
  freeMemoryMiB?: number;
  utilizationPercent?: number;
  pressure: "normal" | "elevated" | "critical" | "unknown";
  contentionLikely: boolean;
  unavailableReason?: "tool_unavailable" | "observation_failed";
}

type ExecFileResult = { stdout: string };
type ExecFileLike = (
  command: string,
  args: string[]
) => Promise<ExecFileResult>;

const execFile = promisify(nodeExecFile);

const numeric = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

export const observeCudaAccelerator = async (
  run: ExecFileLike = async (command, args) => {
    const result = await execFile(command, args, {
      encoding: "utf8",
      timeout: 1_500,
      maxBuffer: 32 * 1024,
      windowsHide: true
    });
    return { stdout: result.stdout };
  },
  now: () => Date = () => new Date()
): Promise<SharedAcceleratorObservation> => {
  const observedAt = now().toISOString();
  try {
    const { stdout } = await run("nvidia-smi", [
      "--query-gpu=memory.total,memory.used,memory.free,utilization.gpu",
      "--format=csv,noheader,nounits"
    ]);
    const firstGpu = stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean);
    if (!firstGpu) throw new Error("missing GPU observation");
    const [totalRaw, usedRaw, freeRaw, utilizationRaw] = firstGpu.split(",");
    const totalMemoryMiB = numeric(totalRaw);
    const usedMemoryMiB = numeric(usedRaw);
    const freeMemoryMiB = numeric(freeRaw);
    const utilizationPercent = numeric(utilizationRaw);
    if (
      totalMemoryMiB === undefined ||
      usedMemoryMiB === undefined ||
      freeMemoryMiB === undefined ||
      utilizationPercent === undefined
    ) {
      throw new Error("invalid GPU observation");
    }
    const freeRatio = totalMemoryMiB === 0 ? 0 : freeMemoryMiB / totalMemoryMiB;
    const pressure =
      freeMemoryMiB < 1_024 || freeRatio < 0.1
        ? "critical"
        : freeRatio < 0.2 || utilizationPercent >= 85
          ? "elevated"
          : "normal";
    return {
      provider: "cuda",
      observedAt,
      capacityAvailable: pressure !== "critical",
      totalMemoryMiB,
      usedMemoryMiB,
      freeMemoryMiB,
      utilizationPercent,
      pressure,
      contentionLikely: utilizationPercent >= 85
    };
  } catch (error) {
    const unavailableReason =
      error instanceof Error && "code" in error && error.code === "ENOENT"
        ? "tool_unavailable"
        : "observation_failed";
    return {
      provider: "cuda",
      observedAt,
      capacityAvailable: false,
      pressure: "unknown",
      contentionLikely: false,
      unavailableReason
    };
  }
};
