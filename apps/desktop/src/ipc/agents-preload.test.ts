import { describe, expect, it, vi } from "vitest";
import { createAgentsPreloadApi } from "./agents-preload.js";
import { agentsCommandChannel } from "./agents-protocol.js";

describe("Agents preload", () => {
  it("sends no renderer-selected instance for Chief bootstrap", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const invoke = vi.fn(async () => ({
      operation: "ensureChief",
      agent: {
        id,
        ownerUserId: id,
        name: "Chief",
        role: null,
        look: {},
        aiClientInstanceId: "codex.default",
        defaultPermissionMode: "supervised",
        defaultModel: null,
        isChiefOfStaff: true,
        createdAt: new Date().toISOString()
      }
    }));
    const api = createAgentsPreloadApi(invoke);
    expect((await api.ensureChief()).id).toBe(id);
    expect(invoke).toHaveBeenCalledWith(agentsCommandChannel, {
      operation: "ensureChief"
    });
  });
  it("rejects invalid or mismatched main results", async () => {
    const api = createAgentsPreloadApi(async () => ({
      operation: "create",
      agent: {}
    }));
    await expect(api.list()).rejects.toThrow();
  });
  it("passes only the cold Project HQ selector and exact request through typed IPC", async () => {
    const projectId = "22222222-2222-4222-8222-222222222222";
    const agentId = "33333333-3333-4333-8333-333333333333";
    const invoke = vi.fn(async () => ({
      operation: "delegateCold",
      agentId,
      executionId: "44444444-4444-4444-8444-444444444444",
      reused: false
    }));
    const api = createAgentsPreloadApi(invoke);
    const request = {
      projectId,
      agentId,
      requestId: "agent-delegation:11111111-1111-4111-8111-111111111111",
      prompt: "Fix lint errors"
    };
    await api.delegateCold(request);
    expect(invoke).toHaveBeenCalledWith(agentsCommandChannel, {
      operation: "delegateCold",
      ...request
    });
  });
});
