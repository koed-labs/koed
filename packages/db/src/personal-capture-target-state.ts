import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { personalCaptureTargetBindingSchema } from "@koed/shared";
import type { KoedDb } from "./connection.js";
import { personalCaptureTargetBindings } from "./schema.js";

export type CaptureTargetSession = {
  id: string;
  logicalSessionId: string;
  projectOverrideId: string | null;
  automaticProjectId: string | null;
  cwd: string | null;
};
export type CaptureTargetChoice = {
  mode: "source" | "global" | "target";
  targetId: string | null;
};
export const captureTargetFromChoice = (
  session: CaptureTargetSession,
  choice: CaptureTargetChoice
) =>
  choice.mode === "global"
    ? null
    : choice.mode === "target"
      ? choice.targetId
      : (session.automaticProjectId ?? session.cwd);

/** The legacy slot remains authoritative before detachment unless the User
 * explicitly repairs the binding. The new organization tables are never read.
 */
export const readPersonalCaptureTarget = async (
  db: KoedDb,
  ownerUserId: string,
  session: CaptureTargetSession
) => {
  const legacyTarget =
    session.projectOverrideId ?? session.automaticProjectId ?? session.cwd;
  // A staged expansion rehearsal can read the old schema before migration 67.
  // Normal server startup separately requires the complete migration set.
  const available = await db.execute<{ available: boolean }>(
    sql`select to_regclass('public.personal_capture_target_bindings') is not null as available`
  );
  if (!available.rows[0]?.available)
    return { binding: null, targetId: legacyTarget, blocked: false };
  const rows = await db
    .select({
      ...getTableColumns(personalCaptureTargetBindings),
      // Staged upgrades can read schema 67 before the route-origin expansion.
      origin: sql<string>`coalesce(to_jsonb(${personalCaptureTargetBindings})->>'origin','legacy_session')`,
      routeSourceScope: sql<
        string | null
      >`to_jsonb(${personalCaptureTargetBindings})->>'route_source_scope'`
    })
    .from(personalCaptureTargetBindings)
    .where(
      and(
        eq(personalCaptureTargetBindings.ownerUserId, ownerUserId),
        eq(personalCaptureTargetBindings.sessionId, session.id)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return { binding: null, targetId: legacyTarget, blocked: false };
  const identityChanged = row.logicalSessionId !== session.logicalSessionId;
  const legacyChanged =
    row.legacyDetachedAt === null
      ? session.projectOverrideId !== row.originalTargetId
      : session.projectOverrideId !== null;
  const binding = personalCaptureTargetBindingSchema.parse({
    origin: row.origin,
    bindingId: row.bindingId,
    sessionId: row.sessionId,
    logicalSessionId: row.logicalSessionId,
    version: row.version,
    mode: row.mode,
    targetId: row.targetId,
    originalTarget: {
      id: row.originalTargetId,
      name: row.originalTargetName,
      path: row.originalTargetPath
    },
    legacyDetachedAt: row.legacyDetachedAt?.toISOString() ?? null,
    repairRequired:
      identityChanged || (row.mode === "preserved" && legacyChanged)
  });
  const effectiveTargetId =
    binding.mode === "preserved"
      ? row.legacyDetachedAt === null
        ? legacyTarget
        : row.targetId
      : captureTargetFromChoice(session, {
          mode: binding.mode,
          targetId: row.targetId
        });
  return {
    binding: { ...binding, effectiveTargetId },
    targetId: effectiveTargetId,
    blocked: identityChanged || (row.legacyDetachedAt !== null && legacyChanged)
  };
};
