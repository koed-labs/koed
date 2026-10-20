import type pg from "pg";
import type { PersonalMembershipRevision } from "@koed/shared";

const reviewRequired = () =>
  Object.assign(
    new Error(
      "Synchronized Project membership needs review before it can be changed."
    ),
    { statusCode: 409, code: "membership_review_required" }
  );
/** Native scalar APIs cannot silently replace one of several synchronized heads. */
export const assertPersonalMembershipMutationReady = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    projectId: string;
    entityKind?: "direct" | "rule" | "exclusion";
    localEntityId?: string;
    logicalSessionId?: string;
    selectorKey?: string;
  }
) => {
  const root = await client.query<{
    state: string;
    current_revision: PersonalMembershipRevision | null;
  }>(
    "select state,current_revision from personal_membership_entities where owner_user_id=$1 and local_project_id=$2 and entity_kind='project'",
    [input.ownerUserId, input.projectId]
  );
  if (
    root.rows.some(
      (row) =>
        row.state !== "available" ||
        row.current_revision?.operation.kind !== "set_project"
    )
  )
    throw reviewRequired();
  if (!input.entityKind) return;
  const entities = await client.query<{
    state: string;
    current_revision: PersonalMembershipRevision | null;
  }>(
    `select e.state,e.current_revision from personal_membership_entities e
     where e.owner_user_id=$1 and e.local_project_id=$2 and e.entity_kind=$3 and (
       ($4::uuid is not null and e.local_entity_id=$4::uuid) or
       ($6::text is not null and e.selector_key=$6) or
       ($5::uuid is not null and exists(select 1 from sessions s join personal_source_bindings b on b.owner_user_id=s.owner_user_id and b.local_session_id=s.id
         where s.owner_user_id=$1 and s.logical_session_id=$5::uuid and b.binding_id=e.source_binding_id)))`,
    [
      input.ownerUserId,
      input.projectId,
      input.entityKind,
      input.localEntityId ?? null,
      input.logicalSessionId ?? null,
      input.selectorKey ?? null
    ]
  );
  if (entities.rows.some((row) => row.state !== "available"))
    throw reviewRequired();
};
