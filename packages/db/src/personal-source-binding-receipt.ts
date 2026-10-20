import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { retainPrebindingLocalSourceChanges } from "./personal-source-context-local-changes.js";
import { projectPersonalSourceBinding } from "./personal-source-context-projection.js";
import type pg from "pg";
import {
  personalOwnerIdSchema,
  PdsConfigurationCompatibilityError,
  canonicalizePdsJson,
  personalGitContextSchema,
  personalFolderAssignmentSchema,
  personalSourceContextSnapshotSchema,
  validatePdsSourceContextOriginBinding,
  type PersonalSourceContextSnapshot,
  type PersonalFolderAssignment
} from "@koed/shared";
import {
  retainSourceContextRevision,
  loadSourceContextFrontier
} from "./personal-source-context-graph.js";
import {
  lockPersonalSourceContextOwner,
  type PersonalSourceBindingRow
} from "./personal-source-binding-state.js";

/** Owner translation is authorized by the authenticated Personal group, never a request-supplied User mapping. */
export const translatePersonalSourceSnapshotOwner = (
  snapshot: PersonalSourceContextSnapshot,
  ownerUserId: string
): PersonalSourceContextSnapshot => {
  const folderAssignment = (
    assignment: PersonalFolderAssignment
  ): PersonalFolderAssignment => {
    const fact = (value: PersonalFolderAssignment["original"]) =>
      value.state === "known"
        ? {
            ...value,
            value: {
              ...value.value,
              reference: { ...value.value.reference, ownerUserId }
            }
          }
        : value;
    return {
      ...assignment,
      original: fact(assignment.original),
      correction:
        assignment.correction.state === "corrected"
          ? {
              ...assignment.correction,
              value: fact(assignment.correction.value)
            }
          : assignment.correction
    };
  };
  return personalSourceContextSnapshotSchema.parse({
    ...snapshot,
    context: {
      ...snapshot.context,
      source: { ...snapshot.context.source, ownerUserId },
      folder: folderAssignment(snapshot.context.folder)
    },
    folder: {
      ...snapshot.folder,
      revisions: snapshot.folder.revisions.map((revision) => ({
        ...revision,
        assignment: folderAssignment(revision.assignment)
      }))
    }
  });
};
export type VerifiedPersonalSourceReceipt = {
  ownerUserId: string;
  groupId: string;
  retainedPackageId: string;
  localSessionId: string;
  sourceLogicalSessionId: string;
  sourceContext: unknown;
  availability?: "pending" | "available";
};

/** Invoke only with the snapshot returned by verified decryption of this exact retained package. */
export const retainVerifiedPersonalSourceBinding = async (
  client: pg.PoolClient,
  raw: VerifiedPersonalSourceReceipt
) => {
  const input = {
    ...raw,
    ownerUserId: personalOwnerIdSchema.parse(raw.ownerUserId),
    localSessionId: personalOwnerIdSchema.parse(raw.localSessionId),
    retainedPackageId: personalOwnerIdSchema.parse(raw.retainedPackageId)
  };
  await lockPersonalSourceContextOwner(client, input.ownerUserId);
  const proof = await client.query<{
    origin_deployment_id: string;
    origin_device_id: string;
    source_logical_session_id: string | null;
    source_context_hash: string | null;
  }>(
    `select p.origin_deployment_id,p.origin_device_id,p.source_logical_session_id,p.source_context_hash from pds_retained_packages p
    join personal_device_groups g on g.id=p.group_id join local_personal_identities i on i.id=g.local_personal_identity_id
    join users u on u.id=i.owner_user_id and u.disabled_at is null and u.deleted_at is null
    where p.id=$1 and p.owner_user_id=$2 and i.owner_user_id=$2 and g.group_id=$3 and g.state='active' and p.state<>'revoked' for share of p,g,i,u`,
    [input.retainedPackageId, input.ownerUserId, input.groupId]
  );
  const origin = proof.rows[0];
  if (!origin) throw new TypeError("PdsCryptoSourceContextAuthorityError");
  if (
    origin.source_logical_session_id !== input.sourceLogicalSessionId ||
    origin.source_context_hash !==
      createHash("sha256")
        .update(canonicalizePdsJson(input.sourceContext))
        .digest("base64url")
  )
    throw new TypeError("PdsCryptoSourceContextIdentityError");
  const signed = validatePdsSourceContextOriginBinding({
    snapshot: input.sourceContext,
    originDeploymentId: origin.origin_deployment_id,
    originDeviceId: origin.origin_device_id,
    logicalSessionId: input.sourceLogicalSessionId
  });
  const snapshot = translatePersonalSourceSnapshotOwner(
      signed,
      input.ownerUserId
    ),
    source = snapshot.context.source;
  const session = await client.query<{
    logical_session_id: string;
    repository_automatic_identity: unknown;
    folder_assignment: unknown;
  }>(
    "select logical_session_id,repository_automatic_identity,folder_assignment from sessions where owner_user_id=$1 and id=$2 and visibility='personal' and invalidated_at is null and personal_deleted_at is null for update",
    [input.ownerUserId, input.localSessionId]
  );
  const native = session.rows[0];
  if (!native) throw new TypeError("PdsCryptoSourceBindingSessionError");
  const occupied = await client.query<PersonalSourceBindingRow>(
    "select * from personal_source_bindings where owner_user_id=$1 and local_session_id=$2 for update",
    [input.ownerUserId, input.localSessionId]
  );
  if (
    occupied.rows.some(
      (row) =>
        row.originating_deployment_id !== source.originatingDeploymentId ||
        row.originating_device_id !== source.originatingDeviceId ||
        row.source_logical_session_id !== source.logicalSessionId
    )
  )
    throw new TypeError("PdsCryptoSourceBindingIdentityError");
  await client.query(
    `insert into personal_source_bindings(owner_user_id,originating_deployment_id,originating_device_id,source_logical_session_id,originating_owner_user_id,local_session_id,local_logical_session_id,retained_package_id)
    values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(owner_user_id,originating_deployment_id,originating_device_id,source_logical_session_id) do nothing`,
    [
      input.ownerUserId,
      source.originatingDeploymentId,
      source.originatingDeviceId,
      source.logicalSessionId,
      signed.context.source.ownerUserId,
      input.localSessionId,
      native.logical_session_id,
      input.retainedPackageId
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
  const binding = found.rows[0];
  if (
    !binding ||
    binding.local_session_id !== input.localSessionId ||
    binding.local_logical_session_id !== native.logical_session_id ||
    (binding.originating_owner_user_id !== null &&
      binding.originating_owner_user_id !== signed.context.source.ownerUserId)
  )
    throw new TypeError("PdsCryptoSourceBindingIdentityError");
  if (binding.context_version === 1) {
    const same = await client.query(
      "select 1 from personal_source_bindings where binding_id=$1 and git_original=$2::jsonb and folder_original=$3::jsonb",
      [
        binding.binding_id,
        snapshot.context.git.original,
        snapshot.context.folder.original
      ]
    );
    if (!same.rowCount)
      throw new TypeError("PdsCryptoSourceOriginalProvenanceChangedError");
  }
  if (binding.context_version === 0) {
    // A pre-binding audit can establish causal intent only while it still
    // describes the current native state. Legacy review edits have no graph head.
    const untracked = await client.query(
      `select 1 from sessions s where s.id=$2 and s.owner_user_id=$1 and (
        s.repository_override_identity->>'kind'='local_project' or
        (s.project_override_by_user_id is not null and s.repository_assignment_revision_id is null) or
        exists(select 1 from personal_source_context_changes c
          where c.owner_user_id=s.owner_user_id and c.logical_session_id=s.logical_session_id and c.axis='git'
          and c.sequence=(select max(n.sequence) from personal_source_context_changes n where n.owner_user_id=c.owner_user_id and n.logical_session_id=c.logical_session_id and n.axis=c.axis)
          and (c.version<>s.repository_assignment_version or
               (c.value->'repositoryOverrideIdentity') is distinct from coalesce(s.repository_override_identity,'null'::jsonb)))
        or exists(select 1 from personal_source_context_changes c
          where c.owner_user_id=s.owner_user_id and c.logical_session_id=s.logical_session_id and c.axis='folder'
          and c.sequence=(select max(n.sequence) from personal_source_context_changes n where n.owner_user_id=c.owner_user_id and n.logical_session_id=c.logical_session_id and n.axis=c.axis)
          and (c.value->'context'->'folder') is distinct from s.folder_assignment)
        or (s.repository_assignment_revision_id is null and exists(
          select 1 from repository_assignment_reviews r where r.owner_user_id=s.owner_user_id and r.status='applied'
          and r.selected_session_ids @> to_jsonb(array[s.id::text])))
      )`,
      [input.ownerUserId, input.localSessionId]
    );
    if (untracked.rowCount)
      throw new PdsConfigurationCompatibilityError("source_context_v1", [
        origin.origin_device_id
      ]);
  }
  if (binding.context_version === 0) {
    const knownGit = personalGitContextSchema.safeParse(
        native.repository_automatic_identity
      ),
      knownFolder = personalFolderAssignmentSchema.parse(
        native.folder_assignment
      ).original;
    if (
      knownGit.success &&
      (snapshot.context.git.original.state !== "known" ||
        !isDeepStrictEqual(knownGit.data, snapshot.context.git.original.value))
    )
      throw new TypeError("PdsCryptoSourceOriginalProvenanceChangedError");
    if (
      knownFolder.state === "known" &&
      !isDeepStrictEqual(knownFolder, snapshot.context.folder.original)
    )
      throw new TypeError("PdsCryptoSourceOriginalProvenanceChangedError");
  }
  if (binding.context_version === 0)
    await client.query(
      "update personal_source_bindings set git_original=$2,folder_original=$3 where binding_id=$1",
      [
        binding.binding_id,
        snapshot.context.git.original,
        snapshot.context.folder.original
      ]
    );
  for (const axis of ["git", "folder"] as const)
    for (const revision of snapshot[axis].revisions)
      await retainSourceContextRevision(client, {
        bindingId: binding.binding_id,
        axis,
        revision,
        witnessDeviceId: origin.origin_device_id,
        retainedPackageId: input.retainedPackageId
      });
  if (binding.context_version === 0)
    await retainPrebindingLocalSourceChanges(client, {
      ownerUserId: input.ownerUserId,
      logicalSessionId: native.logical_session_id,
      bindingId: binding.binding_id,
      snapshot
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
    `update personal_source_bindings set context_version=1,originating_owner_user_id=coalesce(originating_owner_user_id,$12),git_original=$2,folder_original=$3,git_state=$4,folder_state=$5,git_frontier=$6,folder_frontier=$7,git_assignment=$8,folder_assignment=$9,
    availability=case when availability='available' then availability else $10 end,retained_package_id=$11,updated_at=now() where binding_id=$1 returning *`,
    [
      binding.binding_id,
      snapshot.context.git.original,
      snapshot.context.folder.original,
      git.state,
      folder.state,
      git.frontier,
      folder.frontier,
      git.assignment,
      folder.assignment,
      input.availability ?? "pending",
      input.retainedPackageId,
      signed.context.source.ownerUserId
    ]
  );
  const next = updated.rows[0]!;
  await projectPersonalSourceBinding(client, binding, next);
  return { previous: binding, binding: next, snapshot };
};
