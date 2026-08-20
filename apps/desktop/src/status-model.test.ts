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

  it("offers setup and repair for optional Pi and Claude Code integrations", () => {
    const card = statusCards.find((entry) => entry.id === "piIntegration");

    expect(statusComponentKeys).toContain("pi");
    expect(componentDefinitions.pi.label).toBe("Pi configuration");
    expect(card).toMatchObject({
      componentKeys: ["pi"],
      primaryAction: { command: "repair_pi" }
    });
    expect(
      recoveryActionForStatusComponent("pi", "not_configured")
    ).toMatchObject({
      label: "Set up Pi integration",
      command: "setup_pi"
    });
    expect(
      recoveryActionForStatusComponent("pi", "needs_attention")
    ).toMatchObject({
      label: "Repair Pi integration",
      command: "repair_pi"
    });

    const claudeCard = statusCards.find(
      (entry) => entry.id === "claudeIntegration"
    );
    expect(statusComponentKeys).toContain("claudeCode");
    expect(componentDefinitions.claudeCode.label).toBe(
      "Claude Code configuration"
    );
    expect(claudeCard).toMatchObject({
      componentKeys: ["claudeCode"],
      primaryAction: { command: "repair_claude" }
    });
    expect(
      recoveryActionForStatusComponent("claudeCode", "not_configured")
    ).toMatchObject({
      label: "Set up Claude Code integration",
      command: "setup_claude"
    });
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
      label: "Run diagnostics",
      command: "doctor"
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
