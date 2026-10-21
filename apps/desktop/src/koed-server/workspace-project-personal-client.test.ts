import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
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
