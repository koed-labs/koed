import { describe, expect, it } from "vitest";
import { assertReleaseHost } from "./runtime-release.js";

describe("release host gate", () => {
  it("accepts macOS 14 arm64 and Linux x64 with glibc 2.35", () => {
    expect(() =>
      assertReleaseHost({
        platform: "darwin",
        arch: "arm64",
        kernel: "23.0.0",
        libc: ""
      })
    ).not.toThrow();
    expect(() =>
      assertReleaseHost({
        platform: "linux",
        arch: "x64",
        kernel: "",
        libc: "2.35"
      })
    ).not.toThrow();
  });
  it("rejects older macOS with actionable upgrade guidance", () => {
    expect(() =>
      assertReleaseHost({
        platform: "darwin",
        arch: "arm64",
        kernel: "22.6.0",
        libc: ""
      })
    ).toThrow(/macOS 14.*later/i);
    expect(() =>
      assertReleaseHost({
        platform: "darwin",
        arch: "arm64",
        kernel: "invalid",
        libc: ""
      })
    ).toThrow(/macOS 14.*later/i);
  });
  it("rejects unsupported hosts and old or unknown glibc", () => {
    for (const host of [
      { platform: "linux", arch: "x64", kernel: "", libc: "2.34" },
      { platform: "linux", arch: "x64", kernel: "", libc: "" },
      { platform: "darwin", arch: "x64", kernel: "23.0.0", libc: "" },
      { platform: "linux", arch: "arm64", kernel: "", libc: "2.40" }
    ])
      expect(() => assertReleaseHost(host)).toThrow();
  });
});
