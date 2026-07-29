import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import type { RetentionDecisionTarget } from "../retention-lifecycle-repository.js";
import {
  cleanupPurgeTargetArtifact,
  definePurgeTargetStrategyRegistry,
  preparePurgeTargetCompletion,
  recordPurgeTargetCompletion,
  requiredArtifactsForPurgeTarget,
  type ExecutablePurgeTargetKind,
  type PurgeTargetStrategyRegistry
} from "./purge-target-registry.js";

const client = {} as PoolClient;
const calls: string[] = [];

const registry: PurgeTargetStrategyRegistry = definePurgeTargetStrategyRegistry(
  {
    team: {
      requiredArtifacts: (target) => [
        { artifactKind: "database_row", artifactLocatorHash: target.teamId }
      ],
      validateEvidenceArtifacts: () => {},
      lockTarget: async () => {},
      prepareForClaim: async () => {},
      validateAttempt: () => {},
      cleanupArtifact: async (_client, input) => ({
        state: "verified",
        removedRecordCount: input.target.teamId.length,
        removedByteCount: 0
      }),
      beforeJobCompletion: async () => {
        calls.push("team:before");
      },
      afterJobCompletion: async () => {
        calls.push("team:after");
      }
    },
    share_grant: {
      requiredArtifacts: (target) => [
        {
          artifactKind: "database_row",
          artifactLocatorHash: target.shareGrantId
        }
      ],
      validateEvidenceArtifacts: () => {},
      lockTarget: async () => {},
      prepareForClaim: async () => {},
      validateAttempt: () => {},
      cleanupArtifact: async (_client, input) => ({
        state: "verified",
        removedRecordCount: input.target.shareGrantId.length,
        removedByteCount: 0
      }),
      beforeJobCompletion: async () => {
        calls.push("share_grant:before");
      },
      afterJobCompletion: async () => {
        calls.push("share_grant:after");
      }
    },
    owner_private_replica: {
      requiredArtifacts: (target) => [
        {
          artifactKind: "database_row",
          artifactLocatorHash: target.ownerPrivateReplicaId
        }
      ],
      validateEvidenceArtifacts: () => {},
      lockTarget: async () => {},
      prepareForClaim: async () => {},
      validateAttempt: () => {},
      cleanupArtifact: async (_client, input) => ({
        state: "verified",
        removedRecordCount: input.target.ownerPrivateReplicaId.length,
        removedByteCount: 0
      }),
      beforeJobCompletion: async () => {
        calls.push("owner_private_replica:before");
      },
      afterJobCompletion: async () => {
        calls.push("owner_private_replica:after");
      }
    }
  }
);

const targets = {
  team: {
    kind: "team",
    targetId: "team-1",
    teamId: "team-1"
  },
  share_grant: {
    kind: "share_grant",
    targetId: "grant-1",
    teamId: "team-1",
    teamWorkspaceId: "workspace-1",
    shareGrantId: "grant-1",
    logicalMemoryId: "memory-1"
  },
  owner_private_replica: {
    kind: "owner_private_replica",
    targetId: "replica-1",
    ownerPrivateReplicaId: "replica-1",
    logicalMemoryId: "memory-1"
  }
} satisfies {
  [Kind in ExecutablePurgeTargetKind]: Extract<
    RetentionDecisionTarget,
    { kind: Kind }
  >;
};

describe("purge target strategy registry", () => {
  it("is exhaustive for every executable target and dispatches its plan", () => {
    expect(Object.keys(registry).sort()).toEqual(Object.keys(targets).sort());

    for (const target of Object.values(targets)) {
      expect(
        requiredArtifactsForPurgeTarget(registry, target)[0]
          ?.artifactLocatorHash
      ).toBe(target.targetId);
    }
  });

  it("dispatches execution and both completion phases to one target strategy", async () => {
    calls.length = 0;
    const target = targets.share_grant;
    const completion = {
      retentionDecisionId: "decision-1",
      purgeJobId: "job-1",
      completedAt: new Date("2026-01-01T00:00:00.000Z"),
      verifiedArtifactCount: 7
    };

    await expect(
      cleanupPurgeTargetArtifact(registry, client, {
        target,
        artifactKind: "database_row",
        observedAt: completion.completedAt,
        backupExpiresAt: completion.completedAt
      })
    ).resolves.toMatchObject({ removedRecordCount: "grant-1".length });
    await preparePurgeTargetCompletion(registry, client, target, completion);
    await recordPurgeTargetCompletion(registry, client, target, completion);

    expect(calls).toEqual(["share_grant:before", "share_grant:after"]);
  });
});
