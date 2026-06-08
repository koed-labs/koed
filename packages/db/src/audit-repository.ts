import { and, desc, eq } from "drizzle-orm";
import type pg from "pg";
import type { KoedDb } from "./connection.js";
import { auditEvents } from "./schema.js";
import type {
  ActorContext,
  AuditEventRecord,
  ListAuditEventsInput,
  RecordAuditEventInput,
  Visibility
} from "./types.js";

const timestampIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const auditLimit = (limit?: number): number => {
  const requested = Number.isFinite(limit) ? Math.trunc(limit!) : 50;
  return Math.min(Math.max(requested, 1), 200);
};

const mapAuditEventRecord = (row: {
  id: string;
  actorUserId: string | null;
  ownerUserId: string | null;
  visibility: Visibility | null;
  action: string;
  targetTable: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date | string;
}): AuditEventRecord => ({
  id: row.id,
  actorUserId: row.actorUserId,
  ownerUserId: row.ownerUserId,
  visibility: row.visibility,
  action: row.action,
  targetTable: row.targetTable,
  targetId: row.targetId,
  metadata: row.metadata,
  createdAt: timestampIso(row.createdAt)
});

export const auditEventValues = (input: RecordAuditEventInput) => ({
  actorUserId: input.actorUserId ?? null,
  ownerUserId: input.ownerUserId ?? null,
  visibility: input.visibility ?? null,
  action: input.action,
  targetTable: input.targetTable ?? null,
  targetId: input.targetId ?? null,
  metadata: input.metadata ?? {}
});

export const recordAuditEventWithClient = async (
  client: pg.PoolClient,
  input: RecordAuditEventInput
): Promise<void> => {
  const values = auditEventValues(input);
  await client.query(
    `
      insert into audit_events (
        actor_user_id,
        owner_user_id,
        visibility,
        action,
        target_table,
        target_id,
        metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `,
    [
      values.actorUserId,
      values.ownerUserId,
      values.visibility,
      values.action,
      values.targetTable,
      values.targetId,
      JSON.stringify(values.metadata)
    ]
  );
};

export const createAuditRepository = (db: KoedDb) => ({
  async recordAuditEvent(
    input: RecordAuditEventInput
  ): Promise<AuditEventRecord> {
    const rows = await db
      .insert(auditEvents)
      .values(auditEventValues(input))
      .returning();

    return mapAuditEventRecord(rows[0]!);
  },

  async listAuditEvents(
    actor: ActorContext,
    input: ListAuditEventsInput = {}
  ): Promise<AuditEventRecord[]> {
    const conditions = [eq(auditEvents.ownerUserId, actor.userId)];
    if (input.action) {
      conditions.push(eq(auditEvents.action, input.action));
    }

    const rows = await db
      .select()
      .from(auditEvents)
      .where(and(...conditions))
      .orderBy(desc(auditEvents.createdAt))
      .limit(auditLimit(input.limit));

    return rows.map(mapAuditEventRecord);
  }
});
