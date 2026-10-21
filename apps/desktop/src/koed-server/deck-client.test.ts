import { describe, expect, it, vi } from "vitest";
import { createDeckClient } from "./deck-client.js";

const projectId = "00000000-0000-4000-8000-000000000801";
const deckId = "00000000-0000-4000-8000-000000000802";
const cardId = "00000000-0000-4000-8000-000000000803";
const stamp = "2026-10-21T10:00:00.000Z";
const project = {
  id: projectId,
  name: "Econ 101",
  key: "ECON",
  folderPath: null,
  lifecycle: "active",
  deletionPhase: null,
  deleteBatchId: null,
  deletedAt: null,
  createdAt: stamp,
  updatedAt: stamp,
  version: 1,
  teamBackendId: null,
  teamWorkspaceId: null,
  workspaceProjectId: null
};
const deck = {
  id: deckId,
  projectId,
  title: "Midterm",
  scope: "Chapters 1–6",
  madeFrom: "course pack",
  createdByAgentId: null,
  uses: 0,
  version: 1,
  createdAt: stamp,
  updatedAt: stamp,
  cards: [
    {
      id: cardId,
      deckId,
      question: "What is opportunity cost?",
      answer: "The next best alternative.",
      sourceRef: null,
      topicLabel: null,
      version: 1,
      createdAt: stamp,
      updatedAt: stamp
    }
  ]
};
const authority = {
  key: "profile:owner",
  ownerId: projectId,
  apiOrigin: "http://localhost",
  authorization: "Koed-Desktop test",
  canWrite: true
};
const hq = {
  project,
  sections: Object.fromEntries(
    ["conversations", "workItems", "sources", "decks", "scheduledJobs"].map(
      (key) => [key, { availability: "not_implemented" }]
    )
  )
};

describe("Deck client", () => {
  it("establishes first-Again learning before Personal progress write and retries without a new intent", async () => {
    const calls: string[] = [];
    let progress = {
      progress: [] as Array<{
        cardId: string;
        box: number;
        misses: number;
        nextAt: string | null;
      }>
    };
    const sendPersonal = vi.fn(
      async (path: string, init?: RequestInit): Promise<unknown> => {
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path.endsWith("/hq")) return hq;
        if (path.endsWith(`/decks/${deckId}`)) return deck;
        if (path.endsWith("/deck-progress")) return progress;
        if (path.endsWith("/learning")) return { status: "pending" };
        if (path.endsWith("/progress") && init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as {
            box: number;
            misses: number;
            nextAt: string;
          };
          progress = { progress: [{ cardId, ...body }] };
          return { cardId, ...body };
        }
        throw new Error(`Unexpected ${path}`);
      }
    );
    const client = createDeckClient({
      authority: async () => authority,
      sendPersonal,
      sendTeam: async () => {
        throw new Error("Team not used");
      },
      teamCredential: () => "unused",
      now: () => new Date(stamp)
    });
    await expect(
      client({
        operation: "grade",
        projectId,
        deckId,
        cardId,
        rating: "again",
        expectedBox: 0,
        expectedMisses: 0,
        expectedDeckVersion: 1,
        expectedCardVersion: 1
      })
    ).resolves.toMatchObject({
      learningStatus: "pending",
      value: { misses: 1, box: 0 }
    });
    expect(calls.findIndex((call) => call.endsWith("/learning"))).toBeLessThan(
      calls.findIndex((call) => call.startsWith("PUT"))
    );
    await expect(
      client({ operation: "learning", projectId, deckId, cardId })
    ).resolves.toMatchObject({ status: "pending" });
    const learningBodies = sendPersonal.mock.calls
      .filter((call) => call[0].endsWith("/learning"))
      .map((call) => JSON.parse(String(call[1]?.body)));
    expect(learningBodies).toEqual([
      { mode: "begin", expectedDeckVersion: 1, expectedCardVersion: 1 },
      { mode: "reconcile", expectedDeckVersion: 1, expectedCardVersion: 1 }
    ]);
  });

  it("rejects Project profile changes before any grade write", async () => {
    let reads = 0;
    const sendPersonal = vi.fn(async (path: string): Promise<unknown> => {
      if (path.endsWith("/hq")) return hq;
      if (path.endsWith(`/decks/${deckId}`)) return deck;
      if (path.endsWith("/deck-progress")) return { progress: [] };
      throw new Error("unexpected write");
    });
    const client = createDeckClient({
      authority: async () => ({
        ...authority,
        key: ++reads > 3 ? "other" : authority.key
      }),
      sendPersonal,
      sendTeam: async () => null,
      teamCredential: () => "unused"
    });
    await expect(
      client({
        operation: "grade",
        projectId,
        deckId,
        cardId,
        rating: "good",
        expectedBox: 0,
        expectedMisses: 0,
        expectedDeckVersion: 1,
        expectedCardVersion: 1
      })
    ).rejects.toThrow(/profile changed/);
    expect(
      (sendPersonal.mock.calls as [string, RequestInit?][]).every(
        ([, init]) => !init || init.method !== "PUT"
      )
    ).toBe(true);
  });

  it("fails closed when a linked Team Card is revoked before progress write", async () => {
    const workspaceId = "00000000-0000-4000-8000-000000000804";
    const linkedProject = {
      ...project,
      teamBackendId: "team-backend",
      teamWorkspaceId: "00000000-0000-4000-8000-000000000805",
      workspaceProjectId: workspaceId
    };
    const sendPersonal = vi.fn(
      async (path: string, init?: RequestInit): Promise<unknown> => {
        if (path.endsWith("/hq")) return { ...hq, project: linkedProject };
        if (path.endsWith("/progress") && !init) return { progress: [] };
        throw new Error("unexpected Personal write");
      }
    );
    let teamReads = 0;
    const client = createDeckClient({
      authority: async () => authority,
      sendPersonal,
      sendTeam: async () => {
        if (++teamReads > 1) throw new Error("Team read revoked");
        return { ...deck, projectId: workspaceId };
      },
      teamCredential: () => "Team credential"
    });
    await expect(
      client({
        operation: "grade",
        projectId,
        deckId,
        cardId,
        rating: "good",
        expectedBox: 0,
        expectedMisses: 0,
        expectedDeckVersion: 1,
        expectedCardVersion: 1
      })
    ).rejects.toThrow(/Team read revoked/);
    expect(
      sendPersonal.mock.calls.every(([, init]) => init?.method !== "PUT")
    ).toBe(true);
  });

  it("rejects a Card revision change before saving a grade", async () => {
    let deckReads = 0;
    const sendPersonal = vi.fn(
      async (path: string, init?: RequestInit): Promise<unknown> => {
        if (path.endsWith("/hq")) return hq;
        if (path.endsWith(`/decks/${deckId}`))
          return ++deckReads === 1
            ? deck
            : {
                ...deck,
                version: 2,
                cards: [{ ...deck.cards[0], version: 2 }]
              };
        if (path.endsWith("/deck-progress")) return { progress: [] };
        throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
      }
    );
    const client = createDeckClient({
      authority: async () => authority,
      sendPersonal,
      sendTeam: async () => null,
      teamCredential: () => "unused"
    });
    await expect(
      client({
        operation: "grade",
        projectId,
        deckId,
        cardId,
        rating: "easy",
        expectedBox: 0,
        expectedMisses: 0,
        expectedDeckVersion: 1,
        expectedCardVersion: 1
      })
    ).rejects.toThrow(/Card changed/);
    expect(
      sendPersonal.mock.calls.every(([, init]) => init?.method !== "PUT")
    ).toBe(true);
  });

  it("does not begin learning when the shown Card version is already stale", async () => {
    const sendPersonal = vi.fn(
      async (path: string, init?: RequestInit): Promise<unknown> => {
        if (path.endsWith("/hq")) return hq;
        if (path.endsWith(`/decks/${deckId}`))
          return {
            ...deck,
            version: 2,
            cards: [{ ...deck.cards[0], question: "Unseen edit", version: 2 }]
          };
        throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
      }
    );
    const client = createDeckClient({
      authority: async () => authority,
      sendPersonal,
      sendTeam: async () => null,
      teamCredential: () => "unused"
    });
    await expect(
      client({
        operation: "grade",
        projectId,
        deckId,
        cardId,
        rating: "again",
        expectedBox: 0,
        expectedMisses: 0,
        expectedDeckVersion: 1,
        expectedCardVersion: 1
      })
    ).rejects.toThrow(/shown/);
    expect(
      sendPersonal.mock.calls.every(([path]) => !path.endsWith("/learning"))
    ).toBe(true);
  });
});
