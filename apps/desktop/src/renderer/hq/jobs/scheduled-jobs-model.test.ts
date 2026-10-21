import { describe, expect, it } from "vitest";
import {
  scheduledJobSchema,
  scheduledJobRunSchema
} from "@koed/shared/scheduled-job-contract";
import {
  actionableScheduledRuns,
  sortedScheduledJobs
} from "./scheduled-jobs-model.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const base = {
  ownerUserId,
  projectId: null,
  agentId: ownerUserId,
  conversationSessionId: ownerUserId,
  instruction: "Brief me",
  runnerDeviceId: ownerUserId,
  version: 1,
  pausedReason: null,
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z"
};
const job = (id: string, title: string, at: string, paused = false) =>
  scheduledJobSchema.parse({
    ...base,
    id,
    title,
    schedule: { kind: "daily", at, tz: "Europe/Oslo" },
    paused
  });
const run = (id: string, jobId: string, status: string) =>
  scheduledJobRunSchema.parse({
    id,
    jobId,
    scheduledFor: "2026-10-21T07:00:00.000Z",
    trigger: "scheduled",
    attempt: 0,
    status,
    skipReason: null,
    startedAt: null,
    finishedAt: null,
    executionId: null,
    error: null
  });

describe("Scheduled Jobs Now model", () => {
  it("orders the next occurrences first and paused Jobs last", () => {
    const soon = job("22222222-2222-4222-8222-222222222222", "Soon", "09:00");
    const later = job("33333333-3333-4333-8333-333333333333", "Later", "11:00");
    const paused = job(
      "44444444-4444-4444-8444-444444444444",
      "Paused",
      "08:00",
      true
    );
    expect(
      sortedScheduledJobs(
        [paused, later, soon],
        new Date("2026-10-21T06:00:00.000Z")
      ).map(({ job }) => job.title)
    ).toEqual(["Soon", "Later", "Paused"]);
  });
  it("surfaces failed and missed runs but never active or completed runs", () => {
    const item = job("22222222-2222-4222-8222-222222222222", "Brief", "09:00");
    expect(
      actionableScheduledRuns(
        [item],
        [
          run("33333333-3333-4333-8333-333333333333", item.id, "failed"),
          run("44444444-4444-4444-8444-444444444444", item.id, "missed"),
          run("55555555-5555-4555-8555-555555555555", item.id, "running"),
          run("66666666-6666-4666-8666-666666666666", item.id, "ok")
        ]
      ).map(({ run }) => run.status)
    ).toEqual(["failed", "missed"]);
  });
});
