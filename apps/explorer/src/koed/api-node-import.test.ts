import { describe, expect, it } from "vitest";

describe("Explorer API module", () => {
  it("can be imported without browser globals", async () => {
    expect(typeof window).toBe("undefined");
    await expect(import("./api")).resolves.toMatchObject({
      apiBaseUrl: "http://localhost:3300"
    });
  });
});
