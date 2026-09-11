import { z } from "zod";

export const memoryAnswerTaskOrigins = ["mcp", "pi_extension"] as const;
export const memoryAnswerTaskStatuses = [
  "accepted",
  "running",
  "cancel_requested",
  "completed",
  "failed",
  "cancelled"
] as const;

const boundedRecordSchema = z.record(z.string().max(128), z.unknown());
const nullableTimestampSchema = z.string().datetime().nullable();

export const memoryAnswerTaskSchema = z
  .object({
    id: z.string().uuid(),
    origin: z.enum(memoryAnswerTaskOrigins),
    invocationKey: z.string().nullable(),
    questionId: z.string().uuid().nullable(),
    status: z.enum(memoryAnswerTaskStatuses),
    statusMessage: z.string().nullable(),
    attemptCount: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    fenceGeneration: z.number().int().nonnegative(),
    cancelRequestedAt: nullableTimestampSchema,
    startedAt: nullableTimestampSchema,
    lastProgressAt: nullableTimestampSchema,
    completedAt: nullableTimestampSchema,
    failedAt: nullableTimestampSchema,
    cancelledAt: nullableTimestampSchema,
    lastErrorCode: z.string().nullable(),
    lastErrorMessage: z.string().nullable(),
    result: boundedRecordSchema.nullable(),
    version: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    expiresAt: z.string().datetime()
  })
  .strict();

export const claimedMemoryAnswerTaskSchema = memoryAnswerTaskSchema.extend({
  leaseOwner: z.string(),
  leaseUntil: z.string().datetime(),
  request: boundedRecordSchema
});

export const memoryAnswerTaskResponseSchema = z
  .object({ task: memoryAnswerTaskSchema })
  .strict();

export const memoryAnswerTaskClaimResponseSchema = z
  .object({
    task: claimedMemoryAnswerTaskSchema.nullable(),
    reconciled: z.array(memoryAnswerTaskSchema)
  })
  .strict();

export const acceptMemoryAnswerTaskSchema = z
  .object({
    origin: z.enum(memoryAnswerTaskOrigins),
    invocation_key: z.string().trim().min(1).max(500).optional(),
    request: boundedRecordSchema,
    max_attempts: z.number().int().positive().max(10).optional(),
    max_queued: z.number().int().positive().max(10_000)
  })
  .strict();

export const claimMemoryAnswerTaskSchema = z
  .object({
    lease_owner: z.string().trim().min(16).max(256),
    lease_ms: z.number().int().min(1_000).max(300_000)
  })
  .strict();

const fencedTaskMutationSchema = z.object({
  lease_owner: z.string().trim().min(16).max(256),
  fence_generation: z.number().int().positive()
});

export const heartbeatMemoryAnswerTaskSchema = fencedTaskMutationSchema
  .extend({
    lease_ms: z.number().int().min(1_000).max(300_000),
    made_progress: z.boolean().optional(),
    status_message: z.string().trim().min(1).max(500).optional()
  })
  .strict();

export const completeMemoryAnswerTaskSchema = fencedTaskMutationSchema
  .extend({
    question_id: z.string().uuid(),
    result: boundedRecordSchema
  })
  .strict();

export const failMemoryAnswerTaskSchema = fencedTaskMutationSchema
  .extend({
    error_code: z.string().trim().min(1).max(160),
    error_message: z.string().min(1).max(8_192),
    retry: z.boolean(),
    retry_delay_ms: z.number().int().nonnegative().max(3_600_000).optional()
  })
  .strict();

export const memoryAnswerTaskParamsSchema = z
  .object({ taskId: z.string().uuid() })
  .strict();

export type MemoryAnswerTask = z.infer<typeof memoryAnswerTaskSchema>;
export type ClaimedMemoryAnswerTask = z.infer<
  typeof claimedMemoryAnswerTaskSchema
>;
export type MemoryAnswerTaskStatus = MemoryAnswerTask["status"];
export type MemoryAnswerTaskOrigin = MemoryAnswerTask["origin"];
export type AcceptMemoryAnswerTaskInput = z.infer<
  typeof acceptMemoryAnswerTaskSchema
>;
export type ClaimMemoryAnswerTaskInput = z.infer<
  typeof claimMemoryAnswerTaskSchema
>;
export type HeartbeatMemoryAnswerTaskInput = z.infer<
  typeof heartbeatMemoryAnswerTaskSchema
>;
export type CompleteMemoryAnswerTaskInput = z.infer<
  typeof completeMemoryAnswerTaskSchema
>;
export type FailMemoryAnswerTaskInput = z.infer<
  typeof failMemoryAnswerTaskSchema
>;

export const memoryAnswerTaskIsTerminal = (
  task: Pick<MemoryAnswerTask, "status">
): boolean =>
  task.status === "completed" ||
  task.status === "failed" ||
  task.status === "cancelled";
