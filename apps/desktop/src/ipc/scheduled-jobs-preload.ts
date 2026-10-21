import {
  scheduledJobsChannel,
  scheduledJobsRequestSchema,
  scheduledJobsResultSchema,
  type ScheduledJobsDesktopApi
} from "./scheduled-jobs-protocol.js";

export const createScheduledJobsPreloadApi = (
  invoke: (channel: string, value: unknown) => Promise<unknown>
): ScheduledJobsDesktopApi =>
  Object.freeze({
    command: async (value) => {
      const request = scheduledJobsRequestSchema.parse(value);
      const result = scheduledJobsResultSchema.parse(
        await invoke(scheduledJobsChannel, request)
      );
      if (result.operation !== request.operation)
        throw new Error("Scheduled Job operation mismatch.");
      if (
        "jobId" in request &&
        "jobId" in result &&
        result.jobId !== request.jobId
      )
        throw new Error("Scheduled Job identity mismatch.");
      if (
        "jobId" in request &&
        result.operation === "runs" &&
        result.runs.some((run) => run.jobId !== request.jobId)
      )
        throw new Error("Scheduled run identity mismatch.");
      if (
        "jobId" in request &&
        "job" in result &&
        result.job.id !== request.jobId
      )
        throw new Error("Scheduled Job identity mismatch.");
      if (
        "jobId" in request &&
        "run" in result &&
        result.run.jobId !== request.jobId
      )
        throw new Error("Scheduled Job identity mismatch.");
      if (
        "runId" in request &&
        "run" in result &&
        result.run.id !== request.runId
      )
        throw new Error("Scheduled run identity mismatch.");
      return result;
    }
  });
