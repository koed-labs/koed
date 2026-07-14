import { describe, expect, it } from "vitest";

import {
  componentDefinitions,
  statusCards,
  statusComponentKeys
} from "./status-model.js";

describe("Desktop status model", () => {
  it("includes Team Backend setup in Desktop readiness", () => {
    const card = statusCards.find((entry) => entry.id === "teamBackend");

    expect(statusComponentKeys).toContain("upstreamBackends");
    expect(componentDefinitions.upstreamBackends.label).toBe("Team Backend");
    expect(card).toMatchObject({
      componentKeys: ["upstreamBackends"],
      primaryAction: { command: "connect_team_backend" }
    });
    expect(card?.secondaryActions).toContainEqual(
      expect.objectContaining({ command: "disconnect_team_backend" })
    );
  });
});
