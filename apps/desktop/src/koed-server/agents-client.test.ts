import { describe, expect, it, vi } from "vitest";
import { createAgentsClient, type AgentsAuthority } from "./agents-client.js";

const id = "11111111-1111-4111-8111-111111111111";
const agent = {
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
};
const authority = (key: string): AgentsAuthority => ({
  key,
  ownerId: id,
  apiOrigin: "http://127.0.0.1:9999",
  authorization: key
});

describe("Agents main client", () => {
  it("uses the main-resolved default for a missing Chief", async () => {
    const requestJson = vi.fn(async (path: string) =>
      path === "/v1/agents" ? { agents: [] } : { agent }
    );
    const defaultInstance = vi.fn(async () => "codex.default");
    const client = createAgentsClient({
      requestJson,
      authority: async () => authority("owner\0origin\0credential"),
      defaultInstance
    });
    expect(await client({ operation: "ensureChief" })).toEqual({
      operation: "ensureChief",
      agent
    });
    expect(defaultInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: id,
        authorization: "owner\0origin\0credential"
      })
    );
    expect(requestJson).toHaveBeenCalledWith(
      "/v1/agents/chief:ensure",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ aiClientInstanceId: "codex.default" })
      }),
      expect.objectContaining({ authorization: "owner\0origin\0credential" })
    );
  });
  it("returns a customized existing Chief without resolving an unavailable default", async () => {
    const defaultInstance = vi.fn();
    const client = createAgentsClient({
      requestJson: async () => ({ agents: [agent] }),
      authority: async () => authority("owner"),
      defaultInstance
    });
    expect(await client({ operation: "ensureChief" })).toEqual({
      operation: "ensureChief",
      agent
    });
    expect(defaultInstance).not.toHaveBeenCalled();
  });
  it("stops before a mutation if the local profile changes", async () => {
    let current = "owner-a";
    const requestJson = vi.fn(async () => ({ agents: [] }));
    const client = createAgentsClient({
      requestJson,
      authority: async () => authority(current),
      defaultInstance: async () => {
        current = "owner-b";
        return "codex.default";
      }
    });
    await expect(client({ operation: "ensureChief" })).rejects.toThrow(
      "profile changed"
    );
    expect(requestJson).toHaveBeenCalledTimes(1);
  });
  it("passes the original owner's credential to the bootstrap read and blocks a switched profile", async () => {
    let current = "old-owner";
    const boundAuthorities: string[] = [];
    const requestJson = vi.fn(async (path: string) =>
      path === "/v1/agents" ? { agents: [] } : { agent }
    );
    const client = createAgentsClient({
      requestJson,
      authority: async () => authority(current),
      defaultInstance: async (bound) => {
        boundAuthorities.push(bound.authorization);
        current = "new-owner";
        return "codex.default";
      }
    });
    await expect(client({ operation: "ensureChief" })).rejects.toThrow(
      "profile changed"
    );
    expect(boundAuthorities).toEqual(["old-owner"]);
    expect(requestJson).toHaveBeenCalledTimes(1);
  });
  it("never dispatches a Chief write with a newly resolved owner's credential", async () => {
    let current = "old-owner";
    let newOwnerMutations = 0;
    const requestJson = vi.fn(
      async (path: string, _init: RequestInit, bound: AgentsAuthority) => {
        if (path === "/v1/agents") return { agents: [] };
        // Model a profile switch during the async access/fetch boundary.
        current = "new-owner";
        if (bound.authorization === "new-owner") newOwnerMutations++;
        return { agent };
      }
    );
    const client = createAgentsClient({
      requestJson,
      authority: async () => authority(current),
      defaultInstance: async () => "codex.default"
    });
    await expect(client({ operation: "ensureChief" })).rejects.toThrow(
      "profile changed"
    );
    expect(newOwnerMutations).toBe(0);
    expect(requestJson.mock.calls.at(-1)?.[2].authorization).toBe("old-owner");
  });
  it("rejects duplicate lists and a non-Chief bootstrap response", async () => {
    const duplicate = createAgentsClient({
      requestJson: async () => ({ agents: [agent, agent] }),
      authority: async () => authority("owner"),
      defaultInstance: async () => "codex.default"
    });
    await expect(duplicate({ operation: "list" })).rejects.toThrow("duplicate");
    const invalidChief = createAgentsClient({
      requestJson: async (path) =>
        path === "/v1/agents"
          ? { agents: [] }
          : { agent: { ...agent, isChiefOfStaff: false } },
      authority: async () => authority("owner"),
      defaultInstance: async () => "codex.default"
    });
    await expect(invalidChief({ operation: "ensureChief" })).rejects.toThrow(
      "Chief of Staff identity"
    );
  });
});
