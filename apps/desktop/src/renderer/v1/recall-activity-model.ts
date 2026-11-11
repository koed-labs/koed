import type { RecallActivityOverview } from "@koed/shared/personal-desktop";

export type RecallRange = "1" | "7" | "30" | "custom";
export const localRecallDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export function recallPresetDates(
  range: Exclude<RecallRange, "custom">,
  now = new Date()
) {
  const from = new Date(now);
  from.setDate(from.getDate() - Number(range) + 1);
  return { from: localRecallDate(from), to: localRecallDate(now) };
}

export function recallDateRange(from: string, to: string) {
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  // Reject normalized dates such as February 30, as well as empty fields.
  if (localRecallDate(start) !== from || localRecallDate(end) !== to)
    throw new Error("Invalid date range");
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function recallChartModel(
  overview: RecallActivityOverview,
  from: string,
  to: string
) {
  const date = (value: string | number, year = false) =>
    new Date(value).toLocaleDateString(undefined, {
      timeZone: overview.timezone,
      day: "numeric",
      month: "short",
      ...(year ? { year: "numeric" as const } : {})
    });
  const time = (value: string | number, zone = false) =>
    new Date(value).toLocaleTimeString(undefined, {
      timeZone: overview.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(zone ? { timeZoneName: "short" as const } : {})
    });
  const hourly = overview.bucket === "hour";
  // Group server totals, never the current 50-row page. Preserve every empty
  // interval. Thirty daily buckets become ten three-day intervals.
  const step =
    overview.bucket === "day"
      ? Math.max(1, Math.ceil(overview.questions.length / 14))
      : 1;
  const resolution = hourly
    ? "Hourly"
    : overview.bucket === "day"
      ? step === 1
        ? "Daily"
        : `Every ${step} days`
      : overview.bucket === "week"
        ? "Weekly"
        : "Monthly";
  const buckets = [];
  for (let index = 0; index < overview.questions.length; index += step) {
    const points = overview.questions.slice(index, index + step);
    const start = points[0]!.start;
    const end = overview.questions[index + step]?.start ?? to;
    const found = points.reduce((n, point) => n + point.found, 0);
    const errors = points.reduce((n, point) => n + point.errors, 0);
    const count = points.reduce((n, point) => n + point.count, 0);
    buckets.push({
      start,
      end,
      found,
      errors,
      count,
      other: Math.max(0, count - found - errors),
      label: hourly ? time(start) : date(start),
      rangeLabel: hourly
        ? `${date(start)}, ${time(start, true)}–${time(end, true)}`
        : overview.bucket === "day" && step === 1
          ? date(start, true)
          : `${date(start)} – ${date(Date.parse(end) - 1, true)}`
    });
  }
  return {
    buckets,
    resolution,
    label: hourly
      ? date(from, true)
      : `${date(from)} – ${date(Date.parse(to) - 1, true)}`
  };
}

export function recallCallerPresentation(name: string | null | undefined) {
  if (!name) return { label: "Unknown AI Client", icon: null };
  const normalized = name.toLowerCase();
  if (["codex", "codex-cli", "codex-mcp-client"].includes(normalized))
    return { label: "Codex", icon: "codex" as const };
  if (["claude", "claude-code", "claude code"].includes(normalized))
    return { label: "Claude Code", icon: "claude" as const };
  if (normalized === "pi") return { label: "pi", icon: "pi" as const };
  return { label: name, icon: null };
}

export const recallTokenLabel = (value: number | null) =>
  value === null ? "Unknown" : value.toLocaleString();

export const recallMemoryResultLabel = (value: string | null | undefined) =>
  ({
    found: "Found",
    not_found: "Not found",
    insufficient: "Partial evidence",
    pending_summary: "Pending summaries"
  })[value ?? ""] ?? "Unknown";
export const recallDurationLabel = (value: number | null | undefined) =>
  value == null
    ? "Unknown"
    : value < 1000
      ? `${Math.round(value)} ms`
      : `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
