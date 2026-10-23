import type { UsageReading } from "./hq-usage-model.js";

export const usageFixtureNow = Date.parse("2026-10-23T12:00:00Z");
const base = {
  instanceId: "codex.default",
  source: "codex_app_server" as const,
  bucketId: "codex",
  bucketName: "Codex",
  windowDurationMins: 300,
  usedPercent: 12,
  status: "ok" as const,
  resetsAt: "2026-10-23T15:18:00Z",
  planType: "plus",
  details: {
    ordinaryUsageAllowed: true,
    spendControlReached: false,
    rateLimitReachedType: null,
    rateLimitResetCredits: 3
  },
  observedAt: "2026-10-23T11:59:00Z"
};
export const usageFixture = {
  codexLow: [
    { ...base, window: "primary" },
    {
      ...base,
      window: "secondary",
      windowDurationMins: 10_080,
      usedPercent: 96,
      status: "near_limit",
      resetsAt: "2026-10-27T10:00:00Z"
    }
  ],
  claudeNear: [
    {
      instanceId: "claude.default",
      source: "claude_agent_sdk",
      bucketId: "claude",
      bucketName: "Claude",
      window: "seven_day_opus",
      windowDurationMins: null,
      usedPercent: 91,
      status: "near_limit",
      resetsAt: "2026-10-25T18:00:00Z",
      planType: null,
      details: { status: "allowed_warning", rateLimitType: "seven_day_opus" },
      observedAt: "2026-10-23T11:35:00Z"
    }
  ],
  claudeAllowed: [
    {
      instanceId: "claude.default",
      source: "claude_agent_sdk",
      bucketId: "claude",
      bucketName: "Claude",
      window: "five_hour",
      windowDurationMins: null,
      usedPercent: null,
      status: "ok",
      resetsAt: "2026-10-23T14:40:00Z",
      planType: null,
      details: { status: "allowed", rateLimitType: "five_hour" },
      observedAt: "2026-10-23T11:35:00Z"
    }
  ],
  allFine: [
    { ...base, window: "primary", usedPercent: 6 },
    {
      ...base,
      window: "secondary",
      windowDurationMins: 10_080,
      usedPercent: 32
    }
  ],
  noAlternative: [
    { ...base, window: "primary", usedPercent: 96, status: "near_limit" }
  ],
  stale: [{ ...base, window: "primary", observedAt: "2026-10-23T11:35:00Z" }],
  passedReset: [
    { ...base, window: "primary", resetsAt: "2026-10-23T11:10:00Z" }
  ],
  secondCodexBucket: [
    { ...base, window: "secondary", windowDurationMins: 10_080 },
    {
      ...base,
      bucketId: "opus",
      bucketName: "Opus",
      window: "secondary",
      windowDurationMins: 10_080,
      usedPercent: 91,
      details: { ...base.details, normalModelSlug: "opus" }
    }
  ],
  codexRestriction: [
    {
      ...base,
      window: "primary",
      status: "limited",
      details: { ...base.details, ordinaryUsageAllowed: false }
    }
  ],
  unknown: [
    {
      ...base,
      window: "primary",
      status: "unknown",
      details: { ...base.details, unknownFields: ["newField"] }
    }
  ],
  failedProbe: {
    usageOutcome: "failed" as const,
    usageObservedAt: "2026-10-23T12:00:00Z"
  },
  oldAccountLate: [
    { ...base, window: "primary", observedAt: "2026-10-23T11:00:00Z" }
  ]
} satisfies Record<
  string,
  UsageReading[] | { usageOutcome: "failed"; usageObservedAt: string }
>;
