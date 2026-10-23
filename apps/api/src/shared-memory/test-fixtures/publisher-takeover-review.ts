import { randomUUID } from "node:crypto";
import { sharingRulePublisherTakeoverReviewSchema } from "@koed/shared";

/** Protocol boundary fixture. Repository checks obtain reviews from real rules. */
export const publisherTakeoverReviewFixture = (ids: {
  ruleId: string;
  teamId: string;
  teamWorkspaceId: string;
  receivingCredentialId: string;
}) =>
  sharingRulePublisherTakeoverReviewSchema.parse({
    ruleId: ids.ruleId,
    teamId: ids.teamId,
    teamWorkspaceId: ids.teamWorkspaceId,
    expectedAuthorityVersion: 3,
    publisherFence: 2,
    sourceIdentity: {
      originatingDeploymentId: "signed-origin-deployment",
      originatingDeviceId: "signed-origin-device",
      logicalSessionId: "signed-original-conversation"
    },
    selectorKind: "captured_session",
    state: "active",
    maximumFidelity: "lcm_rollups",
    includeCuratedMemory: false,
    effectivePrivacyPolicyHash: "a".repeat(64),
    teamName: "Fixture Team",
    workspaceName: "Fixture Workspace",
    currentPublisher: {
      credentialId: randomUUID(),
      deviceInstanceId: "original-device",
      label: "Original publisher",
      available: true
    },
    receivingPublisher: {
      credentialId: ids.receivingCredentialId,
      deviceInstanceId: "receiving-device",
      label: "Receiving publisher",
      available: true
    },
    logicalMemoryId: randomUUID(),
    membershipId: randomUUID(),
    shareGrantId: randomUUID(),
    membershipVersion: 1,
    selectionScope: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
