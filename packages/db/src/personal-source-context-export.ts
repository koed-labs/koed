import { readBoundPersonalSourceContextSnapshot } from "./personal-source-context-snapshot.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import {
  personalSourceReferenceSchema,
  personalSourceContextSnapshotSchema,
  personalGitAssignmentSchema,
  personalFolderAssignmentSchema,
  PdsConfigurationCompatibilityError,
  type PersonalSourceContextSnapshot
} from "@koed/shared";
import {
  lockPersonalCorrectionSource,
  personalCorrectionContext
} from "./personal-source-correction-context.js";
import {
  lockPersonalSourceContextOwner,
  readPersonalSourceBinding,
  type PersonalSourceBindingRow
} from "./personal-source-binding-state.js";
import {
  retainSourceContextRevision,
  type SourceContextRevision
} from "./personal-source-context-graph.js";

type Axis = "git" | "folder";
type Assignment = PersonalSourceContextSnapshot["context"][Axis];
const assignmentFor = (axis: Axis, value: unknown): Assignment =>
  (axis === "git"
    ? personalGitAssignmentSchema
    : personalFolderAssignmentSchema
  ).parse(value);
const unavailable = (device: string): never => {
  throw new PdsConfigurationCompatibilityError("source_context_v1", [device]);
};

/** Internal publication preparation. The caller owns the transaction and must negotiate before signing. */
export const preparePersonalSourceContextSnapshot = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    localSessionId: string;
    originatingDeploymentId: string;
    originatingDeviceId: string;
  }
): Promise<PersonalSourceContextSnapshot> => {
  await lockPersonalSourceContextOwner(client, input.ownerUserId);
  const native = await lockPersonalCorrectionSource(
    client,
    { userId: input.ownerUserId },
    input.localSessionId
  );
  // A receiving Session can only forward its retained signed source; it cannot become a new origin.
  const replica = await client.query(
    "select 1 from pds_logical_replicas where local_session_id=$1",
    [input.localSessionId]
  );
  if (replica.rowCount) return unavailable(input.originatingDeviceId);
  const source = personalSourceReferenceSchema.parse({
    ownerUserId: input.ownerUserId,
    originatingDeploymentId: input.originatingDeploymentId,
    originatingDeviceId: input.originatingDeviceId,
    logicalSessionId: native.logical_session_id
  });
  let binding = await readPersonalSourceBinding(
    client,
    input.ownerUserId,
    input.localSessionId,
    true
  );
  if (
    binding &&
    (binding.originating_deployment_id !== source.originatingDeploymentId ||
      binding.originating_device_id !== source.originatingDeviceId ||
      binding.source_logical_session_id !== source.logicalSessionId ||
      binding.context_version !== 1 ||
      binding.availability !== "available")
  )
    return unavailable(input.originatingDeviceId);
  const context = personalCorrectionContext(native);
  if (!binding) {
    // The old review system has no causal source revision. Keep unproven
    // context unavailable instead of signing invented ancestry or a named grouping.
    const legacy = await client.query(
      `select 1 from sessions s where s.owner_user_id=$1 and s.id=$2 and (
        s.repository_override_identity->>'kind'='local_project' or
        (s.project_override_by_user_id is not null and s.repository_assignment_revision_id is null) or
        (s.repository_assignment_revision_id is null and exists(select 1 from repository_assignment_reviews r
          where r.owner_user_id=s.owner_user_id and r.status='applied' and r.selected_session_ids @> to_jsonb(array[s.id::text]))) or
        exists(select 1 from personal_membership_changes c where c.owner_user_id=s.owner_user_id
          and c.operation='include_session' and c.value->>'logicalSessionId'=s.logical_session_id::text
          and c.value->'sourceProofRequired'='true'::jsonb)
      )`,
      [input.ownerUserId, input.localSessionId]
    );
    if (legacy.rowCount) return unavailable(input.originatingDeviceId);
    const audit = await client.query<{
      revision_id: string;
      axis: Axis;
      previous: { context: Record<string, unknown> };
      value: { context: Record<string, unknown> };
    }>(
      "select revision_id,axis,previous,value from personal_source_context_changes where owner_user_id=$1 and logical_session_id=$2 order by sequence",
      [input.ownerUserId, native.logical_session_id]
    );
    const histories = {
      git: [] as SourceContextRevision[],
      folder: [] as SourceContextRevision[]
    };
    for (const axis of ["git", "folder"] as const) {
      const changes = audit.rows.filter((change) => change.axis === axis);
      const baseline = assignmentFor(
        axis,
        changes[0]?.previous.context[axis] ?? context[axis]
      );
      if (
        baseline.correction.state !== "original" ||
        !isDeepStrictEqual(baseline.original, context[axis].original)
      )
        return unavailable(input.originatingDeviceId);
      const baselineId = `origin_${createHash("sha256").update(JSON.stringify({ source, axis, baseline })).digest("hex")}`;
      histories[axis].push({
        revisionId: baselineId,
        replaces: [],
        assignment: baseline
      });
      let previous: Assignment = baseline,
        head = baselineId;
      for (const change of changes) {
        const before = assignmentFor(axis, change.previous.context[axis]);
        const after = assignmentFor(axis, change.value.context[axis]);
        if (
          !isDeepStrictEqual(before, previous) ||
          !isDeepStrictEqual(after.original, baseline.original)
        )
          return unavailable(input.originatingDeviceId);
        histories[axis].push({
          revisionId: change.revision_id,
          replaces: [head],
          assignment: after
        });
        previous = after;
        head = change.revision_id;
      }
      if (!isDeepStrictEqual(previous, context[axis]))
        return unavailable(input.originatingDeviceId);
    }
    // Validate size and complete causal ancestry before establishing local authority.
    personalSourceContextSnapshotSchema.parse({
      version: "1",
      context: { version: 1, source, git: context.git, folder: context.folder },
      git: { head: histories.git.at(-1)!.revisionId, revisions: histories.git },
      folder: {
        head: histories.folder.at(-1)!.revisionId,
        revisions: histories.folder
      }
    });
    const created = await client.query<PersonalSourceBindingRow>(
      `insert into personal_source_bindings(owner_user_id,originating_deployment_id,originating_device_id,source_logical_session_id,originating_owner_user_id,local_session_id,local_logical_session_id,context_version,availability,git_original,folder_original)
      values($1,$2,$3,$4::text,$1,$5,$4::uuid,1,'available',$6,$7) returning *`,
      [
        input.ownerUserId,
        source.originatingDeploymentId,
        source.originatingDeviceId,
        source.logicalSessionId,
        input.localSessionId,
        context.git.original,
        context.folder.original
      ]
    );
    binding = created.rows[0]!;
    for (const axis of ["git", "folder"] as const)
      for (const revision of histories[axis])
        await retainSourceContextRevision(client, {
          bindingId: binding.binding_id,
          axis,
          revision,
          ...(revision.replaces.length
            ? { localChangeRevisionId: revision.revisionId }
            : {})
        });
  }
  const snapshot = await readBoundPersonalSourceContextSnapshot(
    client,
    binding
  );
  await client.query(
    `update personal_source_bindings set git_state='available',folder_state='available',git_frontier=$2,folder_frontier=$3,git_assignment=$4,folder_assignment=$5,updated_at=now() where binding_id=$1`,
    [
      binding.binding_id,
      [snapshot.git.head],
      [snapshot.folder.head],
      snapshot.context.git,
      snapshot.context.folder
    ]
  );
  return snapshot;
};
