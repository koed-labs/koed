import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  personalSelectionConsumerSelectionSchema,
  type PersonalSelectionConsumerSelection
} from "@koed/shared";
import type { ActorContext } from "./types.js";
import {
  resolvePersonalSourceSelection,
  type PersonalSourceSelection
} from "./personal-selection-sql.js";
import {
  personalProjectCatalogReadySql,
  personalProjectIdentityMatchesSql
} from "./personal-membership-selection-sql.js";

export const selectionConsumerError = (
  code: string,
  statusCode: number,
  message: string
) => Object.assign(new Error(message), { code, statusCode });
export type ConsumerCursor = {
  cursor_id: string;
  owner_user_id: string;
  kind: "enumeration" | "checkpoint" | "changes";
  selection: PersonalSelectionConsumerSelection;
  snapshot_version: string;
  from_snapshot: string;
  to_snapshot: string | null;
  after_source: { sessionId: string; reasonId: string } | null;
  after_change_id: string | null;
  expires_at: Date;
};
export const withSelectionConsumerTransaction = async <T>(
  pool: pg.Pool,
  actor: ActorContext,
  run: (client: pg.PoolClient) => Promise<T>
) => {
  const client = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read");
    const owner = await client.query(
      "select id from users where id=$1 and disabled_at is null and deleted_at is null for share",
      [actor.userId]
    );
    if (!owner.rows.length)
      throw selectionConsumerError(
        "owner_unavailable",
        403,
        "User is unavailable"
      );
    const value = await run(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};
export const readConsumerCursor = async (
  client: pg.PoolClient,
  actor: ActorContext,
  cursorId: string
) => {
  const rows = await client.query<ConsumerCursor>(
    "select * from personal_selection_cursors where owner_user_id=$1 and cursor_id=$2",
    [actor.userId, cursorId]
  );
  const cursor = rows.rows[0];
  if (!cursor)
    throw selectionConsumerError(
      "selection_cursor_unavailable",
      404,
      "Selection cursor not found"
    );
  if (cursor.expires_at.getTime() <= Date.now())
    throw selectionConsumerError(
      "selection_cursor_expired",
      410,
      "Selection cursor expired. Start a new enumeration."
    );
  cursor.selection = personalSelectionConsumerSelectionSchema.parse(
    cursor.selection
  );
  if (cursor.selection.ownerUserId !== actor.userId)
    throw selectionConsumerError(
      "selection_cursor_unavailable",
      404,
      "Selection cursor not found"
    );
  return cursor;
};
export const retainConsumerCursor = async (
  client: pg.PoolClient,
  cursor: Omit<ConsumerCursor, "cursor_id">
) => {
  const id = randomUUID();
  await client.query(
    `insert into personal_selection_cursors(cursor_id,owner_user_id,kind,selection,snapshot_version,from_snapshot,to_snapshot,after_source,after_change_id,expires_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      cursor.owner_user_id,
      cursor.kind,
      cursor.selection,
      cursor.snapshot_version,
      cursor.from_snapshot,
      cursor.to_snapshot,
      cursor.after_source,
      cursor.after_change_id,
      cursor.expires_at
    ]
  );
  return id;
};
export const currentConsumerSnapshot = async (client: pg.PoolClient) => {
  const result = await client.query<{ snapshot: string }>(
    "select pg_current_snapshot()::text snapshot"
  );
  return result.rows[0]!.snapshot;
};
/** A portable Conversation resolves only through its exact verified local
 * binding. Native-only selection uses the actual owned Session ID directly. */
export interface SelectionConsumerOptions {
  /** Sharing may observe a retained, conclusive Project tombstone as an empty
   * selection. Public Personal enumeration keeps its unavailable-target error. */
  includeDeletedProjects?: boolean;
}
export const resolveConsumerSelection = async (
  client: pg.PoolClient,
  actor: ActorContext,
  selection: PersonalSelectionConsumerSelection,
  options: SelectionConsumerOptions = {}
): Promise<{
  selection: PersonalSourceSelection;
  projectVersion: number | null;
  nativeProjectId?: string;
  projectDeleted?: boolean;
}> => {
  if (selection.ownerUserId !== actor.userId)
    throw selectionConsumerError(
      "selection_unavailable",
      404,
      "Selection not found"
    );
  const target = selection.target;
  if (target.kind === "project") {
    const result = await client.query<{
      version: number;
      project_id: string;
      deleted_at: Date | null;
    }>(
      `select p.version,p.project_id,p.deleted_at from personal_named_projects p where p.owner_user_id=$1 and ${personalProjectIdentityMatchesSql("p", "$2::text")}
      and ((p.deleted_at is null and ${personalProjectCatalogReadySql("p")})
        or ($3::boolean and p.deleted_at is not null and not exists (
          select 1 from personal_membership_entities catalog
          where catalog.owner_user_id=p.owner_user_id and catalog.local_project_id=p.project_id and catalog.entity_kind='project'
            and (catalog.state<>'available' or catalog.current_revision->'operation'->>'kind' is distinct from 'delete_project')
        )))`,
      [
        actor.userId,
        target.project.projectId,
        options.includeDeletedProjects === true
      ]
    );
    if (!result.rows[0])
      throw selectionConsumerError(
        "selection_unavailable",
        404,
        "Project is unavailable. Remove its previous consumer baseline."
      );
    return {
      selection: resolvePersonalSourceSelection(actor.userId, {
        personalSelection: {
          ...selection,
          version: 1,
          target,
          callerRepositoryContext: null
        }
      }),
      projectVersion: result.rows[0].version,
      nativeProjectId: result.rows[0].project_id,
      projectDeleted: result.rows[0].deleted_at !== null
    };
  }
  if (target.kind === "local_session" || target.kind === "session") {
    const result =
      target.kind === "local_session"
        ? await client.query<{ id: string }>(
            "select id from sessions where id=$2 and owner_user_id=$1 and visibility='personal' and invalidated_at is null and personal_deleted_at is null",
            [actor.userId, target.sessionId]
          )
        : await client.query<{ id: string }>(
            `select s.id from personal_source_bindings b join sessions s on s.id=b.local_session_id and s.owner_user_id=b.owner_user_id and s.logical_session_id=b.local_logical_session_id
        where b.owner_user_id=$1 and b.originating_deployment_id=$2 and b.originating_device_id=$3 and b.source_logical_session_id=$4
          and b.availability='available' and s.visibility='personal' and s.invalidated_at is null and s.personal_deleted_at is null`,
            [
              actor.userId,
              target.source.originatingDeploymentId,
              target.source.originatingDeviceId,
              target.source.logicalSessionId
            ]
          );
    if (result.rows.length !== 1)
      throw selectionConsumerError(
        "selection_unavailable",
        404,
        "Conversation is unavailable. Remove its previous consumer baseline."
      );
    return {
      selection: resolvePersonalSourceSelection(actor.userId, {
        searchDomain: "session",
        sessionId: result.rows[0]!.id
      }),
      projectVersion: null
    };
  }
  return {
    selection: resolvePersonalSourceSelection(actor.userId, {
      personalSelection: {
        version: 1,
        ownerUserId: actor.userId,
        target,
        callerRepositoryContext: null
      }
    }),
    projectVersion: null
  };
};
