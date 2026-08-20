import { describe, expect, it } from "vitest";
import { assertExperienceReplayHostPlatform } from "./host-platform.js";

describe("Experience Replay host support", () => {
  it("accepts Linux hosts used by native Linux, WSL, and Linux containers", () => {
    expect(() => assertExperienceReplayHostPlatform("linux")).not.toThrow();
  });

  it.each(["darwin", "win32"] satisfies NodeJS.Platform[])(
    "rejects unsupported %s hosts with an actionable diagnostic",
    (platform) => {
      expect(() => assertExperienceReplayHostPlatform(platform)).toThrow(
        "Experience Replay requires a Linux host. Native Linux, WSL, and Linux containers are supported; macOS and native Windows are not yet supported."
      );
    }
  );
});
