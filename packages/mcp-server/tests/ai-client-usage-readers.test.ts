import { describe, expect, it } from "vitest";
import {
  claudeAccountIdentity,
  claudeUsageReading,
  codexAccountIdentity,
  codexUsageReadings,
  hashAiClientAccountIdentity
} from "../src/ai-client-usage-readers.js";

describe("official AI Client usage readings", () => {
  const input = {
    instanceId: "codex.default",
    accountIdentityHash: "a".repeat(64),
    observedAt: "2026-10-23T12:00:00.000Z"
  };

  it("keeps every Codex bucket and window distinct with restrictions", () => {
    const readings = codexUsageReadings(
      {
        ordinaryUsageAllowed: false,
        rateLimits: { limitId: "codex", primary: { usedPercent: 12 } },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: "Codex",
            planType: "pro",
            spendControlReached: false,
            primary: {
              usedPercent: 12,
              resetsAt: 1792800000,
              windowDurationMins: 300
            },
            secondary: {
              usedPercent: 96,
              resetsAt: 1793300000,
              windowDurationMins: 10080
            }
          },
          "model-x": {
            limitId: "model-x",
            limitName: "Model X",
            planType: "pro",
            spendControlReached: true,
            primary: {
              usedPercent: 24,
              resetsAt: null,
              windowDurationMins: 300
            }
          }
        }
      },
      input
    );
    expect(
      readings.map(({ bucketId, window, usedPercent }) => [
        bucketId,
        window,
        usedPercent
      ])
    ).toEqual([
      ["codex", "primary", 12],
      ["codex", "secondary", 96],
      ["model-x", "primary", 24]
    ]);
    expect(readings.map((reading) => reading.status)).toEqual([
      "limited",
      "limited",
      "unknown"
    ]);
    expect(readings[0]?.resetsAt).toBe("2026-10-24T00:00:00.000Z");
    expect(
      codexUsageReadings(
        {
          ordinaryUsageAllowed: true,
          rateLimitsByLimitId: {
            codex: { limitId: "codex", primary: { usedPercent: 4 } }
          },
          rateLimits: { limitId: "model-y", primary: { usedPercent: 8 } }
        },
        input
      ).map(({ bucketId }) => bucketId)
    ).toEqual(["codex", "model-y"]);
  });

  it("stores unknown Codex fields conservatively", () => {
    const [reading] = codexUsageReadings(
      {
        rateLimits: { primary: { usedPercent: 3 } },
        rateLimitsByLimitId: {
          novel: {
            limitId: "other",
            rateLimitReachedType: "new_restriction",
            primary: { usedPercent: 3 }
          }
        }
      },
      input
    );
    expect(reading).toMatchObject({ bucketId: "novel", status: "unknown" });
    expect(reading?.details.rateLimitReachedType).toBe("unknown");
    const novelField = codexUsageReadings(
      {
        ordinaryUsageAllowed: true,
        rateLimits: {},
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            planType: "plus",
            spendControlReached: false,
            futureField: true,
            primary: { usedPercent: 5 }
          }
        }
      },
      input
    )[0];
    expect(novelField?.status).toBe("unknown");
    expect(novelField?.details.unknownFields).toMatchObject({
      bucket: ["futureField"]
    });
    const restrictionOnly = codexUsageReadings(
      {
        ordinaryUsageAllowed: false,
        rateLimitsByLimitId: {
          codex: { limitId: "codex", spendControlReached: true }
        }
      },
      input
    );
    expect(restrictionOnly).toMatchObject([
      { window: "unknown", status: "limited" }
    ]);
    expect(
      codexUsageReadings({ ordinaryUsageAllowed: false }, input)
    ).toMatchObject([
      { bucketId: "codex", window: "unknown", status: "limited" }
    ]);
  });

  it("keeps malformed known Codex fields unknown without losing valid usage", () => {
    const base = {
      ordinaryUsageAllowed: true,
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          spendControlReached: false,
          primary: { usedPercent: 12, windowDurationMins: 300 }
        }
      }
    };
    const readingWith = (patch: Record<string, unknown>) =>
      codexUsageReadings(
        {
          ...base,
          rateLimitsByLimitId: {
            codex: { ...base.rateLimitsByLimitId.codex, ...patch }
          }
        },
        input
      )[0];
    expect(readingWith({})?.status).toBe("ok");
    expect(readingWith({ credits: "unexpected" })).toMatchObject({
      status: "unknown",
      usedPercent: 12
    });
    expect(readingWith({ planType: 7 })).toMatchObject({
      status: "unknown",
      usedPercent: 12
    });
    const [malformedResetCredits] = codexUsageReadings(
      {
        ...base,
        rateLimitResetCredits: {
          availableCount: 1,
          credits: [{ id: "credit", status: "future", grantedAt: 42 }]
        }
      },
      input
    );
    expect(malformedResetCredits).toMatchObject({
      status: "unknown",
      usedPercent: 12
    });
    expect(
      readingWith({ primary: { usedPercent: 12, windowDurationMins: "300" } })
    ).toMatchObject({
      status: "unknown",
      usedPercent: 12,
      windowDurationMins: null
    });
  });

  it("retains Claude model-specific and overage fields even without utilization", () => {
    const opus = claudeUsageReading(
      {
        status: "allowed_warning",
        rateLimitType: "seven_day_opus",
        overageStatus: "rejected",
        overageDisabledReason: "out_of_credits",
        isUsingOverage: false,
        canUserPurchaseCredits: true
      },
      input
    );
    expect(opus).toMatchObject({
      window: "seven_day_opus",
      status: "limited",
      usedPercent: null
    });
    expect(opus.details).toMatchObject({
      overageStatus: "rejected",
      overageDisabledReason: "out_of_credits"
    });
    const included = claudeUsageReading(
      {
        status: "allowed",
        rateLimitType: "seven_day_overage_included",
        utilization: 0.1234
      },
      input
    );
    expect(included).toMatchObject({
      window: "seven_day_overage_included",
      usedPercent: 12.34
    });
    expect(
      claudeUsageReading(
        { status: "new_status", rateLimitType: "new_window" },
        input
      )
    ).toMatchObject({ window: "unknown", status: "unknown" });
    expect(
      claudeUsageReading(
        {
          status: "allowed",
          rateLimitType: "five_hour",
          overageStatus: "future"
        },
        input
      ).status
    ).toBe("unknown");
    expect(
      claudeUsageReading(
        {
          status: "allowed",
          rateLimitType: "five_hour",
          overageStatus: "rejected"
        },
        input
      ).status
    ).toBe("limited");
  });

  it("hashes only stable official identities within an authority namespace", () => {
    expect(
      codexAccountIdentity({
        account: { type: "chatgpt", email: "User@Example.com" }
      })
    ).toBe("user@example.com");
    expect(codexAccountIdentity({ account: { type: "apiKey" } })).toBeNull();
    expect(
      claudeAccountIdentity({ organization: "org", subscriptionType: "pro" })
    ).toBeNull();
    const namespace = {
      ownerId: "alice",
      backendId: "local",
      profileId: "home",
      instanceId: "codex.default",
      provider: "codex"
    };
    expect(hashAiClientAccountIdentity(namespace, "user@example.com")).not.toBe(
      hashAiClientAccountIdentity(
        { ...namespace, ownerId: "bob" },
        "user@example.com"
      )
    );
  });
});
