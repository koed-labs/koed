import type { ScheduledJobSchedule } from "./scheduled-job-contract.js";

type Wall = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};
const parts = (date: Date, formatter: Intl.DateTimeFormat): Wall => {
  const map = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute)
  };
};
const offsetMinutes = (date: Date, tz: string): number => {
  const zone =
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset"
    })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  if (zone === "GMT" || zone === "UTC") return 0;
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(zone);
  if (!match) throw new Error(`Unsupported timezone offset ${zone}`);
  return (
    (match[1] === "+" ? 1 : -1) *
    (Number(match[2]) * 60 + Number(match[3] ?? 0))
  );
};
const sameDate = (a: Wall, b: Wall) =>
  a.year === b.year && a.month === b.month && a.day === b.day;
const minuteOf = (value: Wall) => value.hour * 60 + value.minute;
const formatter = (tz: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
const matchesDate = (schedule: ScheduledJobSchedule, date: Wall) => {
  const isoDow =
    ((new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) %
      7) +
    1;
  switch (schedule.kind) {
    case "daily":
      return true;
    case "weekdays":
      return isoDow <= 5;
    case "weekly":
      return schedule.dow.includes(isoDow);
    case "monthly": {
      const last = new Date(Date.UTC(date.year, date.month, 0)).getUTCDate();
      return date.day === Math.min(schedule.dom, last);
    }
  }
};
/** First UTC instant for a wall minute; a spring gap advances to its first valid minute. */
export function scheduledJobWallInstant(
  schedule: ScheduledJobSchedule,
  date: { year: number; month: number; day: number }
): Date {
  const [hour, minute] = schedule.at.split(":").map(Number);
  const target = { ...date, hour: hour!, minute: minute! };
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const local = formatter(schedule.tz);
  const offsets = new Set([
    offsetMinutes(new Date(naive - 86_400_000), schedule.tz),
    offsetMinutes(new Date(naive), schedule.tz),
    offsetMinutes(new Date(naive + 86_400_000), schedule.tz)
  ]);
  const exact = [...offsets]
    .map((offset) => new Date(naive - offset * 60_000))
    .filter((instant) => {
      const wall = parts(instant, local);
      return sameDate(wall, target) && minuteOf(wall) === minuteOf(target);
    })
    .sort((a, b) => a.getTime() - b.getTime());
  if (exact[0]) return exact[0];
  // A nonexistent wall minute is resolved to the earliest valid minute after it.
  const start = naive - Math.max(...offsets) * 60_000 - 60_000;
  for (
    let millis = start;
    millis <= start + 30 * 60 * 60_000;
    millis += 60_000
  ) {
    const wall = parts(new Date(millis), local);
    if (sameDate(wall, target) && minuteOf(wall) > minuteOf(target))
      return new Date(millis);
  }
  throw new Error("No valid wall minute after scheduled time");
}

/** Shared by display and the HQ-602 materializer; returns the next wall-clock occurrence. */
export function nextScheduledJobOccurrence(
  schedule: ScheduledJobSchedule,
  after: Date
): Date {
  const local = parts(after, formatter(schedule.tz));
  for (let day = 0; day < 400; day++) {
    const date = new Date(
      Date.UTC(local.year, local.month - 1, local.day + day)
    );
    const wall = {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: 0,
      minute: 0
    };
    if (!matchesDate(schedule, wall)) continue;
    const candidate = scheduledJobWallInstant(schedule, wall);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error("Unable to find Scheduled Job occurrence");
}
