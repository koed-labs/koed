import type pg from "pg";
import {
  personalMembershipSyncEntitySchema,
  personalMembershipSyncStateSchema,
  personalMembershipSourceFromSelectorKey,
  type PersonalMembershipRevision,
  type PersonalMembershipSyncEntity
} from "@koed/shared";
import type { PersonalMembershipEntityRow } from "./personal-membership-causal-history.js";
import { mapPersonalNamedProject } from "./personal-membership-repository.js";

import { loadPersonalMembershipRuleCandidates } from "./personal-membership-rule-candidates.js";
import { personalGraphExclusionBlocksSql } from "./personal-membership-selection-sql.js";

type NativeProjectRow = Parameters<typeof mapPersonalNamedProject>[0];
export const personalMembershipReviewUnavailable = () =>
  Object.assign(new Error("Project membership not found"), { statusCode: 404 });
export const personalMembershipReviewStale = () =>
  Object.assign(
    new Error(
      "Project membership or its source changed. Review the current revisions again."
    ),
    { statusCode: 409, code: "membership_review_stale" }
  );
export const loadPersonalMembershipReviewProject = async (
  client: pg.PoolClient,
  ownerUserId: string,
  projectId: string
) => {
  const native = await client.query<NativeProjectRow>(
    "select * from personal_named_projects where owner_user_id=$1 and project_id=$2 for update",
    [ownerUserId, projectId]
  );
  if (!native.rows[0]) throw personalMembershipReviewUnavailable();
  const root = await client.query<PersonalMembershipEntityRow>(
    "select * from personal_membership_entities where owner_user_id=$1 and local_project_id=$2 and entity_kind='project' for update",
    [ownerUserId, projectId]
  );
  return {
    project: mapPersonalNamedProject(native.rows[0]),
    root: root.rows[0] ?? null
  };
};
export const mapPersonalMembershipSyncEntity = async (
  client: pg.PoolClient,
  entity: PersonalMembershipEntityRow
): Promise<PersonalMembershipSyncEntity> => {
  const heads = await client.query<{ revision: PersonalMembershipRevision }>(
    `select revision from personal_membership_revisions where owner_user_id=$1 and project_identity=$2
     and entity_identity=$3 and revision_id=any($4::text[]) order by revision_id`,
    [
      entity.owner_user_id,
      entity.project_identity,
      entity.entity_identity,
      entity.heads
    ]
  );
  if (heads.rows.length !== entity.heads.length)
    throw new TypeError("PersonalMembershipFrontierUnavailableError");
  let source: PersonalMembershipSyncEntity["source"] = null;
  if (entity.entity_kind === "direct" || entity.entity_kind === "exclusion") {
    const reference = personalMembershipSourceFromSelectorKey(
      entity.selector_key!,
      entity.owner_user_id
    );
    const ready = await client.query<{ id: string }>(
      `select s.id from personal_source_bindings b join sessions s on s.id=b.local_session_id
       and s.owner_user_id=b.owner_user_id and s.logical_session_id=b.local_logical_session_id
       where b.binding_id=$1 and b.owner_user_id=$2 and b.availability='available' and s.visibility='personal'
        and s.invalidated_at is null and s.personal_deleted_at is null and sync_session_recall_ready(s.id)`,
      [entity.source_binding_id, entity.owner_user_id]
    );
    source = {
      reference,
      ready: Boolean(ready.rowCount),
      localSessionId: ready.rows[0]?.id ?? null
    };
  }
  return personalMembershipSyncEntitySchema.parse({
    entityId: entity.entity_identity,
    entityKind: entity.entity_kind,
    state: entity.state,
    heads: heads.rows.map((row) => row.revision),
    source,
    ...(entity.entity_kind === "rule"
      ? {
          ruleCandidates: await loadPersonalMembershipRuleCandidates(
            client,
            entity
          )
        }
      : {})
  });
};
export const readPersonalMembershipSyncState = async (
  client: pg.PoolClient,
  ownerUserId: string,
  projectId: string,
  afterEntityId?: string
) => {
  const { project, root } = await loadPersonalMembershipReviewProject(
    client,
    ownerUserId,
    projectId
  );
  const entities = root
    ? await client.query<PersonalMembershipEntityRow>(
        `select * from personal_membership_entities where owner_user_id=$1 and project_identity=$2
     and entity_kind<>'project' and ($3::text is null or entity_identity>$3) order by entity_identity limit 101`,
        [ownerUserId, root.project_identity, afterEntityId ?? null]
      )
    : null;
  const rows = entities?.rows.slice(0, 100) ?? [];
  const memberships = [];
  for (const entity of rows)
    memberships.push(await mapPersonalMembershipSyncEntity(client, entity));
  return personalMembershipSyncStateSchema.parse({
    project,
    projectIdentity: root?.project_identity ?? projectId,
    catalog: root ? await mapPersonalMembershipSyncEntity(client, root) : null,
    memberships,
    nextEntityId:
      entities && entities.rows.length > 100
        ? rows.at(-1)!.entity_identity
        : null
  });
};

/** Match all evidence that can change what this review means, without paths or inferred identities. */
export const loadPersonalMembershipReviewState = async (
  client: pg.PoolClient,
  ownerUserId: string,
  projectId: string,
  entityId: string
) => {
  const { project, root } = await loadPersonalMembershipReviewProject(
    client,
    ownerUserId,
    projectId
  );
  if (!root) throw personalMembershipReviewUnavailable();
  const found = await client.query<PersonalMembershipEntityRow>(
    "select * from personal_membership_entities where owner_user_id=$1 and project_identity=$2 and entity_identity=$3 for update",
    [ownerUserId, root.project_identity, entityId]
  );
  const entity = found.rows[0];
  if (!entity) throw personalMembershipReviewUnavailable();
  const device = await client.query<{ device_id: string }>(
    "select device_id from personal_membership_local_devices where owner_user_id=$1",
    [ownerUserId]
  );
  if (!device.rows[0])
    throw Object.assign(
      new Error(
        "Local device attribution is unavailable. Synchronize before reviewing membership."
      ),
      { statusCode: 409 }
    );
  const before = await mapPersonalMembershipSyncEntity(client, entity);
  const exclusions = before.source
    ? await client.query<{
        blocked: boolean;
        native: unknown;
        graph: unknown;
      }>(
        `select (
      exists(select 1 from personal_project_exclusions x where x.owner_user_id=$1 and x.project_id=$2
        and x.logical_session_id=s.logical_session_id and x.cleared_at is null)
      or ${personalGraphExclusionBlocksSql("s", "$1", "$2")}
    ) as blocked,
    (select coalesce(jsonb_agg(jsonb_build_object('id',x.exclusion_id,'head',x.head_revision_id,'cleared',x.cleared_at) order by x.exclusion_id),'[]'::jsonb)
     from personal_project_exclusions x where x.owner_user_id=$1 and x.project_id=$2 and x.logical_session_id=s.logical_session_id) as native,
    (select coalesce(jsonb_agg(jsonb_build_object('id',e.entity_identity,'state',e.state,'heads',e.heads) order by e.entity_identity),'[]'::jsonb)
     from personal_membership_entities e join personal_source_bindings b on b.binding_id=e.source_binding_id and b.owner_user_id=e.owner_user_id
     where e.owner_user_id=$1 and e.local_project_id=$2 and e.entity_kind='exclusion'
       and b.local_session_id=s.id and b.local_logical_session_id=s.logical_session_id) as graph
    from sessions s where s.owner_user_id=$1 and s.id=$3`,
        [ownerUserId, projectId, before.source.localSessionId]
      )
    : null;
  const exclusionState = exclusions?.rows[0] ?? null;
  return {
    project,
    root,
    entity,
    blockedByExclusion: exclusionState?.blocked ?? false,
    before,
    localDeviceId: device.rows[0].device_id,
    expectedState: {
      projectVersion: project.version,
      projectDeletedAt: project.deletedAt,
      catalogState: root.state,
      catalogHeads: [...root.heads].sort(),
      entityState: entity.state,
      entityHeads: [...entity.heads].sort(),
      source: before.source,
      exclusionState,
      ruleCandidates: before.ruleCandidates ?? [],
      localDeviceId: device.rows[0].device_id
    }
  };
};
