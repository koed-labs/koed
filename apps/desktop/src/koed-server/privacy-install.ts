import { randomUUID } from "node:crypto";
import type {
  PrivacyInstallBridge,
  PrivacyInstallStatus
} from "../cli-install/protocol.js";

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const resultOk = (value: unknown): boolean => objectValue(value)?.ok === true;
const resultMessage = (value: unknown, fallback: string): string => {
  const result = objectValue(value);
  return (
    [result?.error, result?.message, result?.action].find(
      (part): part is string =>
        typeof part === "string" && part.trim().length > 0
    ) ?? fallback
  );
};

export const privacyInstallStatus = (
  result: Record<string, unknown>
): PrivacyInstallStatus => {
  if (result.requiredManifestPinsAvailable === false)
    return {
      available: false,
      state: "unavailable",
      message:
        "Required component manifest pins are unavailable in this Desktop release. Update to a compatible Koed release before installing Privacy Filter."
    };
  if (!Array.isArray(result.required) || !result.required.includes("privacy"))
    return {
      available: false,
      state: "unavailable",
      message:
        "Privacy Filter is not required by current runtime configuration."
    };
  const component = objectValue(result.components)?.privacy;
  const model = objectValue(result.model);
  const service = objectValue(result.service);
  const verification = objectValue(result.verification);
  const compatibility = objectValue(result.compatibility);
  const details: Partial<PrivacyInstallStatus> = {
    downloadBytes: null,
    ...(result.variant === "cpu" || result.variant === "cuda"
      ? { bundleVariant: result.variant }
      : {}),
    ...(typeof objectValue(service?.details)?.activeProvider === "string"
      ? {
          activeProvider: String(objectValue(service?.details)?.activeProvider)
        }
      : {}),
    ...(compatibility && typeof compatibility.reason === "string"
      ? {
          compatibility: {
            compatible: compatibility.compatible === true,
            reason: compatibility.reason
          }
        }
      : {}),
    ...(typeof objectValue(service?.details)?.fallbackReason === "string"
      ? {
          fallbackReason: String(objectValue(service?.details)?.fallbackReason)
        }
      : typeof verification?.fallbackReason === "string"
        ? { fallbackReason: verification.fallbackReason }
        : {})
  };
  if (!["active", "installed", "staged"].includes(String(component)))
    return {
      ...details,
      available: true,
      state: "not_installed",
      installationState: "missing_runtime",
      message: "Privacy Filter runtime is missing or incompatible."
    };
  if (model?.ok !== true)
    return {
      ...details,
      available: true,
      state: model?.state === "checksum_mismatch" ? "failed" : "not_installed",
      installationState:
        model?.state === "checksum_mismatch" ? "failed" : "missing_model",
      message:
        typeof model?.message === "string"
          ? model.message
          : "The pinned Privacy Filter model is missing."
    };
  if (component !== "active")
    return {
      ...details,
      available: true,
      state: "not_installed",
      installationState: "staged",
      message:
        "Privacy Filter files are verified. Finish installation to verify filtering and activate the service."
    };
  if (service?.state !== "healthy")
    return {
      ...details,
      available: true,
      state: "not_installed",
      installationState: "starting",
      message:
        "Privacy Filter assets are verified. Start or repair Koed to complete service readiness."
    };
  return {
    ...details,
    available: true,
    state: "ready",
    installationState: "ready",
    message: "Privacy Filter is verified and ready for Team sharing."
  };
};

const stageMessage = (stage: string): string => {
  if (stage === "compatibility")
    return "Checking which Privacy runtime is compatible with this device.";
  if (stage === "runtime-cache") return "Reusing the verified Privacy runtime.";
  if (stage === "model-download")
    return "Downloading the pinned Privacy Filter model.";
  if (stage === "model-verify")
    return "Checking the downloaded Privacy Filter model.";
  if (stage === "inference")
    return "Checking that Privacy filtering works on this device.";
  if (stage === "cpu-fallback")
    return "CUDA was unavailable. CPU filtering passed verification.";
  if (/verify|extract/.test(stage))
    return "Checking the downloaded Privacy runtime.";
  return "Downloading the Privacy Filter runtime.";
};

export function createPrivacyInstallBridge({
  productVersion,
  unavailableStatus,
  requestPrivacyRpc,
  stop,
  requestDaemonStart,
  pollUntilReady,
  activatePrivacyGeneration,
  canStartServices = async () => true
}: {
  productVersion?: string;
  unavailableStatus?: PrivacyInstallStatus;
  requestPrivacyRpc: <T>(
    action: string,
    args?: Record<string, unknown>,
    onProgress?: (event: Record<string, unknown>) => void
  ) => Promise<T>;
  stop: () => Promise<unknown>;
  requestDaemonStart: () => Promise<unknown>;
  pollUntilReady: (attempts: number) => Promise<unknown>;
  activatePrivacyGeneration: (
    id: string,
    expectedCurrentGeneration: string | null
  ) => Promise<void>;
  canStartServices?: () => Promise<boolean>;
}): PrivacyInstallBridge {
  let activeRequestId: string | null = null;
  let cancelRequested = false;
  let activationStarted = false;
  const currentStatus = async () =>
    privacyInstallStatus(
      await requestPrivacyRpc<Record<string, unknown>>("status")
    );
  const checkCancelled = () => {
    if (cancelRequested)
      throw new Error("Privacy Filter installation cancelled.");
  };
  const requireReady = async (generationId: string) => {
    const result = await pollUntilReady(60);
    if (!resultOk(result))
      throw new Error(
        resultMessage(
          result,
          "Koed did not become ready after Privacy installation."
        )
      );
    const current = await requestPrivacyRpc<Record<string, unknown>>("status");
    if (current.activeGeneration !== generationId)
      throw new Error(
        "Runtime selection changed before Privacy service readiness completed."
      );
    const status = privacyInstallStatus(current);
    if (status.state !== "ready") throw new Error(status.message);
    return status;
  };
  return {
    getStatus: async () => {
      if (unavailableStatus) return unavailableStatus;
      if (activeRequestId)
        return {
          available: true,
          state: "installing",
          message: activationStarted
            ? "Activating Privacy Filter. This step must finish or recover."
            : "Installing the Privacy runtime and model."
        };
      return currentStatus();
    },
    installPrivacy: async ({ consent, offlineSource, onProgress }) => {
      if (unavailableStatus) throw new Error(unavailableStatus.message);
      if (activeRequestId)
        throw new Error("A Privacy installation is already active.");
      if (consent !== true)
        throw new Error(
          "Explicit consent is required to install the Privacy runtime and model."
        );
      if (
        !productVersion ||
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(productVersion)
      )
        throw new Error(
          "Desktop release version is unavailable. Update Koed Desktop before installing Privacy Filter."
        );
      const requestId = randomUUID();
      activeRequestId = requestId;
      cancelRequested = false;
      activationStarted = false;
      try {
        const before =
          await requestPrivacyRpc<Record<string, unknown>>("status");
        const availability = privacyInstallStatus(before);
        if (!availability.available) throw new Error(availability.message);
        checkCancelled();
        const compatibility =
          await requestPrivacyRpc<Record<string, unknown>>("prepare");
        checkCancelled();
        if (
          compatibility.target !== "macos-arm64" &&
          compatibility.target !== "linux-x64"
        )
          throw new Error(
            "Privacy Filter assets are unavailable for this device target."
          );
        const variant = compatibility.variant;
        if (
          compatibility.target === "linux-x64" &&
          variant !== "cpu" &&
          variant !== "cuda"
        )
          throw new Error(
            "Privacy runtime compatibility could not select an authenticated variant."
          );
        if (compatibility.target === "macos-arm64" && variant !== undefined)
          throw new Error("Unexpected macOS Privacy variant.");
        const platform =
          compatibility.target === "macos-arm64" ? "macos" : "linux";
        const architecture = platform === "macos" ? "arm64" : "x64";
        const archive = `koed-privacy-${productVersion}-${platform}-${architecture}${variant ? `-${variant}` : ""}.tar.gz`;
        const origin = `https://github.com/koed-labs/koed/releases/download/v${productVersion}`;
        const source = offlineSource
          ? { kind: "offline", ...offlineSource }
          : {
              kind: "remote",
              archiveUrl: `${origin}/${archive}`,
              manifestUrl: `${origin}/${archive}.manifest.json`
            };
        const result = await requestPrivacyRpc<{
          state: string;
          generationId: string;
        }>(
          "install",
          {
            requestId,
            source,
            version: productVersion,
            ...(variant ? { variant } : {})
          },
          (event) => {
            const stage = String(event.phase ?? "runtime-download");
            onProgress({
              requestId,
              stage,
              message: stageMessage(stage),
              completedBytes:
                typeof event.transferredBytes === "number"
                  ? event.transferredBytes
                  : null,
              totalBytes:
                typeof event.totalBytes === "number" ? event.totalBytes : null,
              cancellable: true
            });
          }
        );
        checkCancelled();
        if (
          result.state !== "staged" ||
          typeof result.generationId !== "string"
        )
          throw new Error(
            "Privacy installation did not stage a complete verified runtime and model."
          );
        const expectedGeneration =
          typeof before.activeGeneration === "string"
            ? before.activeGeneration
            : null;
        const oldGeneration =
          expectedGeneration ??
          (typeof compatibility.recoveryGenerationId === "string"
            ? compatibility.recoveryGenerationId
            : null);
        if (!oldGeneration)
          throw new Error(
            "The current runtime generation is unavailable for recovery. Koed was not stopped."
          );
        const coreReady = await canStartServices();
        checkCancelled();
        if (!coreReady && before.running === true)
          return {
            available: true,
            state: "not_installed",
            installationState: "staged",
            message:
              "Privacy runtime and model are verified. Complete the remaining Koed runtime and embedding setup before activation."
          };
        activationStarted = true;
        onProgress({
          requestId,
          stage: "activation",
          message:
            "Activating verified Privacy assets. Cancellation is no longer available; this step must finish or recover.",
          completedBytes: null,
          totalBytes: null,
          cancellable: false
        });
        const stopped = await stop();
        if (!resultOk(stopped))
          throw new Error(
            resultMessage(
              stopped,
              "Could not stop Koed to activate Privacy Filter assets."
            )
          );
        let activated = false;
        try {
          await activatePrivacyGeneration(
            result.generationId,
            expectedGeneration
          );
          activated = true;
          if (!coreReady)
            return {
              available: true,
              state: "not_installed",
              installationState: "starting",
              message:
                "Privacy runtime and model are verified and activated. Complete Koed setup to install any remaining storage or embedding assets and start filtering."
            };
          onProgress({
            requestId,
            stage: "restart",
            message:
              "Starting Koed with the verified Privacy runtime and model.",
            completedBytes: null,
            totalBytes: null,
            cancellable: false
          });
          const started = await requestDaemonStart();
          if (!resultOk(started))
            throw new Error(
              resultMessage(
                started,
                "Koed could not restart with Privacy Filter assets."
              )
            );
          return await requireReady(result.generationId);
        } catch (error) {
          // A rejected compare-and-swap did not activate our candidate. Do not
          // roll a newer selection back or stop another operation's services.
          if (!activated) throw error;
          const message =
            error instanceof Error ? error.message : String(error);
          if (!resultOk(await stop()))
            throw new Error(
              `${message} Recovery could not confirm Koed stopped; no generation replacement or restart was attempted.`,
              { cause: error }
            );
          try {
            await activatePrivacyGeneration(oldGeneration, result.generationId);
          } catch (recoveryError) {
            throw new Error(
              `${message} Previous runtime generation could not be restored: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}. Koed remains stopped.`,
              { cause: recoveryError }
            );
          }
          if (before.running === false)
            throw new Error(
              `${message} Previous runtime generation was restored. Koed remains stopped.`,
              { cause: error }
            );
          const restored = await requestDaemonStart();
          if (!resultOk(restored))
            throw new Error(
              `${message} Previous runtime generation was restored but Koed could not restart: ${resultMessage(restored, "restart failed")}`,
              { cause: error }
            );
          const ready = await pollUntilReady(60);
          if (!resultOk(ready))
            throw new Error(
              `${message} Previous runtime generation was restored but Koed did not become ready: ${resultMessage(ready, "readiness failed")}`,
              { cause: error }
            );
          throw error;
        }
      } finally {
        activeRequestId = null;
        cancelRequested = false;
        activationStarted = false;
      }
    },
    cancel: async () => {
      if (!activeRequestId || activationStarted) return;
      cancelRequested = true;
      await requestPrivacyRpc("cancel", { requestId: activeRequestId });
    },
    selectOffline: async () => null
  };
}
