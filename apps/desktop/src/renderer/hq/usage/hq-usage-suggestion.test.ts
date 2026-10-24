import { describe, expect, it } from "vitest";
import type { UsageReading } from "./hq-usage-model.js";
import {
  usageIsFine,
  usageIsLow,
  usageSilenceUntil,
  usageSuggestion
} from "./hq-usage-suggestion.js";

const now = Date.parse("2026-10-23T12:00:00Z");
const codex = {
  instanceId: "codex.fixture",
  driverId: "codex",
  displayName: "Codex",
  model: "gpt-6",
  ready: true
};
const claude = {
  instanceId: "claude.fixture",
  driverId: "claude",
  displayName: "Claude",
  model: "claude-sonnet",
  ready: true
};
const codexRow = (
  window: string,
  usedPercent = 12,
  changes: Partial<UsageReading> = {}
): UsageReading => ({
  instanceId: codex.instanceId,
  accountVerified: true,
  source: "codex_app_server",
  bucketId: "codex",
  bucketName: "Codex",
  window,
  windowDurationMins: window === "primary" ? 300 : 10080,
  usedPercent,
  status: usedPercent >= 90 ? "near_limit" : "ok",
  resetsAt: "2026-10-25T12:00:00Z",
  planType: "plus",
  details: {
    ordinaryUsageAllowed: true,
    spendControlReached: false,
    rateLimitReachedType: null
  },
  observedAt: "2026-10-23T11:59:00Z",
  ...changes
});
const claudeRow = (
  window: string,
  status: "allowed" | "allowed_warning" | "rejected" = "allowed",
  changes: Partial<UsageReading> = {}
): UsageReading => ({
  instanceId: claude.instanceId,
  accountVerified: true,
  source: "claude_agent_sdk",
  bucketId: "claude",
  bucketName: "Claude",
  window,
  windowDurationMins: null,
  usedPercent: status === "allowed" ? null : 91,
  status:
    status === "allowed"
      ? "ok"
      : status === "rejected"
        ? "limited"
        : "near_limit",
  resetsAt: "2026-10-25T12:00:00Z",
  planType: null,
  details: { status, rateLimitType: window },
  observedAt: "2026-10-23T11:59:00Z",
  ...changes
});

describe("HQ usage suggestions", () => {
  it("needs every current Codex bucket and window below 90, with verified identity and no restriction", () => {
    const rows = [codexRow("primary"), codexRow("secondary")];
    expect(usageIsFine(rows, codex, now)).toBe(true);
    expect(usageIsFine(rows.slice(0, 1), codex, now)).toBe(false);
    expect(
      usageIsFine(
        [
          ...rows,
          codexRow("secondary", 92, {
            bucketId: "gpt-6",
            details: { ...rows[0]!.details, normalModelSlug: "gpt-6" }
          })
        ],
        codex,
        now
      )
    ).toBe(false);
    expect(
      usageIsFine(
        rows.map((row) => ({ ...row, accountVerified: false })),
        codex,
        now
      )
    ).toBe(false);
    expect(
      usageIsFine(
        [
          rows[0]!,
          codexRow("secondary", 12, { observedAt: "2026-10-23T11:20:00Z" })
        ],
        codex,
        now
      )
    ).toBe(false);
    expect(
      usageIsFine(
        [
          rows[0]!,
          codexRow("secondary", 12, { resetsAt: "2026-10-23T11:00:00Z" })
        ],
        codex,
        now
      )
    ).toBe(false);
    expect(
      usageIsFine(
        [rows[0]!, codexRow("secondary", 12, { status: "unknown" })],
        codex,
        now
      )
    ).toBe(false);
    expect(
      usageIsFine(
        [
          rows[0]!,
          codexRow("secondary", 12, {
            details: { ...rows[0]!.details, ordinaryUsageAllowed: false }
          })
        ],
        codex,
        now
      )
    ).toBe(false);
  });

  it("accepts Claude allowed without utilization but preserves model limits and unexpired warnings", () => {
    expect(usageIsFine([claudeRow("five_hour")], claude, now)).toBe(true);
    expect(
      usageIsFine(
        [claudeRow("five_hour", "allowed", { accountVerified: false })],
        claude,
        now
      )
    ).toBe(false);
    expect(
      usageIsFine(
        [
          claudeRow("five_hour", "allowed", {
            observedAt: "2026-10-23T11:20:00Z"
          })
        ],
        claude,
        now
      )
    ).toBe(false);
    expect(
      usageIsFine(
        [
          claudeRow("five_hour", "allowed", {
            resetsAt: "2026-10-23T11:00:00Z"
          })
        ],
        claude,
        now
      )
    ).toBe(false);
    expect(
      usageIsFine(
        [
          claudeRow("five_hour"),
          claudeRow("seven_day_sonnet", "allowed_warning", {
            observedAt: "2026-10-23T10:00:00Z"
          })
        ],
        claude,
        now
      )
    ).toBe(false);
    expect(
      usageIsFine(
        [
          claudeRow("five_hour"),
          claudeRow("seven_day_opus", "allowed_warning")
        ],
        claude,
        now
      )
    ).toBe(true);
    expect(
      usageIsFine(
        [claudeRow("five_hour", "allowed", { status: "unknown" })],
        claude,
        now
      )
    ).toBe(false);
    expect(
      usageIsFine(
        [
          claudeRow("five_hour"),
          claudeRow("seven_day", "allowed", {
            observedAt: "2026-10-23T11:20:00Z"
          })
        ],
        claude,
        now
      )
    ).toBe(false);
    expect(
      usageIsFine(
        [
          claudeRow("five_hour"),
          claudeRow("seven_day", "allowed", {
            resetsAt: "2026-10-23T11:00:00Z"
          })
        ],
        claude,
        now
      )
    ).toBe(false);
    expect(
      usageIsFine(
        [claudeRow("five_hour", "allowed", { source: "codex_app_server" })],
        claude,
        now
      )
    ).toBe(false);
    expect(
      usageIsFine(
        [claudeRow("five_hour", "allowed", { window: "future_window" })],
        claude,
        now
      )
    ).toBe(false);
  });

  it("has distinct no warning, suggestion, and warning only outcomes", () => {
    const fine = [
      codexRow("primary"),
      codexRow("secondary"),
      claudeRow("five_hour")
    ];
    expect(
      usageSuggestion(fine, codex, [codex, claude], false, now)
    ).toBeNull();
    const low = [
      codexRow("primary"),
      codexRow("secondary", 96),
      claudeRow("five_hour")
    ];
    const suggested = usageSuggestion(low, codex, [codex, claude], false, now);
    expect(suggested?.alternative?.instanceId).toBe(claude.instanceId);
    expect(suggested?.message).toContain("4% of this week left");
    expect(
      usageSuggestion(low, codex, [codex, claude], true, now)?.alternative
    ).toBeNull();
    expect(
      usageSuggestion(low.slice(0, 2), codex, [codex, claude], false, now)
        ?.alternative
    ).toBeNull();
    expect(
      usageIsLow([claudeRow("seven_day_opus", "allowed_warning")], claude, now)
    ).toBe(false);
    expect(
      usageIsLow(
        [claudeRow("seven_day_sonnet", "allowed_warning")],
        claude,
        now
      )
    ).toBe(true);
  });

  it("silences through a reset or one hour without a reset", () => {
    const reset = usageSuggestion(
      [codexRow("secondary", 96)],
      codex,
      [],
      false,
      now
    )!;
    expect(usageSilenceUntil(reset, now)).toBe(
      Date.parse("2026-10-25T12:00:00Z")
    );
    const noReset = usageSuggestion(
      [codexRow("secondary", 96, { resetsAt: null })],
      codex,
      [],
      false,
      now
    )!;
    expect(usageSilenceUntil(noReset, now)).toBe(now + 60 * 60_000);
  });
});
