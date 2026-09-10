import { z } from "zod";

const taskIdSchema = z.string().uuid();
const leaseOwnerSchema = z.string().trim().min(16).max(256);
const boundedRecordSchema = z.record(z.string().max(128), z.unknown());

export const memoryAnswerTaskParamsSchema = z
  .object({ taskId: taskIdSchema })
  .strict();

export const acceptMemoryAnswerTaskSchema = z
  .object({
    origin: z.enum(["mcp", "pi_extension"]),
    invocation_key: z.string().trim().min(1).max(500).optional(),
    request: boundedRecordSchema,
    max_attempts: z.number().int().positive().max(10).optional()
  })
  .strict();

export const claimMemoryAnswerTaskSchema = z
  .object({
    lease_owner: leaseOwnerSchema,
    lease_ms: z.number().int().min(1_000).max(300_000)
  })
  .strict();

export const heartbeatMemoryAnswerTaskSchema = z
  .object({
    lease_owner: leaseOwnerSchema,
    fence_generation: z.number().int().positive(),
    lease_ms: z.number().int().min(1_000).max(300_000),
    made_progress: z.boolean().optional(),
    status_message: z.string().trim().min(1).max(500).optional()
  })
  .strict();

export const completeMemoryAnswerTaskSchema = z
  .object({
    lease_owner: leaseOwnerSchema,
    fence_generation: z.number().int().positive(),
    question_id: z.string().uuid(),
    result: boundedRecordSchema
  })
  .strict();

export const failMemoryAnswerTaskSchema = z
  .object({
    lease_owner: leaseOwnerSchema,
    fence_generation: z.number().int().positive(),
    error_code: z.string().trim().min(1).max(160),
    error_message: z.string().min(1).max(8_192),
    retry: z.boolean(),
    retry_delay_ms: z.number().int().nonnegative().max(3_600_000).optional()
  })
  .strict();
