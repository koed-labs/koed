import { describe, expect, it } from "vitest";
import {
  coarsePresenceFromTeamPresence,
  deriveTeamPresenceSnapshot,
  TEAM_ACTIVITY_ACTIVE_MS,
  TEAM_ACTIVITY_IDLE_MS,
  TEAM_ACTIVITY_RECENT_MS
} from "./team-presence.js";

const now = Date.parse("2026-07-30T12:00:00.000Z");

describe("Team presence", () => {
  it.each([
    [TEAM_ACTIVITY_ACTIVE_MS, "active"],
    [TEAM_ACTIVITY_ACTIVE_MS + 1, "recently_active"],
    [TEAM_ACTIVITY_RECENT_MS + 1, "idle"],
    [TEAM_ACTIVITY_IDLE_MS + 1, "inactive"]
  ] as const)("derives activity after %i milliseconds", (elapsed, expected) => {
    const presence = deriveTeamPresenceSnapshot(
      {
        mode: "auto",
        manualStatus: "available",
        lastActivityAt: new Date(now - elapsed).toISOString(),
        preferenceVersion: 3
      },
      now
    );
    expect(presence.activityLevel).toBe(expected);
    expect(coarsePresenceFromTeamPresence(presence)).toBe(
      expected === "active"
        ? "available"
        : expected === "inactive"
          ? "offline"
          : "away"
    );
  });

  it("does not disclose activity while a manual status is active", () => {
    expect(
      deriveTeamPresenceSnapshot(
        {
          mode: "manual",
          manualStatus: "out_of_office",
          lastActivityAt: new Date(now).toISOString(),
          preferenceVersion: 2
        },
        now
      )
    ).toEqual({
      mode: "manual",
      manualStatus: "out_of_office",
      activityLevel: null,
      lastActivityAt: null,
      nextTransitionAt: null,
      preferenceVersion: 2
    });
  });

  it("fails closed to inactive for a missing or future activity signal", () => {
    for (const lastActivityAt of [null, new Date(now + 1_000).toISOString()]) {
      expect(
        deriveTeamPresenceSnapshot(
          {
            mode: "auto",
            manualStatus: "available",
            lastActivityAt,
            preferenceVersion: 1
          },
          now
        ).activityLevel
      ).toBe("inactive");
    }
  });
});
