import { z } from "zod";

const at = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const tz = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => {
    if (/^(?:[+-]\d{1,2}(?::?\d{2})?|UTC[+-].*)$/i.test(value)) return false;
    try {
      const canonical = new Intl.DateTimeFormat("en", {
        timeZone: value
      }).resolvedOptions().timeZone;
      return canonical.includes("/") || canonical === "UTC";
    } catch {
      return false;
    }
  }, "Supported IANA timezone required");
const base = { at, tz };
export const scheduledJobScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily"), ...base }).strict(),
  z.object({ kind: z.literal("weekdays"), ...base }).strict(),
  z
    .object({
      kind: z.literal("weekly"),
      ...base,
      dow: z
        .array(z.number().int().min(1).max(7))
        .min(1)
        .max(7)
        .refine(
          (days) => new Set(days).size === days.length,
          "Duplicate weekday"
        )
    })
    .strict(),
  z
    .object({
      kind: z.literal("monthly"),
      ...base,
      dom: z.number().int().min(1).max(31)
    })
    .strict()
]);
export type ScheduledJobSchedule = z.infer<typeof scheduledJobScheduleSchema>;

export const createScheduledJobSchema = z
  .object({
    requestId: z.uuid(),
    agentId: z.uuid(),
    conversationSessionId: z.uuid(),
    projectId: z.uuid().nullable(),
    title: z.string().trim().min(1).max(160),
    instruction: z.string().trim().min(1).max(20_000),
    schedule: scheduledJobScheduleSchema,
    textActionId: z.uuid().optional()
  })
  .strict();
export const editScheduledJobSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    title: z.string().trim().min(1).max(160).optional(),
    instruction: z.string().trim().min(1).max(20_000).optional(),
    schedule: scheduledJobScheduleSchema.optional(),
    agentId: z.uuid().optional(),
    conversationSessionId: z.uuid().optional(),
    projectId: z.uuid().nullable().optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 1);
export const scheduledJobVersionSchema = z
  .object({
    expectedVersion: z.number().int().positive()
  })
  .strict();
export const scheduledJobRunNowSchema = scheduledJobVersionSchema
  .extend({
    requestId: z.uuid()
  })
  .strict();
export const scheduledJobReassignSchema = scheduledJobVersionSchema
  .extend({
    targetDeviceId: z.uuid()
  })
  .strict();
export const scheduledJobRunStatusSchema = z.enum([
  "scheduled",
  "running",
  "waiting_approval",
  "ok",
  "failed",
  "interrupted",
  "missed",
  "skipped"
]);
export const scheduledJobSchema = z
  .object({
    id: z.uuid(),
    ownerUserId: z.uuid(),
    projectId: z.uuid().nullable(),
    agentId: z.uuid(),
    conversationSessionId: z.uuid(),
    title: z.string(),
    instruction: z.string(),
    schedule: scheduledJobScheduleSchema,
    paused: z.boolean(),
    pausedReason: z.string().nullable(),
    runnerDeviceId: z.uuid(),
    version: z.number().int().positive(),
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .strict();
export const scheduledJobRunSchema = z
  .object({
    id: z.uuid(),
    jobId: z.uuid(),
    scheduledFor: z.string(),
    trigger: z.enum(["scheduled", "manual"]),
    attempt: z.number().int().nonnegative(),
    status: scheduledJobRunStatusSchema,
    skipReason: z.string().nullable(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    executionId: z.uuid().nullable(),
    error: z.string().nullable()
  })
  .strict();
// executionId is the Scheduled Job attempt's unique fence identity, not the
// Managed Conversation Execution ID shared by turns in the bound Conversation.
export const scheduledJobAttemptSchema = z
  .object({
    id: z.uuid(),
    runId: z.uuid(),
    attempt: z.number().int().positive(),
    executionId: z.uuid(),
    fenceGeneration: z.number().int().positive(),
    jobVersion: z.number().int().positive(),
    runnerDeviceId: z.uuid(),
    conversationSessionId: z.uuid(),
    conversationProjectAssignmentVersion: z.number().int().positive(),
    projectId: z.uuid().nullable(),
    projectVersion: z.number().int().positive().nullable(),
    teamBackendId: z.string().nullable(),
    workspaceProjectId: z.uuid().nullable(),
    teamProjectVersion: z.number().int().positive().nullable(),
    teamMemberVersion: z.number().int().positive().nullable(),
    startedAt: z.string()
  })
  .strict();
export const scheduledJobAttemptEventSchema = z
  .object({
    id: z.uuid(),
    attemptId: z.uuid(),
    eventKind: z.enum([
      "attempt_start",
      "state",
      "lease_acquired",
      "lease_renewed",
      "fence_changed"
    ]),
    executionId: z.uuid(),
    fenceGeneration: z.number().int().positive(),
    status: scheduledJobRunStatusSchema,
    leaseOwnerId: z.string().nullable(),
    leaseExpiresAt: z.string().nullable(),
    uncertainty: z.boolean(),
    outcome: z.string().nullable(),
    error: z.string().nullable(),
    at: z.string()
  })
  .strict();
export type CreateScheduledJob = z.infer<typeof createScheduledJobSchema>;
export type EditScheduledJob = z.infer<typeof editScheduledJobSchema>;

/** Private Local AI Runtime transport. These receipts never carry a credential. */
export const scheduledJobRuntimeTickRequestSchema = z.object({}).strict();
export const scheduledJobRuntimeTickResultSchema = z
  .object({
    materialized: z.number().int().nonnegative(),
    dispatched: z.number().int().nonnegative(),
    needsReview: z.number().int().nonnegative(),
    reconciled: z.number().int().nonnegative()
  })
  .strict();
export const scheduledJobRuntimeAuthoritySchema = z
  .object({ allowed: z.literal(true), scheduled: z.boolean() })
  .strict();
export const scheduledJobRuntimeLeaseRequestSchema = z
  .object({
    leaseToken: z.string().min(1).max(512),
    runnerId: z.string().min(1).max(160)
  })
  .strict();
export const scheduledJobRuntimeLeaseResultSchema = z
  .object({ recorded: z.literal(true) })
  .strict();

export function scheduledJobLocalApiUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error("Scheduled Jobs require the local Personal API");
  return url;
}
