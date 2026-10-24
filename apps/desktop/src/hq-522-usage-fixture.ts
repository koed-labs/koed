import type { UsageReading } from "./renderer/hq/usage/hq-usage-model.js";
import {
  usageFixture,
  usageFixtureNow
} from "./renderer/hq/usage/hq-usage.fixture.js";

/** HQ-522-only scenarios; the HQ-521 default fixture remains unchanged. */
export const hq522UsageFixture = {
  codexLowClaudeFine: [...usageFixture.codexLow, ...usageFixture.claudeAllowed],
  claudeLowCodexFine: [...usageFixture.allFine, ...usageFixture.claudeNear],
  allFine: [...usageFixture.allFine, ...usageFixture.claudeAllowed],
  noAlternative: [...usageFixture.codexLow, ...usageFixture.claudeNear],
  unknownAlternative: [...usageFixture.codexLow, ...usageFixture.unknown],
  staleAlternative: [
    ...usageFixture.codexLow,
    ...usageFixture.claudeAllowed.map((reading) => ({
      ...reading,
      observedAt: "2026-10-23T11:20:00Z"
    }))
  ],
  passedResetAlternative: [
    ...usageFixture.codexLow,
    ...usageFixture.claudeAllowed.map((reading) => ({
      ...reading,
      resetsAt: "2026-10-23T11:10:00Z"
    }))
  ],
  restrictedAlternative: [
    ...usageFixture.claudeNear,
    ...usageFixture.codexRestriction
  ],
  secondBucketAlternative: [
    ...usageFixture.claudeNear,
    ...usageFixture.secondCodexBucket
  ]
} satisfies Record<string, UsageReading[]>;

export const hq522LiveReadings = (
  variant: keyof typeof hq522UsageFixture,
  now = Date.now()
) =>
  hq522UsageFixture[variant].map((reading) => {
    const shift = (value: string | null) =>
      value
        ? new Date(Date.parse(value) + now - usageFixtureNow).toISOString()
        : null;
    return {
      ...reading,
      accountVerified: true,
      observedAt: shift(reading.observedAt)!,
      resetsAt: shift(reading.resetsAt)
    };
  });
