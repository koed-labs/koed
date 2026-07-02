import { describe, expect, it } from "vitest";
import { resolveDevServerUrl } from "./dev-server-url.js";

describe("Desktop dev server URL resolution", () => {
  it("disables dev server URLs in packaged apps", () => {
    expect(
      resolveDevServerUrl({
        appIsPackaged: true,
        devServerUrl: "http://127.0.0.1:5173"
      })
    ).toBeNull();
  });

  it("allows loopback dev server URLs in development", () => {
    expect(
      resolveDevServerUrl({
        appIsPackaged: false,
        devServerUrl: "http://127.0.0.1:5173"
      })
    ).toBe("http://127.0.0.1:5173/");
    expect(
      resolveDevServerUrl({
        appIsPackaged: false,
        devServerUrl: "http://localhost:5173"
      })
    ).toBe("http://localhost:5173/");
  });

  it("rejects non-loopback or non-http development URLs", () => {
    expect(
      resolveDevServerUrl({
        appIsPackaged: false,
        devServerUrl: "https://example.com"
      })
    ).toBeNull();
    expect(
      resolveDevServerUrl({
        appIsPackaged: false,
        devServerUrl: "file:///tmp/index.html"
      })
    ).toBeNull();
  });
});
