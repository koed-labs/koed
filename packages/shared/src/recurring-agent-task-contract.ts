import { DateTime, IANAZone } from "luxon";
import { z } from "zod";
import {
  aiClientIdentifierPattern,
  aiClientPermissionModes
} from "./ai-client-contract.js";

const uuid = z.uuid();
const timestamp = z
  .string()
  .datetime({ offset: true })
  .refine(
    (value) => Number.isFinite(Date.parse(value)) && Date.parse(value) >= 0,
    "Choose a date on or after 1970-01-01"
  );
const text = (max: number) => z.string().trim().min(1).max(max);
export const recurringAgentTimeZoneSchema = text(96).refine(
  (value) => value === "UTC" || IANAZone.isValidZone(value),
  "Choose an IANA time zone"
);
const localTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
/** Calendar weekdays use ISO numbering: Monday 1, Sunday 7. */
export const recurringAgentScheduleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("interval"),
      everyMinutes: z.number().int().min(5).max(525_600),
      anchorAt: timestamp
    })
    .strict(),
  z
    .object({
      kind: z.literal("daily"),
      localTime,
      timeZone: recurringAgentTimeZoneSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("weekly"),
      localTime,
      timeZone: recurringAgentTimeZoneSchema,
      weekdays: z
        .array(z.number().int().min(1).max(7))
        .min(1)
        .max(7)
        .refine(
          (values) => new Set(values).size === values.length,
          "Choose distinct weekdays"
        )
    })
    .strict()
]);
export const recurringAgentTaskContextSchema = z
  .object({
    projectId: text(2_048).nullable(),
    contextKind: z.enum(["project", "independent"])
  })
  .strict()
  .refine(
    (value) => (value.contextKind === "project") === (value.projectId !== null),
    "Project and context must match"
  );
export const recurringAgentTaskExecutionSchema = z
  .object({
    provider: z.enum(["codex", "claude"]),
    aiClientInstanceId: text(128).regex(aiClientIdentifierPattern),
    targetDeviceId: text(128),
    model: text(512),
    reasoningEffort: text(64).nullable(),
    permissionMode: z.enum(aiClientPermissionModes)
  })
  .strict();
const taskDefinition = {
  title: text(120),
  prompt: text(32_000),
  schedule: recurringAgentScheduleSchema,
  context: recurringAgentTaskContextSchema,
  execution: recurringAgentTaskExecutionSchema
};
export const createRecurringAgentTaskSchema = z
  .object({ ...taskDefinition, requestId: uuid })
  .strict();
export const updateRecurringAgentTaskSchema = z
  .object({ ...taskDefinition, expectedRevision: z.number().int().positive() })
  .strict();
export const recurringAgentTaskControlSchema = z
  .object({
    action: z.enum(["pause", "resume", "archive"]),
    expectedRevision: z.number().int().positive(),
    activationConsent: z.boolean().optional(),
    acknowledgeReview: z.boolean().optional()
  })
  .strict()
  .refine(
    (value) => value.action !== "resume" || value.activationConsent === true,
    "Activating a task requires explicit consent"
  );
export const recurringAgentTaskRunNowSchema = z
  .object({ requestId: uuid, expectedRevision: z.number().int().positive() })
  .strict();
export const recurringAgentTaskStatusSchema = z.enum([
  "paused",
  "active",
  "needs_review",
  "archived"
]);
export const recurringAgentTaskSchema = z
  .object({
    id: uuid,
    agentId: uuid,
    ...taskDefinition,
    status: recurringAgentTaskStatusSchema,
    revision: z.number().int().positive(),
    nextRunAt: timestamp.nullable(),
    lastRunAt: timestamp.nullable(),
    lastErrorCode: text(160).nullable(),
    createdAt: timestamp,
    updatedAt: timestamp
  })
  .strict();
export const recurringAgentOccurrenceStatusSchema = z.enum([
  "reserved",
  "dispatched",
  "completed",
  "needs_review",
  "canceled"
]);
export const recurringAgentOccurrenceSchema = z
  .object({
    id: uuid,
    taskId: uuid,
    taskRevision: z.number().int().positive(),
    trigger: z.enum(["scheduled", "manual"]),
    scheduledAt: timestamp,
    status: recurringAgentOccurrenceStatusSchema,
    conversationId: uuid,
    messageId: uuid.nullable(),
    deliveryId: uuid.nullable(),
    executionId: uuid.nullable(),
    errorCode: text(160).nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp.nullable()
  })
  .strict();
export const recurringAgentTaskListSchema = z
  .object({
    tasks: z.array(recurringAgentTaskSchema).max(100),
    nextCursor: uuid.nullable().optional()
  })
  .strict();
export const recurringAgentOccurrencePageSchema = z
  .object({
    occurrences: z.array(recurringAgentOccurrenceSchema).max(50),
    nextCursor: uuid.nullable()
  })
  .strict();
export type RecurringAgentSchedule = z.infer<
  typeof recurringAgentScheduleSchema
>;
export type RecurringAgentTask = z.infer<typeof recurringAgentTaskSchema>;
export type RecurringAgentTaskExecution = z.infer<
  typeof recurringAgentTaskExecutionSchema
>;
export type RecurringAgentTaskContext = z.infer<
  typeof recurringAgentTaskContextSchema
>;
export type CreateRecurringAgentTask = z.infer<
  typeof createRecurringAgentTaskSchema
>;
export type UpdateRecurringAgentTask = z.infer<
  typeof updateRecurringAgentTaskSchema
>;
export type RecurringAgentTaskControl = z.infer<
  typeof recurringAgentTaskControlSchema
>;
export type RecurringAgentTaskRunNow = z.infer<
  typeof recurringAgentTaskRunNowSchema
>;
export type RecurringAgentOccurrence = z.infer<
  typeof recurringAgentOccurrenceSchema
>;
export type RecurringAgentOccurrencePage = z.infer<
  typeof recurringAgentOccurrencePageSchema
>;

/** A repeated wall-clock time runs only at its earlier instant; a skipped time has no occurrence. */
function calendarSlot(
  schedule: Exclude<RecurringAgentSchedule, { kind: "interval" }>,
  day: DateTime
): number | null {
  if (schedule.kind === "weekly" && !schedule.weekdays.includes(day.weekday))
    return null;
  const [hour, minute] = schedule.localTime.split(":").map(Number);
  const date = DateTime.fromObject(
    {
      year: day.year,
      month: day.month,
      day: day.day,
      hour,
      minute,
      second: 0,
      millisecond: 0
    },
    { zone: schedule.timeZone }
  );
  if (
    !date.isValid ||
    date.year !== day.year ||
    date.month !== day.month ||
    date.day !== day.day ||
    date.hour !== hour ||
    date.minute !== minute
  )
    return null;
  return Math.min(
    ...date.getPossibleOffsets().map((possible) => possible.toMillis())
  );
}
function instant(value: string | number): number {
  const result = typeof value === "number" ? value : Date.parse(value);
  if (
    !Number.isSafeInteger(result) ||
    result < 0 ||
    result > 8_640_000_000_000_000
  )
    throw new Error("RecurringAgentTaskTimeInvalid");
  return result;
}
/** First occurrence strictly after a boundary. Resume calls this at now: paused time is never replayed. */
export function nextRecurringAgentTaskAt(
  input: RecurringAgentSchedule,
  after: string | number
): string {
  const schedule = recurringAgentScheduleSchema.parse(input);
  const boundary = instant(after);
  if (schedule.kind === "interval") {
    const anchor = instant(schedule.anchorAt),
      step = schedule.everyMinutes * 60_000;
    const value =
      anchor > boundary
        ? anchor
        : anchor + (Math.floor((boundary - anchor) / step) + 1) * step;
    return new Date(instant(value)).toISOString();
  }
  const first = DateTime.fromMillis(boundary, {
    zone: schedule.timeZone
  }).startOf("day");
  // Daily/weekly schedules need at most two weeks, including a skipped civil day.
  for (let offset = 0; offset <= 21; offset++) {
    const slot = calendarSlot(schedule, first.plus({ days: offset }));
    if (slot !== null && slot > boundary) return new Date(slot).toISOString();
  }
  throw new Error("RecurringAgentTaskScheduleUnresolvable");
}
/** Coalesce downtime to the latest due slot, in constant bounded calendar work; never enumerate a backlog. */
export function latestDueRecurringAgentTask(
  input: RecurringAgentSchedule,
  nextDueAt: string,
  now: string | number
): { scheduledAt: string; nextRunAt: string } | null {
  const schedule = recurringAgentScheduleSchema.parse(input);
  const boundary = instant(now),
    earliest = instant(nextDueAt);
  if (earliest > boundary) return null;
  let latest: number | null = null;
  if (schedule.kind === "interval") {
    const anchor = instant(schedule.anchorAt),
      step = schedule.everyMinutes * 60_000;
    if (boundary >= anchor)
      latest = anchor + Math.floor((boundary - anchor) / step) * step;
  } else {
    const first = DateTime.fromMillis(boundary, {
      zone: schedule.timeZone
    }).startOf("day");
    for (let offset = 0; offset <= 21; offset++) {
      const slot = calendarSlot(schedule, first.minus({ days: offset }));
      if (slot !== null && slot <= boundary) {
        latest = slot;
        break;
      }
    }
  }
  if (latest === null || latest < earliest) return null;
  return {
    scheduledAt: new Date(latest).toISOString(),
    nextRunAt: nextRecurringAgentTaskAt(schedule, boundary)
  };
}
