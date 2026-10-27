import { describe, expect, it } from "vitest";
import {
  assignEdition,
  collectionView,
  countPhoneAction,
  createGamificationStore,
  evaluateGamification,
  standings,
  wornLook,
  type GamificationFacts,
  type GamificationState
} from "./gamification.js";

const now = new Date("2026-10-28T09:00:00.000Z");
const daysAgo = (days: number) =>
  new Date(now.getTime() - days * 86_400_000).toISOString();

const chief = {
  id: "chief",
  name: "Cooper",
  isChiefOfStaff: true,
  createdAt: daysAgo(40)
};
const quinn = {
  id: "quinn",
  name: "Quinn",
  isChiefOfStaff: false,
  createdAt: daysAgo(3)
};

const facts = (
  finished: Record<string, string[]>,
  extra: Partial<GamificationFacts> = {}
): GamificationFacts => ({
  now,
  agents: [chief, quinn],
  finishedRuns: new Map(Object.entries(finished)),
  scheduledJobs: 1,
  remembered: 120,
  ...extra
});

const empty = (): GamificationState =>
  evaluateGamification(facts({}), {
    version: 1,
    initialized: false,
    counters: { unblocks: 0, asks: 0, chiefReplies: [], chiefRepliesTotal: 0 },
    agents: {},
    editions: {},
    worn: {}
  }).state;

describe("phone gamification", () => {
  it("needs both jobs and days for a rank, and says what's next", () => {
    const six = Array.from({ length: 6 }, (_, index) => daysAgo(6 - index));
    const map = standings(facts({ chief: six, quinn: six }), empty());
    expect(map.get("chief")).toMatchObject({
      rank: "Trusted hand",
      jobsFinished: 6,
      daysTogether: 40,
      toNext: "14 more jobs to Old hand"
    });
    // Six jobs but three days together: still Getting acquainted.
    expect(map.get("quinn")).toMatchObject({
      rank: "Getting acquainted",
      toNext: "11 more days together to Trusted hand"
    });
  });

  it("dates milestones from the jobs themselves", () => {
    const map = standings(facts({ quinn: [daysAgo(2), daysAgo(1)] }), empty());
    const milestones = map.get("quinn")!.milestones;
    expect(milestones[0]).toMatchObject({
      id: "first-job",
      earnedAt: daysAgo(2)
    });
    expect(milestones[1]).toMatchObject({
      id: "ten-jobs",
      earnedAt: null,
      remaining: "8 to go"
    });
    expect(milestones[2]).toMatchObject({
      id: "one-month",
      remaining: "in 27 days"
    });
  });

  it("records what was already true quietly, then announces what's new once", () => {
    const first = evaluateGamification(facts({ quinn: [daysAgo(1)] }), {
      version: 1,
      initialized: false,
      counters: {
        unblocks: 0,
        asks: 0,
        chiefReplies: [],
        chiefRepliesTotal: 0
      },
      agents: {},
      editions: {},
      worn: {}
    });
    expect(first.events).toEqual([]);
    expect(first.state.editions.graphite).toBeDefined();

    const later = evaluateGamification(
      facts({ quinn: [daysAgo(1)] }, { scheduledJobs: 3 }),
      first.state
    );
    expect(later.events).toEqual([
      { kind: "edition", editionId: "lumen", name: "Lumen" }
    ]);
    expect(
      evaluateGamification(
        facts({ quinn: [daysAgo(1)] }, { scheduledJobs: 3 }),
        later.state
      ).events
    ).toEqual([]);
  });

  it("counts the Chief's replies and the phone's unblocks and questions", () => {
    let state = empty();
    state = countPhoneAction(state, "chief_reply", now);
    for (let index = 0; index < 10; index++)
      state = countPhoneAction(state, "unblock", now);
    state = countPhoneAction(state, "ask", now);
    const result = evaluateGamification(facts({}), state);
    expect(result.events).toContainEqual({
      kind: "edition",
      editionId: "glass",
      name: "Glass"
    });
    expect(result.events).toContainEqual({
      kind: "milestone",
      agentId: "chief",
      agentName: "Cooper",
      title: "First job shipped"
    });
    const view = collectionView(facts({}), result.state);
    expect(view.agents[0]).toMatchObject({ agentId: "chief", jobsFinished: 1 });
    expect(
      view.editions.find((edition) => edition.id === "prism")
    ).toMatchObject({
      earned: false,
      memory: true,
      progress: { current: 1, target: 15 }
    });
  });

  it("gives an edition to one agent at a time and keeps the agent's own body", () => {
    let state = evaluateGamification(
      facts({ quinn: [daysAgo(1)] }),
      empty()
    ).state;
    expect(() => assignEdition(state, "goldie", "quinn")).toThrow(
      "isn't earned"
    );
    state = assignEdition(state, "graphite", "quinn");
    state = assignEdition(state, "graphite", "chief");
    expect(state.worn).toEqual({ graphite: "chief" });
    expect(standings(facts({}), state).get("chief")!.editionId).toBe(
      "graphite"
    );
    expect(
      wornLook({ seed: "cooper", body: { shape: "sphere" } }, "graphite")
    ).toEqual({
      seed: "cooper",
      body: { shape: "sphere" },
      palette: { base: "#8b9099", grayscale: true }
    });
  });

  it("keeps state in the secret store and survives a damaged record", async () => {
    const values = new Map<string, string>([
      ["koed-phone-gamification.v1", "{not json"]
    ]);
    const store = createGamificationStore({
      get: async (key) => values.get(key) ?? null,
      put: async (key, value) => void values.set(key, value),
      delete: async (key) => void values.delete(key)
    });
    expect((await store.read()).initialized).toBe(false);
    await store.update((state) => countPhoneAction(state, "ask", now));
    expect(
      JSON.parse(values.get("koed-phone-gamification.v1")!).counters.asks
    ).toBe(1);
  });
});
