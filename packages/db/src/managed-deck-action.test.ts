import { describe, expect, it } from "vitest";
import {
  deckCreateFromTextAction,
  deckMatchesTextAction,
  teamDeckTextActionHash,
  teamDeckCreateFromTextAction
} from "./managed-deck-action.js";

const actionId = "90fd9cee-d5b1-4dda-9675-c044e4613ed7";
const agentId = "2a3c3ff6-ac92-4a5c-88d5-f412c5d831b5";
const projectId = "aad0a71b-041f-4ce5-93e0-79990eb995f3";

describe("reviewed flashcard payload", () => {
  it("derives the idempotency key and Agent from trusted action state", () => {
    const payload = deckCreateFromTextAction(
      actionId,
      {
        projectId,
        title: "Chapter 7",
        scope: "exclude non-midterm topics",
        madeFrom: "Syllabus",
        cards: [{ question: "Q", answer: "A [m:1]" }]
      },
      agentId
    );
    expect(payload.idempotencyKey).toBe(actionId);
    expect(payload.createdByAgentId).toBe(agentId);
    expect(payload.scope).toContain("exclude");
    const card = {
      id: actionId,
      deckId: actionId,
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      question: "Q",
      answer: "A [m:1]",
      sourceRef: null,
      topicLabel: null
    };
    const deck = {
      id: actionId,
      projectId,
      title: payload.title,
      scope: payload.scope,
      madeFrom: payload.madeFrom,
      createdByAgentId: agentId,
      uses: 0,
      version: 1,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
      cards: [card]
    };
    expect(deckMatchesTextAction(deck, payload, projectId, false)).toBe(true);
    expect(
      deckMatchesTextAction(
        { ...deck, cards: [{ ...card, answer: "changed" }] },
        payload,
        projectId,
        false
      )
    ).toBe(false);
    expect(
      deckMatchesTextAction(
        { ...deck, createdByAgentId: null },
        payload,
        projectId,
        true
      )
    ).toBe(true);
  });
  it("binds a Team receipt to the private nonce, principal, backend and exact payload", () => {
    const payload = teamDeckCreateFromTextAction(actionId, {
      projectId,
      title: "Midterm",
      scope: "Only chapters 1–3",
      madeFrom: "Course notes",
      cards: [{ question: "Q", answer: "A" }]
    });
    const proof = {
      actionId,
      teamBackendId: "backend-a",
      workspaceProjectId: projectId,
      teamUserId: agentId,
      runnerDeviceId: "device-a",
      deviceCredentialKeyId: "credential-a",
      operationFamily: "team_workspace_write" as const,
      payload,
      nonce: "A".repeat(43)
    };
    const hash = teamDeckTextActionHash(proof);
    expect(payload).not.toHaveProperty("createdByAgentId");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(teamDeckTextActionHash(proof)).toBe(hash);
    for (const changed of [
      { ...proof, nonce: "B".repeat(43) },
      { ...proof, teamUserId: actionId },
      { ...proof, teamBackendId: "backend-b" },
      { ...proof, runnerDeviceId: "device-b" },
      { ...proof, deviceCredentialKeyId: "credential-b" },
      { ...proof, payload: { ...payload, scope: "Final exam" } }
    ])
      expect(teamDeckTextActionHash(changed)).not.toBe(hash);
  });
});
