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
});
