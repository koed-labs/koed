import { z } from "zod";
import type {
  AccelerationInstallProgress,
  AccelerationInstallResult
} from "./acceleration-contract.js";
import type { createAccelerationInspector } from "./acceleration-inspection.js";
import {
  installReleaseRuntime,
  collectReleaseRuntimeStatus
} from "./runtime-release.js";
import { collectLocalModelStatus } from "./local-models-runtime.js";

export const accelerationInstallSchema = z
  .object({
    mode: z.enum(["core", "cuda"]),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();

const verificationFailed =
  "Runtime verification could not finish. Check service status, retry, or continue with CPU.";
const driverUnavailable =
  "The NVIDIA driver is unavailable or incompatible. Check the driver, or continue with CPU.";
const insufficientVram =
  "CUDA has insufficient free graphics memory. Close other GPU workloads, or continue with CPU.";

// Native validation failures carry a stable reason code. Prefer it over message
// keywords, because their messages embed driver output and llama-server logs.
const nativeReasonMessages: Record<string, string> = {
  cuda_device_unavailable: driverUnavailable,
  cuda_driver_library_unavailable: driverUnavailable,
  cuda_driver_too_old: driverUnavailable,
  cuda_memory_pressure: insufficientVram,
  cuda_offload_unconfirmed: verificationFailed,
  inference_failed: verificationFailed,
  vector_agreement_failed: verificationFailed
};
const nativeReason = (error: unknown): string | null => {
  for (let current = error, depth = 0; depth < 5; depth++) {
    if (!(current instanceof Error)) return null;
    const reason = (current as Error & { reason?: unknown }).reason;
    if (typeof reason === "string" && reason in nativeReasonMessages)
      return reason;
    current = current.cause;
  }
  return null;
};

// Native errors can include executable output and filesystem paths. Keep those
// out of this renderer-facing boundary, including nested acquisition errors.
export function accelerationInstallError(error: unknown): string {
  const text = error instanceof Error ? error.message : "";
  if (/cancel|abort/i.test(text))
    return "Runtime installation was cancelled. Retained assets can be reused.";
  const reason = nativeReason(error);
  if (reason) return nativeReasonMessages[reason]!;
  // Driver and memory text can mention "running" or "model"; classify it first.
  if (/driver|libcuda/i.test(text)) return driverUnavailable;
  if (/VRAM|out of memory/i.test(text)) return insufficientVram;
  if (/owner|lock|stopped|running|read-only/i.test(text))
    return "The runtime must be stopped and owned by this installation before its assets can change.";
  if (/changed|configuration/i.test(text))
    return "Configuration or runtime selection changed. Check again before retrying.";
  if (/disk|free space|ENOSPC/i.test(text))
    return "Free more disk space, then retry the runtime installation.";
  if (/model/i.test(text))
    return "The pinned embedding model must be installed and verified before CUDA can be enabled.";
  if (/digest|checksum|payload|inventory|archive|manifest/i.test(text))
    return "Runtime asset verification failed. Check the selected runtime before retrying.";
  if (/catalog|reviewed|qualified|pin/i.test(text))
    return "This build has no usable reviewed runtime catalog. Use a release with qualified native assets.";
  if (/provider|native entry|native store/i.test(text))
    return "The existing native provider cannot be migrated automatically. Keep that provider or use a fresh Koed installation.";
  if (/glibc|Linux x64/i.test(text))
    return "The release runtime requires Linux x64 with glibc 2.35 or later.";
  if (/download|connect|stalled|acquire/i.test(text))
    return "The runtime download could not finish. Check your connection and retry.";
  return verificationFailed;
}

export function createAccelerationInstaller(
  options: Parameters<typeof createAccelerationInspector>[0],
  inspector: ReturnType<typeof createAccelerationInspector>
) {
  let active = false;
  return {
    runtimeStatus() {
      try {
        const status = collectReleaseRuntimeStatus(
          options.paths,
          options.environment()
        );
        return {
          ok: status.ok,
          state: status.state,
          provider: "release",
          message: status.message
        };
      } catch (error) {
        return {
          ok: false,
          state: "unavailable",
          provider: "release",
          message: accelerationInstallError(error)
        };
      }
    },
    async install(
      input: unknown,
      signal: AbortSignal,
      progress: (event: AccelerationInstallProgress) => void
    ): Promise<AccelerationInstallResult> {
      const choice = accelerationInstallSchema.parse(input);
      if (active)
        throw new Error("Another native installation is already running.");
      active = true;
      const assertConfiguration = async () => {
        signal.throwIfAborted();
        const state = await inspector.inspect(true);
        // Operator acceleration settings block CUDA, not the core runtime that
        // setup needs whatever processing the Operator has chosen.
        if (
          choice.mode === "core"
            ? state.runtimeReadOnlyReason
            : state.readOnlyReason
        )
          throw new Error("Runtime ownership or configuration is read-only.");
        if (state.revision !== choice.expectedRevision)
          throw new Error("Configuration changed.");
        if (choice.mode === "cuda" && state.hardware.state !== "available")
          throw new Error("NVIDIA driver or device capability is unavailable.");
        if (
          choice.mode === "cuda" &&
          (
            await collectLocalModelStatus(
              options.paths,
              "embedding",
              options.environment(),
              signal
            )
          ).state !== "installed"
        )
          throw new Error("Embedding model verification is required.");
      };
      try {
        const result = await installReleaseRuntime(options.paths, {
          environment: options.environment(),
          desktopRuntimeCapability: options.capability,
          cuda: choice.mode === "cuda" ? "with" : "preserve",
          requireModel: choice.mode === "cuda",
          signal,
          assertConfiguration,
          progress: (event) =>
            progress({
              phase: "downloading",
              completedBytes: event.transferredBytes,
              totalBytes: event.totalBytes ?? null,
              message: "Downloading the reviewed runtime…"
            }),
          phase: (phase) =>
            progress({
              phase,
              completedBytes: null,
              totalBytes: null,
              message: {
                checking: "Checking runtime ownership and assets…",
                verifying: "Verifying the runtime assets…",
                inference:
                  "Checking GPU offload and CPU/GPU embedding agreement…",
                activating: "Activating the verified runtime…"
              }[phase]
            })
        });
        inspector.invalidate();
        const snapshot = await inspector.inspect(true);
        const validation =
          result.validation?.scope === "inference"
            ? "inference"
            : result.validation?.scope === "device-only"
              ? "device-only"
              : "unknown";
        snapshot.cuda.validation = validation;
        return { snapshot, validation, changed: result.changed };
      } catch (error) {
        inspector.invalidate();
        throw new Error(accelerationInstallError(error), { cause: error });
      } finally {
        active = false;
      }
    }
  };
}
