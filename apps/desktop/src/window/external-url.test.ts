import { describe, expect, it } from "vitest";
import { safeExternalUrl } from "./external-url.js";

describe("safeExternalUrl", () => {
  it.each([
    ["https://koed.ai/docs", "https://koed.ai/docs"],
    ["http://localhost:3300/ready", "http://localhost:3300/ready"],
    ["mailto:support@koed.ai", "mailto:support@koed.ai"]
  ])("allows an explicit external URL scheme", (value, expected) => {
    expect(safeExternalUrl(value)).toBe(expected);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "https://user:password@example.com/",
    "//example.com",
    "not a url",
    ""
  ])("rejects unsafe external URL %s", (value) => {
    expect(safeExternalUrl(value)).toBeNull();
  });
});
