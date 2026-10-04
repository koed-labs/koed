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
    | "listAiClientInstances"
    | "listCurrentAiClientCapabilitySnapshots"
    | "listDeviceCredentials"
  >,
  execution: ManagedConversationExecutionRecord,
  runner: { deviceId: string; deploymentId: string }
): Promise<void> {
  const [instances, snapshots] = await Promise.all([
    repository.listAiClientInstances({ userId: execution.ownerUserId }),
    repository.listCurrentAiClientCapabilitySnapshots({
      userId: execution.ownerUserId
    })
  ]);
  const runnerMatchesExecution =
    execution.runnerDeviceId === runner.deviceId &&
    execution.runnerDeploymentId === runner.deploymentId;
  const candidates = runnerMatchesExecution
    ? instances.filter(
        (item) =>
          item.instanceId === execution.aiClientInstanceId &&
          item.driverId === execution.provider
      )
    : [];
  let matchingInstances = candidates;
  if (candidates.length > 1) {
    const credentials = await repository.listDeviceCredentials({
      userId: execution.ownerUserId
    });
    matchingInstances = candidates.filter((candidate) => {
      if (candidate.sourceDeviceCredentialId === null) return true;
      const credential = credentials.find(
        (item) => item.id === candidate.sourceDeviceCredentialId
      );
      return (
        credential?.deviceInstanceId === runner.deviceId &&
        credential.metadata.protocolDeploymentId === runner.deploymentId &&
        credential.revokedAt === null &&
        (credential.expiresAt === null ||
          Date.parse(credential.expiresAt) > Date.now())
      );
    });
  }
  const instance = matchingInstances.length === 1 ? matchingInstances[0] : null;
  const matchingSnapshots = instance
    ? snapshots.filter(
        (item) =>
          item.instanceId === execution.aiClientInstanceId &&
          item.hostedInstanceId === instance.hostedInstanceId
      )
    : [];
  const snapshot = matchingSnapshots.length === 1 ? matchingSnapshots[0] : null;
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
