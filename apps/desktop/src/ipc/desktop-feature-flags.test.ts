import { describe, expect, it } from "vitest";
import { desktopFeatureFlagsFromEnvironment } from "./desktop-feature-flags.js";

describe("Desktop feature flags", () => {
  it.each([
    [{}, true],
    [{ KOED_DESKTOP_HQ_ENABLED: undefined }, true],
    [{ KOED_DESKTOP_HQ_ENABLED: "false" }, false],
    [{ KOED_DESKTOP_HQ_ENABLED: "" }, false],
    [{ KOED_DESKTOP_HQ_ENABLED: "1" }, false],
    [{ KOED_DESKTOP_HQ_ENABLED: " true " }, false],
    [{ KOED_DESKTOP_HQ_ENABLED: "true" }, true]
  ] as const)(
    "enables the HQ shell when unset or exactly true",
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
    ).toEqual({
      hqEnabled: true,
      teamCollaborationEnabled: false,
      edition: "solo",
      phoneEnabled: false
    });
  });

  it("keeps Team collaboration disabled when HQ is enabled by default", () => {
    expect(desktopFeatureFlagsFromEnvironment({})).toEqual({
      hqEnabled: true,
      teamCollaborationEnabled: false,
      edition: "solo",
      phoneEnabled: false
    });
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

  it.each([
    [{}, "solo"],
    [{ KOED_EDITION: "solo" }, "solo"],
    [{ KOED_EDITION: "Full" }, "solo"],
    [{ KOED_EDITION: "full" }, "full"]
  ] as const)(
    "runs the Solo edition unless asked for full",
    (environment, expected) => {
      expect(desktopFeatureFlagsFromEnvironment(environment).edition).toBe(
        expected
      );
    }
  );

  it("keeps the phone off until switched on", () => {
    expect(desktopFeatureFlagsFromEnvironment({}).phoneEnabled).toBe(false);
    expect(
      desktopFeatureFlagsFromEnvironment({ KOED_PHONE_ENABLED: "true" })
        .phoneEnabled
    ).toBe(true);
  });
});
