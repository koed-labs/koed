import { describe, expect, it } from "vitest";
import { desktopFeatureFlagsFromEnvironment } from "./desktop-feature-flags.js";

describe("Desktop feature flags", () => {
  it.each([
    [{}, false],
    [{ KOED_DEVELOPER_TEAM_BACKEND_ENABLED: "false" }, false],
    [{ KOED_DEVELOPER_TEAM_BACKEND_ENABLED: "1" }, false],
    [{ KOED_DEVELOPER_TEAM_BACKEND_ENABLED: " true " }, false],
    [{ KOED_DEVELOPER_TEAM_BACKEND_ENABLED: "true" }, true]
  ] as const)(
    "maps the developer Team backend environment to a renderer-safe boolean",
    (environment, expected) => {
      expect(
        desktopFeatureFlagsFromEnvironment(environment)
          .developerTeamBackendEnabled
      ).toBe(expected);
    }
  );
});
