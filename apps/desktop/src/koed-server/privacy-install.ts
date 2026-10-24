import { randomUUID } from "node:crypto";
import type { PrivacyInstallBridge } from "../cli-install/protocol.js";
const objectValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const resultOk = (value: unknown): boolean =>
  Boolean(value && typeof value === "object" && (value as { ok?: unknown }).ok);

const resultMessage = (value: unknown, fallback: string): string => {
  const result = objectValue(value);
  return (
    [result?.error, result?.message, result?.action].find(
      (part): part is string =>
        typeof part === "string" && part.trim().length > 0
    ) ?? fallback
  );
};

export function createPrivacyInstallBridge({
  productVersion,
  requestPrivacyRpc,
  stop,
  requestDaemonStart,
  pollUntilReady,
  activatePrivacyGeneration
}: {
  productVersion?: string;
  requestPrivacyRpc: <T>(
    action: string,
    args?: Record<string, unknown>,
    onProgress?: (event: Record<string, unknown>) => void
  ) => Promise<T>;
  stop: () => Promise<unknown>;
  requestDaemonStart: () => Promise<unknown>;
  pollUntilReady: (attempts: number) => Promise<unknown>;
  activatePrivacyGeneration: (id: string) => Promise<void>;
}): PrivacyInstallBridge {
  let activePrivacyRequestId: string | null = null;
  let cancelActivePrivacyRequest: (() => void) | null = null;
  return {
    getStatus: async () => {
      const result = await requestPrivacyRpc<Record<string, unknown>>("status");
      if (result.requiredManifestPinsAvailable === false)
        return {
          available: false,
          state: "unavailable",
          message:
            "Required component manifest pins are unavailable in this Desktop release for this runtime. Update to a compatible control plane; no component can be installed until then."
        };
      const components = objectValue(result.components);
      const componentState = components?.privacy;
      const required =
        Array.isArray(result.required) && result.required.includes("privacy");
      if (!required)
        return {
          available: false,
          state: "unavailable",
          message:
            "Privacy Filter is not required by current runtime configuration."
        };
      if (componentState === "active")
        return {
          available: true,
          state: "ready",
          message: "Privacy Filter assets are installed and active."
        };
      if (componentState === "staged")
        return {
          available: true,
          state: "not_installed",
          message: "Privacy Filter assets are staged and ready to activate."
        };
      return {
        available: true,
        state: "not_installed",
        message: "Privacy Filter assets are not installed."
      };
    },
    installPrivacy: async ({ consent, offlineSource, onProgress }) => {
      if (activePrivacyRequestId)
        throw new Error("A Privacy installation is already active.");
      if (consent !== true)
        throw new Error(
          "Explicit consent is required to install Privacy Filter assets."
        );
      if (
        !productVersion ||
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(productVersion)
      )
        throw new Error(
          "Desktop release version is unavailable; update Koed Desktop before installing Privacy Filter assets."
        );
      const requestId = randomUUID();
      const version = productVersion;
      const platform =
        process.platform === "darwin" ? "macos" : process.platform;
      const architecture =
        process.arch === "arm64"
          ? "arm64"
          : process.arch === "x64"
            ? "x64"
            : "unsupported";
      if (
        (platform !== "macos" && platform !== "linux") ||
        architecture === "unsupported"
      )
        throw new Error(
          "Privacy Filter assets are unavailable for this Desktop target."
        );
      const archive = `koed-privacy-${version}-${platform}-${architecture}.tar.gz`;
      const origin = `https://github.com/koed-labs/koed/releases/download/v${version}`;
      activePrivacyRequestId = requestId;
      let cancelRequested = false;
      cancelActivePrivacyRequest = () => {
        cancelRequested = true;
      };
      const source = offlineSource
        ? { kind: "offline", ...offlineSource }
        : {
            kind: "remote",
            archiveUrl: `${origin}/${archive}`,
            manifestUrl: `${origin}/${archive}.manifest.json`
          };
      try {
        const before =
          await requestPrivacyRpc<Record<string, unknown>>("status");
        if (cancelRequested)
          throw new Error("Privacy Filter installation cancelled.");
        const result = await requestPrivacyRpc<{
          state: string;
          generationId: string;
        }>("install", { requestId, source, version }, (event) =>
          onProgress({
            requestId,
            stage: String(event.phase ?? "install"),
            message: String(
              event.message ??
                event.phase ??
                "Installing Privacy Filter assets…"
            ),
            completedBytes:
              typeof event.transferredBytes === "number"
                ? event.transferredBytes
                : null,
            totalBytes:
              typeof event.totalBytes === "number" ? event.totalBytes : null
          })
        );
        if (cancelRequested)
          throw new Error("Privacy Filter installation cancelled.");
        if (result.state === "active")
          return {
            available: true,
            state: "ready",
            message: "Privacy Filter assets installed."
          };
        const oldGeneration =
          typeof before.activeGeneration === "string"
            ? before.activeGeneration
            : null;
        if (!oldGeneration)
          throw new Error(
            "Cannot safely activate Privacy Filter assets because the current runtime generation is unavailable for rollback. Koed was not stopped."
          );
        activePrivacyRequestId = null;
        cancelActivePrivacyRequest = null;
        onProgress({
          requestId,
          stage: "activation",
          message: "Stopping Koed to activate verified Privacy Filter assets.",
          completedBytes: null,
          totalBytes: null
        });
        const stopped = await stop();
        if (!resultOk(stopped))
          throw new Error(
            resultMessage(
              stopped,
              "Could not stop Koed to activate Privacy Filter assets."
            )
          );
        try {
          await activatePrivacyGeneration(result.generationId);
          onProgress({
            requestId,
            stage: "restart",
            message: "Restarting Koed with Privacy Filter assets.",
            completedBytes: null,
            totalBytes: null
          });
          const started = await requestDaemonStart();
          if (!resultOk(started))
            throw new Error(
              resultMessage(
                started,
                "Koed could not restart with Privacy Filter assets."
              )
            );
          await pollUntilReady(60);
          return {
            available: true,
            state: "ready",
            message: "Privacy Filter assets installed and activated."
          };
        } catch (error) {
          const originalMessage =
            error instanceof Error ? error.message : String(error);
          const rollbackStop = await stop();
          if (!resultOk(rollbackStop))
            throw new Error(
              `${originalMessage} Previous runtime rollback could not confirm Koed stopped; no runtime restart was attempted.`,
              { cause: error }
            );
          try {
            await activatePrivacyGeneration(oldGeneration);
          } catch (rollbackError) {
            throw new Error(
              `${originalMessage} Previous runtime generation could not be restored: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}. Koed remains stopped.`,
              { cause: rollbackError }
            );
          }
          const restored = await requestDaemonStart();
          if (!resultOk(restored))
            throw new Error(
              `${originalMessage} Previous runtime generation was restored but Koed could not restart: ${resultMessage(restored, "restart failed")}`,
              { cause: error }
            );
          try {
            await pollUntilReady(60);
          } catch (restartError) {
            throw new Error(
              `${originalMessage} Previous runtime generation was restored but Koed did not become ready: ${restartError instanceof Error ? restartError.message : String(restartError)}`,
              { cause: restartError }
            );
          }
          throw error;
        }
      } finally {
        if (activePrivacyRequestId === requestId) {
          activePrivacyRequestId = null;
          cancelActivePrivacyRequest = null;
        }
      }
    },
    cancel: async () => {
      if (!activePrivacyRequestId) return;
      cancelActivePrivacyRequest?.();
      await requestPrivacyRpc("cancel", { requestId: activePrivacyRequestId });
    },
    selectOffline: async () => null
  };
}
