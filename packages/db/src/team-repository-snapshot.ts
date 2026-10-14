import type pg from "pg";
import { readOwnerPrivateRepositorySnapshotMetadata } from "./owner-private-repository-snapshot.js";
import {
  createTeamRepositorySnapshot,
  teamRepositorySnapshotSchema,
  unresolvedTeamRepositorySnapshot,
  type EnvelopeEncryptionProvider,
  type TeamRepositorySnapshot
} from "@koed/shared";
import {
  mapRepositoryAssignment,
  type RepositoryAssignmentRow
} from "./repository-assignment.js";

/** Snapshot after owner/share authorization, under the same transaction as grant creation. */
export const snapshotOwnedTeamRepository = async (
  client: pg.PoolClient,
  ownerUserId: string,
  logicalMemoryId: string,
  options: {
    forPrivacyClassification?: boolean;
    ownerPrivateProvider?: EnvelopeEncryptionProvider;
  } = {}
): Promise<TeamRepositorySnapshot> => {
  const result = await client.query<
    RepositoryAssignmentRow & {
      captured_branch: string | null;
      metadata: Record<string, unknown>;
      id: string;
      owner_principal_id: string;
    }
  >(
    `select s.id,lm.owner_principal_id,s.repository_assignment_state,s.repository_assignment_version,
      s.repository_automatic_identity,s.repository_override_identity,s.metadata,
      case when s.metadata ? 'pds' then s.metadata->'pds'->'repositoryAssignment'->>'branchObservation'
      when s.repository_automatic_identity is not null and not exists (
        select 1 from session_repository_observations o where o.session_id=s.id
        and (o.is_conflict or o.identity->>'branch' is distinct from s.repository_automatic_identity->>'branch')
      ) then s.repository_automatic_identity->>'branch' else null end as captured_branch
     from local_captured_session_logical_memories m
     join sessions s on s.id=m.local_session_id and s.owner_user_id=$1
     join logical_memories lm on lm.id=m.logical_memory_id and lm.owner_user_id=$1
     where m.logical_memory_id=$2 and m.owner_user_id=$1
       and s.visibility='personal' and s.invalidated_at is null
       and s.personal_deleted_at is null for share of s`,
    [ownerUserId, logicalMemoryId]
  );
  const row = result.rows[0];
  if (row?.metadata?.syncReplica === true) {
    const source = row.metadata.repositorySnapshot
      ? teamRepositorySnapshotSchema.parse(row.metadata.repositorySnapshot)
      : unresolvedTeamRepositorySnapshot();
    if (source.label !== null || source.branchObservation !== null)
      throw new Error("Raw repository disclosure metadata must be encrypted");
    if (
      options.forPrivacyClassification &&
      row.metadata.repositorySnapshotMetadataEnvelope
    ) {
      if (!options.ownerPrivateProvider)
        throw new Error(
          "Owner-private repository metadata requires its encryption provider"
        );
      return readOwnerPrivateRepositorySnapshotMetadata(
        options.ownerPrivateProvider,
        {
          sessionId: row.id,
          ownerUserId,
          ownerPrincipalId: row.owner_principal_id
        },
        row.metadata.repositorySnapshotMetadataEnvelope,
        source
      );
    }
    return source;
  }
  if (!row) return unresolvedTeamRepositorySnapshot();
  const assignment = mapRepositoryAssignment(row);
  return createTeamRepositorySnapshot(assignment, {
    permittedLabel: options.forPrivacyClassification
      ? assignment.effective?.anchorDisplay
      : null,
    capturedBranchObservation: options.forPrivacyClassification
      ? row.captured_branch
      : null
  });
};
