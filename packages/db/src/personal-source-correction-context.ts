import {
  readPersonalSourceBinding,
  readPersonalSourceContextSync
} from "./personal-source-binding-state.js";
import { sourceContextViewRevisionId } from "./personal-source-context-projection.js";
import type pg from "pg";
import {
  personalFolderAssignmentSchema,
  personalFolderContextSchema,
  personalGitContextSchema,
  personalSourceContextStateSchema,
  repositoryScopeId,
  type PersonalFolderAssignment,
  type PersonalGitAssignment,
  type PersonalSourceContextSync,
  personalGitAssignmentSchema,
  type PersonalSourceCorrectionInput,
  type RepositoryIdentity
} from "@koed/shared";
import type { ActorContext } from "./types.js";

export type PersonalCorrectionSourceRow = {
  id: string;
  logical_session_id: string;
  folder_assignment: PersonalFolderAssignment;
  repository_assignment_state: "recorded" | "historical_unresolved";
  repository_assignment_version: number;
  repository_automatic_identity: RepositoryIdentity | null;
  repository_override_identity: RepositoryIdentity | null;
  git_revision_id: string | null;
  import_observed_at: Date | null;
  source_sync?: PersonalSourceContextSync;
  source_body_pending?: boolean;
  source_git_original?: PersonalGitAssignment["original"];
};
export const lockPersonalCorrectionSource = async (
  client: pg.PoolClient,
  actor: ActorContext,
  sessionId: string
) => {
  const found = await client.query<PersonalCorrectionSourceRow>(
    `select s.id,s.logical_session_id,s.folder_assignment,s.repository_assignment_state,s.repository_assignment_version,s.repository_automatic_identity,s.repository_override_identity,s.import_observed_at,
    coalesce(s.repository_assignment_revision_id,(select c.revision_id from personal_source_context_changes c where c.owner_user_id=s.owner_user_id and c.logical_session_id=s.logical_session_id and c.axis='git' and c.version=s.repository_assignment_version)) as git_revision_id
    from sessions s where s.owner_user_id=$1 and s.id=$2 and s.visibility='personal' and s.invalidated_at is null and s.personal_deleted_at is null for update of s`,
    [actor.userId, sessionId]
  );
  const row = found.rows[0];
  if (!row)
    throw Object.assign(new Error("Conversation not found or not available"), {
      statusCode: 404
    });
  const binding = await readPersonalSourceBinding(
    client,
    actor.userId,
    sessionId
  );
  row.source_body_pending = binding?.availability === "pending";
  if (binding?.context_version === 1) {
    row.source_sync = await readPersonalSourceContextSync(client, binding);
    row.source_git_original = personalGitAssignmentSchema.shape.original.parse(
      binding.git_original
    );
    row.git_revision_id =
      binding.git_state === "available" && binding.git_frontier.length === 1
        ? binding.git_frontier[0]!
        : sourceContextViewRevisionId(
            binding.binding_id,
            "git",
            binding.git_state,
            binding.git_frontier
          );
  }
  return row;
};
export const personalCorrectionContext = (row: PersonalCorrectionSourceRow) => {
  const original = personalGitContextSchema.safeParse(
    row.repository_automatic_identity
  );
  const override = personalGitContextSchema.safeParse(
    row.repository_override_identity
  );
  const git: PersonalGitAssignment = {
    revision: row.repository_assignment_version,
    original:
      row.source_git_original ??
      (original.success
        ? { state: "known", value: original.data }
        : {
            state: "unresolved",
            reason:
              row.repository_assignment_state === "historical_unresolved" ||
              (!row.repository_automatic_identity && row.import_observed_at)
                ? "historical_unresolved"
                : row.repository_automatic_identity
                  ? "unreliable"
                  : "missing"
          }),
    correction: row.repository_override_identity
      ? {
          state: "corrected",
          value: override.success
            ? { state: "known", value: override.data }
            : { state: "unresolved", reason: "explicit_unresolved" },
          revisionId:
            row.git_revision_id ??
            `legacy_git_${row.repository_assignment_version}`
        }
      : { state: "original" }
  };
  if (row.source_sync && row.source_sync.git.state !== "available")
    git.correction = {
      state: "corrected",
      revisionId: row.git_revision_id!,
      value: {
        state: "unresolved",
        reason:
          row.source_sync.git.state === "conflict"
            ? "source_context_conflict"
            : "source_context_pending"
      }
    };
  return personalSourceContextStateSchema.parse({
    ...(row.source_sync ? { sync: row.source_sync } : {}),
    sessionId: row.id,
    logicalSessionId: row.logical_session_id,
    git,
    folder: row.folder_assignment
  });
};
const unavailable = () =>
  Object.assign(
    new Error(
      "Recorded source context is unavailable. Capture from that context before correcting it."
    ),
    { statusCode: 404 }
  );
/** Resolve a selected identity from owned recorded facts, never caller display paths. */
export const personalCorrectionPatch = async (
  client: pg.PoolClient,
  actor: ActorContext,
  row: PersonalCorrectionSourceRow,
  input: PersonalSourceCorrectionInput,
  revisionId: string
): Promise<Record<string, unknown>> => {
  if (input.axis === "git") {
    let identity: RepositoryIdentity | null = null;
    if (input.action === "set") {
      const scope = repositoryScopeId(input.repository);
      const targets = await client.query<{ identity: unknown }>(
        `select fact.identity from sessions s cross join lateral (values(s.repository_automatic_identity),(s.repository_override_identity)) fact(identity)
        where s.owner_user_id=$1 and s.visibility='personal' and s.personal_deleted_at is null and repository_scope_id(fact.identity)=$2
        union all select o.identity from session_repository_observations o join sessions s on s.id=o.session_id
        where o.owner_user_id=$1 and s.owner_user_id=$1 and s.visibility='personal' and s.personal_deleted_at is null and repository_scope_id(o.identity)=$2 union all select fact.identity from personal_source_context_revisions r
        join personal_source_bindings b on b.binding_id=r.binding_id join sessions s on s.id=b.local_session_id
        cross join lateral(values(r.assignment->'original'->'value'),(r.assignment->'correction'->'value'->'value')) fact(identity)
        where b.owner_user_id=$1 and s.owner_user_id=$1 and s.invalidated_at is null and s.personal_deleted_at is null and r.axis='git' and repository_scope_id(fact.identity)=$2 limit 1`,
        [actor.userId, scope]
      );
      const known = personalGitContextSchema.safeParse(
        targets.rows[0]?.identity
      );
      if (!known.success) throw unavailable();
      identity = known.data;
    } else if (input.action === "unresolved") {
      identity = {
        kind: "unresolved",
        key: null,
        root: null,
        branch: null,
        reason: "selection_missing",
        checkoutId: null,
        originatingDeviceId:
          row.repository_automatic_identity?.originatingDeviceId ??
          row.repository_override_identity?.originatingDeviceId ??
          "unresolved",
        selectedRemote: null,
        anchorDisplay: null
      };
    }
    return { repository_override_identity: identity };
  }
  let assignment: PersonalFolderAssignment;
  const original = personalFolderAssignmentSchema.parse(row.folder_assignment);
  if (input.action === "reset")
    assignment = {
      ...original,
      revision: original.revision + 1,
      correction: { state: "original" }
    };
  else {
    let value: PersonalFolderAssignment["original"] = {
      state: "unresolved",
      reason: "explicit_unresolved"
    };
    if (input.action === "set") {
      if (input.folder.ownerUserId !== actor.userId)
        throw Object.assign(new Error("Folder belongs to another owner"), {
          statusCode: 403
        });
      const target = await client.query<{ context: unknown }>(
        `select fact.value->'value' as context from sessions s
        cross join lateral(values(s.folder_assignment->'original'),(s.folder_assignment->'correction'->'value')) fact(value)
        where s.owner_user_id=$1 and s.visibility='personal' and s.personal_deleted_at is null and fact.value->>'state'='known' and fact.value->'value'->'reference'=$2::jsonb
        union all select jsonb_build_object('reference',o.observation->'identity'||jsonb_build_object('ownerUserId',o.owner_user_id),'normalizedPath',o.observation->'normalizedPath','capturedPath',o.observation->'capturedPath')
        from session_folder_observations o join sessions s on s.id=o.session_id where o.owner_user_id=$1 and s.owner_user_id=$1 and s.visibility='personal' and s.personal_deleted_at is null and (o.observation->'identity'||jsonb_build_object('ownerUserId',o.owner_user_id))=$2::jsonb union all select fact.value->'value' as context from personal_source_context_revisions r
        join personal_source_bindings b on b.binding_id=r.binding_id join sessions s on s.id=b.local_session_id
        cross join lateral(values(r.assignment->'original'),(r.assignment->'correction'->'value')) fact(value)
        where b.owner_user_id=$1 and s.owner_user_id=$1 and s.invalidated_at is null and s.personal_deleted_at is null and r.axis='folder' and fact.value->>'state'='known' and fact.value->'value'->'reference'=$2::jsonb limit 1`,
        [actor.userId, input.folder]
      );
      if (!target.rows[0]) throw unavailable();
      value = {
        state: "known",
        value: personalFolderContextSchema.parse(target.rows[0].context)
      };
    }
    assignment = {
      ...original,
      revision: original.revision + 1,
      correction: { state: "corrected", value, revisionId }
    };
  }
  return {
    folder_assignment: personalFolderAssignmentSchema.parse(assignment)
  };
};
