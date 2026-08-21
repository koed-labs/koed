import { describe, expect, it } from "vitest";
import { detectDeterministicSecrets } from "./secrets.js";

describe("deterministic secret detector", () => {
  it("detects known credential formats and assignment values", () => {
    const text = [
      "aws=AKIAABCDEFGHIJKLMNOP",
      "password: correct-horse-battery",
      "github=ghp_abcdefghijklmnopqrstuvwxyz"
    ].join("\n");
    const values = detectDeterministicSecrets(text).map((span) =>
      text.slice(span.start, span.end)
    );
    expect(values).toEqual(
      expect.arrayContaining([
        "AKIAABCDEFGHIJKLMNOP",
        "correct-horse-battery",
        "ghp_abcdefghijklmnopqrstuvwxyz"
      ])
    );
  });

  it("does not classify ordinary prose as a secret", () => {
    expect(
      detectDeterministicSecrets("Alice discussed the API design.")
    ).toEqual([]);
  });
});
