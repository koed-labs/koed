import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@koed/shared";
import { AgentsStore } from "./agents-store.js";

const id = "11111111-1111-4111-8111-111111111111";
const chief: Agent = {
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

describe("HQ Agents store", () => {
  it("loads real owner-bound Helpers after Chief setup", async () => {
    const quinn = {
      ...chief,
      id: "33333333-3333-4333-8333-333333333333",
      name: "Quinn",
      isChiefOfStaff: false
    };
    const api = {
      list: vi.fn(async () => [chief]),
      ensureChief: vi.fn(),
      ensureHelpers: vi.fn(async () => [chief, quinn])
    };
    const store = new AgentsStore(api as never);
    store.setOwner(id, "local");
    await store.refresh();
    expect(api.ensureHelpers).toHaveBeenCalledOnce();
    expect(store.current().agents).toEqual([chief, quinn]);
    expect(store.current().selectedAgentId).toBe(chief.id);
  });
  it("bootstraps a missing Chief and chooses only an owned listed Agent", async () => {
    const api = {
      list: vi.fn(async () => []),
      ensureChief: vi.fn(async () => chief)
    };
    const store = new AgentsStore(api as never);
    store.setOwner(id, "local");
    await store.refresh();
    expect(store.current().agents).toEqual([chief]);
    expect(store.current().selectedAgentId).toBe(id);
    expect(() => store.choose("foreign")).toThrow();
    store.setOwner("22222222-2222-4222-8222-222222222222", "other");
    expect(store.current().agents).toEqual([]);
  });
  it("keeps an existing Chief visible when runtime is unavailable", async () => {
    const api = { list: vi.fn(async () => [chief]), ensureChief: vi.fn() };
    const store = new AgentsStore(api as never);
    store.setOwner(id, "local");
    await store.refresh();
    expect(store.current().agents).toEqual([chief]);
    expect(api.ensureChief).not.toHaveBeenCalled();
  });
  it("deduplicates same-owner refreshes and ignores a late old-profile result", async () => {
    const nextOwner = "22222222-2222-4222-8222-222222222222";
    let releaseOld!: (agents: Agent[]) => void;
    const old = new Promise<Agent[]>((resolve) => {
      releaseOld = resolve;
    });
    const api = {
      list: vi
        .fn()
        .mockImplementationOnce(() => old)
        .mockResolvedValueOnce([
          { ...chief, id: nextOwner, ownerUserId: nextOwner }
        ]),
      ensureChief: vi.fn()
    };
    const store = new AgentsStore(api as never);
    store.setOwner(id, "profile-a");
    const duplicate = store.refresh();
    expect(api.list).toHaveBeenCalledTimes(1);
    store.setOwner(nextOwner, "profile-b");
    await store.refresh();
    releaseOld([chief]);
    await duplicate;
    expect(store.current().ownerId).toBe(nextOwner);
    expect(store.current().agents[0]?.ownerUserId).toBe(nextOwner);
  });
  it("rejects foreign, duplicate and multi-Chief lists", async () => {
    for (const invalid of [
      [{ ...chief, ownerUserId: "foreign" }],
      [chief, chief],
      [chief, { ...chief, id: "22222222-2222-4222-8222-222222222222" }]
    ]) {
      const store = new AgentsStore({ list: async () => invalid } as never);
      store.setOwner(id, "local");
      await store.refresh();
      expect(store.current().agents).toEqual([]);
      expect(store.current().error).toMatch(/Invalid owner Agent list/);
    }
  });
  it("keeps the missing-default state explicit without inventing a Chief", async () => {
    const store = new AgentsStore({
      list: async () => [],
      ensureChief: async () => {
        throw new Error("conversations instance unavailable");
      }
    } as never);
    store.setOwner(id, "local");
    await store.refresh();
    expect(store.current().agents).toEqual([]);
    expect(store.current().selectedAgentId).toBeNull();
    expect(store.current().error).toContain(
      "conversations instance unavailable"
    );
  });
  it("never publishes a foreign Chief returned by bootstrap", async () => {
    const store = new AgentsStore({
      list: async () => [],
      ensureChief: async () => ({ ...chief, ownerUserId: "foreign" })
    } as never);
    store.setOwner(id, "local");
    await store.refresh();
    expect(store.current().agents).toEqual([]);
    expect(store.current().error).toMatch(/Invalid owner Agent list/);
  });
});
