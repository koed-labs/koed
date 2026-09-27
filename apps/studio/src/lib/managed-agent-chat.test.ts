import { describe, expect, it } from "vitest";
import {
  acceptRuntimeSnapshot,
  parseLaunchInstances,
  parseRuntime,
  resolveLaunchSelection
} from "./managed-agent-chat";

const instances = parseLaunchInstances({
  instances: [
    {
      ready: true,
      instanceId: "codex.default",
      driverId: "codex",
      models: [{ id: "luna", supportedReasoningEfforts: ["high"] }],
      capabilities: {
        permissionModes: [{ mode: "supervised", support: "supported" }]
      }
    }
  ]
});
const selection = {
  agentId: "bob",
  provider: "codex",
  model: "luna",
  effort: "High",
  permissionMode: "ask" as const
};
const execution = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: null,
  provider: "codex",
  aiClientInstanceId: "codex.default",
  model: "luna",
  reasoningEffort: "high",
  permissionMode: "supervised",
  executionGeneration: 2,
  stateVersion: 3,
  state: "running",
  lastErrorCode: null
};

describe("managed agent chat boundary", () => {
  it("resolves the actual instance and preserves explicitly selected permissions", () => {
    expect(resolveLaunchSelection(selection, instances)).toMatchObject({
      permissionMode: "supervised",
      reasoningEffort: "high",
      aiClientInstanceId: "codex.default"
    });
    expect(() =>
      resolveLaunchSelection(
        { ...selection, permissionMode: "read" },
        instances
      )
    ).toThrow("read-only");
    expect(() =>
      resolveLaunchSelection(
        { ...selection, permissionMode: "full" },
        instances
      )
    ).toThrow("not available");
  });
  it("never substitutes an unavailable agent model or effort", () => {
    expect(() =>
      resolveLaunchSelection({ ...selection, model: "astra" }, instances)
    ).toThrow("not available");
    expect(() =>
      resolveLaunchSelection({ ...selection, effort: "max" }, instances)
    ).toThrow("not available");
    expect(() =>
      resolveLaunchSelection({ ...selection, agentId: null }, instances)
    ).toThrow("Choose an agent");
  });
  it("ignores unready models and old-generation runtime items", () => {
    expect(
      parseLaunchInstances({ instances: [{ ...instances[0], ready: false }] })
    ).toEqual([]);
    const snapshot = parseRuntime({
      execution,
      items: [
        {
          id: "old",
          executionGeneration: 1,
          itemKind: "transient_output",
          state: "pending",
          payload: { text: "old" }
        }
      ]
    });
    expect(snapshot.items).toEqual([]);
    expect(
      acceptRuntimeSnapshot(
        snapshot,
        parseRuntime({
          execution: { ...execution, stateVersion: 2 },
          items: []
        })
      )
    ).toBe(false);
    expect(
      acceptRuntimeSnapshot(
        snapshot,
        parseRuntime({
          execution: { ...execution, executionGeneration: 1, stateVersion: 99 },
          items: []
        })
      )
    ).toBe(false);
  });
});
