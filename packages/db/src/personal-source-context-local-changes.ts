import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import {
  personalGitAssignmentSchema,
  personalFolderAssignmentSchema,
  type PersonalGitAssignment,
  type PersonalFolderAssignment,
  type PersonalSourceContextSnapshot
} from "@koed/shared";
import {
  retainSourceContextRevision,
  type SourceContextRevision
} from "./personal-source-context-graph.js";
import { readPersonalSourceBinding } from "./personal-source-binding-state.js";

type Assignment = PersonalGitAssignment | PersonalFolderAssignment;
const schemaFor = (axis: "git" | "folder") =>
  axis === "git" ? personalGitAssignmentSchema : personalFolderAssignmentSchema;
export const retainPrebindingLocalSourceChanges = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    logicalSessionId: string;
    bindingId: string;
    snapshot: PersonalSourceContextSnapshot;
  }
) => {
  const rows = await client.query<{
    revision_id: string;
    axis: "git" | "folder";
    previous: { context: unknown };
    value: { context: unknown };
  }>(
    "select revision_id,axis,previous,value from personal_source_context_changes where owner_user_id=$1 and logical_session_id=$2 order by sequence",
    [input.ownerUserId, input.logicalSessionId]
  );
  const last = new Map<string, string>();
  for (const row of rows.rows) {
    const axis = row.axis,
      schema = schemaFor(axis),
      original = input.snapshot.context[axis].original;
    const before = schema.parse(
      (row.previous.context as Record<string, unknown>)[axis]
    );
    const native = schema.parse(
      (row.value.context as Record<string, unknown>)[axis]
    );
    const assignment = schema.parse({ ...native, original });
    let replaces = last.has(axis) ? [last.get(axis)!] : [];
    if (!replaces.length) {
      const candidates = input.snapshot[axis].revisions.filter((revision) => {
        const correction = revision.assignment.correction;
        return (
          revision.assignment.revision === before.revision &&
          (before.correction.state === "original"
            ? correction.state === "original"
            : correction.state === "corrected" &&
              isDeepStrictEqual(correction.value, before.correction.value))
        );
      });
      if (candidates.length === 1) replaces = [candidates[0]!.revisionId];
    }
    await retainSourceContextRevision(client, {
      bindingId: input.bindingId,
      axis,
      revision: { revisionId: row.revision_id, replaces, assignment },
      localChangeRevisionId: row.revision_id
    });
    last.set(axis, row.revision_id);
  }
};

/** The caller holds the owner journal lock and rechecks the exact preview before recording this node. */
export const recordBoundPersonalSourceCorrection = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    sessionId: string;
    axis: "git" | "folder";
    revisionId: string;
    assignment: Assignment;
  }
) => {
  const binding = await readPersonalSourceBinding(
    client,
    input.ownerUserId,
    input.sessionId,
    true
  );
  if (!binding || binding.context_version !== 1) return;
  const axis = input.axis,
    state = axis === "git" ? binding.git_state : binding.folder_state;
  if (state === "pending")
    throw Object.assign(
      new Error(
        "Source context history is pending. Synchronize it before correcting it."
      ),
      { statusCode: 409 }
    );
  const original =
    axis === "git" ? binding.git_original : binding.folder_original;
  if (!isDeepStrictEqual(input.assignment.original, original))
    throw new TypeError("PdsCryptoSourceOriginalProvenanceChangedError");
  const parents =
    axis === "git" ? binding.git_frontier : binding.folder_frontier;
  const revision: SourceContextRevision = {
    revisionId: input.revisionId,
    replaces: parents,
    assignment: input.assignment
  };
  await retainSourceContextRevision(client, {
    bindingId: binding.binding_id,
    axis,
    revision,
    localChangeRevisionId: input.revisionId
  });
  if (axis === "git")
    await client.query(
      "update personal_source_bindings set git_state='available',git_frontier=$2,git_assignment=$3,updated_at=now() where binding_id=$1",
      [binding.binding_id, [input.revisionId], input.assignment]
    );
  else
    await client.query(
      "update personal_source_bindings set folder_state='available',folder_frontier=$2,folder_assignment=$3,updated_at=now() where binding_id=$1",
      [binding.binding_id, [input.revisionId], input.assignment]
    );
};
