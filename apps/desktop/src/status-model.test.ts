import { describe, expect, it } from "vitest";

import {
  componentDefinitions,
  recoveryActionForStatusComponent,
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

  it("presents local readiness as User outcomes", () => {
    expect(statusGroups.map((group) => group.title)).toEqual([
      "Capture",
      "Recall",
      "Memory processing"
    ]);
    for (const group of statusGroups) {
      expect(group.healthySummary).toMatch(/captur|AI Client|recall/i);
    }
  });

  it("selects recovery actions for the component that is unhealthy", () => {
    expect(recoveryActionForStatusComponent("api")).toMatchObject({
      label: "Ensure API is running",
      command: "start"
    });
    expect(recoveryActionForStatusComponent("database")).toMatchObject({
      label: "Start dependencies",
      command: "start"
    });
    expect(recoveryActionForStatusComponent("embeddingService")).toMatchObject({
      label: "Ensure embedding stack",
      command: "start"
    });
    expect(
      recoveryActionForStatusComponent("embeddingService", "not_configured")
    ).toMatchObject({
      label: "Install embedding model",
      command: "models_install"
    });
    expect(
      recoveryActionForStatusComponent("database", "not_configured")
    ).toMatchObject({
      label: "Install runtime",
      command: "runtime_install"
    });
    expect(recoveryActionForStatusComponent("captureHook")).toMatchObject({
      label: "Fix Codex integration",
      command: "repair_codex"
    });
    expect(recoveryActionForStatusComponent("workerQueues")).toMatchObject({
      label: "Ensure worker stack",
      command: "start"
    });
    expect(recoveryActionForStatusComponent("lastVerification")).toMatchObject({
      label: "Run diagnostics",
      command: "doctor"
    });
  });
});
