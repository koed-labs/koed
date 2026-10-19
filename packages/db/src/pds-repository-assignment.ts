import type pg from "pg";
import {
  pdsRepositoryAssignmentSchema,
  repositoryAssignmentSchema,
  type PdsRepositoryAssignment
} from "@koed/shared";
import {
  mapRepositoryAssignment,
  type RepositoryAssignmentRow
} from "./repository-assignment.js";

/** Signed source changes update only replicas still following that exact source state. */
export const applyPdsRepositoryAssignmentSnapshot = async (
  client: pg.PoolClient,
  ownerUserId: string,
  sessionId: string,
  input: PdsRepositoryAssignment
): Promise<boolean> => {
  const incoming = pdsRepositoryAssignmentSchema.parse(input);
  const result = await client.query<
    RepositoryAssignmentRow & {
      metadata: { pds?: { repositoryAssignment?: unknown } };
    }
  >(
    "select repository_assignment_state,repository_assignment_version,repository_automatic_identity,repository_override_identity,metadata from sessions where id=$1 and owner_user_id=$2 and visibility='personal' and invalidated_at is null and personal_deleted_at is null for update",
    [sessionId, ownerUserId]
  );
  const row = result.rows[0];
  if (!row) throw new Error("PDS assignment Session is unavailable");
  const previous = pdsRepositoryAssignmentSchema.safeParse(
    row.metadata?.pds?.repositoryAssignment
  );
  if (
    !previous.success ||
    BigInt(incoming.assignmentVersion) <=
      BigInt(previous.data.assignmentVersion)
  )
    return false;
  const current = repositoryAssignmentSchema.parse(
    mapRepositoryAssignment(row)
  );
  const previousState = {
    state: previous.data.state,
    automatic: previous.data.automatic,
    override: previous.data.override
  };
  if (
    current.version !== Number(previous.data.assignmentVersion) ||
    JSON.stringify({
      state: current.state,
      automatic: current.automatic,
      override: current.override
    }) !== JSON.stringify(previousState)
  )
    return false;
  // Capture or a later snapshot cannot invent an automatic identity for existing history.
  const unchangedAutomatic =
    JSON.stringify(incoming.automatic) ===
      JSON.stringify(previous.data.automatic) &&
    incoming.state === previous.data.state;
  const cutover =
    incoming.state === "historical_unresolved" &&
    incoming.automatic === null &&
    incoming.override === null;
  if (!unchangedAutomatic && !cutover) return false;
  await client.query(
    "update sessions set repository_assignment_state=$3,repository_assignment_version=$4,repository_automatic_identity=$5,repository_override_identity=$6,updated_at=now() where id=$1 and owner_user_id=$2",
    [
      sessionId,
      ownerUserId,
      incoming.state,
      Number(incoming.assignmentVersion),
      incoming.automatic,
      incoming.override
    ]
  );
  return true;
};
