import { randomUUID } from "node:crypto";
import {
  calculateConversationSourceDownloadRequestHash,
  calculateConversationSourceDownloadScopeHash,
  calculateConversationSourceDiscoveryRequestHash,
  calculateConversationSourceDiscoveryScopeHash
} from "@koed/shared";
import { describe, expect, it, vi } from "vitest";

import { admitHighRiskActionGrant } from "./action-definitions.js";
import { ActionApprovalPolicyError } from "./approval-policy.js";
import {
  managedConversationTransferRequestHash,
  managedConversationTransferScopeHash,
  type HighRiskActionGrantIntent
} from "./action-grant-protocol.js";

const ids = {
  actor: randomUUID(),
  execution: randomUUID(),
  currentDevice: randomUUID(),
  targetDevice: randomUUID(),
  backend: "backend-test",
  targetDeployment: randomUUID(),
  sourceGeneration: randomUUID(),
  sourceArtifact: randomUUID(),
  operation: randomUUID()
};

const execution = {
  id: ids.execution,
  state: "running",
  runnerDeviceId: ids.currentDevice
};

const credential = (input: {
  deviceInstanceId: string;
  deploymentId: string;
  createdAt: string;
  label: string;
}) => ({
  deviceInstanceId: input.deviceInstanceId,
  deviceLabel: input.label,
  createdAt: input.createdAt,
  revokedAt: null,
  expiresAt: null,
  operationFamilies: ["sync", "managed_execution"],
  metadata: { protocolDeploymentId: input.deploymentId }
});

const repository = (credentials: ReturnType<typeof credential>[] = []) => ({
  getConversationSourceArtifactByGeneration: vi.fn(async () => ({
    id: ids.sourceArtifact
  })),
  getManagedConversationExecution: vi.fn(async () => execution as never),
  listDeviceCredentials: vi.fn(async () => credentials as never)
});

const admit = (
  intent: HighRiskActionGrantIntent,
  repo = repository(),
  auth: { backend?: string; device?: string } = {}
) =>
  admitHighRiskActionGrant({
    repository: repo as never,
    userId: ids.actor,
    upstreamBackendId: auth.backend ?? ids.backend,
    currentDeviceInstanceId: auth.device ?? ids.currentDevice,
    clientRequestId: randomUUID(),
    hashSecret: (value) => value,
    intent
  });

const handoff = {
  action: "managed_conversation.handoff",
  executionId: ids.execution,
  body: { operationId: ids.operation, targetDeviceId: ids.targetDevice }
} as const satisfies HighRiskActionGrantIntent;

const recipientKey = {
  algorithm: "RSA-OAEP-SHA256" as const,
  keyId: randomUUID(),
  keyVersion: 1,
  publicJwk: {
    kty: "RSA" as const,
    n: "test-modulus",
    e: "AQAB",
    alg: "RSA-OAEP-256" as const,
    key_ops: ["encrypt"] as ["encrypt"],
    ext: true as const,
    kid: "source-download-recipient",
    use: "enc" as const
  }
};

describe("managed Conversation and source-transfer action definitions", () => {
  it("binds the exact running execution and gives an established target Native review", async () => {
    const createdAt = new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString();
    const repo = repository([
      credential({
        deviceInstanceId: ids.currentDevice,
        deploymentId: randomUUID(),
        createdAt,
        label: "Current Mac"
      }),
      credential({
        deviceInstanceId: ids.targetDevice,
        deploymentId: ids.targetDeployment,
        createdAt,
        label: "Travel Mac"
      })
    ]);
    const path = `/v1/managed-conversations/${ids.execution}/handoffs`;

    const admitted = await admit(handoff, repo);

    expect(admitted).toMatchObject({
      operation: {
        operationFamily: "managed_execution",
        action: handoff.action,
        targetId: ids.execution,
        path,
        body: handoff.body,
        scopeHash: managedConversationTransferScopeHash({
          action: handoff.action,
          executionId: ids.execution
        }),
        requestHash: managedConversationTransferRequestHash({
          method: "POST",
          path,
          body: handoff.body
        })
      },
      policy: {
        disposition: "native_review",
        review: {
          details: expect.arrayContaining([
            { label: "Current device", value: "Current Mac" },
            { label: "Target device", value: "Travel Mac" },
            { label: "Target trust", value: "Enrolled and established" }
          ])
        }
      }
    });
  });

  it("keeps new, unverified, or ambiguous targets on Step-up", async () => {
    await expect(admit(handoff)).resolves.toMatchObject({
      policy: { disposition: "step_up" }
    });
    const createdAt = new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString();
    const ambiguous = repository([
      credential({
        deviceInstanceId: ids.targetDevice,
        deploymentId: randomUUID(),
        createdAt,
        label: "Target A"
      }),
      credential({
        deviceInstanceId: ids.targetDevice,
        deploymentId: randomUUID(),
        createdAt,
        label: "Target B"
      })
    ]);

    await expect(admit(handoff, ambiguous)).resolves.toMatchObject({
      policy: { disposition: "step_up" }
    });
  });

  it("fails closed for missing execution and steps up stale, wrong-runner, or same-device context", async () => {
    const missing = repository();
    missing.getManagedConversationExecution.mockResolvedValueOnce(
      null as never
    );
    await expect(admit(handoff, missing)).rejects.toBeInstanceOf(
      ActionApprovalPolicyError
    );
    for (const value of [
      { ...execution, state: "stopped" },
      { ...execution, runnerDeviceId: randomUUID() }
    ]) {
      const repo = repository();
      repo.getManagedConversationExecution.mockResolvedValueOnce(
        value as never
      );
      await expect(admit(handoff, repo)).resolves.toMatchObject({
        policy: { disposition: "step_up" }
      });
    }
    const sameDevice = {
      ...handoff,
      body: { ...handoff.body, targetDeviceId: ids.currentDevice }
    } as const;
    await expect(admit(sameDevice)).resolves.toMatchObject({
      policy: { disposition: "step_up" }
    });
  });

  it("keeps discovery Direct only inside authenticated enrolled-device context", async () => {
    const intent = {
      action: "conversation_source.discover",
      body: { cursor: null, limit: 50 }
    } as const satisfies HighRiskActionGrantIntent;

    await expect(admit(intent)).resolves.toEqual({
      operation: {
        operationFamily: "source_download",
        action: intent.action,
        teamId: null,
        targetId: null,
        method: "POST",
        path: "/v1/conversation-source-replication/sources/discover",
        body: intent.body,
        scopeHash: calculateConversationSourceDiscoveryScopeHash(),
        requestHash: calculateConversationSourceDiscoveryRequestHash(
          intent.body
        )
      },
      policy: { disposition: "direct", review: null }
    });
    expect(() =>
      admit(intent, repository(), { backend: "", device: "" })
    ).toThrow(ActionApprovalPolicyError);
  });

  it("keeps standalone download Step-up with exact source, target, segment, and recipient key", async () => {
    const intent = {
      action: "conversation_source.download",
      sourceGenerationId: ids.sourceGeneration,
      sourceComponentId: "agent.researcher",
      targetDeploymentId: ids.targetDeployment,
      firstSegmentIndex: 3,
      recipientKey
    } as const satisfies HighRiskActionGrantIntent;

    const repo = repository();
    const admitted = await admit(intent, repo);

    expect(admitted).toMatchObject({
      operation: {
        operationFamily: "source_download",
        targetId: ids.sourceArtifact,
        scopeHash: calculateConversationSourceDownloadScopeHash({
          sourceGenerationId: ids.sourceGeneration,
          sourceComponentId: "agent.researcher",
          targetDeploymentId: ids.targetDeployment,
          recipientKey
        }),
        requestHash: calculateConversationSourceDownloadRequestHash({
          sourceGenerationId: ids.sourceGeneration,
          sourceComponentId: "agent.researcher",
          targetDeploymentId: ids.targetDeployment,
          firstSegmentIndex: 3,
          recipientKey
        })
      },
      policy: { disposition: "step_up" }
    });
    expect(
      admitted && "operation" in admitted ? admitted.operation.body : null
    ).toMatchObject({ sourceComponentId: "agent.researcher" });
    expect(repo.getConversationSourceArtifactByGeneration).toHaveBeenCalledWith(
      { userId: ids.actor },
      ids.sourceGeneration,
      "agent.researcher"
    );
  });
});
