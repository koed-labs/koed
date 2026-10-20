import type pg from "pg";
import {
  decodePdsPersonalSourceContextSnapshot,
  type PersonalConfigurationRecord
} from "@koed/shared";
import { translatePersonalSourceSnapshotOwner } from "./personal-source-binding-receipt.js";
import { type PersonalSourceBindingRow } from "./personal-source-binding-state.js";
import {
  loadSourceContextFrontier,
  retainSourceContextRevision
} from "./personal-source-context-graph.js";
import { projectPersonalSourceBinding } from "./personal-source-context-projection.js";

/** A configuration author can correct a verified source, but cannot establish its originals. */
export const applyVerifiedConfigurationSourceContext = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    record: PersonalConfigurationRecord;
    recordHash: string;
    allowApplication?: boolean;
  }
): Promise<{ bindingId: string; applied: boolean }> => {
  if (input.record.revision.payload.kind !== "source_context")
    throw new TypeError("PdsCryptoConfigurationPayloadKindError");
  const signed = decodePdsPersonalSourceContextSnapshot(
    input.record.revision.payload.snapshot
  );
  const snapshot = translatePersonalSourceSnapshotOwner(
      signed,
      input.ownerUserId
    ),
    source = snapshot.context.source;
  await client.query(
    `insert into personal_source_bindings(owner_user_id,originating_deployment_id,originating_device_id,source_logical_session_id)
    values($1,$2,$3,$4) on conflict(owner_user_id,originating_deployment_id,originating_device_id,source_logical_session_id) do nothing`,
    [
      input.ownerUserId,
      source.originatingDeploymentId,
      source.originatingDeviceId,
      source.logicalSessionId
    ]
  );
  const found = await client.query<PersonalSourceBindingRow>(
    "select * from personal_source_bindings where owner_user_id=$1 and originating_deployment_id=$2 and originating_device_id=$3 and source_logical_session_id=$4 for update",
    [
      input.ownerUserId,
      source.originatingDeploymentId,
      source.originatingDeviceId,
      source.logicalSessionId
    ]
  );
  const binding = found.rows[0]!;
  // Retain the encrypted record as pending. Do not pin originals or graph nodes
  // from a peer correction before the actual origin source has been authenticated.
  if (
    input.allowApplication === false ||
    binding.context_version !== 1 ||
    binding.availability !== "available" ||
    !binding.local_session_id
  )
    return { bindingId: binding.binding_id, applied: false };
  const native = await client.query(
    "select 1 from sessions where id=$1 and owner_user_id=$2 and logical_session_id=$3 and visibility='personal' and invalidated_at is null and personal_deleted_at is null for update",
    [
      binding.local_session_id,
      input.ownerUserId,
      binding.local_logical_session_id
    ]
  );
  if (!native.rowCount)
    return { bindingId: binding.binding_id, applied: false };
  const originals = await client.query(
    "select 1 from personal_source_bindings where binding_id=$1 and git_original=$2::jsonb and folder_original=$3::jsonb",
    [
      binding.binding_id,
      snapshot.context.git.original,
      snapshot.context.folder.original
    ]
  );
  if (!originals.rowCount)
    throw new TypeError("PdsCryptoConfigurationOriginalProvenanceError");
  for (const axis of ["git", "folder"] as const)
    for (const revision of snapshot[axis].revisions)
      await retainSourceContextRevision(client, {
        bindingId: binding.binding_id,
        axis,
        revision,
        witnessDeviceId: input.record.revision.authorDeviceId,
        verifiedRecordHash: input.recordHash
      });
  const git = await loadSourceContextFrontier(
      client,
      binding.binding_id,
      "git"
    ),
    folder = await loadSourceContextFrontier(
      client,
      binding.binding_id,
      "folder"
    );
  const updated = await client.query<PersonalSourceBindingRow>(
    `update personal_source_bindings set git_state=$2,folder_state=$3,git_frontier=$4,folder_frontier=$5,git_assignment=$6,folder_assignment=$7,updated_at=now() where binding_id=$1 returning *`,
    [
      binding.binding_id,
      git.state,
      folder.state,
      git.frontier,
      folder.frontier,
      git.assignment,
      folder.assignment
    ]
  );
  const next = updated.rows[0]!;
  await projectPersonalSourceBinding(client, binding, next);
  if (
    binding.git_state !== next.git_state ||
    binding.folder_state !== next.folder_state ||
    JSON.stringify(binding.git_frontier) !==
      JSON.stringify(next.git_frontier) ||
    JSON.stringify(binding.folder_frontier) !==
      JSON.stringify(next.folder_frontier)
  )
    await client.query("select pg_notify('koed_graph_updates',$1)", [
      JSON.stringify({
        ownerUserId: input.ownerUserId,
        visibility: "personal",
        kind: "personal_source_context_changed"
      })
    ]);
  return { bindingId: binding.binding_id, applied: true };
};
