import {
  scheduledJobSchema,
  scheduledJobRunSchema
} from "@koed/shared/scheduled-job-contract";
import { nextScheduledJobOccurrence } from "@koed/shared/scheduled-job-calendar";
import type { z } from "zod";
type ScheduledJob = z.infer<typeof scheduledJobSchema>;
type ScheduledJobRun = z.infer<typeof scheduledJobRunSchema>;

export const sortedScheduledJobs = (
  jobs: readonly ScheduledJob[],
  at = new Date()
) =>
  jobs
    .map((job) => ({
      job,
      next: job.paused ? null : nextScheduledJobOccurrence(job.schedule, at)
    }))
    .sort(
      (left, right) =>
        Number(left.job.paused) - Number(right.job.paused) ||
        (left.next?.getTime() ?? Number.POSITIVE_INFINITY) -
          (right.next?.getTime() ?? Number.POSITIVE_INFINITY) ||
        left.job.title.localeCompare(right.job.title) ||
        left.job.id.localeCompare(right.job.id)
    );

export const actionableScheduledRuns = (
  jobs: readonly ScheduledJob[],
  runs: readonly ScheduledJobRun[]
) => {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  return runs
    .filter((run) => ["failed", "missed", "interrupted"].includes(run.status))
    .map((run) => ({ job: byId.get(run.jobId), run }))
    .filter((entry): entry is { job: ScheduledJob; run: ScheduledJobRun } =>
      Boolean(entry.job)
    )
    .sort(
      (left, right) =>
        Date.parse(right.run.scheduledFor) - Date.parse(left.run.scheduledFor)
    );
};
