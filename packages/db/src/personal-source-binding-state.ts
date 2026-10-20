import type pg from "pg";
import {
  personalSourceContextSyncSchema,
  personalGitAssignmentSchema,
  personalFolderAssignmentSchema,
  type PersonalGitAssignment,
  type PersonalFolderAssignment
} from "@koed/shared";

export type PersonalSourceBindingRow = {
  binding_id: string;
  owner_user_id: string;
  originating_deployment_id: string;
  originating_device_id: string;
  source_logical_session_id: string;
  originating_owner_user_id: string | null;
  local_session_id: string | null;
  local_logical_session_id: string | null;
  context_version: number;
  availability: "pending" | "available";
  git_original: PersonalGitAssignment["original"] | null;
  folder_original: PersonalFolderAssignment["original"] | null;
  git_state: "pending" | "available" | "conflict";
  folder_state: "pending" | "available" | "conflict";
  git_frontier: string[];
  folder_frontier: string[];
  git_assignment: PersonalGitAssignment | null;
  folder_assignment: PersonalFolderAssignment | null;
};
export const lockPersonalSourceContextOwner = async (
  client: pg.PoolClient,
  ownerUserId: string
) => {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    `personal-membership:${ownerUserId}`
  ]);
};
export const readPersonalSourceBinding = async (
  client: pg.PoolClient,
  ownerUserId: string,
  sessionId: string,
  lock = false
) => {
  const result = await client.query<PersonalSourceBindingRow>(
    `select * from personal_source_bindings where owner_user_id=$1 and local_session_id=$2 ${lock ? "for update" : ""}`,
    [ownerUserId, sessionId]
  );
  if (result.rows.length > 1)
    throw new TypeError("PdsCryptoAmbiguousSourceBindingError");
  return result.rows[0];
};
export const readPersonalSourceContextSync = async (
  client: pg.PoolClient,
  binding: PersonalSourceBindingRow
) => {
  if (binding.context_version !== 1) return undefined;
  const heads = await client.query<{
    axis: "git" | "folder";
    revision_id: string;
    assignment: unknown;
  }>(
    `select axis,revision_id,assignment from personal_source_context_revisions
    where binding_id=$1 and ((axis='git' and revision_id=any($2::text[])) or (axis='folder' and revision_id=any($3::text[]))) order by axis,revision_id`,
    [binding.binding_id, binding.git_frontier, binding.folder_frontier]
  );
  return personalSourceContextSyncSchema.parse({
    source: {
      ownerUserId: binding.owner_user_id,
      originatingDeploymentId: binding.originating_deployment_id,
      originatingDeviceId: binding.originating_device_id,
      logicalSessionId: binding.source_logical_session_id
    },
    availability: binding.availability,
    git: {
      state: binding.git_state,
      frontier: binding.git_frontier,
      heads: heads.rows
        .filter((row) => row.axis === "git")
        .map((row) => ({
          revisionId: row.revision_id,
          assignment: personalGitAssignmentSchema.parse(row.assignment)
        }))
    },
    folder: {
      state: binding.folder_state,
      frontier: binding.folder_frontier,
      heads: heads.rows
        .filter((row) => row.axis === "folder")
        .map((row) => ({
          revisionId: row.revision_id,
          assignment: personalFolderAssignmentSchema.parse(row.assignment)
        }))
    }
  });
};
