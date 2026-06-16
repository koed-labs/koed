import { describe, expect, it } from "vitest";
import { resolveApiUrl, resolveExplorerUrl } from "./env-file.js";

describe("local URL resolution", () => {
  it("lets one-shot environment port overrides win over repo .env ports", () => {
    expect(
      resolveApiUrl(
        { API_HOST_PORT: "4545" },
        { API_HOST_PORT: "3300" }
      )
    ).toBe("http://localhost:4545");
    expect(
      resolveExplorerUrl(
        { EXPLORER_WEB_HOST_PORT: "5574" },
        { EXPLORER_WEB_HOST_PORT: "5174" }
      )
    ).toBe("http://localhost:5574");
  });
});
