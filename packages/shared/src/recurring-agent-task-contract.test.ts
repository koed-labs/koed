import { describe, expect, it } from "vitest";
import {
  createRecurringAgentTaskSchema,
  recurringAgentScheduleSchema,
  recurringAgentTaskControlSchema,
  nextRecurringAgentTaskAt,
  latestDueRecurringAgentTask,
  type RecurringAgentSchedule
} from "./recurring-agent-task-contract.js";

const daily = {
  kind: "daily",
  localTime: "02:30",
  timeZone: "Europe/Oslo"
} as const;
const interval = {
  kind: "interval",
  everyMinutes: 5,
  anchorAt: "2026-10-15T12:00:00.000Z"
} as const;
describe("recurring Agent scheduling rules", () => {
  it("keeps elapsed intervals anchored instead of drifting with completion", () => {
    expect(nextRecurringAgentTaskAt(interval, "2026-10-15T12:00:00Z")).toBe(
      "2026-10-15T12:05:00.000Z"
    );
    expect(nextRecurringAgentTaskAt(interval, "2026-10-15T12:07:22Z")).toBe(
      "2026-10-15T12:10:00.000Z"
    );
    expect(nextRecurringAgentTaskAt(interval, "2026-10-15T11:00:00Z")).toBe(
      interval.anchorAt
    );
  });
  it("coalesces years of missed intervals to one occurrence without replaying a backlog", () => {
    expect(
      latestDueRecurringAgentTask(
        interval,
        interval.anchorAt,
        "2036-10-15T12:07:22Z"
      )
    ).toEqual({
      scheduledAt: "2036-10-15T12:05:00.000Z",
      nextRunAt: "2036-10-15T12:10:00.000Z"
    });
    expect(
      latestDueRecurringAgentTask(
        interval,
        "2026-10-15T12:10:00Z",
        "2026-10-15T12:07:22Z"
      )
    ).toBeNull();
  });
  it("skips a nonexistent local spring-forward time rather than moving the task", () => {
    expect(nextRecurringAgentTaskAt(daily, "2026-03-28T23:00:00Z")).toBe(
      "2026-03-30T00:30:00.000Z"
    );
    expect(
      latestDueRecurringAgentTask(
        daily,
        "2026-03-28T01:30:00Z",
        "2026-03-29T12:00:00Z"
      )?.scheduledAt
    ).toBe("2026-03-28T01:30:00.000Z");
  });
  it("uses only the first instant of a repeated local time", () => {
    expect(nextRecurringAgentTaskAt(daily, "2026-10-24T23:00:00Z")).toBe(
      "2026-10-25T00:30:00.000Z"
    );
    expect(nextRecurringAgentTaskAt(daily, "2026-10-25T00:45:00Z")).toBe(
      "2026-10-26T01:30:00.000Z"
    );
    expect(
      latestDueRecurringAgentTask(
        daily,
        "2026-10-25T00:30:00Z",
        "2026-10-25T01:45:00Z"
      )?.scheduledAt
    ).toBe("2026-10-25T00:30:00.000Z");
  });
  it("handles a half-hour DST gap and fold", () => {
    expect(
      nextRecurringAgentTaskAt(
        { kind: "daily", localTime: "02:15", timeZone: "Australia/Lord_Howe" },
        "2026-10-03T12:00:00Z"
      )
    ).toBe("2026-10-04T15:15:00.000Z");
    expect(
      nextRecurringAgentTaskAt(
        { kind: "daily", localTime: "01:45", timeZone: "Australia/Lord_Howe" },
        "2026-04-04T13:00:00Z"
      )
    ).toBe("2026-04-04T14:45:00.000Z");
  });
  it("skips a removed civil day without inventing a duplicate occurrence", () => {
    expect(
      nextRecurringAgentTaskAt(
        { kind: "daily", localTime: "09:00", timeZone: "Pacific/Apia" },
        "2011-12-29T20:00:00Z"
      )
    ).toBe("2011-12-30T19:00:00.000Z");
  });
  it("resumes after now, retaining the selected weekdays and local time", () => {
    const weekly: RecurringAgentSchedule = {
      kind: "weekly",
      localTime: "09:00",
      timeZone: "Europe/Oslo",
      weekdays: [1, 5]
    };
    expect(nextRecurringAgentTaskAt(weekly, "2026-10-15T12:00:00Z")).toBe(
      "2026-10-16T07:00:00.000Z"
    );
    expect(
      latestDueRecurringAgentTask(
        weekly,
        "2026-10-02T07:00:00Z",
        "2026-10-15T12:00:00Z"
      )
    ).toEqual({
      scheduledAt: "2026-10-12T07:00:00.000Z",
      nextRunAt: "2026-10-16T07:00:00.000Z"
    });
  });
  it("does not depend on the computer's current time zone", () => {
    const old = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      expect(nextRecurringAgentTaskAt(daily, "2026-10-24T23:00:00Z")).toBe(
        "2026-10-25T00:30:00.000Z"
      );
    } finally {
      if (old === undefined) delete process.env.TZ;
      else process.env.TZ = old;
    }
  });
  it.each([
    { ...interval, everyMinutes: 0 },
    { ...interval, anchorAt: "1969-12-31T23:59:59Z" },
    { ...daily, timeZone: "Computer/Local" },
    { ...daily, localTime: "24:00" },
    { kind: "weekly", localTime: "09:00", timeZone: "UTC", weekdays: [1, 1] },
    { ...interval, rawCron: "* * * * *" }
  ])("rejects malformed or unsupported cadence %j", (value) =>
    expect(recurringAgentScheduleSchema.safeParse(value).success).toBe(false)
  );
  it("requires an explicit activation action and consent", () => {
    const base = { action: "resume", expectedRevision: 1 };
    expect(recurringAgentTaskControlSchema.safeParse(base).success).toBe(false);
    expect(
      recurringAgentTaskControlSchema.safeParse({
        ...base,
        activationConsent: true
      }).success
    ).toBe(true);
  });
  it("does not accept a Team, filesystem path, or unsupported provider as task authority", () => {
    const input = {
      requestId: "11111111-1111-4111-8111-111111111111",
      title: "Weekly review",
      prompt: "Summarize the current project",
      schedule: daily,
      context: { projectId: null, contextKind: "independent" },
      execution: {
        provider: "codex",
        aiClientInstanceId: "codex.default",
        targetDeviceId: "device-1",
        model: "model",
        reasoningEffort: null,
        permissionMode: "supervised"
      }
    };
    expect(createRecurringAgentTaskSchema.safeParse(input).success).toBe(true);
    expect(
      createRecurringAgentTaskSchema.safeParse({
        ...input,
        teamId: "foreign-team"
      }).success
    ).toBe(false);
    expect(
      createRecurringAgentTaskSchema.safeParse({
        ...input,
        context: { ...input.context, path: "/unverified" }
      }).success
    ).toBe(false);
    expect(
      createRecurringAgentTaskSchema.safeParse({
        ...input,
        execution: { ...input.execution, provider: "other" }
      }).success
    ).toBe(false);
  });
});
