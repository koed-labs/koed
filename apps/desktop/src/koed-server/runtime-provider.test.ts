import { describe, expect, it } from "vitest";
import { selectDesktopRuntimeProvider } from "./runtime-provider.js";

const select = (platform: NodeJS.Platform, files: string[] = []) =>
  selectDesktopRuntimeProvider({
    platform,
    koedHome: "/koed",
    packagedManifest: "/resources/manifest.json",
    exists: (path) => files.includes(path)
  });
describe("Desktop runtime provider selection", () => {
  it("routes fresh Linux to release even when Desktop carries a legacy bundled manifest", () => {
    expect(select("linux")).toBe("release");
    expect(select("linux", ["/resources/manifest.json"])).toBe("release");
  });
  it("preserves established native providers and leaves admission to that provider", () => {
    expect(select("linux", ["/koed/cache/runtime-homebrew.json"])).toBe(
      "homebrew"
    );
    expect(select("linux", ["/koed/cache/runtime-packaged.json"])).toBe(
      "packaged"
    );
    expect(select("linux", ["/koed/runtime/native"])).toBe("release");
  });
  it("retains macOS packaged and source behavior", () => {
    expect(select("darwin", ["/resources/manifest.json"])).toBe("packaged");
    expect(select("darwin")).toBe("homebrew");
  });
});
