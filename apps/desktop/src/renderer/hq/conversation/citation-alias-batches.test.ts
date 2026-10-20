import { describe, expect, it } from "vitest";
import { citationAliasBatches } from "./citation-alias-batches.js";

describe("citation alias batching", () => {
  it("resolves all 65 visible aliases within bounded requests", () => {
    const aliases = Array.from(
      { length: 65 },
      (_, index) => `r${index.toString(16).padStart(32, "0")}c1`
    );
    expect(
      citationAliasBatches(aliases.join("\u0000")).map((batch) => batch.length)
    ).toEqual([64, 1]);
    expect(citationAliasBatches(aliases.join("\u0000")).flat()).toEqual(
      aliases
    );
  });
});
