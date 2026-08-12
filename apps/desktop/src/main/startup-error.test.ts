import { describe, expect, it } from "vitest";
import { formatDesktopStartupError } from "./startup-error.js";

describe("desktop startup error formatting", () => {
  it("redacts secret-like values and preserves useful stack context", () => {
    const formatted = formatDesktopStartupError(
      new Error("startup failed API_TOKEN=secret-value")
    );
    expect(formatted).toContain("startup failed");
    expect(formatted).toContain("[REDACTED_SECRET]");
    expect(formatted).not.toContain("secret-value");
  });
});
