import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type pg from "pg";
import type { KoedDb } from "./connection.js";
import { auditEvents, teamMemberships, teamWorkspaces } from "./schema.js";
import type {
  ActivationAnalyticsFunnelRecord,
  ActorContext,
  AuditEventRecord,
  GetActivationAnalyticsFunnelInput,
  ListAuditEventsInput,
  RecordAuditEventInput,
  Visibility
} from "./types.js";

const timestampIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export const auditLimit = (limit?: number): number => {
  const requested = Number.isFinite(limit) ? Math.trunc(limit!) : 50;
  return Math.min(Math.max(requested, 1), 200);
};

export const mapAuditEventRecord = (row: {
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
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.auditSequence))
      .limit(auditLimit(input.limit));

    return rows.map(mapAuditEventRecord);
  },

  async getActivationAnalyticsFunnel(
    actor: ActorContext,
    input: GetActivationAnalyticsFunnelInput = {}
  ): Promise<ActivationAnalyticsFunnelRecord | null> {
    let teamId = input.teamId ?? null;
    const teamWorkspaceId = input.teamWorkspaceId ?? null;

    if (teamWorkspaceId) {
      const workspaceRows = await db
        .select({ teamId: teamWorkspaces.teamId })
        .from(teamWorkspaces)
        .where(eq(teamWorkspaces.id, teamWorkspaceId))
        .limit(1);
      const workspace = workspaceRows[0];
      if (!workspace || (teamId && teamId !== workspace.teamId)) {
        return null;
      }
      teamId = workspace.teamId;
    }

    if (teamId) {
      const membershipRows = await db
        .select({ role: teamMemberships.role, status: teamMemberships.status })
        .from(teamMemberships)
        .where(
          and(
            eq(teamMemberships.teamId, teamId),
            eq(teamMemberships.userId, actor.userId)
          )
        )
        .limit(1);
      const membership = membershipRows[0];
      if (
        !membership ||
        membership.status !== "enabled" ||
        !["owner", "admin"].includes(membership.role)
      ) {
        return null;
      }
    }

    const conditions = [
      sql`${auditEvents.action} like 'analytics.activation.%'`
    ];
    if (teamId) {
      conditions.push(sql`${auditEvents.metadata} ->> 'teamId' = ${teamId}`);
    } else {
      conditions.push(eq(auditEvents.ownerUserId, actor.userId));
    }
    if (teamWorkspaceId) {
      conditions.push(
        sql`${auditEvents.metadata} ->> 'teamWorkspaceId' = ${teamWorkspaceId}`
      );
    }
    if (input.since) {
      conditions.push(gte(auditEvents.createdAt, input.since));
    }
    if (input.until) {
      conditions.push(lte(auditEvents.createdAt, input.until));
    }

    const rows = await db
      .select({
        event: sql<string>`coalesce(${auditEvents.metadata} ->> 'event', replace(${auditEvents.action}, 'analytics.activation.', ''))`,
        surface: sql<string | null>`${auditEvents.metadata} ->> 'surface'`,
        deploymentProfile: sql<
          string | null
        >`${auditEvents.metadata} ->> 'deploymentProfile'`,
        count: sql<number>`count(*)::int`,
        firstSeenAt: sql<Date | null>`min(${auditEvents.createdAt})`,
        lastSeenAt: sql<Date | null>`max(${auditEvents.createdAt})`
      })
      .from(auditEvents)
      .where(and(...conditions))
      .groupBy(
        sql`coalesce(${auditEvents.metadata} ->> 'event', replace(${auditEvents.action}, 'analytics.activation.', ''))`,
        sql`${auditEvents.metadata} ->> 'surface'`,
        sql`${auditEvents.metadata} ->> 'deploymentProfile'`
      );

    const byEvent = new Map<
      string,
      ActivationAnalyticsFunnelRecord["events"][number]
    >();
    for (const row of rows) {
      const event = row.event;
      const existing =
        byEvent.get(event) ??
        ({
          event,
          count: 0,
          firstSeenAt: null,
          lastSeenAt: null,
          surfaces: {},
          deploymentProfiles: {}
        } satisfies ActivationAnalyticsFunnelRecord["events"][number]);
      existing.count += Number(row.count ?? 0);
      const firstSeenAt = row.firstSeenAt
        ? timestampIso(row.firstSeenAt)
        : null;
      const lastSeenAt = row.lastSeenAt ? timestampIso(row.lastSeenAt) : null;
      if (
        firstSeenAt &&
        (!existing.firstSeenAt ||
          Date.parse(firstSeenAt) < Date.parse(existing.firstSeenAt))
      ) {
        existing.firstSeenAt = firstSeenAt;
      }
      if (
        lastSeenAt &&
        (!existing.lastSeenAt ||
          Date.parse(lastSeenAt) > Date.parse(existing.lastSeenAt))
      ) {
        existing.lastSeenAt = lastSeenAt;
      }
      if (row.surface) {
        existing.surfaces[row.surface] =
          (existing.surfaces[row.surface] ?? 0) + Number(row.count ?? 0);
      }
      if (row.deploymentProfile) {
        existing.deploymentProfiles[row.deploymentProfile] =
          (existing.deploymentProfiles[row.deploymentProfile] ?? 0) +
          Number(row.count ?? 0);
      }
      byEvent.set(event, existing);
    }

    return {
      generatedAt: new Date().toISOString(),
      scope: {
        ownerUserId: teamId ? null : actor.userId,
        teamId,
        teamWorkspaceId
      },
      window: {
        since: input.since ? input.since.toISOString() : null,
        until: input.until ? input.until.toISOString() : null
      },
      events: [...byEvent.values()].sort((left, right) =>
        left.event.localeCompare(right.event)
      )
    };
  }
});
