import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceProjectPersonalClient } from "./workspace-project-personal-client.js";

const deck = {
  id: randomUUID(),
  title: "Midterm",
  scope: "Chapter 7",
  madeFrom: "Notes",
  createdByAgentId: null,
  cards: [
    {
      id: randomUUID(),
      question: "Q?",
      answer: "A.",
      sourceRef: null,
      topicLabel: null
    }
  ]
};
const load = (snapshot: unknown) =>
  createWorkspaceProjectPersonalClient(
    async () => ({ snapshot, manifestHash: "a".repeat(64) }),
    () => "Koed-Device fixture"
  ).loadPersonalCopy(
    randomUUID(),
    "team-fixture",
    "share-attempt",
    randomUUID(),
    randomUUID()
  );
const snapshot = {
  personalProjectVersion: 1,
  workItems: [],
  sources: [],
  decks: [deck]
};

describe("Personal Project copy snapshot", () => {
  it("loads the complete local snapshot without a Team target version", async () => {
    await expect(load(snapshot)).resolves.toEqual(snapshot);
  });
  it("preserves duplicate Deck and Card rejection after deriving the local shape", async () => {
    await expect(load({ ...snapshot, decks: [deck, deck] })).rejects.toThrow(
      /Duplicate source Deck ID/
    );
    await expect(
      load({
        ...snapshot,
        decks: [{ ...deck, cards: [deck.cards[0], deck.cards[0]] }]
      })
    ).rejects.toThrow(/Duplicate source Card ID/);
  });
  it("rejects an unreviewed Team target version in a local snapshot", async () => {
    await expect(load({ ...snapshot, expectedVersion: 1 })).rejects.toThrow();
  });
});

describe("joined Team Project Personal link", () => {
  it("uses one owner-scoped create key and confirms exact Team identity", async () => {
    const workspaceProjectId = randomUUID();
    const personalProjectId = randomUUID();
    const project = {
      id: personalProjectId,
      name: "Joined Project",
      key: "JOIN",
      folderPath: null,
      lifecycle: "active",
      deletionPhase: null,
      deleteBatchId: null,
      deletedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      teamBackendId: null,
      teamWorkspaceId: null,
      workspaceProjectId: null
    };
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const sendPersonal = vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path === "/v1/projects") return project;
      if (path.endsWith("workspace-project-join-confirm"))
        return { projectId: personalProjectId, version: 2, linked: true };
      return {
        ...project,
        version: 2,
        teamBackendId: "team-backend",
        teamWorkspaceId: randomUUID(),
        workspaceProjectId
      };
    });
    const client = createWorkspaceProjectPersonalClient(
      sendPersonal,
      () => "Koed-Device team-proof"
    );
    const created = await client.createJoinedProject(
      workspaceProjectId,
      "team-backend",
      "Joined Project"
    );
    await client.createJoinedProject(
      workspaceProjectId,
      "team-backend",
      "Joined Project"
    );
    expect(created.id).toBe(personalProjectId);
    const firstCreate = JSON.parse(String(calls[0]?.init?.body));
    const secondCreate = JSON.parse(String(calls[1]?.init?.body));
    expect(firstCreate.idempotencyKey).toBe(secondCreate.idempotencyKey);
    expect(firstCreate.idempotencyKey).not.toContain(workspaceProjectId);
    const linked = await client.confirmJoinedProject(
      personalProjectId,
      workspaceProjectId,
      "team-backend",
      created.version
    );
    expect(linked.workspaceProjectId).toBe(workspaceProjectId);
    expect(calls[2]?.init?.headers).toMatchObject({
      "x-koed-team-client-credential": "Koed-Device team-proof"
    });
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      expectedPersonalProjectVersion: 1,
      teamBackendId: "team-backend",
      workspaceProjectId
    });
  });
});
