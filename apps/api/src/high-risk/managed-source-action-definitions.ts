import type { MemorySourceRepository } from "@koed/db";
import {
  calculateConversationSourceDownloadRequestHash,
  calculateConversationSourceDownloadScopeHash,
  calculateConversationSourceDiscoveryRequestHash,
  calculateConversationSourceDiscoveryScopeHash,
  type CollaborationApprovalReview
} from "@koed/shared";

import type { ActionApprovalPolicy } from "./approval-policy.js";
import {
  reviewedAction,
  unavailableAction
} from "./action-definition-support.js";
import {
  managedConversationTransferRequestHash,
  managedConversationTransferScopeHash,
  type HighRiskActionGrantIntent,
  type HighRiskResolvedActionGrantOperation
} from "./action-grant-protocol.js";

type ManagedSourceAction =
  | "conversation_source.discover"
  | "conversation_source.download"
  | "managed_conversation.handoff"
  | "managed_conversation.fork";

type ManagedSourceIntent = Extract<
  HighRiskActionGrantIntent,
  { action: ManagedSourceAction }
>;

type ManagedSourceRepository = Pick<
  MemorySourceRepository,
  | "getConversationSourceArtifactByGeneration"
  | "getManagedConversationExecution"
  | "listDeviceCredentials"
>;

interface ManagedSourceAdmissionInput {
  repository: ManagedSourceRepository;
  userId: string;
  upstreamBackendId?: string;
  currentDeviceInstanceId?: string;
  intent: HighRiskActionGrantIntent;
}

const TARGET_ESTABLISHMENT_MS = 24 * 60 * 60 * 1_000;

const unavailable = (context: string): never =>
  unavailableAction(
    `${context} requires complete current execution and enrolled device context`
  );

const reviewed = (
  disposition: "native_review" | "step_up",
  review: Omit<CollaborationApprovalReview, "version">
): ActionApprovalPolicy => reviewedAction(disposition, review);

export const bindConversationSourceDiscoveryOperation = (
  intent: Extract<
    ManagedSourceIntent,
    { action: "conversation_source.discover" }
  >
): HighRiskResolvedActionGrantOperation => ({
  operationFamily: "source_download",
  action: intent.action,
  teamId: null,
  targetId: null,
  method: "POST",
  path: "/v1/conversation-source-replication/sources/discover",
  body: intent.body,
  scopeHash: calculateConversationSourceDiscoveryScopeHash(),
  requestHash: calculateConversationSourceDiscoveryRequestHash(intent.body)
});

export const bindConversationSourceDownloadOperation = (
  intent: Extract<
    ManagedSourceIntent,
    { action: "conversation_source.download" }
  >,
  artifactId: string
): HighRiskResolvedActionGrantOperation => ({
  operationFamily: "source_download",
  action: intent.action,
  teamId: null,
  targetId: artifactId,
  method: "POST",
  path: "/v1/conversation-source-replication/download-authorizations",
  body: {
    sourceGenerationId: intent.sourceGenerationId,
    sourceComponentId: intent.sourceComponentId,
    targetDeploymentId: intent.targetDeploymentId,
    firstSegmentIndex: intent.firstSegmentIndex,
    recipientKey: intent.recipientKey
  },
  scopeHash: calculateConversationSourceDownloadScopeHash({
    sourceGenerationId: intent.sourceGenerationId,
    sourceComponentId: intent.sourceComponentId,
    targetDeploymentId: intent.targetDeploymentId,
    recipientKey: intent.recipientKey
  }),
  requestHash: calculateConversationSourceDownloadRequestHash({
    sourceGenerationId: intent.sourceGenerationId,
    sourceComponentId: intent.sourceComponentId,
    targetDeploymentId: intent.targetDeploymentId,
    firstSegmentIndex: intent.firstSegmentIndex,
    recipientKey: intent.recipientKey
  })
});

export const bindManagedConversationTransferOperation = (
  intent: Extract<
    ManagedSourceIntent,
    { action: "managed_conversation.handoff" | "managed_conversation.fork" }
  >
): HighRiskResolvedActionGrantOperation => {
  const path = `/v1/managed-conversations/${intent.executionId}/${
    intent.action === "managed_conversation.handoff" ? "handoffs" : "forks"
  }`;
  return {
    operationFamily: "managed_execution",
    action: intent.action,
    teamId: null,
    targetId: intent.executionId,
    method: "POST",
    path,
    body: intent.body,
    scopeHash: managedConversationTransferScopeHash({
      action: intent.action,
      executionId: intent.executionId
    }),
    requestHash: managedConversationTransferRequestHash({
      method: "POST",
      path,
      body: intent.body
    })
  };
};

const sourceDiscoveryDefinition = {
  operationFamily: "source_download" as const,
  admit(input: ManagedSourceAdmissionInput) {
    if (input.intent.action !== "conversation_source.discover") {
      return Promise.resolve(null);
    }
    if (!input.upstreamBackendId || !input.currentDeviceInstanceId) {
      unavailable("Conversation source discovery");
    }
    return Promise.resolve({
      operation: bindConversationSourceDiscoveryOperation(input.intent),
      policy: { disposition: "direct" as const, review: null }
    });
  }
};

const sourceDownloadDefinition = {
  operationFamily: "source_download" as const,
  async admit(input: ManagedSourceAdmissionInput) {
    if (input.intent.action !== "conversation_source.download") {
      return null;
    }
    if (!input.upstreamBackendId || !input.currentDeviceInstanceId) {
      unavailable("Conversation source download");
    }
    const artifact =
      await input.repository.getConversationSourceArtifactByGeneration(
        { userId: input.userId },
        input.intent.sourceGenerationId,
        input.intent.sourceComponentId
      );
    if (!artifact) return null;
    return {
      operation: bindConversationSourceDownloadOperation(
        input.intent,
        artifact.id
      ),
      policy: reviewed("step_up", {
        title: "Download a conversation source?",
        description:
          "This standalone source download is not attached to a reviewed handoff, fork, restore, or sync decision.",
        consequence:
          "Approving authorizes only the exact source generation and component, target deployment, segment boundary, and recipient key.",
        confirmLabel: "Authorize download",
        details: [
          {
            label: "Source generation",
            value: input.intent.sourceGenerationId
          },
          {
            label: "Source component",
            value: input.intent.sourceComponentId
          },
          {
            label: "Target deployment",
            value: input.intent.targetDeploymentId
          },
          {
            label: "First segment",
            value: String(input.intent.firstSegmentIndex)
          }
        ]
      })
    };
  }
};

const managedTransferDefinition = {
  operationFamily: "managed_execution" as const,
  async admit(input: ManagedSourceAdmissionInput) {
    if (
      input.intent.action !== "managed_conversation.handoff" &&
      input.intent.action !== "managed_conversation.fork"
    ) {
      return null;
    }
    const intent = input.intent;
    if (!input.upstreamBackendId || !input.currentDeviceInstanceId) {
      unavailable("Managed Conversation transfer");
    }
    const upstreamBackendId = input.upstreamBackendId;
    const currentDeviceInstanceId = input.currentDeviceInstanceId;
    const execution = await input.repository.getManagedConversationExecution(
      { userId: input.userId },
      intent.executionId
    );
    if (!execution) {
      return unavailable("Managed Conversation transfer");
    }
    const credentials = await input.repository.listDeviceCredentials(
      { userId: input.userId },
      { upstreamBackendId }
    );
    const active = credentials.filter(
      (credential) =>
        credential.revokedAt === null &&
        (credential.expiresAt === null ||
          Date.parse(credential.expiresAt) > Date.now()) &&
        credential.operationFamilies.includes("sync") &&
        credential.operationFamilies.includes("managed_execution")
    );
    const targets = active.filter(
      (credential) => credential.deviceInstanceId === intent.body.targetDeviceId
    );
    const targetDeployments = new Set(
      targets.map((credential) => credential.metadata.protocolDeploymentId)
    );
    const targetUnambiguous =
      targetDeployments.size === 1 &&
      typeof [...targetDeployments][0] === "string";
    const target = targets.reduce<(typeof targets)[number] | null>(
      (oldest, candidate) =>
        !oldest ||
        Date.parse(candidate.createdAt) < Date.parse(oldest.createdAt)
          ? candidate
          : oldest,
      null
    );
    const current = active.find(
      (credential) => credential.deviceInstanceId === execution.runnerDeviceId
    );
    const targetTrusted =
      execution.state === "running" &&
      execution.runnerDeviceId === currentDeviceInstanceId &&
      execution.runnerDeviceId !== intent.body.targetDeviceId &&
      targetUnambiguous &&
      target !== null &&
      Date.parse(target.createdAt) <= Date.now() - TARGET_ESTABLISHMENT_MS;
    const handoff = intent.action === "managed_conversation.handoff";
    return {
      operation: bindManagedConversationTransferOperation(intent),
      policy: reviewed(targetTrusted ? "native_review" : "step_up", {
        title: handoff
          ? "Move this Conversation to another Personal Device?"
          : "Fork this Conversation on another Personal Device?",
        description: handoff
          ? "Review the current and target devices and the verified handoff boundary."
          : "Review both devices and the new independent Conversation lineage.",
        consequence: handoff
          ? "The current device stops writing after the verified handoff boundary."
          : "The original Conversation continues independently on the current device.",
        confirmLabel: handoff ? "Move Conversation" : "Fork Conversation",
        details: [
          {
            label: "Current device",
            value: current?.deviceLabel?.trim() || execution.runnerDeviceId
          },
          {
            label: "Target device",
            value: target?.deviceLabel?.trim() || intent.body.targetDeviceId
          },
          {
            label: "Target trust",
            value: targetTrusted
              ? "Enrolled and established"
              : "New or unverified — Step-up required"
          }
        ]
      })
    };
  }
};

export const managedSourceActionDefinitions = {
  "conversation_source.discover": sourceDiscoveryDefinition,
  "conversation_source.download": sourceDownloadDefinition,
  "managed_conversation.handoff": managedTransferDefinition,
  "managed_conversation.fork": managedTransferDefinition
};
