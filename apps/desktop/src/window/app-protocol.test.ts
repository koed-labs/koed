import { describe, expect, it } from "vitest";
import { resolveAppProtocolRequest } from "./app-protocol.js";

describe("Koed app protocol", () => {
  it("serves index for app root and SPA routes", () => {
    expect(resolveAppProtocolRequest("/dist", "koed://app/")).toMatchObject({
      kind: "file",
      fileUrl: "file:///dist/index.html"
    });
    expect(
      resolveAppProtocolRequest("/dist", "koed://app/settings")
    ).toMatchObject({
      kind: "file",
      fileUrl: "file:///dist/index.html"
    });
  });

  it("serves asset files from app dist", () => {
    expect(
      resolveAppProtocolRequest("/dist", "koed://app/assets/index.js")
    ).toMatchObject({
      kind: "file",
      fileUrl: "file:///dist/assets/index.js"
    });
  });

  it("normalizes direct index.html requests", () => {
    expect(
      resolveAppProtocolRequest("/dist", "koed://app/index.html?x=1#top")
    ).toMatchObject({
      kind: "redirect",
      redirectUrl: "koed://app/?x=1#top",
      status: 307
    });
  });

  it("blocks path traversal", () => {
    expect(
      resolveAppProtocolRequest("/dist", "koed://app/%2e%2e/secret")
    ).toMatchObject({
      kind: "not_found",
      status: 404
    });
  });
});
