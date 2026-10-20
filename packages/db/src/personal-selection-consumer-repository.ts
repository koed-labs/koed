import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  personalSelectionConsumerStartSchema,
  personalSelectionConsumerContinueSchema,
  personalSelectionConsumerSelectionSchema,
  personalSelectionConsumerPageSchema,
  personalSelectionConsumerChangesSchema
} from "@koed/shared";
import type { ActorContext } from "./types.js";
import { personalSourceSelectionSql } from "./personal-selection-sql.js";
import { personalProjectMembershipReasonsSql } from "./personal-project-rule-repository.js";
import {
  selectionConsumerError,
  withSelectionConsumerTransaction,
  readConsumerCursor,
  retainConsumerCursor,
  currentConsumerSnapshot,
  resolveConsumerSelection,
  type ConsumerCursor
} from "./personal-selection-consumer-state.js";

const page = async (
  client: pg.PoolClient,
  actor: ActorContext,
  cursor: Omit<ConsumerCursor, "cursor_id">
) => {
  const changed = await client.query(
    `select 1 from personal_selection_changes where owner_user_id=$1
    and not pg_visible_in_snapshot(transaction_id::xid8,$2::pg_snapshot) limit 1`,
    [actor.userId, cursor.from_snapshot]
  );
  if (changed.rows.length)
    throw selectionConsumerError(
      "selection_enumeration_stale",
      409,
      "Selection changed during enumeration. Discard its partial baseline and start again."
    );
  const resolved = await resolveConsumerSelection(
    client,
    actor,
    cursor.selection
  );
  const named = resolved.nativeProjectId;
  const reasonSql = named
    ? personalProjectMembershipReasonsSql("s", "$1", "$3")
    : `select '00000000-0000-0000-0000-000000000000'::uuid id,jsonb_build_object('kind','selection','targetKind',$3::text) value`;
  const rows = await client.query<{
    id: string;
    logical_session_id: string;
    repository_assignment_version: number;
    folder_revision: number;
    portable: unknown;
    reason_id: string;
    reason: unknown;
  }>(
    `select s.id,s.logical_session_id,s.repository_assignment_version,(s.folder_assignment->>'revision')::int folder_revision,
    case when b.binding_id is not null then jsonb_build_object('ownerUserId',b.owner_user_id,'originatingDeploymentId',b.originating_deployment_id,
      'originatingDeviceId',b.originating_device_id,'logicalSessionId',b.source_logical_session_id) else null end portable,
    reason.id reason_id,reason.value reason from sessions s
    left join personal_source_bindings b on b.owner_user_id=s.owner_user_id and b.local_session_id=s.id and b.local_logical_session_id=s.logical_session_id and b.availability='available'
    cross join lateral (${reasonSql}) reason
    where s.owner_user_id=$1 and ${personalSourceSelectionSql("s", "$2")} and pds_session_recall_ready(s.id)
      and not exists(select 1 from personal_source_bindings pending where pending.owner_user_id=s.owner_user_id and pending.local_session_id=s.id
        and (pending.availability<>'available' or pending.local_logical_session_id is distinct from s.logical_session_id))
      and ($4::uuid is null or (s.id,reason.id)>($4::uuid,$5::uuid))
    order by s.id,reason.id limit 101`,
    [
      actor.userId,
      resolved.selection,
      named ?? cursor.selection.target.kind,
      cursor.after_source?.sessionId ?? null,
      cursor.after_source?.reasonId ?? null
    ]
  );
  const entries = rows.rows.slice(0, 100),
    hasMore = rows.rows.length > 100;
  const continuation = {
    ...cursor,
    after_source: hasMore
      ? { sessionId: entries.at(-1)!.id, reasonId: entries.at(-1)!.reason_id }
      : null,
    kind: hasMore ? ("enumeration" as const) : ("checkpoint" as const)
  };
  const next = await retainConsumerCursor(client, continuation);
  return personalSelectionConsumerPageSchema.parse({
    version: 1,
    snapshotVersion: cursor.snapshot_version,
    selection: cursor.selection,
    entries: entries.map((row) => ({
      source: {
        localSessionId: row.id,
        localLogicalSessionId: row.logical_session_id,
        portable: row.portable,
        identityState: row.portable ? "verified" : "local_only",
        contextVersion: {
          git: row.repository_assignment_version,
          folder: row.folder_revision
        }
      },
      reason: row.reason,
      projectVersion: resolved.projectVersion
    })),
    nextCursor: hasMore ? next : null,
    changeCursor: hasMore ? null : next,
    expiresAt: cursor.expires_at.toISOString()
  });
};

export const createPersonalSelectionConsumerRepository = (pool: pg.Pool) => ({
  async startPersonalSelectionEnumeration(actor: ActorContext, raw: unknown) {
    const input = personalSelectionConsumerStartSchema.parse(raw);
    const selection = personalSelectionConsumerSelectionSchema.parse({
      version: 1,
      ownerUserId: actor.userId,
      target: input.target
    });
    return withSelectionConsumerTransaction(pool, actor, async (client) =>
      page(client, actor, {
        owner_user_id: actor.userId,
        kind: "enumeration",
        selection,
        snapshot_version: randomUUID(),
        from_snapshot: await currentConsumerSnapshot(client),
        to_snapshot: null,
        after_source: null,
        after_change_id: null,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000)
      })
    );
  },
  async continuePersonalSelectionEnumeration(
    actor: ActorContext,
    raw: unknown
  ) {
    const { cursor: cursorId } =
      personalSelectionConsumerContinueSchema.parse(raw);
    return withSelectionConsumerTransaction(pool, actor, async (client) => {
      const cursor = await readConsumerCursor(client, actor, cursorId);
      if (cursor.kind !== "enumeration")
        throw selectionConsumerError(
          "selection_cursor_kind",
          400,
          "This cursor does not continue an enumeration"
        );
      return page(client, actor, cursor);
    });
  },
  async reconcilePersonalSelectionChanges(actor: ActorContext, raw: unknown) {
    const { cursor: cursorId } =
      personalSelectionConsumerContinueSchema.parse(raw);
    return withSelectionConsumerTransaction(pool, actor, async (client) => {
      const cursor = await readConsumerCursor(client, actor, cursorId);
      if (cursor.kind === "enumeration")
        throw selectionConsumerError(
          "selection_cursor_kind",
          400,
          "Finish the enumeration before collecting changes"
        );
      const toSnapshot =
        cursor.to_snapshot ?? (await currentConsumerSnapshot(client));
      // The ID is a page key within this fixed visibility window, never a
      // global commit watermark. Late commits belong to a subsequent window.
      const rows = await client.query<{ change_id: string; kind: string }>(
        `select c.change_id::text change_id,c.kind from personal_selection_changes c where c.owner_user_id=$1
        and not pg_visible_in_snapshot(c.transaction_id::xid8,$2::pg_snapshot)
        and pg_visible_in_snapshot(c.transaction_id::xid8,$3::pg_snapshot)
        and ($4::bigint is null or c.change_id>$4::bigint) order by c.change_id limit 101`,
        [actor.userId, cursor.from_snapshot, toSnapshot, cursor.after_change_id]
      );
      const events = rows.rows.slice(0, 100),
        hasMore = rows.rows.length > 100;
      const next = await retainConsumerCursor(client, {
        ...cursor,
        kind: hasMore ? "changes" : "checkpoint",
        from_snapshot: hasMore ? cursor.from_snapshot : toSnapshot,
        to_snapshot: hasMore ? toSnapshot : null,
        after_change_id: hasMore ? events.at(-1)!.change_id : null,
        after_source: null,
        expires_at: hasMore
          ? cursor.expires_at
          : new Date(Date.now() + 24 * 60 * 60 * 1000)
      });
      return personalSelectionConsumerChangesSchema.parse({
        version: 1,
        selection: cursor.selection,
        events: events.map((row) => ({
          eventId: row.change_id,
          kind: row.kind
        })),
        nextCursor: hasMore ? next : null,
        changeCursor: hasMore ? null : next,
        reconciliationRequired: events.length > 0,
        expiresAt: (hasMore
          ? cursor.expires_at
          : new Date(Date.now() + 24 * 60 * 60 * 1000)
        ).toISOString()
      });
    });
  }
});
export type PersonalSelectionConsumerRepository = ReturnType<
  typeof createPersonalSelectionConsumerRepository
>;
