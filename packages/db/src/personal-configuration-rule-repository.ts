import type pg from "pg";
import {
  PdsConfigurationCompatibilityError,
  personalMembershipEntitySnapshotSchema,
  type PersonalMembershipEntitySnapshot,
  type PersonalMembershipRevision
} from "@koed/shared";
import {
  withPersonalConfigurationPublication,
  type PersonalConfigurationPublicationScope
} from "./personal-configuration-authority.js";
import { retainPersonalMembershipLocalDevice } from "./personal-membership-local-device.js";
import { bridgePersonalMembershipCatalog } from "./personal-membership-catalog-bridge.js";
import { bridgePersonalMembershipRule } from "./personal-membership-rule-bridge.js";
import { bridgePersonalMembershipExclusion } from "./personal-membership-exclusion-bridge.js";

type Scope = PersonalConfigurationPublicationScope & {
  originatingDeploymentId: string;
  afterNativeId?: string;
  afterEntity?: { projectIdentity: string; entityIdentity: string };
  limit?: number;
};
type Page = {
  snapshots: PersonalMembershipEntitySnapshot[];
  nextNativeId: string | null;
  nextEntity: { projectIdentity: string; entityIdentity: string } | null;
  unresolvedNativeIds: string[];
};
/** Separate native preparation and retained-entity cursors keep removals and
 * source-pending references exportable without a fabricated native source row.
 */
export const createPersonalConfigurationRuleRepository = (pool: pg.Pool) => {
  const list = (input: Scope, family: "rule" | "exclusion"): Promise<Page> =>
    withPersonalConfigurationPublication(
      pool,
      input,
      {
        snapshots: [],
        nextNativeId: null,
        nextEntity: null,
        unresolvedNativeIds: []
      },
      async (client) => {
        await retainPersonalMembershipLocalDevice(client, input.userId, {
          deviceId: input.authorDeviceId,
          signingKeyId: input.authorSigningKeyId,
          originatingDeploymentId: input.originatingDeploymentId
        });
        const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
        const table =
            family === "rule"
              ? "personal_project_rules"
              : "personal_project_exclusions",
          id = family === "rule" ? "inclusion_id" : "exclusion_id";
        const native = await client.query<{
          native_id: string;
          project_id: string;
        }>(
          `select ${id} native_id,project_id from ${table} where owner_user_id=$1
           and ($2::uuid is null or ${id}>$2) order by ${id} limit $3`,
          [input.userId, input.afterNativeId ?? null, limit]
        );
        const unresolvedNativeIds: string[] = [];
        for (const row of native.rows) {
          await client.query("savepoint personal_rule_snapshot");
          try {
            await bridgePersonalMembershipCatalog(client, {
              ownerUserId: input.userId,
              nativeProjectId: row.project_id,
              localDeviceId: input.authorDeviceId
            });
            if (family === "rule")
              await bridgePersonalMembershipRule(client, {
                ownerUserId: input.userId,
                nativeProjectId: row.project_id,
                nativeRuleId: row.native_id,
                localDeviceId: input.authorDeviceId
              });
            else
              await bridgePersonalMembershipExclusion(client, {
                ownerUserId: input.userId,
                nativeProjectId: row.project_id,
                nativeExclusionId: row.native_id,
                localDeviceId: input.authorDeviceId,
                originatingDeploymentId: input.originatingDeploymentId
              });
            await client.query("release savepoint personal_rule_snapshot");
          } catch (error) {
            await client.query("rollback to savepoint personal_rule_snapshot");
            await client.query("release savepoint personal_rule_snapshot");
            if (
              !(error instanceof PdsConfigurationCompatibilityError) &&
              !(
                error instanceof Error &&
                error.name === "PersonalMembershipBridgeRequiredError"
              )
            )
              throw error;
            unresolvedNativeIds.push(row.native_id);
          }
        }
        const entities = await client.query<{
          project_identity: string;
          entity_identity: string;
        }>(
          `select project_identity,entity_identity from personal_membership_entities e where owner_user_id=$1 and entity_kind=$2
           and ($3::text is null or (project_identity,entity_identity)>($3,$4))
           and exists(select 1 from personal_membership_revisions r where r.owner_user_id=e.owner_user_id
             and r.project_identity=e.project_identity and r.entity_identity=e.entity_identity)
           order by project_identity,entity_identity limit $5`,
          [
            input.userId,
            family,
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
            "select revision from personal_membership_revisions where owner_user_id=$1 and project_identity=$2 and entity_identity=$3 order by revision_id",
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
              entityKind: family,
              revisions: history.rows.map((row) => row.revision)
            })
          );
        }
        const last = entities.rows.at(-1);
        return {
          snapshots,
          unresolvedNativeIds,
          nextNativeId:
            native.rows.length === limit ? native.rows.at(-1)!.native_id : null,
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
  return {
    listPersonalConfigurationRuleSnapshots: (input: Scope) =>
      list(input, "rule"),
    listPersonalConfigurationExclusionSnapshots: (input: Scope) =>
      list(input, "exclusion")
  };
};
