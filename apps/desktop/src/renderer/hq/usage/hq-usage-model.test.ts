import { describe, expect, it } from "vitest";
import {
  usageCell,
  usageForWindow,
  usageMenuLine,
  usageAge
} from "./hq-usage-model.js";
import { usageFixture, usageFixtureNow } from "./hq-usage.fixture.js";

describe("HQ usage presentation", () => {
  it("keeps Codex windows and model buckets distinct", () => {
    const five = usageForWindow(
      usageFixture.codexLow,
      "codex_app_server",
      "five",
      "",
      usageFixtureNow
    );
    const week = usageForWindow(
      usageFixture.codexLow,
      "codex_app_server",
      "week",
      "",
      usageFixtureNow
    );
    expect(usageCell(five.primary, usageFixtureNow).text).toBe("12%");
    expect(usageCell(week.primary, usageFixtureNow)).toMatchObject({
      text: "96%",
      low: true
    });
    const bucket = usageForWindow(
      usageFixture.secondCodexBucket,
      "codex_app_server",
      "week",
      "opus",
      usageFixtureNow
    );
    expect(bucket.primary?.bucketId).toBe("codex");
    expect(bucket.note?.bucketId).toBe("opus");
  });

  it("uses Claude allowed without inventing a percentage and identifies Opus", () => {
    expect(
      usageCell(usageFixture.claudeAllowed[0]!, usageFixtureNow).text
    ).toBe("OK");
    expect(
      usageCell(
        { ...usageFixture.claudeAllowed[0]!, usedPercent: 20 },
        usageFixtureNow
      ).text
    ).toBe("OK");
    const opus = usageForWindow(
      usageFixture.claudeNear,
      "claude_agent_sdk",
      "week",
      "claude-opus",
      usageFixtureNow
    );
    expect(opus.primary?.window).toBe("seven_day_opus");
    expect(usageCell(opus.primary, usageFixtureNow)).toMatchObject({
      text: "91%",
      low: true
    });
  });

  it("keeps a more constrained global or overage weekly limit ahead of Opus", () => {
    const opus = usageFixture.claudeNear[0]!;
    const global = {
      ...opus,
      window: "seven_day",
      usedPercent: 96,
      status: "near_limit" as const
    };
    const overage = {
      ...opus,
      window: "seven_day_overage_included",
      usedPercent: 20,
      status: "limited" as const,
      details: {
        ...opus.details,
        overageStatus: "rejected",
        overageDisabledReason: "out_of_credits"
      }
    };
    const globalFirst = usageForWindow(
      [opus, global],
      "claude_agent_sdk",
      "week",
      "claude-opus",
      usageFixtureNow
    );
    expect(globalFirst.primary?.window).toBe("seven_day");
    expect(
      usageMenuLine(
        "Claude",
        "claude_agent_sdk",
        [opus, global],
        "claude-opus",
        usageFixtureNow
      )
    ).toContain("96% used");
    const overageFirst = usageForWindow(
      [opus, global, overage],
      "claude_agent_sdk",
      "week",
      "claude-opus",
      usageFixtureNow
    );
    expect(overageFirst.primary?.window).toBe("seven_day_overage_included");
    expect(usageCell(overageFirst.primary, usageFixtureNow).text).toBe(
      "Limited"
    );
    expect(usageCell(overageFirst.primary, usageFixtureNow).tooltip).toContain(
      "overage rejected"
    );
    expect(usageCell(overageFirst.primary, usageFixtureNow).tooltip).toContain(
      "out of credits"
    );
    const expiredOpus = {
      ...opus,
      usedPercent: 99,
      resetsAt: "2026-10-23T11:10:00Z"
    };
    expect(
      usageForWindow(
        [expiredOpus, global],
        "claude_agent_sdk",
        "week",
        "claude-opus",
        usageFixtureNow
      ).primary?.window
    ).toBe("seven_day");
  });

  it("keeps a five-hour restriction ahead of a near weekly percentage in the menu", () => {
    expect(
      usageMenuLine(
        "Codex",
        "codex_app_server",
        [usageFixture.codexRestriction[0]!, usageFixture.codexLow[1]!],
        "gpt",
        usageFixtureNow
      )
    ).toBe("Codex: Limited");
  });

  it("shows the more constrained percentage when both windows are near", () => {
    expect(
      usageMenuLine(
        "Codex",
        "codex_app_server",
        [
          {
            ...usageFixture.codexLow[0]!,
            usedPercent: 99,
            status: "near_limit"
          },
          {
            ...usageFixture.codexLow[1]!,
            usedPercent: 91,
            status: "near_limit"
          }
        ],
        "gpt",
        usageFixtureNow
      )
    ).toContain("1% of this 5-hour window left");
  });

  it("shows no percentage after reset or for unknown readings", () => {
    const passed = usageCell(usageFixture.passedReset[0]!, usageFixtureNow);
    expect(passed.text).toBe("—");
    expect(passed.tooltip).toContain("not checked since");
    expect(usageCell(usageFixture.unknown[0]!, usageFixtureNow).text).toBe("—");
    expect(
      usageCell(usageFixture.codexRestriction[0]!, usageFixtureNow).text
    ).toBe("Limited");
    expect(usageAge(usageFixture.stale[0]!.observedAt, usageFixtureNow)).toBe(
      "25m ago"
    );
  });

  it("does not infer that a provider with no reading is fine", () => {
    expect(usageMenuLine("Pi", null, [], "", usageFixtureNow)).toBe(
      "Pi: Not shared by Pi"
    );
    expect(
      usageMenuLine("Claude", "claude_agent_sdk", [], "", usageFixtureNow)
    ).toContain("not reported");
    expect(
      usageMenuLine(
        "Claude",
        "claude_agent_sdk",
        usageFixture.claudeAllowed,
        "",
        usageFixtureNow + 6 * 60_000
      )
    ).toContain("reading as of 31m ago");
  });
});
