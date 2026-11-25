import { describe, expect, it } from "vitest";
import { desktopFeatureFlagsFromEnvironment } from "./desktop-feature-flags.js";

describe("Desktop feature flags", () => {
  it.each([
    [{}, false],
    [{ KOED_TEAM_COLLABORATION_ENABLED: "false" }, false],
    [{ KOED_TEAM_COLLABORATION_ENABLED: "1" }, false],
    [{ KOED_TEAM_COLLABORATION_ENABLED: " " }, false],
    [{ KOED_TEAM_COLLABORATION_ENABLED: " true " }, true],
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
    [{}, false],
    [{ KOED_PERSONAL_DEVICE_SYNC_ENABLED: "" }, false],
    [{ KOED_PERSONAL_DEVICE_SYNC_ENABLED: "false" }, false],
    [{ KOED_PERSONAL_DEVICE_SYNC_ENABLED: "yes" }, false],
    [{ KOED_PERSONAL_DEVICE_SYNC_ENABLED: "true" }, true]
  ] as const)(
    "shows Personal Device Sync only when it is exactly enabled",
    (environment, expected) => {
      expect(
        desktopFeatureFlagsFromEnvironment(environment)
          .personalDeviceSyncEnabled
      ).toBe(expected);
    }
  );
});
