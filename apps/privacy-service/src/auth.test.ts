import { describe, expect, it } from "vitest";
import { requirePrivacyToken } from "./auth.js";

describe("privacy service authentication", () => {
  it("accepts only the exact configured token", () => {
    expect(() => requirePrivacyToken("secret", "secret")).not.toThrow();
    expect(() => requirePrivacyToken("secret", "secreu")).toThrow(
      /invalid privacy service token/
    );
    expect(() => requirePrivacyToken("secret", null)).toThrow(
      /invalid privacy service token/
    );
  });
});
