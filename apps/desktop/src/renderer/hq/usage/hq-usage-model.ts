import type { LocalAiClientResponse } from "../../../ipc/local-ai-client-protocol.js";

export type UsageReading = NonNullable<LocalAiClientResponse["usage"]>[number];
export type UsageWindow = "five" | "week";

const validDate = (value: string | null): number | null => {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

export const usageAge = (value: string, now = Date.now()): string => {
  const at = validDate(value);
  if (at === null) return "unknown time";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};

export const usageReset = (value: string, now = Date.now()): string => {
  const at = validDate(value);
  if (at === null) return "unknown time";
  const date = new Date(at);
  const clock = date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit"
  });
  if (date.toDateString() === new Date(now).toDateString()) return clock;
  if (date.toDateString() === new Date(now + 86_400_000).toDateString())
    return `tomorrow ${clock}`;
  return `${date.toLocaleDateString("en-GB", { weekday: "short" })} ${clock}`;
};

export const usageWindow = (reading: UsageReading): UsageWindow | null => {
  if (reading.source === "claude_agent_sdk") {
    if (reading.window === "five_hour") return "five";
    if (
      [
        "seven_day",
        "seven_day_opus",
        "seven_day_sonnet",
        "seven_day_overage_included"
      ].includes(reading.window)
    )
      return "week";
    return null;
  }
  if (reading.source !== "codex_app_server") return null;
  if (reading.window !== "primary" && reading.window !== "secondary")
    return null;
  if (reading.windowDurationMins === 300) return "five";
  if (reading.windowDurationMins === 10_080) return "week";
  return null;
};

export const usageIsCurrent = (reading: UsageReading, now = Date.now()) => {
  const observed = validDate(reading.observedAt);
  const reset = validDate(reading.resetsAt);
  return (
    observed !== null && observed <= now && (reset === null || reset > now)
  );
};

export const usageForWindow = (
  readings: readonly UsageReading[],
  source: UsageReading["source"],
  window: UsageWindow,
  model = "",
  now = Date.now()
): { primary: UsageReading | null; note: UsageReading | null } => {
  const candidates = readings.filter(
    (reading) =>
      reading.source === source &&
      usageWindow(reading) === window &&
      Date.parse(reading.observedAt) <= now
  );
  const latest = (items: UsageReading[]) =>
    items.sort(
      (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)
    )[0] ?? null;
  if (source === "codex_app_server") {
    const primary = latest(
      candidates.filter((reading) => reading.bucketId === "codex")
    );
    const matching = candidates.filter(
      (reading) =>
        reading.bucketId !== "codex" &&
        Boolean(model) &&
        (model.toLowerCase().includes(reading.bucketId.toLowerCase()) ||
          String(reading.details.normalModelSlug ?? "").toLowerCase() ===
            model.toLowerCase())
    );
    return { primary, note: latest(matching) };
  }
  const applicable = candidates.filter(
    (reading) =>
      reading.window === "five_hour" ||
      reading.window === "seven_day" ||
      reading.window === "seven_day_overage_included" ||
      !model ||
      (reading.window === "seven_day_opus" && /opus/i.test(model)) ||
      (reading.window === "seven_day_sonnet" && /sonnet/i.test(model))
  );
  const byType = new Map<string, UsageReading>();
  for (const reading of applicable) {
    const previous = byType.get(reading.window);
    if (
      !previous ||
      Date.parse(reading.observedAt) > Date.parse(previous.observedAt)
    )
      byType.set(reading.window, reading);
  }
  const latestByType = [...byType.values()];
  const current = latestByType.filter((reading) =>
    usageIsCurrent(reading, now)
  );
  const rank = (reading: UsageReading) =>
    reading.status === "limited"
      ? 4
      : reading.status === "unknown"
        ? 3
        : reading.status === "near_limit"
          ? 2
          : 1;
  const primary =
    current.sort(
      (a, b) =>
        rank(b) - rank(a) ||
        (b.usedPercent ?? -1) - (a.usedPercent ?? -1) ||
        Date.parse(b.observedAt) - Date.parse(a.observedAt)
    )[0] ?? latest(latestByType);
  const note =
    primary && primary.window !== "five_hour" && primary.window !== "seven_day"
      ? primary
      : null;
  return { primary, note };
};

export type UsageCell = {
  text: string;
  reset: string | null;
  percent: number | null;
  low: boolean;
  tooltip: string;
};
export const usageCell = (
  reading: UsageReading | null,
  now = Date.now()
): UsageCell => {
  if (!reading)
    return {
      text: "—",
      reset: null,
      percent: null,
      low: false,
      tooltip: "Not reported"
    };
  const reset = reading.resetsAt ? validDate(reading.resetsAt) : null;
  if (reset !== null && reset <= now)
    return {
      text: "—",
      reset: null,
      percent: null,
      low: false,
      tooltip: `Reset at ${usageReset(reading.resetsAt!, now)}; not checked since`
    };
  if (!usageIsCurrent(reading, now) || reading.status === "unknown")
    return {
      text: "—",
      reset: null,
      percent: null,
      low: false,
      tooltip: "Unknown provider reading"
    };
  const resetLabel = reading.resetsAt
    ? `resets ${usageReset(reading.resetsAt, now)}`
    : null;
  const details = reading.details;
  const resetCredits = details.rateLimitResetCredits;
  const freeResets =
    typeof resetCredits === "number"
      ? resetCredits
      : resetCredits &&
          typeof resetCredits === "object" &&
          "availableCount" in resetCredits &&
          typeof resetCredits.availableCount === "number"
        ? resetCredits.availableCount
        : null;
  const overageStatus = ["allowed", "allowed_warning", "rejected"].includes(
    String(details.overageStatus)
  )
    ? String(details.overageStatus).replaceAll("_", " ")
    : null;
  const overageDisabledReason =
    typeof details.overageDisabledReason === "string" &&
    /^[a-z_]{1,64}$/.test(details.overageDisabledReason)
      ? details.overageDisabledReason.replaceAll("_", " ")
      : null;
  const overageReset =
    typeof details.overageResetsAt === "string" &&
    validDate(details.overageResetsAt) !== null
      ? `overage resets ${usageReset(details.overageResetsAt, now)}`
      : null;
  const restriction =
    reading.status === "limited" ||
    details.ordinaryUsageAllowed === false ||
    details.spendControlReached === true ||
    Boolean(details.rateLimitReachedType);
  const text = restriction
    ? "Limited"
    : reading.source === "claude_agent_sdk" &&
        details.status === "allowed" &&
        reading.status === "ok"
      ? "OK"
      : reading.usedPercent !== null
        ? `${Math.round(reading.usedPercent)}%`
        : "—";
  const percent = text.endsWith("%") ? reading.usedPercent : null;
  const tooltip = [
    reading.source === "codex_app_server"
      ? "Reported by Codex"
      : "Reported by Claude on its last run",
    `checked ${usageAge(reading.observedAt, now)}`,
    reading.planType ? `plan ${reading.planType}` : null,
    freeResets !== null ? `${freeResets} free resets left` : null,
    overageStatus ? `overage ${overageStatus}` : null,
    details.isUsingOverage === true || details.overageInUse === true
      ? "using overage"
      : null,
    overageDisabledReason ? `overage disabled: ${overageDisabledReason}` : null,
    overageReset,
    resetLabel
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    text,
    reset: resetLabel,
    percent,
    low:
      restriction ||
      (percent !== null && percent >= 90) ||
      reading.status === "near_limit",
    tooltip
  };
};

export const usageMenuLine = (
  name: string,
  source: UsageReading["source"] | null,
  readings: readonly UsageReading[],
  model: string,
  now = Date.now()
) => {
  if (!source) return `${name}: Not shared by ${name}`;
  const fiveReading = usageForWindow(
    readings,
    source,
    "five",
    model,
    now
  ).primary;
  const weekReading = usageForWindow(
    readings,
    source,
    "week",
    model,
    now
  ).primary;
  const five = usageCell(fiveReading, now);
  const week = usageCell(weekReading, now);
  const picked =
    five.text !== "Limited" &&
    (week.text === "Limited" ||
      (week.percent !== null &&
        (five.percent === null || week.percent >= five.percent)) ||
      (week.text !== "—" && five.text === "—"))
      ? { cell: week, window: "this week" }
      : { cell: five, window: "this 5-hour window" };
  if (picked.cell.text === "—") return `${name}: usage not reported`;
  if (picked.cell.text === "OK") {
    const observed =
      picked.cell === week ? weekReading?.observedAt : fiveReading?.observedAt;
    if (observed && now - Date.parse(observed) > 30 * 60_000)
      return `${name}: reading as of ${usageAge(observed, now)}`;
    return `${name}: not near a limit`;
  }
  if (picked.cell.text === "Limited") return `${name}: Limited`;
  if (
    source === "claude_agent_sdk" &&
    picked.cell.low &&
    picked.cell.percent !== null
  )
    return `${name}: near its ${picked.window === "this week" ? "weekly" : "5-hour"} limit (${Math.round(picked.cell.percent)}% used)${picked.cell.reset ? ` · ${picked.cell.reset}` : ""}`;
  return `${name}: ${Math.max(0, 100 - Math.round(picked.cell.percent ?? 0))}% of ${picked.window} left${picked.cell.reset ? ` · ${picked.cell.reset}` : ""}`;
};
