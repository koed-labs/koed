import { describe, expect, it } from "vitest";

import {
  dueInfo,
  dueSoon,
  parseCanonicalDueDate,
  parseDue,
  resolveDue,
  type CanonicalDueDate,
  type DueDateContext
} from "./due-date.js";

const context = (now: string, timeZone = "UTC"): DueDateContext => ({
  now: new Date(now),
  timeZone
});

const date = (value: string): CanonicalDueDate => {
  const parsed = parseCanonicalDueDate(value);
  if (!parsed) throw new Error(`Invalid test due date: ${value}`);
  return parsed;
};

describe("parseCanonicalDueDate", () => {
  it("accepts only real, canonical Gregorian dates", () => {
    expect(parseCanonicalDueDate("0001-01-01")).toBe("0001-01-01");
    expect(parseCanonicalDueDate("9999-12-31")).toBe("9999-12-31");
    expect(parseCanonicalDueDate("2024-02-29")).toBe("2024-02-29");
    expect(parseCanonicalDueDate("2026-02-29")).toBeNull();
    expect(parseCanonicalDueDate("2026-04-31")).toBeNull();
    expect(parseCanonicalDueDate("2026-4-01")).toBeNull();
    expect(parseCanonicalDueDate("2026-01-01T00:00:00Z")).toBeNull();
  });
});

describe("resolveDue", () => {
  it("resolves relative phrases from the supplied viewer calendar", () => {
    const monday = context("2026-06-01T11:30:00Z", "Europe/Oslo");
    expect(resolveDue("today", monday)).toBe("2026-06-01");
    expect(resolveDue("tonight", monday)).toBe("2026-06-01");
    expect(resolveDue("eod", monday)).toBe("2026-06-01");
    expect(resolveDue("tomorrow", monday)).toBe("2026-06-02");
    expect(resolveDue("tmrw", monday)).toBe("2026-06-02");
    expect(resolveDue("next week", monday)).toBe("2026-06-08");
  });

  it("rolls tomorrow and next week across December 31", () => {
    const yearEnd = context("2026-12-31T12:00:00Z");
    expect(resolveDue("tomorrow", yearEnd)).toBe("2027-01-01");
    expect(resolveDue("next week", yearEnd)).toBe("2027-01-04");
  });

  it("keeps years below 100 in calendar arithmetic and rejects year overflow", () => {
    expect(resolveDue("tomorrow", context("0099-12-31T12:00:00Z"))).toBe(
      "0100-01-01"
    );
    expect(resolveDue("tomorrow", context("9999-12-31T12:00:00Z"))).toBeNull();
    expect(resolveDue("next week", context("9999-12-31T12:00:00Z"))).toBeNull();
  });

  it("uses the nearest weekday, including today, for bare and prefixed names", () => {
    const monday = context("2026-06-01T11:30:00Z", "Europe/Oslo");
    expect(resolveDue("Monday", monday)).toBe("2026-06-01");
    expect(resolveDue("this Monday", monday)).toBe("2026-06-01");
    expect(resolveDue("next Monday", monday)).toBe("2026-06-01");
    expect(resolveDue("Friday", monday)).toBe("2026-06-05");
    expect(resolveDue("next Friday", monday)).toBe("2026-06-05");
  });

  it("parses spaced and compact month/day forms with optional weekday labels", () => {
    const today = context("2026-10-19T12:00:00Z", "Europe/Oslo");
    expect(resolveDue("22 Oct", today)).toBe("2026-10-22");
    expect(resolveDue("Oct 22", today)).toBe("2026-10-22");
    expect(resolveDue("Thu 22 Oct", today)).toBe("2026-10-22");
    expect(resolveDue("Thu Oct 22", today)).toBe("2026-10-22");
    expect(resolveDue("Thursday 22 October", today)).toBe("2026-10-22");
    expect(resolveDue("Thursday October 22", today)).toBe("2026-10-22");
    expect(resolveDue("22Oct", today)).toBe("2026-10-22");
    expect(resolveDue("Oct22", today)).toBe("2026-10-22");
    expect(resolveDue("Thu22Oct", today)).toBe("2026-10-22");
    expect(resolveDue("Thursday22October", today)).toBe("2026-10-22");
    expect(resolveDue("next Thu 22 Oct", today)).toBe("2026-10-22");
  });

  it("rejects weekday labels that conflict with the resolved month/day", () => {
    const today = context("2026-10-19T12:00:00Z", "Europe/Oslo");
    expect(resolveDue("Fri 22 Oct", today)).toBeNull();
    expect(resolveDue("Friday October 22", today)).toBeNull();
    expect(resolveDue("Fri22Oct", today)).toBeNull();
    expect(resolveDue("Thu 22 Oct", today)).toBe("2026-10-22");
    expect(resolveDue("Sun 25 Oct", today)).toBe("2026-10-25");
    expect(resolveDue("Mon 25 Oct", today)).toBeNull();
  });

  it("checks weekday labels after rolling a month/day into the next year", () => {
    const today = context("2026-10-19T12:00:00Z");
    expect(resolveDue("Thu 19 Aug", today)).toBe("2027-08-19");
    expect(resolveDue("Wed 19 Aug", today)).toBeNull();
  });

  it("keeps dates through 60 calendar days past and rolls later dates forward", () => {
    const today = context("2026-10-19T12:00:00Z");
    expect(resolveDue("20 Aug", today)).toBe("2026-08-20");
    expect(resolveDue("19 Aug", today)).toBe("2027-08-19");
    expect(resolveDue("22 Oct", today)).toBe("2026-10-22");
  });

  it("rejects impossible dates instead of normalizing them", () => {
    expect(resolveDue("31 Apr", context("2026-04-01T12:00:00Z"))).toBeNull();
    expect(resolveDue("29 Feb", context("2026-01-01T12:00:00Z"))).toBeNull();
    expect(resolveDue("29 Feb", context("2024-02-01T12:00:00Z"))).toBe(
      "2024-02-29"
    );
  });

  it("requires a valid IANA time zone and a valid injected instant", () => {
    expect(() => resolveDue("today", { timeZone: "+01:00" })).toThrow(
      /IANA time zone/
    );
    expect(() => resolveDue("today", { timeZone: "Not/AZone" })).toThrow(
      /IANA time zone/
    );
    expect(() =>
      resolveDue("today", { timeZone: "UTC", now: new Date(Number.NaN) })
    ).toThrow(/valid Date/);
    expect(() => resolveDue("today", undefined as never)).toThrow(
      /IANA time zone/
    );
  });

  it("supports the valid +13 and +14 Etc/GMT local calendar zones", () => {
    const instant = "2026-12-31T10:30:00Z";
    expect(resolveDue("today", context(instant, "Etc/GMT-13"))).toBe(
      "2026-12-31"
    );
    expect(resolveDue("today", context(instant, "Etc/GMT-14"))).toBe(
      "2027-01-01"
    );
  });

  it("uses each viewer's local calendar near midnight", () => {
    const instant = "2026-02-01T00:30:00Z";
    expect(resolveDue("today", context(instant, "America/New_York"))).toBe(
      "2026-01-31"
    );
    expect(resolveDue("today", context(instant, "Asia/Tokyo"))).toBe(
      "2026-02-01"
    );
    expect(
      dueInfo(date("2026-02-01"), context(instant, "America/New_York"))
    ).toEqual(["amber", "Due tomorrow"]);
    expect(dueInfo(date("2026-02-01"), context(instant, "Asia/Tokyo"))).toEqual(
      ["red", "Due today"]
    );
  });
});

describe("parseDue", () => {
  it("extracts a supported trailing due marker", () => {
    expect(
      parseDue("Read chapter 4 by Friday", context("2026-06-01T12:00:00Z"))
    ).toEqual({ title: "Read chapter 4", due: "2026-06-05" });
    expect(
      parseDue(
        "Prepare slides — due Thu 22 Oct",
        context("2026-10-19T12:00:00Z")
      )
    ).toEqual({ title: "Prepare slides", due: "2026-10-22" });
    expect(
      parseDue(
        "Review notes (before tomorrow)",
        context("2026-06-01T12:00:00Z")
      )
    ).toEqual({ title: "Review notes", due: "2026-06-02" });
  });

  it("leaves the original title intact when its due expression is unsupported", () => {
    expect(
      parseDue("Review notes by 31 Apr", context("2026-04-01T12:00:00Z"))
    ).toEqual({
      title: "Review notes by 31 Apr",
      due: null
    });
    expect(parseDue("Review notes", context("2026-04-01T12:00:00Z"))).toEqual({
      title: "Review notes",
      due: null
    });
    expect(
      parseDue("Review notes by Fri 22 Oct", context("2026-10-19T12:00:00Z"))
    ).toEqual({
      title: "Review notes by Fri 22 Oct",
      due: null
    });
  });

  it("extracts a matching weekday-labeled date without the marker", () => {
    expect(
      parseDue("Review notes by Thu 22 Oct", context("2026-10-19T12:00:00Z"))
    ).toEqual({ title: "Review notes", due: "2026-10-22" });
  });
});

describe("dueInfo and dueSoon", () => {
  it("assigns red, amber, and grey from calendar-day distance", () => {
    const today = context("2026-03-07T17:00:00Z", "America/New_York");
    expect(dueInfo(date("2026-03-06"), today)).toEqual(["red", "Overdue 1d"]);
    expect(dueInfo(date("2026-03-07"), today)).toEqual(["red", "Due today"]);
    expect(dueInfo(date("2026-03-08"), today)).toEqual([
      "amber",
      "Due tomorrow"
    ]);
    expect(dueInfo(date("2026-03-10"), today)).toEqual(["amber", "Due Tue"]);
    expect(dueInfo(date("2026-03-11"), today)).toEqual(["grey", "Due Wed"]);
    expect(dueInfo(date("2026-03-15"), today)).toEqual(["grey", "Due 15 Mar"]);
  });

  it("counts civil days across spring and fall DST transitions", () => {
    const beforeSpring = context("2026-03-08T04:30:00Z", "America/New_York");
    const afterSpring = context("2026-03-08T07:30:00Z", "America/New_York");
    expect(dueInfo(date("2026-03-08"), beforeSpring)).toEqual([
      "amber",
      "Due tomorrow"
    ]);
    expect(dueInfo(date("2026-03-08"), afterSpring)).toEqual([
      "red",
      "Due today"
    ]);
    expect(dueInfo(date("2026-03-09"), beforeSpring)).toEqual([
      "amber",
      "Due Mon"
    ]);

    const beforeFall = context("2026-11-01T03:30:00Z", "America/New_York");
    const afterFall = context("2026-11-01T07:30:00Z", "America/New_York");
    expect(dueInfo(date("2026-11-01"), beforeFall)).toEqual([
      "amber",
      "Due tomorrow"
    ]);
    expect(dueInfo(date("2026-11-01"), afterFall)).toEqual([
      "red",
      "Due today"
    ]);
    expect(dueInfo(date("2026-11-02"), beforeFall)).toEqual([
      "amber",
      "Due Mon"
    ]);
  });

  it("marks only overdue, today, and tomorrow as due soon", () => {
    const today = context("2026-06-01T12:00:00Z");
    expect(dueSoon(date("2026-05-31"), today)).toBe(true);
    expect(dueSoon(date("2026-06-01"), today)).toBe(true);
    expect(dueSoon(date("2026-06-02"), today)).toBe(true);
    expect(dueSoon(date("2026-06-03"), today)).toBe(false);
    expect(dueSoon(null, today)).toBe(false);
  });

  it("counts due dates across year end and leap day", () => {
    const yearEnd = context("2023-12-31T12:00:00Z");
    expect(dueInfo(date("2024-01-01"), yearEnd)).toEqual([
      "amber",
      "Due tomorrow"
    ]);
    expect(dueSoon(date("2024-01-01"), yearEnd)).toBe(true);
    expect(dueInfo(date("2024-01-02"), yearEnd)).toEqual(["amber", "Due Tue"]);

    const leapEve = context("2024-02-28T12:00:00Z");
    expect(dueInfo(date("2024-02-29"), leapEve)).toEqual([
      "amber",
      "Due tomorrow"
    ]);
    expect(dueSoon(date("2024-02-29"), leapEve)).toBe(true);
    expect(
      dueInfo(date("2024-03-01"), context("2024-02-29T12:00:00Z"))
    ).toEqual(["amber", "Due tomorrow"]);
  });
});
