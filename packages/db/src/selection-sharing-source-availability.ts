import type pg from "pg";
import {
  crossIdentitySyncDeterministicUuid,
  sharingRuleSourceIdentitySchema,
  sharingSelectionTargetSchema,
  personalSelectionConsumerPageSchema
} from "@koed/shared";
import type {
  SelectionSharingGoal,
  SelectionSharingProgress
} from "@koed/shared";
import { resolveConsumerSelection } from "./personal-selection-consumer-state.js";
import { personalProjectIdentityMatchesSql } from "./personal-membership-selection-sql.js";
import { personalSourceSelectionSql } from "./personal-selection-sql.js";

type SourceAvailabilityInput = {
  ownerUserId: string;
  goal: SelectionSharingGoal;
  target: SelectionSharingProgress["intent"]["review"]["target"];
};

/** Team transport identity is derived only after proving native ownership.
 * Personal sync origin identifiers occupy an independent namespace. */
export const resolveNativeSharingSource = async (
  client: pg.PoolClient,
  input: SourceAvailabilityInput & { deploymentProtocolId: string }
) => {
  const { goal, ownerUserId, target, deploymentProtocolId } = input;
  if (goal.desired !== "present") return null;
  const source = goal.source;
  const resolved = await resolveConsumerSelection(
    client,
    { userId: ownerUserId },
    {
      version: 1,
      ownerUserId,
      target
    }
  );
  const native = await client.query(
    `select 1 from sessions s where s.id=$1 and s.logical_session_id=$2 and s.owner_user_id=$3
      and s.visibility='personal' and s.invalidated_at is null and s.personal_deleted_at is null
      and s.repository_assignment_version=$4 and (s.folder_assignment->>'revision')::integer=$6
      and ${personalSourceSelectionSql("s", "$5")}
      and pds_session_recall_ready(s.id) and sync_session_recall_ready(s.id)
      and not exists(select 1 from pds_logical_replicas where local_session_id=s.id)
      and not exists(select 1 from local_captured_session_logical_memories binding join memory_replicas replica on replica.logical_memory_id=binding.logical_memory_id
        where binding.local_session_id=s.id and replica.replica_role='target')
      and not exists(select 1 from personal_source_bindings binding where binding.owner_user_id=s.owner_user_id and binding.local_session_id=s.id
        and (binding.availability<>'available' or binding.local_logical_session_id<>s.logical_session_id or binding.retained_package_id is not null))`,
    [
      source.localSessionId,
      source.localLogicalSessionId,
      ownerUserId,
      source.contextVersion.git,
      resolved.selection,
      source.contextVersion.folder
    ]
  );
  return native.rowCount === 1
    ? {
        logicalMemoryId: crossIdentitySyncDeterministicUuid({
          protocol: "koed.captured-session-sync/v2",
          sourceDeploymentId: deploymentProtocolId,
          sourceUserId: ownerUserId,
          originSessionId: source.localSessionId,
          identity: "logical-memory"
        }),
        sessionId: source.localSessionId
      }
    : null;
};

/** A ready, authenticated receiving checkpoint can identify an existing Team
 * source. It cannot authorize a new source origin or a new source upload. */
export const resolveReplicaSharingSource = async (
  client: pg.PoolClient,
  input: SourceAvailabilityInput
) => {
  const { goal, ownerUserId, target } = input;
  const source = goal.source,
    portable = source.portable;
  if (
    goal.desired !== "present" ||
    source.identityState !== "verified" ||
    !portable
  )
    return null;
  const resolved = await resolveConsumerSelection(
    client,
    { userId: ownerUserId },
    {
      version: 1,
      ownerUserId,
      target
    }
  );
  const available = await client.query(
    `select 1 from personal_source_bindings binding
       join sessions s on s.id=binding.local_session_id and s.owner_user_id=binding.owner_user_id
       where binding.owner_user_id=$1 and binding.local_session_id=$2 and binding.local_logical_session_id=$3
         and binding.originating_deployment_id=$4 and binding.originating_device_id=$5
         and binding.source_logical_session_id=$6 and binding.availability='available'
         and binding.retained_package_id is not null and s.logical_session_id=$3
         and s.visibility='personal' and s.invalidated_at is null and s.personal_deleted_at is null
         and s.repository_assignment_version=$7 and (s.folder_assignment->>'revision')::integer=$8
         and ${personalSourceSelectionSql("s", "$9")}
         and pds_session_recall_ready(s.id) and sync_session_recall_ready(s.id)
         and exists(select 1 from pds_logical_replicas replica where replica.local_session_id=s.id and replica.owner_user_id=$1)`,
    [
      ownerUserId,
      source.localSessionId,
      source.localLogicalSessionId,
      portable.originatingDeploymentId,
      portable.originatingDeviceId,
      portable.logicalSessionId,
      source.contextVersion.git,
      source.contextVersion.folder,
      resolved.selection
    ]
  );
  return available.rowCount === 1
    ? {
        originatingDeploymentId: portable.originatingDeploymentId,
        originatingDeviceId: portable.originatingDeviceId,
        logicalSessionId: portable.logicalSessionId
      }
    : null;
};

/** Exact native Conversation proof. A retained receiving checkpoint cannot supply
 * a new source origin, even when its provider ID or local Session UUID matches. */
export const resolveNativeConversationSharingSource = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    sessionId: string;
    deploymentProtocolId: string;
  }
) => {
  const result = await client.query<{ source_identity: unknown }>(
    `select jsonb_build_object('originatingDeploymentId',binding.originating_deployment_id,
       'originatingDeviceId',binding.originating_device_id,'logicalSessionId',binding.source_logical_session_id) source_identity
     from sessions s join personal_source_bindings binding on binding.owner_user_id=s.owner_user_id
       and binding.local_session_id=s.id and binding.local_logical_session_id=s.logical_session_id
       and binding.context_version=1 and binding.availability='available' and binding.retained_package_id is null
       and binding.git_state='available' and binding.folder_state='available'
     where s.id=$1 and s.owner_user_id=$2 and s.visibility='personal' and s.invalidated_at is null and s.personal_deleted_at is null
       and pds_session_recall_ready(s.id) and sync_session_recall_ready(s.id)
       and not exists(select 1 from pds_logical_replicas where local_session_id=s.id)
       and not exists(select 1 from local_captured_session_logical_memories local_source
         join memory_replicas replica on replica.logical_memory_id=local_source.logical_memory_id
         where local_source.local_session_id=s.id and replica.replica_role='target')`,
    [input.sessionId, input.ownerUserId]
  );
  if (result.rows.length !== 1) return null;
  return {
    sourceIdentity: sharingRuleSourceIdentitySchema.parse(
      result.rows[0]!.source_identity
    ),
    logicalMemoryId: crossIdentitySyncDeterministicUuid({
      protocol: "koed.captured-session-sync/v2",
      sourceDeploymentId: input.deploymentProtocolId,
      sourceUserId: input.ownerUserId,
      originSessionId: input.sessionId,
      identity: "logical-memory"
    })
  };
};

/** Resolve only a verified portable Project alias. A native view ID, label or
 * path cannot substitute for its signed Personal membership identity. */
export const resolveTakeoverSelectionTarget = async (
  client: pg.PoolClient,
  ownerUserId: string,
  raw: ReturnType<typeof sharingSelectionTargetSchema.parse>
) => {
  const target = sharingSelectionTargetSchema.parse(raw);
  if (target.kind === "folder")
    return target.folder.ownerUserId === ownerUserId ? target : null;
  if (target.kind !== "project") return target;
  if (target.project.ownerUserId !== ownerUserId) return null;
  const result = await client.query<{ project_identity: string }>(
    `select catalog.project_identity from personal_named_projects project
       join personal_membership_entities catalog on catalog.owner_user_id=project.owner_user_id
         and catalog.local_project_id=project.project_id and catalog.entity_kind='project'
         and catalog.state='available' and catalog.current_revision->'operation'->>'kind'='set_project'
       where project.owner_user_id=$1 and project.deleted_at is null and ${personalProjectIdentityMatchesSql("project", "$2::text")}`,
    [ownerUserId, target.project.projectId]
  );
  if (result.rows.length !== 1) return null;
  return {
    kind: "project" as const,
    project: { ownerUserId, projectId: result.rows[0]!.project_identity }
  };
};

/** A locally created Project keeps its own identity before Personal sync is
 * configured. A receiving view must resolve through its available catalog;
 * unresolved/conflicting catalog rows cannot fall back to a native UUID. */
export const resolveSharingSelectionTarget = async (
  client: pg.PoolClient,
  ownerUserId: string,
  raw: ReturnType<typeof sharingSelectionTargetSchema.parse>
) => {
  const portable = await resolveTakeoverSelectionTarget(
    client,
    ownerUserId,
    raw
  );
  if (
    portable ||
    raw.kind !== "project" ||
    raw.project.ownerUserId !== ownerUserId
  )
    return portable;
  const native = await client.query(
    `select 1 from personal_named_projects project join users owner on owner.id=project.owner_user_id
       and owner.disabled_at is null and owner.deleted_at is null
     where project.owner_user_id=$1 and project.project_id::text=$2 and project.deleted_at is null
       and exists(select 1 from personal_membership_changes change where change.owner_user_id=project.owner_user_id
         and change.project_id=project.project_id and change.entity_id=project.project_id
         and change.revision_id=project.head_revision_id and change.operation='set_project')
       and exists(select 1 from personal_membership_changes origin_change where origin_change.owner_user_id=project.owner_user_id
         and origin_change.project_id=project.project_id and origin_change.entity_id=project.project_id
         and origin_change.operation='set_project' and cardinality(origin_change.replaces)=0)
       and not exists(select 1 from personal_membership_entities catalog where catalog.owner_user_id=project.owner_user_id
         and catalog.entity_kind='project' and (catalog.local_project_id=project.project_id or catalog.project_identity=$2))`,
    [ownerUserId, raw.project.projectId]
  );
  return native.rowCount === 1 ? sharingSelectionTargetSchema.parse(raw) : null;
};

/** Read an exact available local native source or authenticated receiving
 * checkpoint for reviewed publisher takeover. Returns Personal evidence only;
 * the owner-authorized Team review must resolve its existing rule member. */
export const resolvePublisherTakeoverSource = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    sessionId: string;
    target?: ReturnType<typeof sharingSelectionTargetSchema.parse>;
  }
) => {
  const target = input.target
    ? await resolveTakeoverSelectionTarget(
        client,
        input.ownerUserId,
        input.target
      )
    : undefined;
  if (target === null) return null;
  const resolved = target
    ? await resolveConsumerSelection(
        client,
        { userId: input.ownerUserId },
        { version: 1, ownerUserId: input.ownerUserId, target }
      )
    : null;
  const result = await client.query<{
    local_session_id: string;
    local_logical_session_id: string;
    git_version: number;
    folder_version: number;
    source_identity: unknown;
  }>(
    `select s.id local_session_id,s.logical_session_id local_logical_session_id,s.repository_assignment_version git_version,
       (s.folder_assignment->>'revision')::integer folder_version,
       jsonb_build_object('originatingDeploymentId',binding.originating_deployment_id,'originatingDeviceId',binding.originating_device_id,'logicalSessionId',binding.source_logical_session_id) source_identity
     from sessions s join personal_source_bindings binding on binding.owner_user_id=s.owner_user_id
       and binding.local_session_id=s.id and binding.local_logical_session_id=s.logical_session_id
       and binding.context_version=1 and binding.availability='available'
       and binding.git_state='available' and binding.folder_state='available'
     where s.id=$1 and s.owner_user_id=$2 and s.visibility='personal' and s.invalidated_at is null and s.personal_deleted_at is null
       and pds_session_recall_ready(s.id) and sync_session_recall_ready(s.id)
       and ($3::jsonb is null or ${personalSourceSelectionSql("s", "$3")})
       and ((binding.retained_package_id is not null and exists(select 1 from pds_logical_replicas replica where replica.owner_user_id=$2 and replica.local_session_id=s.id))
         or (binding.retained_package_id is null
           and not exists(select 1 from pds_logical_replicas where local_session_id=s.id)
           and not exists(select 1 from local_captured_session_logical_memories local_source join memory_replicas replica on replica.logical_memory_id=local_source.logical_memory_id where local_source.local_session_id=s.id and replica.replica_role='target')))`,
    [input.sessionId, input.ownerUserId, resolved?.selection ?? null]
  );
  if (result.rows.length !== 1) return null;
  const row = result.rows[0]!,
    sourceIdentity = sharingRuleSourceIdentitySchema.parse(row.source_identity);
  return {
    sourceIdentity,
    source:
      personalSelectionConsumerPageSchema.shape.entries.element.shape.source.parse(
        {
          localSessionId: row.local_session_id,
          localLogicalSessionId: row.local_logical_session_id,
          identityState: "verified",
          portable: { ownerUserId: input.ownerUserId, ...sourceIdentity },
          contextVersion: { git: row.git_version, folder: row.folder_version }
        }
      ),
    ...(target ? { target } : {})
  };
};

/** Bounded discovery of verified Personal bindings, including Conversations
 * outside the current selection and retained explicit deletions. Team member
 * hashes are compared locally; no Team ID is treated as a native Session ID.
 * Eligibility/removal still requires evaluation against a completed selection. */
export const readPublisherTakeoverSourceBindings = async (
  client: pg.PoolClient,
  input: { ownerUserId: string; afterBindingId?: string }
) => {
  const result = await client.query<{
    binding_id: string;
    local_session_id: string;
    local_logical_session_id: string;
    git_version: number;
    folder_version: number;
    source_identity: unknown;
  }>(
    `select binding.binding_id,s.id local_session_id,s.logical_session_id local_logical_session_id,
       s.repository_assignment_version git_version,(s.folder_assignment->>'revision')::integer folder_version,
       jsonb_build_object('originatingDeploymentId',binding.originating_deployment_id,
         'originatingDeviceId',binding.originating_device_id,'logicalSessionId',binding.source_logical_session_id) source_identity
     from personal_source_bindings binding join sessions s on s.id=binding.local_session_id
       and s.owner_user_id=binding.owner_user_id and s.logical_session_id=binding.local_logical_session_id
     where binding.owner_user_id=$1 and ($2::uuid is null or binding.binding_id>$2::uuid)
       and binding.context_version=1 and binding.availability='available'
       and binding.git_state='available' and binding.folder_state='available'
       and s.visibility='personal' and s.invalidated_at is null
       and ((binding.retained_package_id is not null and exists(select 1 from pds_logical_replicas replica
           where replica.owner_user_id=$1 and replica.local_session_id=s.id))
         or (binding.retained_package_id is null
           and not exists(select 1 from pds_logical_replicas where local_session_id=s.id)
           and not exists(select 1 from local_captured_session_logical_memories local_source
             join memory_replicas replica on replica.logical_memory_id=local_source.logical_memory_id
             where local_source.local_session_id=s.id and replica.replica_role='target')))
     order by binding.binding_id limit 101`,
    [input.ownerUserId, input.afterBindingId ?? null]
  );
  const entries = result.rows.slice(0, 100).map((row) => {
    const identity = sharingRuleSourceIdentitySchema.parse(row.source_identity);
    return {
      bindingId: row.binding_id,
      source:
        personalSelectionConsumerPageSchema.shape.entries.element.shape.source.parse(
          {
            localSessionId: row.local_session_id,
            localLogicalSessionId: row.local_logical_session_id,
            identityState: "verified",
            portable: { ownerUserId: input.ownerUserId, ...identity },
            contextVersion: { git: row.git_version, folder: row.folder_version }
          }
        )
    };
  });
  return {
    entries,
    nextAfterBindingId:
      result.rows.length > 100 ? entries.at(-1)!.bindingId : null
  };
};
