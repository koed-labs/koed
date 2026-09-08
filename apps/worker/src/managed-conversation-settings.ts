import type {
  MemorySourceRepository,
  ManagedConversationExecutionRecord
} from "@koed/db";
import {
  aiClientPermissionContractFor,
  isSupportedAiClientDriverId
} from "@koed/shared/ai-client-contract";

/** Revalidate at dispatch: a queued turn must not outlive its capability evidence. */
export async function assertManagedConversationTurnSettings(
  repository: Pick<
    MemorySourceRepository,
    "listAiClientInstances" | "listCurrentAiClientCapabilitySnapshots"
  >,
  execution: ManagedConversationExecutionRecord
): Promise<void> {
  const [instances, snapshots] = await Promise.all([
    repository.listAiClientInstances({ userId: execution.ownerUserId }),
    repository.listCurrentAiClientCapabilitySnapshots({
      userId: execution.ownerUserId
    })
  ]);
  const instance = instances.find(
    (item) => item.instanceId === execution.aiClientInstanceId
  );
  const snapshot = snapshots.find(
    (item) => item.instanceId === execution.aiClientInstanceId
  );
  const descriptors = snapshot?.capabilities?.descriptors;
  const descriptor =
    descriptors && typeof descriptors === "object"
      ? (descriptors as Record<string, unknown>).managed_conversation_send
      : undefined;
  const model = snapshot?.models.find((item) => item.id === execution.model);
  const efforts = model?.supportedReasoningEfforts;
  if (
    !isSupportedAiClientDriverId(execution.provider) ||
    !instance?.enabled ||
    instance.driverId !== execution.provider ||
    !instance.configIdentityHash ||
    snapshot?.installationIdentityHash !== instance.configIdentityHash ||
    snapshot.authenticationState !== "authenticated" ||
    snapshot.healthState !== "healthy" ||
    !(Date.parse(snapshot.expiresAt) > Date.now()) ||
    !descriptor ||
    typeof descriptor !== "object" ||
    (descriptor as Record<string, unknown>).support !== "supported" ||
    (descriptor as Record<string, unknown>).readiness !== "ready" ||
    !model ||
    (execution.reasoningEffort !== null &&
      (!Array.isArray(efforts) ||
        !efforts.includes(execution.reasoningEffort))) ||
    !aiClientPermissionContractFor(execution.provider).permissionModes.some(
      (mode) =>
        mode.mode === execution.permissionMode && mode.support === "supported"
    )
  ) {
    throw Object.assign(
      new Error(
        "Selected Conversation settings are unavailable for this AI Client."
      ),
      { name: "ManagedConversationSettingsUnavailableError" }
    );
  }
}
