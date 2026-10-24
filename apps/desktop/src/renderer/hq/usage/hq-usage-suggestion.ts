import { usageReset, type UsageReading } from "./hq-usage-model.js";

export type UsageChoice = {
  instanceId: string;
  driverId: string;
  displayName: string;
  model: string;
  ready: boolean;
};
export type UsageWarning = {
  current: UsageChoice;
  alternative: UsageChoice | null;
  message: string;
  resetsAt: string | null;
  silenceKey: string;
};

const validTime = (value: string | null) => (value ? Date.parse(value) : NaN);
const fresh = (reading: UsageReading, now: number) => {
  const observed = validTime(reading.observedAt);
  const reset = validTime(reading.resetsAt);
  return (
    Number.isFinite(observed) &&
    observed <= now &&
    now - observed < 30 * 60_000 &&
    (!reading.resetsAt || (Number.isFinite(reset) && reset > now))
  );
};
const current = (reading: UsageReading, now: number) => {
  const observed = validTime(reading.observedAt);
  const reset = validTime(reading.resetsAt);
  return (
    Number.isFinite(observed) &&
    observed <= now &&
    (!reading.resetsAt || (Number.isFinite(reset) && reset > now))
  );
};
const latest = (readings: readonly UsageReading[]) => {
  const byWindow = new Map<string, UsageReading>();
  for (const reading of readings) {
    const key = `${reading.bucketId}\u0000${reading.window}`;
    const previous = byWindow.get(key);
    if (
      !previous ||
      validTime(reading.observedAt) > validTime(previous.observedAt)
    )
      byWindow.set(key, reading);
  }
  return [...byWindow.values()];
};
const knownClaudeWindow = new Set([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
  "overage"
]);
const applies = (reading: UsageReading, choice: UsageChoice) => {
  if (choice.driverId === "claude") {
    if (reading.source !== "claude_agent_sdk") return false;
    if (!knownClaudeWindow.has(reading.window)) return false;
    if (reading.window === "seven_day_opus") return /opus/i.test(choice.model);
    if (reading.window === "seven_day_sonnet")
      return /sonnet/i.test(choice.model);
    return true;
  }
  if (choice.driverId !== "codex") return false;
  if (reading.source !== "codex_app_server") return false;
  if (reading.bucketId === "codex") return true;
  const slug = reading.details.normalModelSlug;
  return (
    (typeof slug === "string" &&
      slug.toLowerCase() === choice.model.toLowerCase()) ||
    choice.model.toLowerCase().includes(reading.bucketId.toLowerCase())
  );
};
const restrictions = (reading: UsageReading) =>
  reading.details.ordinaryUsageAllowed === false ||
  reading.details.spendControlReached === true ||
  Boolean(reading.details.rateLimitReachedType) ||
  reading.details.individualLimitReached === true ||
  (typeof reading.details.individualLimit === "object" &&
    reading.details.individualLimit !== null &&
    "remainingPercent" in reading.details.individualLimit &&
    reading.details.individualLimit.remainingPercent === 0) ||
  reading.details.overageDisabledReason != null ||
  reading.details.overageStatus === "rejected";
const codexLow = (reading: UsageReading) =>
  restrictions(reading) ||
  reading.status === "limited" ||
  (reading.usedPercent !== null && reading.usedPercent >= 90);
const claudeLow = (reading: UsageReading) =>
  reading.status === "near_limit" ||
  reading.status === "limited" ||
  reading.details.status === "allowed_warning" ||
  reading.details.status === "rejected";
const hasUnknownFields = (reading: UsageReading) => {
  const fields = reading.details.unknownFields;
  if (Array.isArray(fields)) return fields.length > 0;
  if (fields && typeof fields === "object")
    return Object.values(fields).some(
      (value) => Array.isArray(value) && value.length > 0
    );
  return false;
};

export function usageIsLow(
  readings: readonly UsageReading[],
  choice: UsageChoice,
  now = Date.now()
) {
  return latest(
    readings.filter(
      (reading) =>
        reading.instanceId === choice.instanceId && applies(reading, choice)
    )
  ).some(
    (reading) =>
      current(reading, now) &&
      (choice.driverId === "codex" ? codexLow(reading) : claudeLow(reading))
  );
}

export function usageIsFine(
  readings: readonly UsageReading[],
  choice: UsageChoice,
  now = Date.now()
) {
  if (!choice.ready || !["codex", "claude"].includes(choice.driverId))
    return false;
  const rows = latest(
    readings.filter((reading) => reading.instanceId === choice.instanceId)
  );
  if (
    rows.some(
      (reading) =>
        reading.source !==
        (choice.driverId === "codex" ? "codex_app_server" : "claude_agent_sdk")
    )
  )
    return false;
  const applicable = rows.filter((reading) => applies(reading, choice));
  if (
    !applicable.length ||
    applicable.some((reading) => reading.accountVerified !== true)
  )
    return false;
  if (choice.driverId === "codex") {
    if (
      rows.some(
        (reading) =>
          reading.bucketId !== "codex" &&
          !applies(reading, choice) &&
          typeof reading.details.normalModelSlug !== "string"
      )
    )
      return false;
    if (!applicable.some((reading) => reading.bucketId === "codex"))
      return false;
    if (
      applicable.some(
        (reading) => !["primary", "secondary"].includes(reading.window)
      )
    )
      return false;
    if (
      !applicable.some((reading) => reading.window === "primary") ||
      !applicable.some((reading) => reading.window === "secondary")
    )
      return false;
    return applicable.every(
      (reading) =>
        fresh(reading, now) &&
        reading.status !== "unknown" &&
        !hasUnknownFields(reading) &&
        reading.usedPercent !== null &&
        reading.usedPercent >= 0 &&
        reading.usedPercent < 90 &&
        reading.details.ordinaryUsageAllowed === true &&
        reading.details.spendControlReached === false &&
        (reading.details.rateLimitReachedType === null ||
          reading.details.rateLimitReachedType === false) &&
        !restrictions(reading)
    );
  }
  // The SDK can report only the closest limit and omit utilization when allowed.
  // Every known applicable warning remains decisive until its reset expires.
  if (
    rows.some(
      (reading) =>
        reading.instanceId === choice.instanceId &&
        !knownClaudeWindow.has(reading.window)
    )
  )
    return false;
  if (
    applicable.some(
      (reading) =>
        !fresh(reading, now) ||
        reading.status === "unknown" ||
        hasUnknownFields(reading) ||
        restrictions(reading)
    )
  )
    return false;
  if (applicable.some((reading) => claudeLow(reading))) return false;
  return applicable.some(
    (reading) =>
      fresh(reading, now) &&
      reading.status === "ok" &&
      reading.details.status === "allowed" &&
      !restrictions(reading)
  );
}

const windowLabel = (reading: UsageReading) =>
  reading.window === "five_hour" || reading.windowDurationMins === 300
    ? "this 5-hour window"
    : "this week";
export function usageSuggestion(
  readings: readonly UsageReading[],
  selected: UsageChoice,
  alternatives: readonly UsageChoice[],
  projectHq = false,
  now = Date.now()
): UsageWarning | null {
  const low = latest(
    readings.filter(
      (reading) =>
        reading.instanceId === selected.instanceId && applies(reading, selected)
    )
  )
    .filter(
      (reading) =>
        current(reading, now) &&
        (selected.driverId === "codex" ? codexLow(reading) : claudeLow(reading))
    )
    .sort((a, b) => (b.usedPercent ?? -1) - (a.usedPercent ?? -1))[0];
  if (!low) return null;
  const reset =
    low.resetsAt && Number.isFinite(validTime(low.resetsAt))
      ? low.resetsAt
      : null;
  const until = reset ? `, until ${usageReset(reset, now)}` : "";
  const message =
    selected.driverId === "codex" && low.usedPercent !== null
      ? `${selected.displayName} has ${Math.max(0, 100 - Math.round(low.usedPercent))}% of ${windowLabel(low)} left${until}.`
      : `${selected.displayName} is near its ${windowLabel(low) === "this week" ? "weekly" : "5-hour"} limit${low.usedPercent !== null ? ` (${Math.round(low.usedPercent)}% used)` : ""}${until}.`;
  return {
    current: selected,
    alternative: projectHq
      ? null
      : (alternatives.find(
          (choice) =>
            choice.instanceId !== selected.instanceId &&
            usageIsFine(readings, choice, now)
        ) ?? null),
    message,
    resetsAt: reset,
    silenceKey: `${selected.instanceId}\u0000${low.bucketId}\u0000${low.window}\u0000${reset ?? "none"}`
  };
}

export const usageSilenceUntil = (warning: UsageWarning, now = Date.now()) =>
  warning.resetsAt ? validTime(warning.resetsAt) : now + 60 * 60_000;
