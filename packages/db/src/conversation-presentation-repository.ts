import type pg from "pg";
import type {
  ActorContext,
  ConversationPresentationMode,
  ConversationPresentationStateRecord
} from "./types.js";

type PresentationRow = {
  session_id: string;
  logical_session_id: string;
  pinned_at: Date | null;
  display_mode: ConversationPresentationMode;
  snoozed_at: Date | null;
  snoozed_until: Date | null;
  version: number;
  updated_at: Date;
};

const mapPresentation = (
  row: PresentationRow
): ConversationPresentationStateRecord => ({
  sessionId: row.session_id,
  logicalSessionId: row.logical_session_id,
  pinnedAt: row.pinned_at?.toISOString() ?? null,
  displayMode: row.display_mode,
  snoozedAt: row.snoozed_at?.toISOString() ?? null,
  snoozedUntil: row.snoozed_until?.toISOString() ?? null,
  version: row.version,
  updatedAt: row.updated_at.toISOString()
});

export class ConversationPresentationVersionConflictError extends Error {
  constructor() {
    super("Conversation presentation state changed on another client");
    this.name = "ConversationPresentationVersionConflictError";
  }
}

export interface ConversationPresentationRepository {
  listConversationPresentationStates(
    actor: ActorContext,
    sessionIds: string[]
  ): Promise<ConversationPresentationStateRecord[]>;
  updateConversationPresentationState(
    actor: ActorContext,
    input: {
      sessionId: string;
      expectedVersion: number;
      pinned?: boolean;
      displayMode?: ConversationPresentationMode;
      snoozedUntil?: string | null;
    }
  ): Promise<ConversationPresentationStateRecord | null>;
}

const selection = `
  select
    s.id as session_id,
    s.logical_session_id,
    p.pinned_at,
    coalesce(p.display_mode, 'automatic') as display_mode,
    p.snoozed_at,
    p.snoozed_until,
    coalesce(p.version, 0)::integer as version,
    coalesce(p.updated_at, s.updated_at) as updated_at
  from sessions s
  left join conversation_presentation_states p
    on p.owner_user_id = s.owner_user_id
   and p.logical_session_id = s.logical_session_id
`;

export const createConversationPresentationRepository = (
  pool: pg.Pool
): ConversationPresentationRepository => ({
  async listConversationPresentationStates(actor, sessionIds) {
    if (sessionIds.length === 0) return [];
    const result = await pool.query<PresentationRow>(
      `${selection}
       where s.owner_user_id = $1
         and s.visibility = 'personal'
         and s.personal_deleted_at is null
         and s.id = any($2::uuid[])
       order by s.id`,
      [actor.userId, sessionIds]
    );
    return result.rows.map(mapPresentation);
  },

  async updateConversationPresentationState(actor, input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const sessionResult = await client.query<{
        session_id: string;
        logical_session_id: string;
      }>(
        `select id as session_id, logical_session_id
         from sessions
         where id = $1
           and owner_user_id = $2
           and visibility = 'personal'
           and personal_deleted_at is null
         for update`,
        [input.sessionId, actor.userId]
      );
      const session = sessionResult.rows[0];
      if (!session) {
        await client.query("rollback");
        return null;
      }
      const currentResult = await client.query<{
        pinned_at: Date | null;
        display_mode: ConversationPresentationMode;
        snoozed_at: Date | null;
        snoozed_until: Date | null;
        version: number;
      }>(
        `select pinned_at, display_mode, snoozed_at, snoozed_until, version
         from conversation_presentation_states
         where owner_user_id = $1 and logical_session_id = $2
         for update`,
        [actor.userId, session.logical_session_id]
      );
      const current = currentResult.rows[0];
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== input.expectedVersion) {
        throw new ConversationPresentationVersionConflictError();
      }
      const changedAt = new Date();
      const pinnedAt =
        input.pinned === undefined
          ? (current?.pinned_at ?? null)
          : input.pinned
            ? changedAt
            : null;
      const displayMode =
        input.displayMode ?? current?.display_mode ?? "automatic";
      const snoozedAt =
        input.snoozedUntil === undefined
          ? (current?.snoozed_at ?? null)
          : input.snoozedUntil === null
            ? null
            : changedAt;
      const snoozedUntil =
        input.snoozedUntil === undefined
          ? (current?.snoozed_until ?? null)
          : input.snoozedUntil === null
            ? null
            : new Date(input.snoozedUntil);
      const nextVersion = currentVersion + 1;
      await client.query(
        `insert into conversation_presentation_states (
           owner_user_id, logical_session_id, pinned_at, display_mode,
           snoozed_at, snoozed_until, version, updated_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (owner_user_id, logical_session_id) do update set
           pinned_at = excluded.pinned_at,
           display_mode = excluded.display_mode,
           snoozed_at = excluded.snoozed_at,
           snoozed_until = excluded.snoozed_until,
           version = excluded.version,
           updated_at = excluded.updated_at`,
        [
          actor.userId,
          session.logical_session_id,
          pinnedAt,
          displayMode,
          snoozedAt,
          snoozedUntil,
          nextVersion,
          changedAt
        ]
      );
      await client.query("select pg_notify('koed_graph_updates', $1)", [
        JSON.stringify({
          table: "conversation_presentation_states",
          operation: current ? "UPDATE" : "INSERT",
          id: session.session_id,
          ownerUserId: actor.userId,
          visibility: "personal",
          changedAt: changedAt.toISOString()
        })
      ]);
      await client.query("commit");
      return {
        sessionId: session.session_id,
        logicalSessionId: session.logical_session_id,
        pinnedAt: pinnedAt?.toISOString() ?? null,
        displayMode,
        snoozedAt: snoozedAt?.toISOString() ?? null,
        snoozedUntil: snoozedUntil?.toISOString() ?? null,
        version: nextVersion,
        updatedAt: changedAt.toISOString()
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
});
