import { describe, expect, it } from "vitest";
import { scheduledJobScheduleSchema } from "./scheduled-job-contract.js";
import { nextScheduledJobOccurrence } from "./scheduled-job-calendar.js";

describe("Scheduled Job calendar contract", () => {
  const base = { at: "09:30", tz: "America/New_York" };
  it("accepts only strict calendar variants and supported IANA zones", () => {
    expect(
      scheduledJobScheduleSchema.parse({ kind: "daily", ...base })
    ).toEqual({ kind: "daily", ...base });
    expect(
      scheduledJobScheduleSchema.parse({ kind: "weekdays", ...base })
    ).toEqual({ kind: "weekdays", ...base });
    expect(
      scheduledJobScheduleSchema.parse({ kind: "weekly", ...base, dow: [1, 7] })
    ).toEqual({ kind: "weekly", ...base, dow: [1, 7] });
    expect(
      scheduledJobScheduleSchema.parse({ kind: "monthly", ...base, dom: 31 })
    ).toEqual({ kind: "monthly", ...base, dom: 31 });
    for (const input of [
      { kind: "daily", ...base, dow: [1] },
      { kind: "weekdays", ...base, dom: 1 },
      { kind: "weekly", ...base, dow: [] },
      { kind: "weekly", ...base, dow: [1, 1] },
      { kind: "weekly", ...base, dow: [0] },
      { kind: "monthly", ...base, dom: 32 },
      { kind: "daily", at: "24:00", tz: base.tz },
      { kind: "daily", at: "9:30", tz: base.tz },
      { kind: "daily", at: base.at, tz: "+02:00" },
      { kind: "daily", at: base.at, tz: "Mars/Nope" },
      { kind: "daily", ...base, extra: true }
    ])
      expect(scheduledJobScheduleSchema.safeParse(input).success).toBe(false);
  });
  it("moves a spring gap to its first valid minute", () => {
    const next = nextScheduledJobOccurrence(
      { kind: "daily", at: "02:30", tz: base.tz },
      new Date("2026-03-08T00:00:00Z")
    );
    expect(next.toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });
  it("uses the first repeated wall minute once", () => {
    const schedule = { kind: "daily" as const, at: "01:30", tz: base.tz };
    const first = nextScheduledJobOccurrence(
      schedule,
      new Date("2026-11-01T00:00:00Z")
    );
    expect(first.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    const next = nextScheduledJobOccurrence(schedule, first);
    expect(next.toISOString()).toBe("2026-11-02T06:30:00.000Z");
  });
  it("clamps a 31st-day monthly job to the last day", () => {
    const next = nextScheduledJobOccurrence(
      { kind: "monthly", at: "09:30", tz: "UTC", dom: 31 },
      new Date("2026-02-01T00:00:00Z")
    );
    expect(next.toISOString()).toBe("2026-02-28T09:30:00.000Z");
  });
});
