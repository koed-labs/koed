import { describe, expect, it } from "vitest";
import { desktopFeatureFlagsFromEnvironment } from "./desktop-feature-flags.js";

describe("Desktop feature flags", () => {
  it.each([
    [{}, false],
    [{ KOED_DESKTOP_HQ_ENABLED: "false" }, false],
    [{ KOED_DESKTOP_HQ_ENABLED: "1" }, false],
    [{ KOED_DESKTOP_HQ_ENABLED: " true " }, false],
    [{ KOED_DESKTOP_HQ_ENABLED: "true" }, true]
  ] as const)(
    "enables the HQ shell only for the exact true environment value",
    (environment, expected) => {
      expect(desktopFeatureFlagsFromEnvironment(environment).hqEnabled).toBe(
        expected
      );
    }
  );

  it("keeps the HQ flag independent from Team collaboration", () => {
    expect(
      desktopFeatureFlagsFromEnvironment({
        KOED_DESKTOP_HQ_ENABLED: "true",
        KOED_TEAM_COLLABORATION_ENABLED: "false"
      })
    ).toEqual({ hqEnabled: true, teamCollaborationEnabled: false });
  });

  it.each([
    [{}, false],
    [{ KOED_TEAM_COLLABORATION_ENABLED: "false" }, false],
    [{ KOED_TEAM_COLLABORATION_ENABLED: "1" }, false],
    [{ KOED_TEAM_COLLABORATION_ENABLED: " true " }, false],
    [{ KOED_DEVELOPER_TEAM_BACKEND_ENABLED: "true" }, false],
    [{ KOED_TEAM_COLLABORATION_ENABLED: "true" }, true]
  ] as const)(
    "maps the Team collaboration environment to a renderer-safe boolean",
    (environment, expected) => {
      expect(
        desktopFeatureFlagsFromEnvironment(environment).teamCollaborationEnabled
      ).toBe(expected);
    }
  );
});
