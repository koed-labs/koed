import { describe, expect, it } from "vitest";
import { detectDeterministicSecrets } from "./secrets.js";

describe("deterministic secret detector", () => {
  it("detects known credential formats and assignment values", () => {
    const text = [
      "aws=AKIAABCDEFGHIJKLMNOP",
      "password: correct-horse-battery",
      "My password is LaunchPass1234",
      "The old passphrase was winter-rainbow-2025",
      "github=ghp_abcdefghijklmnopqrstuvwxyz"
    ].join("\n");
    const values = detectDeterministicSecrets(text).map((span) =>
      text.slice(span.start, span.end)
    );
    expect(values).toEqual(
      expect.arrayContaining([
        "AKIAABCDEFGHIJKLMNOP",
        "correct-horse-battery",
        "LaunchPass1234",
        "winter-rainbow-2025",
        "ghp_abcdefghijklmnopqrstuvwxyz"
      ])
    );
  });

  it("does not classify ordinary prose as a secret", () => {
    expect(
      detectDeterministicSecrets("Alice discussed the API design.")
    ).toEqual([]);
    expect(
      detectDeterministicSecrets(
        "The password is important, but no credential was provided."
      )
    ).toEqual([]);
  });
});
