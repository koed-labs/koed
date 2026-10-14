import type { PersonalAgentChatLaunchSnapshot } from "@koed/shared/personal-agent-chat-contract";
import type { ChatComposerSelection } from "@/components/ChatComposer";

export type PersonalChatLaunchInstance = {
  instanceId: string;
  hostedInstanceId?: string;
  driverId: string;
  runnerDeviceId?: string;
  ready?: boolean;
  permissionModes: readonly string[];
  models: readonly {
    id: string;
    supportedReasoningEfforts: readonly string[];
  }[];
};

type AgentIdentity = { id: string; currentVersion: number; lifecycle: string };

/** One launch contract for local and hosted Personal chat controllers. */
export function resolvePersonalChatRecipients(
  selection: ChatComposerSelection,
  instances: readonly PersonalChatLaunchInstance[],
  agents: readonly AgentIdentity[]
): PersonalAgentChatLaunchSnapshot[] {
  const requested = selection.recipients?.length
    ? selection.recipients
    : [selection];
  const recipients = requested.map(
    (recipient): PersonalAgentChatLaunchSnapshot => {
      if (!recipient.provider || !recipient.model)
        throw new Error(
          "Choose an available AI Client and model for each recipient."
        );
      if (recipient.permissionMode === "read")
        throw new Error(
          "Read-only access is not available for managed Personal chat."
        );
      const permissionMode =
        recipient.permissionMode === "ask" ? "supervised" : "full_access";
      const matching = instances.filter(
        (instance) =>
          instance.ready !== false &&
          instance.driverId === recipient.provider &&
          (!recipient.instanceId ||
            instance.instanceId === recipient.instanceId) &&
          (!recipient.hostedInstanceId ||
            instance.hostedInstanceId === recipient.hostedInstanceId) &&
          instance.models.some((model) => model.id === recipient.model)
      );
      if (matching.length !== 1)
        throw new Error(
          "A selected AI Client or model is unavailable or ambiguous. Refresh launch options and choose it again."
        );
      const instance = matching[0]!;
      if (!instance.runnerDeviceId)
        throw new Error(
          "The selected AI Client has no verified Personal Device. Refresh its launch options before sending."
        );
      if (!instance.permissionModes.includes(permissionMode))
        throw new Error(
          "The selected AI Client does not support this permission mode."
        );
      const model = instance.models.find(
        (candidate) => candidate.id === recipient.model
      )!;
      const reasoningEffort = recipient.effort || null;
      if (
        reasoningEffort &&
        !model.supportedReasoningEfforts.includes(reasoningEffort)
      )
        throw new Error(
          "The selected reasoning effort is unavailable for this model. Choose it again."
        );
      const common = {
        provider: instance.driverId,
        aiClientInstanceId: instance.hostedInstanceId ?? instance.instanceId,
        targetDeviceId: instance.runnerDeviceId,
        model: recipient.model,
        reasoningEffort,
        permissionMode: permissionMode as "supervised" | "full_access",
        selectedResourceIds: [...(recipient.selectedResourceIds ?? [])],
        ...(recipient.selectedResourceIds?.length
          ? {
              selectedResourceHostedInstanceId:
                ("selectedResourceHostedInstanceId" in recipient
                  ? recipient.selectedResourceHostedInstanceId
                  : undefined) ?? recipient.hostedInstanceId
            }
          : {})
      };
      if (recipient.agentId) {
        const agent = agents.find(
          (candidate) => candidate.id === recipient.agentId
        );
        if (!agent || agent.lifecycle !== "active")
          throw new Error("A selected Agent is unavailable or retired.");
        return {
          kind: "agent",
          agentId: agent.id,
          agentVersion: recipient.expectedAgentVersion ?? agent.currentVersion,
          ...common
        };
      }
      return { kind: "generic", agentId: null, agentVersion: null, ...common };
    }
  );
  if (
    recipients.some(
      (recipient) => recipient.targetDeviceId !== recipients[0]?.targetDeviceId
    )
  )
    throw new Error("All Agents in a batch must use the same Personal Device.");
  return recipients;
}
