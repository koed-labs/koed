import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import {
  personalGitAssignmentSchema,
  personalFolderAssignmentSchema,
  personalOwnerIdSchema,
  type PersonalFolderAssignment
} from "@koed/shared";
import type { PersonalSourceBindingRow } from "./personal-source-binding-state.js";

export const sourceContextViewRevisionId = (
  bindingId: string,
  axis: "git" | "folder",
  state: string,
  frontier: readonly string[]
) =>
  `view_${createHash("sha256")
    .update(JSON.stringify([bindingId, axis, state, [...frontier].sort()]))
    .digest("hex")}`;
/** Only the effective native fields change. Original signed records and Project organization remain intact. */
export const projectPersonalSourceBinding = async (
  client: pg.PoolClient,
  previous: PersonalSourceBindingRow,
  binding: PersonalSourceBindingRow
) => {
  if (!binding.local_session_id || binding.context_version !== 1) return;
  const native = await client.query<{
    repository_assignment_version: number;
    folder_assignment: PersonalFolderAssignment;
  }>(
    "select repository_assignment_version,folder_assignment from sessions where owner_user_id=$1 and id=$2 and visibility='personal' and invalidated_at is null and personal_deleted_at is null for update",
    [binding.owner_user_id, binding.local_session_id]
  );
  const row = native.rows[0];
  if (!row) throw new TypeError("PdsCryptoSourceBindingSessionError");
  const gitChanged =
    previous.context_version !== 1 ||
    previous.git_state !== binding.git_state ||
    !isDeepStrictEqual(previous.git_frontier, binding.git_frontier);
  const folderChanged =
    previous.context_version !== 1 ||
    previous.folder_state !== binding.folder_state ||
    !isDeepStrictEqual(previous.folder_frontier, binding.folder_frontier);
  if (gitChanged || folderChanged)
    await client.query(
      "select set_config('koed.personal_source_context_binding_id',$1,true)",
      [binding.binding_id]
    );
  if (gitChanged) {
    const original = personalGitAssignmentSchema.shape.original.parse(
      binding.git_original
    );
    const automatic = original.state === "known" ? original.value : null;
    const assignment =
      binding.git_state === "available"
        ? personalGitAssignmentSchema.parse(binding.git_assignment)
        : null;
    const correction =
      assignment?.correction.state === "corrected"
        ? assignment.correction.value
        : null;
    const unresolved =
      binding.git_state !== "available" || correction?.state === "unresolved";
    const override =
      correction?.state === "known"
        ? correction.value
        : unresolved
          ? {
              kind: "unresolved",
              key: null,
              root: null,
              branch: null,
              reason:
                binding.git_state === "conflict"
                  ? "selection_conflict"
                  : "selection_missing",
              checkoutId: null,
              originatingDeviceId: binding.originating_device_id,
              selectedRemote: null,
              anchorDisplay: null
            }
          : null;
    const head =
      binding.git_state === "available" && binding.git_frontier.length === 1
        ? binding.git_frontier[0]
        : null;
    const uuidHead = personalOwnerIdSchema.safeParse(head);
    await client.query(
      `update sessions set repository_automatic_identity=$3,repository_assignment_state=$4,repository_override_identity=$5,
      repository_assignment_revision_id=$6,repository_assignment_version=repository_assignment_version+1,updated_at=now() where owner_user_id=$1 and id=$2`,
      [
        binding.owner_user_id,
        binding.local_session_id,
        automatic,
        automatic
          ? "recorded"
          : original.state === "unresolved" &&
              original.reason === "historical_unresolved"
            ? "historical_unresolved"
            : "recorded",
        override,
        uuidHead.success ? uuidHead.data : null
      ]
    );
  }
  if (folderChanged) {
    const original = personalFolderAssignmentSchema.shape.original.parse(
      binding.folder_original
    );
    const assignment =
      binding.folder_state === "available"
        ? personalFolderAssignmentSchema.parse(binding.folder_assignment)
        : null;
    const projection: PersonalFolderAssignment = {
      revision: row.folder_assignment.revision + 1,
      original,
      correction: assignment
        ? assignment.correction
        : {
            state: "corrected",
            revisionId: sourceContextViewRevisionId(
              binding.binding_id,
              "folder",
              binding.folder_state,
              binding.folder_frontier
            ),
            value: {
              state: "unresolved",
              reason:
                binding.folder_state === "conflict"
                  ? "source_context_conflict"
                  : "source_context_pending"
            }
          }
    };
    await client.query(
      "update sessions set folder_assignment=$3,updated_at=now() where owner_user_id=$1 and id=$2",
      [
        binding.owner_user_id,
        binding.local_session_id,
        personalFolderAssignmentSchema.parse(projection)
      ]
    );
  }
};
