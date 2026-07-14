import { describe, expect, it } from "vitest";

import {
  componentDefinitions,
  statusCards,
  statusComponentKeys,
  statusGroups
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

  it("presents local readiness as User outcomes with recovery actions", () => {
    expect(statusGroups.map((group) => group.title)).toEqual([
      "Capture",
      "Recall",
      "Memory processing"
    ]);
    for (const group of statusGroups) {
      expect(group.healthySummary).toMatch(/captur|AI Client|recall/i);
      expect(group.action?.label).toBeTruthy();
    }
  });
});
