import { describe, expect, it } from "vitest";

import { safeReturnTo } from "./routes.js";

describe("safeReturnTo", () => {
  it.each([
    "/high-risk/browser-activations/activation-1",
    "/device-enrollment/challenge-1",
    "/device-enrollment/challenge-1?source=desktop",
    "/koed/high-risk/browser-activations/activation-1",
    "/koed/device-enrollment/challenge-1"
  ])("accepts the same-origin approval path %s", (path) => {
    expect(safeReturnTo(path)).toBe(path);
  });

  it.each([
    "https://evil.example.test/phish",
    "//evil.example.test/phish",
    "/\\evil.example.test/phish",
    "/device-enrollment/challenge-1\nset-cookie: stolen",
    null,
    undefined
  ])("rejects the unsafe return target %s", (target) => {
    expect(safeReturnTo(target)).toBe("/");
  });
});
