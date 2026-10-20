import { bridgePersonalMembershipProject } from "./personal-membership-project-bridge.js";
import { projectPersonalMembershipState } from "./personal-membership-projection.js";
import { retainPersonalMembershipLocalDevice } from "./personal-membership-local-device.js";
import type pg from "pg";
import {
  personalMembershipEntitySnapshotSchema,
  type PersonalMembershipEntitySnapshot,
  type PersonalMembershipRevision
} from "@koed/shared";
import {
  withPersonalConfigurationPublication,
  type PersonalConfigurationPublicationScope
} from "./personal-configuration-authority.js";
import { bridgePersonalDirectMembership } from "./personal-membership-direct-bridge.js";
import { PdsConfigurationCompatibilityError } from "@koed/shared";
import { bridgePersonalMembershipCatalog } from "./personal-membership-catalog-bridge.js";

/** Catalog preparation is independent from capture and source-context publication.
 * Transport must negotiate project_membership_v1 before signing these candidates.
 */
export const createPersonalConfigurationMembershipRepository = (
  pool: pg.Pool
) => ({
  async listPersonalConfigurationCatalogSnapshots(input: {
    userId: string;
    groupId: string;
    authorDeviceId: string;
    authorSigningKeyId: string;
    expectedEpoch: string;
    expectedAuthorityHead: string;
    originatingDeploymentId: string;
    afterProjectId?: string;
    limit?: number;
  }): Promise<{
    snapshots: PersonalMembershipEntitySnapshot[];
    nextProjectId: string | null;
  }> {
    return withPersonalConfigurationPublication(
      pool,
      input,
      { snapshots: [], nextProjectId: null },
      async (client) => {
        await retainPersonalMembershipLocalDevice(client, input.userId, {
          deviceId: input.authorDeviceId,
          signingKeyId: input.authorSigningKeyId,
          originatingDeploymentId: input.originatingDeploymentId
        });
        const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
        // Deleted and empty Projects are still catalog history. A Conversation is not a prerequisite.
        const projects = await client.query<{ project_id: string }>(
          `select project_id from personal_named_projects where owner_user_id=$1
         and ($2::uuid is null or project_id>$2) order by project_id limit $3`,
          [input.userId, input.afterProjectId ?? null, limit]
        );
        const snapshots: PersonalMembershipEntitySnapshot[] = [];
        for (const project of projects.rows) {
          await bridgePersonalMembershipCatalog(client, {
            ownerUserId: input.userId,
            nativeProjectId: project.project_id,
            localDeviceId: input.authorDeviceId
          });
          const history = await client.query<{
            revision: PersonalMembershipRevision;
          }>(
            `select r.revision from personal_membership_entities e join personal_membership_revisions r
           on r.owner_user_id=e.owner_user_id and r.project_identity=e.project_identity and r.entity_identity=e.entity_identity
           where e.owner_user_id=$1 and e.local_project_id=$2 and e.entity_kind='project' order by r.revision_id`,
            [input.userId, project.project_id]
          );
          const first = history.rows[0]?.revision;
          // A child may arrive before its catalog. Its placeholder cannot be signed as a User edit.
          if (!first) continue;
          snapshots.push(
            personalMembershipEntitySnapshotSchema.parse({
              version: 1,
              project: first.project,
              entityId: first.entityId,
              entityKind: "project",
              revisions: history.rows.map((row) => row.revision)
            })
          );
        }
        return {
          snapshots,
          nextProjectId:
            projects.rows.length === limit
              ? projects.rows.at(-1)!.project_id
              : null
        };
      }
    );
  },
  async listPersonalConfigurationDirectSnapshots(
    input: PersonalConfigurationPublicationScope & {
      originatingDeploymentId: string;
      afterInclusionId?: string;
      afterEntity?: { projectIdentity: string; entityIdentity: string };
      limit?: number;
    }
  ): Promise<{
    snapshots: PersonalMembershipEntitySnapshot[];
    nextInclusionId: string | null;
    nextEntity: { projectIdentity: string; entityIdentity: string } | null;
    unresolvedInclusionIds: string[];
  }> {
    return withPersonalConfigurationPublication(
      pool,
      input,
      {
        snapshots: [],
        nextInclusionId: null,
        nextEntity: null,
        unresolvedInclusionIds: []
      },
      async (client) => {
        await retainPersonalMembershipLocalDevice(client, input.userId, {
          deviceId: input.authorDeviceId,
          signingKeyId: input.authorSigningKeyId,
          originatingDeploymentId: input.originatingDeploymentId
        });
        const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
        const native = await client.query<{
          inclusion_id: string;
          project_id: string;
        }>(
          `select inclusion_id,project_id from personal_project_inclusions where owner_user_id=$1
         and ($2::uuid is null or inclusion_id>$2) order by inclusion_id limit $3`,
          [input.userId, input.afterInclusionId ?? null, limit]
        );
        const unresolvedInclusionIds: string[] = [];
        for (const inclusion of native.rows) {
          await client.query("savepoint personal_direct_snapshot");
          try {
            await bridgePersonalMembershipCatalog(client, {
              ownerUserId: input.userId,
              nativeProjectId: inclusion.project_id,
              localDeviceId: input.authorDeviceId
            });
            await bridgePersonalDirectMembership(client, {
              ownerUserId: input.userId,
              nativeProjectId: inclusion.project_id,
              nativeInclusionId: inclusion.inclusion_id,
              localDeviceId: input.authorDeviceId,
              originatingDeploymentId: input.originatingDeploymentId
            });
            await client.query("release savepoint personal_direct_snapshot");
          } catch (error) {
            await client.query(
              "rollback to savepoint personal_direct_snapshot"
            );
            await client.query("release savepoint personal_direct_snapshot");
            if (
              !(error instanceof PdsConfigurationCompatibilityError) &&
              !(
                error instanceof Error &&
                error.name === "PersonalMembershipBridgeRequiredError"
              )
            )
              throw error;
            unresolvedInclusionIds.push(inclusion.inclusion_id);
          }
        }
        // Page retained entities separately: a pending source has no native inclusion,
        // and still needs forwarding, removals, and restart-safe history.
        const entities = await client.query<{
          project_identity: string;
          entity_identity: string;
        }>(
          `select project_identity,entity_identity from personal_membership_entities e
         where owner_user_id=$1 and entity_kind='direct'
          and ($2::text is null or (project_identity,entity_identity)>($2,$3))
          and exists(select 1 from personal_membership_revisions r where r.owner_user_id=e.owner_user_id
            and r.project_identity=e.project_identity and r.entity_identity=e.entity_identity)
         order by project_identity,entity_identity limit $4`,
          [
            input.userId,
            input.afterEntity?.projectIdentity ?? null,
            input.afterEntity?.entityIdentity ?? null,
            limit
          ]
        );
        const snapshots: PersonalMembershipEntitySnapshot[] = [];
        for (const entity of entities.rows) {
          const history = await client.query<{
            revision: PersonalMembershipRevision;
          }>(
            `select revision from personal_membership_revisions where owner_user_id=$1 and project_identity=$2
           and entity_identity=$3 order by revision_id`,
            [input.userId, entity.project_identity, entity.entity_identity]
          );
          snapshots.push(
            personalMembershipEntitySnapshotSchema.parse({
              version: 1,
              project: {
                ownerUserId: input.userId,
                projectId: entity.project_identity
              },
              entityId: entity.entity_identity,
              entityKind: "direct",
              revisions: history.rows.map((row) => row.revision)
            })
          );
        }
        const last = entities.rows.at(-1);
        return {
          snapshots,
          unresolvedInclusionIds,
          nextInclusionId:
            native.rows.length === limit
              ? native.rows.at(-1)!.inclusion_id
              : null,
          nextEntity:
            entities.rows.length === limit && last
              ? {
                  projectIdentity: last.project_identity,
                  entityIdentity: last.entity_identity
                }
              : null
        };
      }
    );
  },
  async reconcilePersonalConfigurationMembershipViews(
    input: PersonalConfigurationPublicationScope & {
      originatingDeploymentId: string;
      afterProjectIdentity?: string;
      limit?: number;
    }
  ): Promise<{
    changed: number;
    nextProjectIdentity: string | null;
    unresolvedProjectIdentities: string[];
  }> {
    return withPersonalConfigurationPublication(
      pool,
      input,
      {
        changed: 0,
        nextProjectIdentity: null,
        unresolvedProjectIdentities: []
      },
      async (client) => {
        const localDevice = {
          deviceId: input.authorDeviceId,
          signingKeyId: input.authorSigningKeyId,
          originatingDeploymentId: input.originatingDeploymentId
        };
        await retainPersonalMembershipLocalDevice(
          client,
          input.userId,
          localDevice
        );
        const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
        const projects = await client.query<{
          project_identity: string;
          local_project_id: string;
        }>(
          `select project_identity,local_project_id from personal_membership_entities where owner_user_id=$1
         and entity_kind='project' and local_project_id is not null and ($2::text is null or project_identity>$2)
         order by project_identity limit $3`,
          [input.userId, input.afterProjectIdentity ?? null, limit]
        );
        let changed = 0;
        const unresolvedProjectIdentities: string[] = [];
        for (const project of projects.rows) {
          await client.query("savepoint personal_membership_view");
          try {
            await bridgePersonalMembershipProject(client, {
              ownerUserId: input.userId,
              nativeProjectId: project.local_project_id,
              localDevice
            });
            const result = await projectPersonalMembershipState(client, {
              ownerUserId: input.userId,
              projectIdentity: project.project_identity
            });
            if (result.changed) changed++;
            await client.query("release savepoint personal_membership_view");
          } catch (error) {
            await client.query(
              "rollback to savepoint personal_membership_view"
            );
            await client.query("release savepoint personal_membership_view");
            if (
              !(error instanceof PdsConfigurationCompatibilityError) &&
              !(
                error instanceof Error &&
                error.name === "PersonalMembershipBridgeRequiredError"
              )
            )
              throw error;
            unresolvedProjectIdentities.push(project.project_identity);
          }
        }
        return {
          changed,
          unresolvedProjectIdentities,
          nextProjectIdentity:
            projects.rows.length === limit
              ? projects.rows.at(-1)!.project_identity
              : null
        };
      },
      { allowPublicationPause: true }
    );
  }
});
