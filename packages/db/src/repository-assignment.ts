import { recordRepositoryChange } from "./repository-change-events.js";
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  effectiveRepositoryIdentity,
  repositoryIdentitySchema,
  type RepositoryAssignment,
  type RepositoryIdentity
} from "@koed/shared";

export type RepositoryAssignmentRow = {
  repository_assignment_state: "recorded" | "historical_unresolved";
  repository_assignment_version: number;
  repository_automatic_identity: RepositoryIdentity | null;
  repository_override_identity: RepositoryIdentity | null;
};
export const mapRepositoryAssignment = (
  row: RepositoryAssignmentRow
): RepositoryAssignment => ({
  state: row.repository_assignment_state,
  version: row.repository_assignment_version,
  automatic: row.repository_automatic_identity,
  override: row.repository_override_identity,
  effective: effectiveRepositoryIdentity({
    automatic: row.repository_automatic_identity,
    override: row.repository_override_identity
  })
});

export const recordRepositoryObservation = async (
  client: pg.PoolClient,
  row: RepositoryAssignmentRow & {
    id: string;
    owner_user_id: string | null;
    logical_session_id: string;
    external_session_id: string | null;
    capture_inserted?: boolean;
  },
  identity: RepositoryIdentity | undefined,
  cwd: string | undefined
): Promise<void> => {
  if (!row.owner_user_id) return;
  // Continued/re-imported native Conversations cannot evade recorded or historical
  // state by changing idempotency keys or reviving an invalidated Session row.
  if (row.capture_inserted) {
    const prior = await client.query<RepositoryAssignmentRow>(
      `
      select repository_assignment_state, repository_assignment_version,
        repository_automatic_identity, repository_override_identity
      from sessions where owner_user_id = $1 and id <> $2 and visibility = 'personal'
        and (logical_session_id = $3 or ($4::text is not null and external_session_id = $4))
      order by created_at asc, id asc limit 1
    `,
      [
        row.owner_user_id,
        row.id,
        row.logical_session_id,
        row.external_session_id
      ]
    );
    if (prior.rows[0]) {
      const retained = prior.rows[0];
      await client.query(
        `update sessions set repository_assignment_state = $2,
        repository_assignment_version = $3, repository_automatic_identity = $4,
        repository_override_identity = $5 where id = $1`,
        [
          row.id,
          retained.repository_assignment_state,
          retained.repository_assignment_version,
          retained.repository_automatic_identity,
          retained.repository_override_identity
        ]
      );
      Object.assign(row, retained);
    }
  }
  if (!identity) return;
  const automatic = row.repository_automatic_identity;
  const conflict =
    row.repository_assignment_state === "historical_unresolved" ||
    !automatic ||
    automatic.kind !== identity.kind ||
    automatic.key !== identity.key ||
    (identity.kind !== "portable_repository" &&
      automatic.originatingDeviceId !== identity.originatingDeviceId);
  const observationHash = createHash("sha256")
    .update(JSON.stringify({ identity, cwd: cwd ?? null }))
    .digest("hex");
  const observation = await client.query(
    `insert into session_repository_observations
    (session_id, owner_user_id, observation_hash, identity, captured_cwd, is_conflict, assignment_version)
    values ($1, $2, $3, $4, $5, $6, $7)
    on conflict (session_id, observation_hash) do nothing returning id`,
    [
      row.id,
      row.owner_user_id,
      observationHash,
      identity,
      cwd ?? null,
      conflict,
      row.repository_assignment_version
    ]
  );
  if (conflict && observation.rowCount && identity.checkoutId) {
    await recordRepositoryChange(client, row.owner_user_id, {
      id: randomUUID(),
      kind: "capture_conflict",
      originatingDeviceId: identity.originatingDeviceId,
      checkoutId: identity.checkoutId,
      originatingRevision: null,
      previousIdentity: automatic,
      targetIdentity: identity
    });
  }
};

export const updateSessionRepositoryOverride = async (
  pool: pg.Pool,
  input: {
    ownerUserId: string;
    sessionId: string;
    expectedVersion: number;
    identity: RepositoryIdentity | null;
  }
): Promise<RepositoryAssignment | null> => {
  const identity =
    input.identity === null
      ? null
      : repositoryIdentitySchema.parse(input.identity);
  const result = await pool.query<RepositoryAssignmentRow>(
    `update sessions
    set repository_override_identity = $4, repository_assignment_version = repository_assignment_version + 1, updated_at = now()
    where owner_user_id = $1 and id = $2 and repository_assignment_version = $3
      and visibility = 'personal' and invalidated_at is null and personal_deleted_at is null
    returning repository_assignment_state, repository_assignment_version, repository_automatic_identity, repository_override_identity`,
    [input.ownerUserId, input.sessionId, input.expectedVersion, identity]
  );
  return result.rows[0] ? mapRepositoryAssignment(result.rows[0]) : null;
};

// Prepared for ticket 16. No startup, migration, or capture path invokes this.
// The cutover caller must use its release transaction and fixed cutoff.
export const markPreCutoverRepositoryAssignmentsUnresolved = async (
  client: pg.PoolClient,
  cutoff: string
): Promise<number> => {
  await client.query(
    "select set_config('koed.repository_assignment_cutover','1',true)"
  );
  const result = await client.query(
    `update sessions set repository_assignment_state = 'historical_unresolved',
    repository_automatic_identity = null, repository_override_identity = null,
    repository_assignment_version = repository_assignment_version + 1
    where created_at <= $1::timestamptz and visibility = 'personal'`,
    [cutoff]
  );
  await client.query(
    "select set_config('koed.repository_assignment_cutover','',true)"
  );
  return result.rowCount ?? 0;
};
