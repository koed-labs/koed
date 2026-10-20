import { createHash } from "node:crypto";
import type pg from "pg";
import {
  personalFolderAssignmentSchema,
  personalFolderObservationSchema,
  type PersonalFolderAssignment,
  type PersonalFolderObservation
} from "@koed/shared";

/** Pin once, even when a logical Conversation gets a new physical Session row. */
export const recordFolderObservation = async (
  client: pg.PoolClient,
  row: {
    id: string;
    owner_user_id: string | null;
    logical_session_id: string;
    external_session_id: string | null;
    capture_inserted?: boolean;
    folder_assignment: PersonalFolderAssignment;
  },
  input: PersonalFolderObservation | undefined,
  historical: boolean,
  current?: PersonalFolderObservation,
  logicalIdentityOnly = false
): Promise<void> => {
  if (!row.owner_user_id) return;
  const observation = input
    ? personalFolderObservationSchema.parse(input)
    : undefined;
  if (row.capture_inserted) {
    const prior = await client.query<{
      folder_assignment: PersonalFolderAssignment;
    }>(
      `select folder_assignment from sessions
       where owner_user_id=$1 and visibility='personal' and id<>$2
         and (logical_session_id=$3 or ($4::text is not null and external_session_id=$4))
       order by (folder_assignment->>'revision')::bigint desc,created_at asc,id asc limit 1`,
      [
        row.owner_user_id,
        row.id,
        row.logical_session_id,
        logicalIdentityOnly ? null : row.external_session_id
      ]
    );
    const assignment = prior.rows[0]?.folder_assignment ?? {
      revision: 1,
      original: observation
        ? {
            state: "known",
            value: {
              reference: {
                ...observation.identity,
                ownerUserId: row.owner_user_id
              },
              normalizedPath: observation.normalizedPath,
              capturedPath: observation.capturedPath
            }
          }
        : {
            state: "unresolved",
            reason: historical ? "historical_unresolved" : "missing"
          },
      correction: { state: "original" }
    };
    row.folder_assignment = personalFolderAssignmentSchema.parse(assignment);
    await client.query("update sessions set folder_assignment=$2 where id=$1", [
      row.id,
      row.folder_assignment
    ]);
  }
  for (const observed of [
    observation,
    current ? personalFolderObservationSchema.parse(current) : undefined
  ]) {
    if (!observed) continue;
    const evidence = {
      identity: observed.identity,
      normalizedPath: observed.normalizedPath,
      capturedPath: observed.capturedPath
    };
    const hash = createHash("sha256")
      .update(JSON.stringify(evidence))
      .digest("hex");
    await client.query(
      `insert into session_folder_observations (session_id,owner_user_id,observation_hash,observation)
     values ($1,$2,$3,$4) on conflict (session_id,observation_hash) do nothing`,
      [row.id, row.owner_user_id, hash, observed]
    );
  }
};
