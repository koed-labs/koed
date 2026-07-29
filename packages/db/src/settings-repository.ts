import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { auditEventValues } from "./audit-repository.js";
import type { KoedDb } from "./connection.js";
import {
  auditEvents,
  capturePolicies,
  localMemoryAgentSettings,
  sessions
} from "./schema.js";
import type {
  ActorContext,
  CapturePolicyRecord,
  CapturePolicyTarget,
  CaptureState,
  EffectiveCapturePolicy,
  LocalMemoryAgentSettingRecord,
  LocalMemoryAgentSettingsFlowKey,
  UpsertCapturePolicyInput,
  Visibility
} from "./types.js";

const timestampIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const mapCapturePolicyRecord = (row: {
  id: string;
  ownerUserId: string;
  targetType: CapturePolicyTarget;
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  threadId: string | null;
  threadName: string | null;
  captureState: CaptureState | null;
  visibility: Visibility | null;
  pauseUntil: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}): CapturePolicyRecord => ({
  id: row.id,
  ownerUserId: row.ownerUserId,
  targetType: row.targetType,
  projectId: row.projectId,
  projectName: row.projectName,
  projectPath: row.projectPath,
  threadId: row.threadId,
  threadName: row.threadName,
  captureState: row.captureState,
  visibility: row.visibility,
  pauseUntil: row.pauseUntil ? timestampIso(row.pauseUntil) : null,
  createdAt: timestampIso(row.createdAt),
  updatedAt: timestampIso(row.updatedAt)
});

const mapCapturePolicySqlRecord = (row: {
  id: string;
  owner_user_id: string;
  target_type: CapturePolicyTarget;
  project_id: string | null;
  project_name: string | null;
  project_path: string | null;
  thread_id: string | null;
  thread_name: string | null;
  capture_state: CaptureState | null;
  visibility: Visibility | null;
  pause_until: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): CapturePolicyRecord =>
  mapCapturePolicyRecord({
    id: row.id,
    ownerUserId: row.owner_user_id,
    targetType: row.target_type,
    projectId: row.project_id,
    projectName: row.project_name,
    projectPath: row.project_path,
    threadId: row.thread_id,
    threadName: row.thread_name,
    captureState: row.capture_state,
    visibility: row.visibility,
    pauseUntil: row.pause_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });

const mapLocalMemoryAgentSettingRecord = (row: {
  ownerUserId: string;
  flowKey: string;
  provider: string;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  maxAttempts: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}): LocalMemoryAgentSettingRecord => ({
  ownerUserId: row.ownerUserId,
  flowKey: row.flowKey as LocalMemoryAgentSettingsFlowKey,
  provider: row.provider as "codex",
  model: row.model,
  reasoningEffort: row.reasoningEffort,
  timeoutMs: Number(row.timeoutMs),
  maxAttempts: Number(row.maxAttempts),
  createdAt: timestampIso(row.createdAt),
  updatedAt: timestampIso(row.updatedAt)
});

const capturePolicyAuditMetadata = (policy: CapturePolicyRecord) => ({
  targetType: policy.targetType,
  projectId: policy.projectId,
  projectName: policy.projectName,
  projectPath: policy.projectPath,
  threadId: policy.threadId,
  threadName: policy.threadName,
  captureState: policy.captureState,
  visibility: policy.visibility,
  pauseUntil: policy.pauseUntil
});

export const createSettingsRepository = (db: KoedDb) => ({
  async listLocalMemoryAgentSettings(
    actor: ActorContext
  ): Promise<LocalMemoryAgentSettingRecord[]> {
    const rows = await db
      .select()
      .from(localMemoryAgentSettings)
      .where(eq(localMemoryAgentSettings.ownerUserId, actor.userId))
      .orderBy(asc(localMemoryAgentSettings.flowKey));

    return rows.map(mapLocalMemoryAgentSettingRecord);
  },

  async upsertLocalMemoryAgentSetting(
    actor: ActorContext,
    input: {
      flowKey: LocalMemoryAgentSettingsFlowKey;
      provider: "codex";
      model: string;
      reasoningEffort: string;
      timeoutMs: number;
      maxAttempts: number;
    }
  ): Promise<LocalMemoryAgentSettingRecord> {
    const rows = await db
      .insert(localMemoryAgentSettings)
      .values({
        ownerUserId: actor.userId,
        flowKey: input.flowKey,
        provider: input.provider,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        timeoutMs: input.timeoutMs,
        maxAttempts: input.maxAttempts
      })
      .onConflictDoUpdate({
        target: [
          localMemoryAgentSettings.ownerUserId,
          localMemoryAgentSettings.flowKey
        ],
        set: {
          provider: input.provider,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          timeoutMs: input.timeoutMs,
          maxAttempts: input.maxAttempts,
          updatedAt: sql`now()`
        }
      })
      .returning();

    return mapLocalMemoryAgentSettingRecord(rows[0]!);
  },

  async getEffectiveCapturePolicy(
    actor: ActorContext,
    input: { projectId?: string; threadId?: string; sessionId?: string } = {}
  ): Promise<EffectiveCapturePolicy> {
    const sessionRows = input.sessionId
      ? await db
          .select({
            id: sessions.id,
            externalSessionId: sessions.externalSessionId,
            cwd: sessions.cwd,
            automaticProjectId: sessions.automaticProjectId,
            projectOverrideId: sessions.projectOverrideId
          })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, input.sessionId),
              eq(sessions.ownerUserId, actor.userId),
              isNull(sessions.invalidatedAt)
            )
          )
          .limit(1)
      : [];

    const session = sessionRows[0];
    const threadIds = (
      session
        ? [input.sessionId, session.externalSessionId ?? undefined]
        : [input.threadId]
    ).filter((value): value is string => Boolean(value));
    const projectId =
      input.projectId ??
      session?.projectOverrideId ??
      session?.automaticProjectId ??
      session?.cwd ??
      null;

    const policyConditions = [
      eq(capturePolicies.targetType, "global"),
      projectId
        ? and(
            eq(capturePolicies.targetType, "project"),
            eq(capturePolicies.projectId, projectId)
          )
        : undefined,
      threadIds.length > 0
        ? and(
            eq(capturePolicies.targetType, "thread"),
            inArray(capturePolicies.threadId, threadIds)
          )
        : undefined
    ].filter((condition): condition is Exclude<typeof condition, undefined> =>
      Boolean(condition)
    );

    const rows = await db
      .select()
      .from(capturePolicies)
      .where(
        and(
          eq(capturePolicies.ownerUserId, actor.userId),
          or(...policyConditions)
        )
      )
      .orderBy(
        sql`case ${capturePolicies.targetType}
          when 'thread' then 3
          when 'project' then 2
          else 1
        end desc`,
        desc(capturePolicies.updatedAt)
      );

    const policies = rows.map(mapCapturePolicyRecord);
    const global = policies.find((policy) => policy.targetType === "global");
    const effective = policies[0] ?? null;
    const activePauseTimes = policies
      .map((policy) => policy.pauseUntil)
      .filter((value): value is string => Boolean(value))
      .filter((value) => new Date(value).getTime() > Date.now())
      .sort(
        (left, right) => new Date(right).getTime() - new Date(left).getTime()
      );
    const pauseUntil = activePauseTimes[0] ?? null;
    const paused = pauseUntil !== null;

    return {
      captureState: paused
        ? "disabled"
        : (effective?.captureState ?? global?.captureState ?? "enabled"),
      visibility: effective?.visibility ?? global?.visibility ?? "personal",
      paused,
      pauseUntil,
      source: effective?.targetType ?? (global ? "global" : "default"),
      policy: effective
    };
  },

  async listCapturePolicies(
    actor: ActorContext,
    targetType?: CapturePolicyTarget
  ): Promise<CapturePolicyRecord[]> {
    const rows = await db
      .select()
      .from(capturePolicies)
      .where(
        and(
          eq(capturePolicies.ownerUserId, actor.userId),
          targetType ? eq(capturePolicies.targetType, targetType) : undefined
        )
      )
      .orderBy(
        sql`case ${capturePolicies.targetType}
          when 'global' then 0
          when 'project' then 1
          else 2
        end`,
        desc(capturePolicies.updatedAt)
      );

    return rows.map(mapCapturePolicyRecord);
  },

  async upsertCapturePolicy(
    actor: ActorContext,
    input: UpsertCapturePolicyInput
  ): Promise<CapturePolicyRecord> {
    if (input.targetType === "project" && !input.projectId) {
      throw new Error("Project capture policy requires projectId");
    }
    if (input.targetType === "thread" && !input.threadId) {
      throw new Error("Thread capture policy requires threadId");
    }

    const pauseUntil =
      input.pauseUntil instanceof Date
        ? input.pauseUntil
        : input.pauseUntil
          ? new Date(input.pauseUntil)
          : null;

    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`capture-policy:${actor.userId}`}, 0))`
      );
      const result = await tx.execute<{
        id: string;
        owner_user_id: string;
        target_type: CapturePolicyTarget;
        project_id: string | null;
        project_name: string | null;
        project_path: string | null;
        thread_id: string | null;
        thread_name: string | null;
        capture_state: CaptureState | null;
        visibility: Visibility | null;
        pause_until: Date | string | null;
        created_at: Date | string;
        updated_at: Date | string;
      }>(sql`
        insert into ${capturePolicies} (
          owner_user_id,
          target_type,
          project_id,
          project_name,
          project_path,
          thread_id,
          thread_name,
          capture_state,
          visibility,
          pause_until
        )
        values (
          ${actor.userId},
          ${input.targetType},
          ${input.targetType === "global" ? null : (input.projectId ?? null)},
          ${input.projectName ?? null},
          ${input.projectPath ?? null},
          ${input.targetType === "thread" ? input.threadId! : null},
          ${input.threadName ?? null},
          ${input.captureState ?? null},
          ${input.visibility ?? null},
          ${pauseUntil}
        )
        on conflict (
          owner_user_id,
          target_type,
          (coalesce(project_id, '')),
          (coalesce(thread_id, ''))
        )
        do update set
          project_name = excluded.project_name,
          project_path = excluded.project_path,
          thread_name = excluded.thread_name,
          capture_state = excluded.capture_state,
          visibility = excluded.visibility,
          pause_until = excluded.pause_until,
          updated_at = now()
        returning *
      `);

      const policy = mapCapturePolicySqlRecord(result.rows[0]!);
      await tx.insert(auditEvents).values(
        auditEventValues({
          actorUserId: actor.userId,
          ownerUserId: actor.userId,
          visibility: policy.visibility ?? "personal",
          action: "capture_policy.upserted",
          targetTable: "capture_policies",
          targetId: policy.id,
          metadata: capturePolicyAuditMetadata(policy)
        })
      );

      return policy;
    });
  },

  async deleteCapturePolicy(
    actor: ActorContext,
    policyId: string
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`capture-policy:${actor.userId}`}, 0))`
      );
      const rows = await tx
        .delete(capturePolicies)
        .where(
          and(
            eq(capturePolicies.id, policyId),
            eq(capturePolicies.ownerUserId, actor.userId)
          )
        )
        .returning();

      const policy = rows[0] ? mapCapturePolicyRecord(rows[0]) : null;
      if (policy) {
        await tx.insert(auditEvents).values(
          auditEventValues({
            actorUserId: actor.userId,
            ownerUserId: actor.userId,
            visibility: policy.visibility ?? "personal",
            action: "capture_policy.deleted",
            targetTable: "capture_policies",
            targetId: policy.id,
            metadata: capturePolicyAuditMetadata(policy)
          })
        );
      }

      return Boolean(policy);
    });
  }
});
