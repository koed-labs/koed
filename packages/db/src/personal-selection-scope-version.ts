import type pg from "pg";
import { crossIdentitySyncDigest } from "@koed/shared";
import type { ActorContext } from "./types.js";
import {
  resolveConsumerSelection,
  selectionConsumerError,
  type ConsumerCursor,
  type SelectionConsumerOptions
} from "./personal-selection-consumer-state.js";
import { personalSourceSelectionSql } from "./personal-selection-sql.js";
import { personalProjectMembershipReasonsSql } from "./personal-project-rule-repository.js";

/** A bounded owner-only membership version for continuous consent and
 * publication enumeration. Content changes remain in the delivery journal. */
export const personalSelectionScopeVersion = async (
  client: pg.PoolClient,
  actor: ActorContext,
  selection: ConsumerCursor["selection"],
  options: SelectionConsumerOptions
): Promise<string> => {
  const resolved = await resolveConsumerSelection(
    client,
    actor,
    selection,
    options
  );
  const named = resolved.nativeProjectId;
  const reasons = named
    ? personalProjectMembershipReasonsSql("s", "$1", "$3")
    : `select jsonb_build_object('kind','selection','targetKind',$3::text) value`;
  const result = await client.query<{
    scope_digest?: string;
    id: string;
    logical_session_id: string;
    git_version: number;
    folder_version: number;
    portable: unknown;
    reason: unknown;
  }>(
    `with selected as materialized (
       select s.id,s.logical_session_id,
         s.repository_assignment_version git_version,
         (s.folder_assignment->>'revision')::int folder_version,
         case when b.binding_id is not null then jsonb_build_object(
           'ownerUserId',b.owner_user_id,'originatingDeploymentId',b.originating_deployment_id,
           'originatingDeviceId',b.originating_device_id,'logicalSessionId',b.source_logical_session_id
         ) else null end portable,reason.value reason
       from sessions s
       left join personal_source_bindings b on b.owner_user_id=s.owner_user_id
         and b.local_session_id=s.id and b.local_logical_session_id=s.logical_session_id
         and b.availability='available'
       cross join lateral (${reasons}) reason
       where s.owner_user_id=$1 and not $4::boolean
         and ${personalSourceSelectionSql("s", "$2")}
         and pds_session_recall_ready(s.id)
         and not exists(select 1 from personal_source_bindings pending
           where pending.owner_user_id=s.owner_user_id and pending.local_session_id=s.id
             and (pending.availability<>'available' or pending.local_logical_session_id is distinct from s.logical_session_id))
       order by s.id,reason.value::text ${options.scopeToSharingMembership ? "" : "limit 10001"}
     )
     ${
       options.scopeToSharingMembership
         ? `select encode(sha256(convert_to(coalesce(string_agg(
           encode(sha256(convert_to(to_jsonb(selected)::text,'UTF8')),'hex'),''
           order by selected.id,selected.reason::text),''),'UTF8')),'hex') scope_digest from selected`
         : "select * from selected order by selected.id,selected.reason::text"
     }`,
    [
      actor.userId,
      resolved.selection,
      named ?? selection.target.kind,
      resolved.projectDeleted === true
    ]
  );
  if (
    !options.scopeToSharingMembership &&
    (result.rows.length > 10000 ||
      new Set(result.rows.map((row) => row.id)).size > 5000)
  )
    throw selectionConsumerError(
      "selection_review_too_large",
      409,
      "This selection is too large for a complete review."
    );
  // Continuous selection consent includes later content. Fence the selected
  // identities, membership and context rather than a changing content head.
  // Read the current state in this repeatable-read transaction; journal sequence
  // allocation is neither a commit watermark nor sharing authority.
  const hash = crossIdentitySyncDigest({
    purpose: "personal-selection-sharing-review-v1",
    selection,
    projectVersion: resolved.projectVersion ?? null,
    projectDeleted: resolved.projectDeleted === true,
    entries: options.scopeToSharingMembership
      ? result.rows[0]!.scope_digest
      : result.rows
  });
  // snapshotVersion is an opaque UUID throughout the existing review protocol.
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${((Number.parseInt(hash[16]!, 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};
