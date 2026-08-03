import type { PoolClient } from "pg";

import type {
  PurgeArtifactKind,
  RequiredPurgeArtifact
} from "../retention-lifecycle-repository.js";
import {
  definePurgeTargetStrategyRegistry,
  type PurgeArtifactCleanupResult,
  type PurgeTargetStrategyRegistry
} from "./purge-target-registry.js";

type TargetFor<Kind extends keyof PurgeTargetStrategyRegistry> = Parameters<
  PurgeTargetStrategyRegistry[Kind]["requiredArtifacts"]
>[0];

interface CreatePurgeTargetStrategiesDependencies {
  teamArtifacts(teamId: string): RequiredPurgeArtifact[];
  shareGrantArtifacts(shareGrantId: string): RequiredPurgeArtifact[];
  ownerPrivateReplicaArtifacts(
    ownerPrivateReplicaId: string
  ): RequiredPurgeArtifact[];
  prepareShareGrantForClaim(
    client: PoolClient,
    target: TargetFor<"share_grant">,
    observedAt: Date
  ): Promise<void>;
  cleanupTeamArtifact(
    client: PoolClient,
    input: {
      target: TargetFor<"team">;
      artifactKind: PurgeArtifactKind;
      observedAt: Date;
      backupExpiresAt: Date;
    }
  ): Promise<PurgeArtifactCleanupResult>;
  cleanupShareGrantArtifact(
    client: PoolClient,
    input: {
      target: TargetFor<"share_grant">;
      artifactKind: PurgeArtifactKind;
      observedAt: Date;
      backupExpiresAt: Date;
    }
  ): Promise<PurgeArtifactCleanupResult>;
  cleanupOwnerPrivateArtifact(
    client: PoolClient,
    input: {
      target: TargetFor<"owner_private_replica">;
      artifactKind: PurgeArtifactKind;
      observedAt: Date;
      backupExpiresAt: Date;
    }
  ): Promise<PurgeArtifactCleanupResult>;
}

const noTargetLifecycleWork = async (): Promise<void> => {};

const artifactKey = (artifact: RequiredPurgeArtifact): string =>
  `${artifact.artifactKind}:${artifact.artifactLocatorHash}`;

const assertSameArtifactSet = (
  expected: RequiredPurgeArtifact[],
  actual: RequiredPurgeArtifact[]
): void => {
  const expectedKeys = expected.map(artifactKey).sort();
  const actualKeys = actual.map(artifactKey).sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    throw new Error(
      "Purge job idempotency key was reused with different artifacts"
    );
  }
};

export const createPurgeTargetStrategies = (
  dependencies: CreatePurgeTargetStrategiesDependencies
): PurgeTargetStrategyRegistry =>
  definePurgeTargetStrategyRegistry({
    team: {
      requiredArtifacts: (target, suppliedArtifacts) =>
        suppliedArtifacts ?? dependencies.teamArtifacts(target.teamId),
      validateEvidenceArtifacts: () => {},
      lockTarget: noTargetLifecycleWork,
      prepareForClaim: noTargetLifecycleWork,
      validateAttempt: (_target, attempt) => {
        if (!attempt.teamId) {
          throw new Error("Root Team purge job is missing its Team scope");
        }
      },
      cleanupArtifact: dependencies.cleanupTeamArtifact,
      beforeJobCompletion: async (client, target, context) => {
        await client.query(
          `update teams
              set lifecycle = 'purged',
                  purge_completed_at = $2,
                  updated_at = $2
            where id = $1
              and lifecycle in ('deletion_requested', 'purge_pending')`,
          [target.teamId, context.completedAt]
        );
      },
      afterJobCompletion: async (client, target, context) => {
        await client.query(
          `insert into audit_events (
             actor_user_id, action, target_table, target_id, metadata
           ) values (
             null, 'team.purge_completed', 'teams', $1, $2::jsonb
           )`,
          [
            target.teamId,
            JSON.stringify({
              teamId: target.teamId,
              retentionDecisionId: context.retentionDecisionId,
              purgeJobId: context.purgeJobId,
              completedAt: context.completedAt.toISOString(),
              verifiedArtifactCount: context.verifiedArtifactCount
            })
          ]
        );
      }
    },
    share_grant: {
      requiredArtifacts: (target, suppliedArtifacts) =>
        suppliedArtifacts ??
        dependencies.shareGrantArtifacts(target.shareGrantId),
      validateEvidenceArtifacts: (target, actualArtifacts) => {
        assertSameArtifactSet(
          dependencies.shareGrantArtifacts(target.shareGrantId),
          actualArtifacts
        );
      },
      lockTarget: async (client, target) => {
        const targetLock = await client.query(
          `select id from team_session_share_grants
            where id = $1 for update`,
          [target.shareGrantId]
        );
        if (!targetLock.rowCount) {
          throw new Error("Share Grant purge target is unavailable");
        }
      },
      prepareForClaim: dependencies.prepareShareGrantForClaim,
      validateAttempt: () => {},
      cleanupArtifact: dependencies.cleanupShareGrantArtifact,
      beforeJobCompletion: noTargetLifecycleWork,
      afterJobCompletion: async (client, target, context) => {
        await client.query(
          `insert into audit_events (
             actor_user_id, action, target_table, target_id, metadata
           )
           select null, 'share_grant.purge_completed',
                  'team_session_share_grants', $1, $3::jsonb
            where not exists (
              select 1 from audit_events audit
               where audit.action = 'share_grant.purge_completed'
                 and audit.target_id = $1
                 and audit.metadata ->> 'purgeJobId' = $2::text
            )`,
          [
            target.shareGrantId,
            context.purgeJobId,
            JSON.stringify({
              teamId: target.teamId,
              teamWorkspaceId: target.teamWorkspaceId,
              shareGrantId: target.shareGrantId,
              retentionDecisionId: context.retentionDecisionId,
              purgeJobId: context.purgeJobId,
              completedAt: context.completedAt.toISOString(),
              verifiedArtifactCount: context.verifiedArtifactCount
            })
          ]
        );
      }
    },
    owner_private_replica: {
      requiredArtifacts: (target, suppliedArtifacts) => {
        const discovered = dependencies.ownerPrivateReplicaArtifacts(
          target.ownerPrivateReplicaId
        );
        if (suppliedArtifacts) {
          try {
            assertSameArtifactSet(discovered, suppliedArtifacts);
          } catch {
            throw new Error(
              "Owner-private purge artifacts must use server discovery"
            );
          }
        }
        return discovered;
      },
      validateEvidenceArtifacts: (target, actualArtifacts) => {
        assertSameArtifactSet(
          dependencies.ownerPrivateReplicaArtifacts(
            target.ownerPrivateReplicaId
          ),
          actualArtifacts
        );
      },
      lockTarget: noTargetLifecycleWork,
      prepareForClaim: noTargetLifecycleWork,
      validateAttempt: () => {},
      cleanupArtifact: dependencies.cleanupOwnerPrivateArtifact,
      beforeJobCompletion: noTargetLifecycleWork,
      afterJobCompletion: async (client, target, context) => {
        await client.query(
          `insert into audit_events (
             actor_user_id, owner_user_id, visibility, action,
             target_table, target_id, metadata
           )
           select null, replica.owner_user_id, 'personal',
                  'owner_private_replica.purge_completed',
                  'memory_replicas', replica.id, $3::jsonb
             from memory_replicas replica
            where replica.id = $1
              and not exists (
                select 1 from audit_events audit
                 where audit.action = 'owner_private_replica.purge_completed'
                   and audit.target_id = replica.id
                   and audit.metadata ->> 'purgeJobId' = $2::text
              )`,
          [
            target.ownerPrivateReplicaId,
            context.purgeJobId,
            JSON.stringify({
              ownerPrivateReplicaId: target.ownerPrivateReplicaId,
              logicalMemoryId: target.logicalMemoryId,
              retentionDecisionId: context.retentionDecisionId,
              purgeJobId: context.purgeJobId,
              completedAt: context.completedAt.toISOString(),
              verifiedArtifactCount: context.verifiedArtifactCount
            })
          ]
        );
      }
    }
  });
