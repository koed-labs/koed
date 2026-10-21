import { z } from "zod";
import {
  createScheduledJobSchema,
  scheduledJobRunSchema,
  scheduledJobSchema
} from "@koed/shared/scheduled-job-contract";

export const scheduledJobsChannel = "koed:scheduled-jobs:command";
const id = z.uuid();
const version = z.number().int().positive();
export const scheduledJobsRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({ operation: z.literal("list"), cursor: z.string().optional() })
    .strict(),
  z
    .object({
      operation: z.literal("runs"),
      jobId: id,
      cursor: z.string().optional()
    })
    .strict(),
  z.object({ operation: z.literal("get"), jobId: id }).strict(),
  z
    .object({ operation: z.literal("create"), value: createScheduledJobSchema })
    .strict(),
  z
    .object({
      operation: z.literal("pause"),
      jobId: id,
      expectedVersion: version,
      paused: z.boolean(),
      textActionId: id.optional()
    })
    .strict(),
  z
    .object({
      operation: z.literal("runNow"),
      jobId: id,
      expectedVersion: version,
      requestId: id
    })
    .strict(),
  z
    .object({
      operation: z.literal("retry"),
      jobId: id,
      runId: id,
      expectedVersion: version
    })
    .strict(),
  z
    .object({
      operation: z.literal("skip"),
      jobId: id,
      runId: id,
      expectedVersion: version
    })
    .strict()
]);
export const scheduledJobsResultSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("list"),
      jobs: z.array(scheduledJobSchema),
      nextCursor: z.string().nullable()
    })
    .strict(),
  z
    .object({
      operation: z.literal("runs"),
      jobId: id,
      runs: z.array(scheduledJobRunSchema),
      nextCursor: z.string().nullable()
    })
    .strict(),
  z.object({ operation: z.literal("get"), job: scheduledJobSchema }).strict(),
  z
    .object({ operation: z.literal("create"), job: scheduledJobSchema })
    .strict(),
  z.object({ operation: z.literal("pause"), job: scheduledJobSchema }).strict(),
  z
    .object({ operation: z.literal("runNow"), run: scheduledJobRunSchema })
    .strict(),
  z
    .object({ operation: z.literal("retry"), run: scheduledJobRunSchema })
    .strict(),
  z
    .object({ operation: z.literal("skip"), run: scheduledJobRunSchema })
    .strict()
]);
export type ScheduledJobsRequest = z.infer<typeof scheduledJobsRequestSchema>;
export type ScheduledJobsResult = z.infer<typeof scheduledJobsResultSchema>;
export type ScheduledJobsDesktopApi = {
  command(request: ScheduledJobsRequest): Promise<ScheduledJobsResult>;
};
