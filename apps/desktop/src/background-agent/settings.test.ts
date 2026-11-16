import { describe, expect, it } from "vitest";
import { agentSettingsChoices } from "./settings.js";

describe("Background Agent settings", () => {
  it("allows reconciling an enabled registration after an uncertain attach", () => {
    expect(agentSettingsChoices("enabled")).toEqual([
      "Reconcile",
      "Disable",
      "Cancel"
    ]);
  });
  it("allows disabling a registration waiting for approval", () => {
    expect(agentSettingsChoices("requires-approval")).toEqual([
      "Disable",
      "Cancel"
    ]);
  });
  it("offers enable for a disabled registration", () => {
    expect(agentSettingsChoices("disabled")).toEqual(["Enable", "Cancel"]);
  });
});
