import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Hq713Actor, Hq713Fixture } from "./hq713-fixture.js";

type Deck = {
  id: string;
  projectId: string;
  version: number;
  cards: { id: string; version: number; question: string; answer: string }[];
};
type Progress = {
  progress: {
    cardId: string;
    box: number;
    misses: number;
    nextAt: string | null;
  }[];
};

const asDeck = (body: unknown): Deck => {
  assert.ok(
    body && typeof body === "object",
    "Deck response must be an object"
  );
  const deck = body as Deck;
  assert.ok(typeof deck.id === "string" && Array.isArray(deck.cards));
  assert.ok(deck.cards.length > 0, "Shared Deck must have a Card");
  return deck;
};

/** Step 13 and I26: Team Card content is common, while progress is owner-local. */
export async function runHq713Decks(fixture: Hq713Fixture): Promise<void> {
  const { workspaceProjectId, alicePersonalProjectId, bobPersonalProjectId } =
    fixture.ids;
  const question = `HQ713 shared question ${randomUUID()}`;
  const answer = "Only this shared Deck carries the answer.";
  const created = await fixture.alice.team.request(
    "POST",
    `/v1/workspace-projects/${workspaceProjectId}/decks`,
    {
      body: {
        idempotencyKey: randomUUID(),
        title: "HQ713 shared study",
        scope: "landing",
        madeFrom: "Project material",
        cards: [{ question, answer }]
      },
      expectedStatus: 201
    }
  );
  const deck = asDeck(created.body);
  assert.equal(deck.projectId, workspaceProjectId);
  const card = deck.cards[0]!;
  const path = `/v1/workspace-projects/${workspaceProjectId}/decks/${deck.id}`;
  const aliceRead = asDeck(
    (await fixture.alice.team.request("GET", path, { expectedStatus: 200 }))
      .body
  );
  const bobRead = asDeck(
    (await fixture.bob.team.request("GET", path, { expectedStatus: 200 })).body
  );
  assert.deepEqual(bobRead.cards, aliceRead.cards);
  assert.equal(bobRead.cards[0]?.question, question);
  assert.equal(bobRead.cards[0]?.answer, answer);

  const progressPath = (projectId: string) =>
    `/v1/local-edge/projects/${projectId}/decks/${deck.id}`;
  const putProgress = async (
    actor: Hq713Actor,
    projectId: string,
    box: number,
    misses: number
  ) => {
    await actor.personalEdge.request(
      "PUT",
      `${progressPath(projectId)}/cards/${card.id}/progress`,
      { body: { box, misses, nextAt: null }, expectedStatus: 200 }
    );
  };
  const readProgress = async (actor: Hq713Actor, projectId: string) => {
    const response = await actor.personalEdge.request(
      "GET",
      `${progressPath(projectId)}/progress`,
      { expectedStatus: 200 }
    );
    return response.body as Progress;
  };
  await putProgress(fixture.alice, alicePersonalProjectId, 4, 0);
  await putProgress(fixture.bob, bobPersonalProjectId, 0, 1);
  const aliceProgress = await readProgress(
    fixture.alice,
    alicePersonalProjectId
  );
  const bobProgress = await readProgress(fixture.bob, bobPersonalProjectId);
  assert.deepEqual(aliceProgress.progress, [
    { cardId: card.id, box: 4, misses: 0, nextAt: null }
  ]);
  assert.deepEqual(bobProgress.progress, [
    { cardId: card.id, box: 0, misses: 1, nextAt: null }
  ]);
  assert.notDeepEqual(aliceProgress, bobProgress);

  // The first Again creates a source-backed proposal. The reviewer must store
  // it as a Me learning for this owner; it cannot become Team Deck content.
  const bobLearningId = await storeFirstAgainAsMeLearning(
    fixture,
    fixture.bob,
    bobPersonalProjectId,
    deck,
    card
  );
  const aliceLearningId = await storeFirstAgainAsMeLearning(
    fixture,
    fixture.alice,
    alicePersonalProjectId,
    deck,
    card
  );
  assert.notEqual(aliceLearningId, bobLearningId);
  const aliceOwn = await fixture.alice.personal.request(
    "GET",
    "/v1/memory/curated/assertions?scope=me&kind=learning",
    { expectedStatus: 200 }
  );
  const bobOwn = await fixture.bob.personal.request(
    "GET",
    "/v1/memory/curated/assertions?scope=me&kind=learning",
    { expectedStatus: 200 }
  );
  assert.ok(JSON.stringify(aliceOwn.body).includes(aliceLearningId));
  assert.ok(!JSON.stringify(aliceOwn.body).includes(bobLearningId));
  assert.ok(JSON.stringify(bobOwn.body).includes(bobLearningId));
  assert.ok(!JSON.stringify(bobOwn.body).includes(aliceLearningId));
  const unchangedAlice = await readProgress(
    fixture.alice,
    alicePersonalProjectId
  );
  assert.deepEqual(unchangedAlice, aliceProgress);
  const unchangedDeck = asDeck(
    (await fixture.alice.team.request("GET", path, { expectedStatus: 200 }))
      .body
  );
  assert.deepEqual(unchangedDeck.cards, aliceRead.cards);
  fixture.results.record("I713.13", {
    teamDeckId: deck.id,
    cardId: card.id,
    aliceProgress,
    bobProgress,
    aliceLearningId,
    bobLearningId,
    learningScope: "me"
  });
  fixture.results.record("I26", {
    teamDeckId: deck.id,
    separatePersonalProgress: true,
    firstAgainLearning: "me",
    ownerAssertionIds: [aliceLearningId, bobLearningId]
  });
}

async function storeFirstAgainAsMeLearning(
  fixture: Hq713Fixture,
  actor: Hq713Actor,
  personalProjectId: string,
  deck: Deck,
  card: Deck["cards"][number]
): Promise<string> {
  const learningPath = `/v1/local-edge/projects/${personalProjectId}/decks/${deck.id}/cards/${card.id}/learning`;
  let result = await actor.personalEdge.request("POST", learningPath, {
    body: {
      mode: "begin",
      expectedDeckVersion: deck.version,
      expectedCardVersion: card.version
    },
    expectedStatus: 200
  });
  for (
    let attempt = 0;
    attempt < 20 && !(result.body as { proposalId?: string }).proposalId;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = await actor.personalEdge.request("POST", learningPath, {
      body: {
        mode: "reconcile",
        expectedDeckVersion: deck.version,
        expectedCardVersion: card.version
      },
      expectedStatus: 200
    });
  }
  const proposalId = (result.body as { proposalId?: string }).proposalId;
  assert.ok(
    proposalId,
    "First Again did not produce a reviewable learning proposal"
  );

  const claimed = await actor.personalTokenClient.request(
    "POST",
    "/v1/memory/curated/proposals/claim-pending",
    { body: { proposal_id: proposalId, limit: 1 }, expectedStatus: 200 }
  );
  const reviews = (
    claimed.body as {
      reviews: Array<{
        proposal: { id: string; attemptCount: number };
        evidence: Array<{
          sourceType: "memory_event" | "conversation_item";
          sourceId: string;
          sourceHash: string;
        }>;
      }>;
    }
  ).reviews;
  assert.equal(reviews.length, 1);
  const review = reviews[0]!;
  assert.equal(review.proposal.id, proposalId);
  assert.ok(review.evidence.length > 0, "Again needs Personal source evidence");
  const evidence = review.evidence.map((item) => ({
    source_type: item.sourceType,
    source_id: item.sourceId,
    source_hash: item.sourceHash
  }));
  const accepted = await actor.personalTokenClient.request(
    "PATCH",
    `/v1/memory/curated/proposals/${proposalId}/review`,
    {
      body: {
        outcome: "accepted",
        operation: "store",
        attempt_count: review.proposal.attemptCount,
        evidence_revisions: evidence,
        selected_evidence_ids: review.evidence.map((item) => item.sourceId),
        candidate_assertion_ids: [],
        assertion_text: `Needs another look: ${card.question}`,
        kind: "learning",
        scope: "me",
        decision_reason: "The owner marked this Card Again.",
        reviewer_model: "hq713-fixture-review",
        reviewer_prompt_version: "deck-first-again-v1"
      },
      expectedStatus: 200
    }
  );
  const stored = (
    accepted.body as { proposal: { status: string; assertionId?: string } }
  ).proposal;
  assert.equal(stored.status, "stored");
  assert.ok(stored.assertionId);
  const listed = await actor.personal.request(
    "GET",
    "/v1/memory/curated/assertions?scope=me&kind=learning&include_sources=true",
    { expectedStatus: 200 }
  );
  assert.ok(
    JSON.stringify(listed.body).includes(stored.assertionId!),
    "Owner's Me learning is unavailable after review"
  );
  fixture.results.record(`I713.13.learning.${actor.name}`, {
    ownerUserId: actor.id,
    proposalId,
    assertionId: stored.assertionId,
    scope: "me",
    kind: "learning"
  });
  return stored.assertionId!;
}
