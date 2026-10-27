import {
  scheduledJobRunSchema,
  scheduledJobSchema
} from "@koed/shared/scheduled-job-contract";
import { z } from "zod";
import {
  scheduledJobsRequestSchema,
  scheduledJobsResultSchema,
  type ScheduledJobsRequest,
  type ScheduledJobsResult
} from "../ipc/scheduled-jobs-protocol.js";

export type ScheduledJobsAuthority = Readonly<{
  key: string;
  ownerId: string;
  apiOrigin: string;
  authorization: string;
}>;
type RequestJson = (
  path: string,
  init: RequestInit,
  authority: ScheduledJobsAuthority
) => Promise<Record<string, unknown>>;
const jobPage = z
  .object({
    jobs: z.array(scheduledJobSchema),
    nextCursor: z.string().nullable()
  })
  .strict();
const runPage = z
  .object({
    runs: z.array(scheduledJobRunSchema),
    nextCursor: z.string().nullable()
  })
  .strict();

export const createScheduledJobsClient =
  (input: {
    authority: () => Promise<ScheduledJobsAuthority>;
    requestJson: RequestJson;
  }) =>
  async (value: ScheduledJobsRequest): Promise<ScheduledJobsResult> => {
    const request = scheduledJobsRequestSchema.parse(value);
    const authority = await input.authority();
    const path = "/v1/scheduled-jobs";
    const endpoint =
      "jobId" in request
        ? `${path}/${encodeURIComponent(request.jobId)}`
        : path;
    const json = (method: string, suffix = "", body?: unknown) =>
      input.requestJson(
        endpoint + suffix,
        {
          method,
          ...(body === undefined
            ? {}
            : {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body)
              })
        },
        authority
      );
    let result: ScheduledJobsResult;
    switch (request.operation) {
      case "list": {
        const page = jobPage.parse(
          await json(
            "GET",
            `?limit=100${request.cursor ? `&cursor=${encodeURIComponent(request.cursor)}` : ""}`
          )
        );
        result = { operation: "list", ...page };
        break;
      }
      case "runs": {
        const page = runPage.parse(
          await json(
            "GET",
            `/runs?limit=100${request.cursor ? `&cursor=${encodeURIComponent(request.cursor)}` : ""}`
          )
        );
        if (page.runs.some((run) => run.jobId !== request.jobId))
          throw new Error("Scheduled run identity mismatch.");
        result = { operation: "runs", jobId: request.jobId, ...page };
        break;
      }
      case "get":
        result = {
          operation: "get",
          job: scheduledJobSchema.parse(await json("GET"))
        };
        break;
      case "create":
        result = {
          operation: "create",
          job: scheduledJobSchema.parse(await json("POST", "", request.value))
        };
        break;
      case "edit":
        result = {
          operation: "edit",
          job: scheduledJobSchema.parse(
            await json("PATCH", "", {
              expectedVersion: request.expectedVersion,
              ...(request.title !== undefined ? { title: request.title } : {}),
              ...(request.instruction !== undefined
                ? { instruction: request.instruction }
                : {}),
              ...(request.schedule !== undefined
                ? { schedule: request.schedule }
                : {})
            })
          )
        };
        break;
      case "pause":
        result = {
          operation: "pause",
          job: scheduledJobSchema.parse(
            await json("POST", "/pause", {
              expectedVersion: request.expectedVersion,
              paused: request.paused,
              ...(request.textActionId
                ? { textActionId: request.textActionId }
                : {})
            })
          )
        };
        break;
      case "runNow":
        result = {
          operation: "runNow",
          run: scheduledJobRunSchema.parse(
            await json("POST", "/run-now", {
              expectedVersion: request.expectedVersion,
              requestId: request.requestId
            })
          )
        };
        break;
      case "retry":
        result = {
          operation: "retry",
          run: scheduledJobRunSchema.parse(
            await json(
              "POST",
              `/runs/${encodeURIComponent(request.runId)}/retry`,
              { expectedVersion: request.expectedVersion }
            )
          )
        };
        break;
      case "skip":
        result = {
          operation: "skip",
          run: scheduledJobRunSchema.parse(
            await json(
              "POST",
              `/runs/${encodeURIComponent(request.runId)}/skip`,
              { expectedVersion: request.expectedVersion }
            )
          )
        };
        break;
    }
    if ((await input.authority()).key !== authority.key)
      throw new Error("Scheduled Jobs profile changed during request.");
    if ("job" in result && result.job.ownerUserId !== authority.ownerId)
      throw new Error("Scheduled Job owner mismatch.");
    if (
      result.operation === "list" &&
      result.jobs.some((job) => job.ownerUserId !== authority.ownerId)
    )
      throw new Error("Scheduled Job owner mismatch.");
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
      throw new Error("Scheduled run identity mismatch.");
    if (
      "runId" in request &&
      "run" in result &&
      result.run.id !== request.runId
    )
      throw new Error("Scheduled run identity mismatch.");
    return scheduledJobsResultSchema.parse(result);
  };
