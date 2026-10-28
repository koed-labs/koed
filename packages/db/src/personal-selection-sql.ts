import {
  personalProjectCatalogReadySql,
  personalGraphExclusionBlocksSql,
  personalProjectIdentityMatchesSql,
  personalDirectMembershipReadySql,
  personalRuleMembershipReadySql
} from "./personal-membership-selection-sql.js";
import {
  authorizedPersonalSelectionSnapshot,
  personalSelectionLegacyScope,
  type PersonalSelectionSnapshot,
  type PersonalFolderReference
} from "@koed/shared";
import type pg from "pg";
import { semanticMemoryEventEligibleSql } from "./approval-activity-sql.js";

export type PersonalSourceSelection = {
  ownerUserId: string;
  searchDomain: "global" | "project" | "session";
  projectId?: string;
  sessionId?: string;
  namedProjectId?: string;
  folder?: PersonalFolderReference;
};

export type PersonalSelectionQuery = {
  personalSelection?: PersonalSelectionSnapshot;
  searchDomain?: "global" | "project" | "session";
  projectId?: string;
  sessionId?: string;
};

export type PersonalSourceReadOptions = {
  /** Server-owned parameter for an already enumerated native ID batch. */
  sessionIdsParameter?: string;
  includeInvalidated?: boolean;
  includeUnassigned?: boolean;
  inspection?: boolean;
  /** Metadata-only explanation reads; never accepted from a caller selection. */
  ignoreProjectExclusions?: boolean;
};

export const personalEffectiveFolderFactSql = (session: string): string =>
  `(case when ${session}.folder_assignment->'correction'->>'state'='corrected'
    then ${session}.folder_assignment->'correction'->'value'
    else ${session}.folder_assignment->'original' end)`;

/** One rule predicate for membership, previews, and explanation; paths are never authority. */
export const personalProjectRuleMatchesSql = (
  session: string,
  rule: string
): string => `(
  ${personalRuleMembershipReadySql(rule)} and (
  (${rule}.target->>'kind'='repository' and repository_scope_matches(
    coalesce(${session}.repository_override_identity,${session}.repository_automatic_identity),${rule}.target_scope))
  or (${rule}.target->>'kind'='folder' and ${personalEffectiveFolderFactSql(session)}->>'state'='known'
    and ${personalEffectiveFolderFactSql(session)}->'value'->'reference'=${rule}.target->'folder')
  )
)`;

/** Inventory accepts established legacy filters without discovering any new context. */
export const projectPersonalInspectionQuery = <
  T extends PersonalSelectionQuery
>(
  ownerUserId: string,
  input: T
) =>
  projectPersonalSelectionQuery(ownerUserId, {
    ...input,
    searchDomain:
      input.searchDomain ??
      (input.sessionId ? "session" : input.projectId ? "project" : "global")
  });

/** Accepted targets take precedence. Global can keep a caller's narrower query. */
export const projectPersonalSelectionQuery = <T extends PersonalSelectionQuery>(
  ownerUserId: string,
  input: T
): { input: T; selection: PersonalSourceSelection } => {
  const accepted = resolvePersonalSourceSelection(ownerUserId, input);
  const projected =
    input.personalSelection && accepted.searchDomain !== "global"
      ? {
          ...input,
          searchDomain: accepted.searchDomain,
          projectId: accepted.projectId,
          sessionId:
            accepted.searchDomain === "project"
              ? input.sessionId
              : accepted.sessionId
        }
      : input;
  return {
    input: projected,
    selection: {
      ...resolvePersonalSourceSelection(ownerUserId, {
        ...projected,
        personalSelection: undefined
      }),
      ...(accepted.namedProjectId
        ? { namedProjectId: accepted.namedProjectId }
        : {}),
      ...(accepted.folder ? { folder: accepted.folder } : {})
    }
  };
};

/** Compatibility projection stays in one module while each caller migrates. */
export const resolvePersonalSourceSelection = (
  ownerUserId: string,
  input: {
    personalSelection?: PersonalSelectionSnapshot;
    searchDomain?: "global" | "project" | "session";
    projectId?: string;
    sessionId?: string;
  }
): PersonalSourceSelection => {
  const snapshot = input.personalSelection
    ? authorizedPersonalSelectionSnapshot(input.personalSelection, ownerUserId)
    : undefined;
  const scope = snapshot
    ? personalSelectionLegacyScope(snapshot)
    : {
        searchDomain: input.searchDomain ?? "global",
        projectId: input.projectId,
        sessionId: input.sessionId
      };
  if (scope.searchDomain === "project" && !scope.projectId)
    throw new Error("Personal Project selection requires a pinned identity");
  if (scope.searchDomain === "session" && !scope.sessionId)
    throw new Error(
      "Personal Conversation selection requires a pinned identity"
    );
  return {
    ownerUserId,
    searchDomain: scope.searchDomain,
    projectId: scope.projectId,
    sessionId: scope.sessionId,
    ...(snapshot?.version === 1 && snapshot.target.kind === "project"
      ? { namedProjectId: snapshot.target.project.projectId }
      : {}),
    ...(snapshot?.version === 1 && snapshot.target.kind === "folder"
      ? { folder: snapshot.target.folder }
      : {})
  };
};

/** Parameter is JSON from resolvePersonalSourceSelection, never unvalidated caller JSON.
 * Global permits owner-bound standalone Memory with no Session. A present Session
 * must be eligible even for Global. Callers also check the evidence row's owner,
 * eligibility and time bounds before limits and before decrypting source content.
 */
export const personalSourceSelectionSql = (
  session: string,
  parameter: string,
  options: PersonalSourceReadOptions = {}
): string => `(
  ${options.sessionIdsParameter ? `(${options.sessionIdsParameter}::uuid[] is null or ${session}.id=any(${options.sessionIdsParameter}::uuid[])) and` : ""}
  (
  (${session}.id is null and (${parameter}::jsonb->>'searchDomain'='global'${options.includeUnassigned ? ` or (${parameter}::jsonb->>'searchDomain'='project' and ${parameter}::jsonb->>'namedProjectId' is null and ${parameter}::jsonb->>'projectId'='unassigned')` : ""}))
  or (
    ${session}.owner_user_id=(${parameter}::jsonb->>'ownerUserId')::uuid
    and ${session}.visibility='personal'
    and not exists(select 1 from personal_source_bindings pending_source where pending_source.owner_user_id=${session}.owner_user_id and pending_source.local_session_id=${session}.id and pending_source.availability='pending')
    and (${parameter}::jsonb->>'searchDomain'<>'project' or ${parameter}::jsonb->>'sessionId' is null or ${session}.id=(${parameter}::jsonb->>'sessionId')::uuid)
    and ${options.includeInvalidated ? "true" : `${session}.invalidated_at is null and ${session}.personal_deleted_at is null${options.inspection ? "" : ` and sync_session_recall_ready(${session}.id)`}`}
    and (
      ${parameter}::jsonb->>'searchDomain'='global'
      or (${parameter}::jsonb->>'searchDomain'='session' and ${session}.id=(${parameter}::jsonb->>'sessionId')::uuid)
      or (${parameter}::jsonb->>'searchDomain'='project' and ${parameter}::jsonb->>'namedProjectId' is null and ${parameter}::jsonb->'folder' is null and repository_scope_matches(
        coalesce(${session}.repository_override_identity,${session}.repository_automatic_identity),${parameter}::jsonb->>'projectId'))
      or (${parameter}::jsonb->'folder' is not null and ${personalEffectiveFolderFactSql(session)}->>'state'='known'
        and ${personalEffectiveFolderFactSql(session)}->'value'->'reference'=${parameter}::jsonb->'folder')
      or (${parameter}::jsonb->>'namedProjectId' is not null and exists (
        select 1 from personal_named_projects selected_project
        where selected_project.owner_user_id=${session}.owner_user_id and selected_project.deleted_at is null
          and ${personalProjectCatalogReadySql("selected_project")}
          and ${personalProjectIdentityMatchesSql("selected_project", `${parameter}::jsonb->>'namedProjectId'`)}
          ${
            options.ignoreProjectExclusions
              ? ""
              : `and not exists (select 1 from personal_project_exclusions selected_exclusion
            where selected_exclusion.owner_user_id=selected_project.owner_user_id and selected_exclusion.project_id=selected_project.project_id
              and selected_exclusion.logical_session_id=${session}.logical_session_id and selected_exclusion.cleared_at is null)
            and not ${personalGraphExclusionBlocksSql(session, "selected_project.owner_user_id", "selected_project.project_id")}`
          }
          and (
            exists (select 1 from personal_project_inclusions selected_inclusion
              where selected_inclusion.owner_user_id=selected_project.owner_user_id
                and selected_inclusion.project_id=selected_project.project_id and selected_inclusion.removed_at is null
                and selected_inclusion.logical_session_id=${session}.logical_session_id
                and ${personalDirectMembershipReadySql("selected_inclusion", session)})
            or exists (select 1 from personal_project_rules selected_rule
              where selected_rule.owner_user_id=selected_project.owner_user_id and selected_rule.project_id=selected_project.project_id
                and selected_rule.removed_at is null and ${personalProjectRuleMatchesSql(session, "selected_rule")})
          )
      ))
      ${options.includeUnassigned ? `or (${parameter}::jsonb->>'searchDomain'='project' and ${parameter}::jsonb->>'namedProjectId' is null and ${parameter}::jsonb->>'projectId'='unassigned' and repository_scope_id(coalesce(${session}.repository_override_identity,${session}.repository_automatic_identity)) is null)` : ""}
    )
  )
)
)`;

/** Recheck current authorization after candidate selection and before source decryption. */
export const authorizedPersonalRawEvidence = async (
  pool: Pick<pg.Pool, "query">,
  selection: PersonalSourceSelection,
  rows: Array<{ source_type: string; source_id: string }>,
  sourceAfter: Date | null,
  sourceBefore: Date | null
): Promise<Set<string>> => {
  const events = rows
    .filter((row) => row.source_type === "memory_event")
    .map((row) => row.source_id);
  const messages = rows
    .filter((row) => row.source_type === "message")
    .map((row) => row.source_id);
  if (events.length === 0 && messages.length === 0) return new Set();
  const result = await pool.query<{ source_type: string; source_id: string }>(
    `
    select 'memory_event' as source_type, ev.id::text as source_id
    from memory_events ev left join sessions s on s.id=ev.session_id
    where ev.id=any($3::uuid[]) and ev.owner_user_id=$1 and ev.visibility='personal'
      and ev.invalidated_at is null and ev.personal_deleted_at is null and ev.include_in_embedding=true
      and (${semanticMemoryEventEligibleSql("ev")})
      and ${personalSourceSelectionSql("s", "$2")}
      and ($5::timestamptz is null or coalesce(ev.source_event_time, ev.captured_at) >= $5)
      and ($6::timestamptz is null or coalesce(ev.source_event_time, ev.captured_at) < $6)
    union all
    select 'message', m.id::text
    from messages m left join sessions s on s.id=m.session_id
    where m.id=any($4::uuid[]) and m.owner_user_id=$1 and m.visibility='personal'
      and m.invalidated_at is null and m.recall_eligible=true
      and ${personalSourceSelectionSql("s", "$2")}
      and ($5::timestamptz is null or coalesce(m.source_event_time, m.captured_at) >= $5)
      and ($6::timestamptz is null or coalesce(m.source_event_time, m.captured_at) < $6)
  `,
    [
      selection.ownerUserId,
      JSON.stringify(selection),
      events,
      messages,
      sourceAfter,
      sourceBefore
    ]
  );
  return new Set(
    result.rows.map((row) => `${row.source_type}:${row.source_id}`)
  );
};
