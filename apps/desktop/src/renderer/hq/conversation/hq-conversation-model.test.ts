import { describe, expect, it } from "vitest";
import type { ManagedConversationLaunchOptions } from "../../../ipc/managed-conversation-protocol.js";
import {
  hqReasoningHeat,
  hqReasoningLabel,
  hqSelectionForInstance,
  hqSelectionIsSupported,
  hqSettingsChange
} from "./hq-conversation-model.js";

const options: ManagedConversationLaunchOptions = {
  runners: [],
  instances: [
    {
      instanceId: "codex.default",
      driverId: "codex",
      displayName: "Codex",
      ready: true,
      readiness: "ready",
      models: [
        {
          id: "model-a",
          isDefault: true,
          supportedReasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "low"
        }
      ],
      capabilities: {
        defaultPermissionMode: "full_access",
        permissionModes: [
          { mode: "supervised", support: "supported" },
          { mode: "full_access", support: "supported" },
          { mode: "auto_edit", support: "unsupported" },
          { mode: "auto", support: "requires_bridge" }
        ]
      }
    }
  ]
};

describe("HQ Conversation settings", () => {
  it("maps advertised efforts to v50 heat steps without inventing levels", () => {
    expect([0, 1, 2].map((index) => hqReasoningHeat(index, 3))).toEqual([
      1, 2, 4
    ]);
    expect([0, 1, 2, 3].map((index) => hqReasoningHeat(index, 4))).toEqual([
      1, 2, 3, 4
    ]);
    expect(hqReasoningLabel("xhigh")).toBe("Extra high");
  });
  it("starts with Ask first even when the AI Client default is Full access", () => {
    const selection = hqSelectionForInstance(options, "codex.default");
    expect(selection.permissionMode).toBe("supervised");
    expect(hqSelectionIsSupported(options, selection)).toBe(true);
    expect(
      hqSelectionIsSupported(options, { ...selection, permissionMode: "auto" })
    ).toBe(false);
  });
  it("does not silently widen when supervised is unsupported", () => {
    const unavailable = structuredClone(options);
    unavailable.instances[0]!.capabilities.permissionModes[0]!.support =
      "unsupported";
    const selection = hqSelectionForInstance(unavailable, "codex.default");
    expect(selection.permissionMode).toBe("");
    expect(hqSelectionIsSupported(unavailable, selection)).toBe(false);
  });
  it("binds a per-turn change to exact expected settings", () => {
    const expected = {
      model: "model-a",
      reasoningEffort: "low",
      permissionMode: "supervised" as const
    };
    const selection = {
      ...hqSelectionForInstance(options, "codex.default"),
      reasoningEffort: "high"
    };
    expect(hqSettingsChange(expected, selection)).toEqual({
      expected,
      next: {
        model: "model-a",
        reasoningEffort: "high",
        permissionMode: "supervised"
      }
    });
    expect(
      hqSettingsChange(expected, { ...selection, reasoningEffort: "low" })
    ).toBeNull();
  });
});
