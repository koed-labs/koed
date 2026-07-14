import { describe, expect, it } from "vitest";

import {
  componentDefinitions,
  statusCards,
  statusComponentKeys
} from "./status-model.js";

describe("Desktop status model", () => {
  it("keeps unshipped Team Backend setup out of the Desktop UI", () => {
    expect(statusCards.map((card) => card.id)).not.toContain("teamBackend");
    expect(statusComponentKeys).not.toContain("upstreamBackends");
    expect(componentDefinitions).not.toHaveProperty("upstreamBackends");
  });
});
