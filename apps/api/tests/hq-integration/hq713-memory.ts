import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadPersonalCuratedSharedSourceMaterial } from "@koed/db";

import type { Hq713Actor, Hq713Fixture } from "./hq713-fixture.js";

export interface Hq713SharedSession {
  sessionId: string;
  logicalMemoryId: string;
  grantId: string;
  sourceItemIds: string[];
  sourceRevision: number;
  summaryText: string;
}

const record = (value: unknown, label: string): Record<string, unknown> => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  return value as Record<string, unknown>;
};

const list = (value: unknown, label: string): unknown[] => {
  assert.ok(Array.isArray(value), label);
  return value;
};

const nonemptyString = (value: unknown, label: string): string => {
  assert.ok(typeof value === "string", label);
  assert.ok(value.length > 0, label);
  return value;
};

const teamGrantPath = (fixture: Hq713Fixture, grantId: string) =>
  `/v1/shared-memory/teams/${fixture.ids.teamId}/workspaces/${fixture.ids.workspaceId}/share-grants/${grantId}`;

export const answerTeam = async (
  fixture: Hq713Fixture,
  actor: Hq713Actor,
  query: string,
  stage?: "scoped_leaf_search" | "curated_memory_search"
) => {
  const response = await actor.team.request("POST", "/v1/memory/answer", {
    body: {
      query,
      search_domain: "global",
      team_workspace_id: fixture.ids.workspaceId,
      ...(stage ? { retrieval_stage: stage } : {})
    },
    expectedStatus: 200
  });
  return record(response.body, "Team Memory Answer response");
};

/** Persist one genuine Team answer through its frozen-authority task lifecycle. */
export async function persistHq713TeamQuestion(
  fixture: Hq713Fixture,
  actor: Hq713Actor,
  answer: Record<string, unknown>,
  query: string
): Promise<string> {
  const accepted = await actor.team.request("POST", "/v1/memory/answer-tasks", {
    body: {
      origin: "mcp",
      invocation_key: `hq713-question-${randomUUID()}`,
      request: {
        input: {
          query,
          search_domain: "global",
          team_workspace_id: fixture.ids.workspaceId,
          team_backend_id: fixture.teamBackendId,
          include_evidence: true
        },
        caller: { cwd: "" }
      },
      max_queued: 16
    },
    expectedStatus: 200
  });
  const taskId = nonemptyString(
    record(record(accepted.body, "accepted Team task").task, "accepted task")
      .id,
    "accepted task ID"
  );
  const leaseOwner = `hq713-task-${randomUUID()}`;
  const claimed = await actor.team.request(
    "POST",
    "/v1/memory/answer-tasks/claim",
    {
      body: {
        scope_filter: "team",
        task_id: taskId,
        lease_owner: leaseOwner,
        lease_ms: 180_000
      },
      expectedStatus: 200
    }
  );
  const task = record(
    record(claimed.body, "claimed Team task").task,
    "leased task"
  );
  assert.equal(task.id, taskId);
  assert.equal(record(task.executionAuthority, "task authority").scope, "team");
  const fenceGeneration = task.fenceGeneration;
  assert.ok(typeof fenceGeneration === "number" && fenceGeneration > 0);
  const markdown = nonemptyString(answer.markdown, "answer markdown");
  const completed = await actor.team.request(
    "POST",
    `/v1/memory/answer-tasks/${taskId}/complete`,
    {
      body: {
        lease_owner: leaseOwner,
        fence_generation: fenceGeneration,
        final_question: {
          idempotency_key: `hq713-final-${randomUUID()}`,
          query,
          origin: "mcp_memory_answer",
          retrieval_scope: "personal",
          team_workspace_id: fixture.ids.workspaceId,
          search_domain: "global",
          status: "answered",
          answer_markdown: markdown,
          evidence: answer.evidence,
          citations: answer.citations,
          retrieval: answer.retrieval
        },
        result: { markdown }
      },
      expectedStatus: 200
    }
  );
  const finalTask = record(
    record(completed.body, "completed Team task").task,
    "completed task"
  );
  assert.equal(finalTask.status, "completed");
  return nonemptyString(finalTask.questionId, "frozen Team question ID");
}

export const teamEvidenceForGrant = (
  answer: Record<string, unknown>,
  grantId: string
) =>
  list(answer.evidence, "Team evidence")
    .map((entry) => record(entry, "Team evidence item"))
    .filter((entry) => {
      const provenance = record(
        entry.visibilityProvenance,
        "Team visibility provenance"
      );
      return provenance.shareGrantId === grantId;
    });

/** Observe the real Team embedding worker before asserting semantic recall. */
export async function waitForHq713TeamEmbedding(
  fixture: Hq713Fixture,
  grantId: string,
  representation: "lcm_leaves" | "curated_assertions"
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await fixture.team.db.query<{
      embedding_state: string;
      count: string;
    }>(
      `select item.embedding_state,count(*)::text as count
         from team_memory_semantic_items item
         join team_memory_representations representation
           on representation.id=item.representation_id
        where item.share_grant_id=$1 and representation.representation=$2
        group by item.embedding_state`,
      [grantId, representation]
    );
    const embedded = state.rows.find(
      (row) => row.embedding_state === "embedded"
    );
    if (embedded && Number(embedded.count) > 0) return;
    assert.ok(
      !state.rows.some((row) => row.embedding_state === "failed"),
      `Team ${representation} embedding failed`
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.fail(`Team ${representation} embedding did not become searchable`);
}

/** Alice's owned Conversation reaches Bob only through an exact summary grant. */
export async function runHq713MemoryStep3(
  fixture: Hq713Fixture,
  existing?: Hq713SharedSession
): Promise<Hq713SharedSession> {
  const shared =
    existing ??
    (await (async (): Promise<Hq713SharedSession> => {
      const marker = `hq713-summary-${randomUUID()}`;
      const captured = await fixture.seedCapturedSession(fixture.alice, {
        projectId: fixture.ids.alicePersonalProjectId,
        sessionLabel: marker
      });
      const published = await fixture.shareCapturedSession(fixture.alice, {
        sessionId: captured.sessionId,
        workspaceProjectId: fixture.ids.workspaceProjectId,
        teamWorkspaceId: fixture.ids.workspaceId,
        summaryText: marker,
        includeCuratedMemory: false
      });
      return { ...captured, ...published, summaryText: marker };
    })());
  const marker = shared.summaryText;
  await waitForHq713TeamEmbedding(fixture, shared.grantId, "lcm_leaves");
  const answer = await answerTeam(
    fixture,
    fixture.bob,
    marker,
    "scoped_leaf_search"
  );
  const evidence = teamEvidenceForGrant(answer, shared.grantId);
  assert.ok(evidence.length > 0, "Bob must recall Alice's published summary");
  assert.ok(
    evidence.some((item) => String(item.summaryText).includes(marker)),
    "Bob's recalled summary must be the published source"
  );
  assert.ok(
    evidence.every((item) => item.visibility === "team"),
    "Shared evidence must carry Team visibility"
  );
  const citations = list(answer.citations, "Team citations").map((item) =>
    record(item, "Team citation")
  );
  assert.ok(
    citations.some((citation) => citation.visibility === "team"),
    "Bob must receive a Team citation"
  );
  const summary = await fixture.bob.team.request(
    "GET",
    `${teamGrantPath(fixture, shared.grantId)}?representation=lcm_leaves`,
    { expectedStatus: 200 }
  );
  assert.ok(record(summary.body, "scoped grant read").sharedMemory);
  const transcript = await fixture.bob.team.request(
    "GET",
    `/v1/shared-memory/share-grants/${shared.grantId}/transcript/manifest`,
    {}
  );
  assert.ok(
    [403, 404].includes(transcript.status),
    `N2: summary sharing exposed Conversation Source Access (${transcript.status})`
  );
  fixture.results.record("I713.3", {
    summaryFound: true,
    teamCitationCount: citations.length,
    grantId: shared.grantId
  });
  return shared;
}

/** Policy issuance never attaches separately authorized source access. */
export async function runHq713MemoryN2(
  fixture: Hq713Fixture
): Promise<Hq713SharedSession> {
  const policyMarker = `hq713-policy-${randomUUID()}`;
  const captured = await fixture.seedCapturedSession(fixture.alice, {
    projectId: fixture.ids.alicePersonalProjectId,
    sessionLabel: policyMarker
  });
  const policy = await fixture.shareCapturedSessionViaProjectPolicy(
    fixture.alice,
    {
      sessionId: captured.sessionId,
      workspaceProjectId: fixture.ids.workspaceProjectId,
      teamWorkspaceId: fixture.ids.workspaceId,
      summaryText: policyMarker
    }
  );
  await waitForHq713TeamEmbedding(fixture, policy.grantId, "lcm_leaves");
  const summary = await fixture.bob.team.request(
    "GET",
    `${teamGrantPath(fixture, policy.grantId)}?representation=lcm_leaves`,
    { expectedStatus: 200 }
  );
  const policyRead = record(summary.body, "policy grant read");
  assert.ok(policyRead.sharedMemory);
  assert.ok(
    JSON.stringify(policyRead.sharedMemory).includes(policyMarker),
    "N2: Policy grant must publish the exact captured summary"
  );
  const transcript = await fixture.bob.team.request(
    "GET",
    `/v1/shared-memory/share-grants/${policy.grantId}/transcript/manifest`
  );
  assert.ok(
    [403, 404].includes(transcript.status),
    `N2: Project Share Policy exposed Conversation Source Access (${transcript.status})`
  );
  const sourceAccessRows = await fixture.team.db.query<{ count: string }>(
    `select count(*)::text as count from team_conversation_source_grants where share_grant_id=$1`,
    [policy.grantId]
  );
  assert.equal(
    Number(sourceAccessRows.rows[0]?.count),
    0,
    "N2: Project Share Policy created Conversation Source Access"
  );
  fixture.results.record("N2", {
    policyGrantId: policy.grantId,
    transcriptStatus: transcript.status,
    sourceAccessGrantCount: 0
  });
  return { ...captured, ...policy, summaryText: policyMarker };
}

/** Making a Conversation private withdraws its policy grant before recall returns. */
export async function runHq713MemoryStep6(
  fixture: Hq713Fixture,
  shared: Hq713SharedSession
): Promise<void> {
  await fixture.makeChatPrivate(fixture.alice, {
    sessionId: shared.sessionId,
    grantId: shared.grantId,
    projectId: fixture.ids.alicePersonalProjectId
  });
  const scoped = await fixture.bob.team.request(
    "GET",
    `${teamGrantPath(fixture, shared.grantId)}?representation=lcm_leaves`,
    {}
  );
  assert.ok(
    [403, 404].includes(scoped.status),
    `Bob retained access to a private Conversation (${scoped.status})`
  );
  const answer = await answerTeam(fixture, fixture.bob, shared.summaryText);
  assert.equal(
    teamEvidenceForGrant(answer, shared.grantId).length,
    0,
    "Revoked grant must leave Bob's recall"
  );
  fixture.results.record("I713.6", {
    revokedReadStatus: scoped.status,
    absentFromRecall: true
  });
}

/** A caller cannot issue a grant over another member's source Session. */
export async function runHq713MemoryN5(fixture: Hq713Fixture): Promise<void> {
  const bobSource = await fixture.seedCapturedSession(fixture.bob, {
    projectId: fixture.ids.bobPersonalProjectId,
    sessionLabel: `hq713-other-owner-${randomUUID()}`
  });
  const attempted = await fixture.attemptShareCapturedSessionAs(fixture.alice, {
    ownerActor: fixture.bob,
    sessionId: bobSource.sessionId,
    workspaceProjectId: fixture.ids.workspaceProjectId,
    teamWorkspaceId: fixture.ids.workspaceId
  });
  const denied = record(attempted.body, "N5 owner command result");
  assert.equal(attempted.status, 200, "Personal command protocol response");
  assert.equal(denied.ok, false, "Alice must not preview Bob's source");
  const error = record(denied.error, "N5 safe error");
  assert.ok(
    ["not_available", "access_revoked"].includes(String(error.code)),
    `N5: Alice acquired a grant over Bob's source (${String(error.code)})`
  );
  const grants = await fixture.team.db.query<{ count: string }>(
    `select count(*)::text as count from team_memory_share_grants
      where logical_memory_id=$1 and owner_user_id=$2`,
    [bobSource.logicalMemoryId, fixture.alice.teamUserId]
  );
  assert.equal(
    Number(grants.rows[0]?.count),
    0,
    "Alice created a grant for Bob's source"
  );
  fixture.results.record("N5", {
    deniedCode: error.code,
    createdGrantCount: 0
  });
}

/** Curated consent admits only complete exact-Session Project provenance. */
export async function runHq713MemoryStep12(
  fixture: Hq713Fixture
): Promise<{ grantId: string; positiveAssertionId: string }> {
  const {
    prepareHq713PriorSummaryGrants,
    optInHq713CuratedPolicies,
    assertHq713PriorSummaryGrantsAfterOptIn
  } = await import("./hq713-curated-policy.js");
  const prior = await prepareHq713PriorSummaryGrants(fixture);
  assert.ok(prior.active.sourceItemIds.length >= 2);
  const preExistingCurated = await fixture.seedCuratedAssertion(fixture.bob, {
    projectId: fixture.ids.bobPersonalProjectId,
    scope: "project",
    text: `${prior.active.marker}-curated-without-source-consent`,
    sourceItemIds: prior.active.sourceItemIds.slice(0, 2)
  });
  const policyOptIns = await optInHq713CuratedPolicies(fixture);
  const preserved = await assertHq713PriorSummaryGrantsAfterOptIn(
    fixture,
    prior,
    `${prior.active.marker}-curated-without-source-consent`
  );
  assert.ok(preExistingCurated.assertionId);
  const prefix = `hq713-curated-${randomUUID()}`;
  const inside = await fixture.seedCapturedSession(fixture.bob, {
    projectId: fixture.ids.bobPersonalProjectId,
    sessionLabel: `${prefix}-inside`,
    sourceItemCount: 2
  });
  const outside = await fixture.seedCapturedSession(fixture.bob, {
    projectId: fixture.ids.bobPersonalProjectId,
    sessionLabel: `${prefix}-outside`
  });
  assert.ok(
    inside.sourceItemIds.length >= 2,
    "Curated positive needs two direct sources"
  );
  assert.ok(
    outside.sourceItemIds.length >= 1,
    "Mixed source needs another Session"
  );
  const insideFirst = inside.sourceItemIds[0];
  const outsideFirst = outside.sourceItemIds[0];
  assert.ok(insideFirst && outsideFirst, "Mixed source Session items");
  const labels = {
    positive: `${prefix}-project-complete`,
    me: `${prefix}-me`,
    unscoped: `${prefix}-unscoped`,
    mixed: `${prefix}-mixed`,
    nonConversation: `${prefix}-non-conversation`
  };
  const positive = await fixture.seedCuratedAssertion(fixture.bob, {
    projectId: fixture.ids.bobPersonalProjectId,
    scope: "project",
    text: labels.positive,
    sourceItemIds: inside.sourceItemIds.slice(0, 2)
  });
  await fixture.seedCuratedAssertion(fixture.bob, {
    projectId: fixture.ids.bobPersonalProjectId,
    scope: "me",
    text: labels.me,
    sourceItemIds: inside.sourceItemIds.slice(0, 1)
  });
  await fixture.seedCuratedAssertion(fixture.bob, {
    projectId: fixture.ids.bobPersonalProjectId,
    scope: "unscoped",
    text: labels.unscoped,
    sourceItemIds: inside.sourceItemIds.slice(0, 1)
  });
  await fixture.seedCuratedAssertion(fixture.bob, {
    projectId: fixture.ids.bobPersonalProjectId,
    scope: "project",
    text: labels.mixed,
    sourceItemIds: [insideFirst, outsideFirst]
  });
  await fixture.seedCuratedAssertion(fixture.bob, {
    projectId: fixture.ids.bobPersonalProjectId,
    scope: "project",
    text: labels.nonConversation,
    sourceItemIds: inside.sourceItemIds.slice(0, 1),
    includeNonConversationSource: true
  });
  const ownerDerived = await loadPersonalCuratedSharedSourceMaterial(
    fixture.personalDb(fixture.bob),
    fixture.personalEncryptionProvider,
    {
      ownerUserId: fixture.bob.id,
      logicalMemoryId: inside.logicalMemoryId,
      sourceSessionId: inside.sessionId,
      sourceRevision: inside.sourceRevision,
      teamBackendId: fixture.teamBackendId,
      teamWorkspaceId: fixture.ids.workspaceId,
      requirePersistedRevision: false
    }
  );
  assert.equal(ownerDerived.items.length, 1);
  assert.equal(ownerDerived.provenance[0]?.assertionId, positive.assertionId);
  assert.equal(ownerDerived.provenance[0]?.directSources.length, 2);
  for (const item of ownerDerived.items) {
    assert.equal(
      "expansionItems" in item.content,
      false,
      "Signed Curated Team material must not carry direct-source text"
    );
  }
  const shared = await fixture.shareCapturedSession(fixture.bob, {
    sessionId: inside.sessionId,
    projectBoundCuratedDenialProjectId: fixture.ids.workspaceProjectId,
    teamWorkspaceId: fixture.ids.workspaceId,
    summaryText: `${prefix}-inside`,
    includeCuratedMemory: true
  });
  assert.equal(
    shared.projectBoundCuratedRejected,
    true,
    "Project-bound Curated consent must fail before Workspace consent"
  );
  await waitForHq713TeamEmbedding(
    fixture,
    shared.grantId,
    "curated_assertions"
  );
  const summaryRead = await fixture.alice.team.request(
    "GET",
    `${teamGrantPath(fixture, shared.grantId)}?representation=lcm_leaves`,
    { expectedStatus: 200 }
  );
  assert.ok(
    JSON.stringify(record(summaryRead.body, "Bob summary read")).includes(
      `${prefix}-inside`
    ),
    "Alice must see Bob's separately shared summary"
  );
  const curatedRead = await fixture.alice.team.request(
    "GET",
    `${teamGrantPath(fixture, shared.grantId)}?representation=curated_assertions`,
    { expectedStatus: 200 }
  );
  const sharedMemory = record(
    record(curatedRead.body, "Curated read").sharedMemory,
    "Shared Memory"
  );
  const items = list(sharedMemory.items, "Curated shared items");
  const material = JSON.stringify(items);
  assert.ok(
    material.includes(labels.positive),
    "Complete Project assertion must be shared"
  );
  for (const excluded of [
    labels.me,
    labels.unscoped,
    labels.mixed,
    labels.nonConversation
  ]) {
    assert.ok(
      !material.includes(excluded),
      `${excluded} leaked into Team Curated representation`
    );
  }
  const answer = await answerTeam(
    fixture,
    fixture.alice,
    labels.positive,
    "curated_memory_search"
  );
  const evidence = teamEvidenceForGrant(answer, shared.grantId);
  assert.ok(
    evidence.some((item) => String(item.summaryText).includes(labels.positive)),
    "Alice must recall the positive Curated assertion"
  );
  const recalled = JSON.stringify(evidence);
  for (const excluded of [
    labels.me,
    labels.unscoped,
    labels.mixed,
    labels.nonConversation
  ]) {
    assert.ok(
      !recalled.includes(excluded),
      `${excluded} leaked into Team recall`
    );
    const negativeAnswer = await answerTeam(
      fixture,
      fixture.alice,
      excluded,
      "curated_memory_search"
    );
    assert.ok(
      !JSON.stringify(negativeAnswer.evidence).includes(excluded),
      `${excluded} became independently recallable in Team Memory`
    );
  }
  fixture.results.record("I713.12", {
    grantId: shared.grantId,
    positiveCuratedCount: evidence.length,
    excludedClasses: 4
  });
  fixture.results.record("I27", {
    exactSessionDirectSources: 2,
    positiveShared: true,
    mixedSessionExcluded: true
  });
  fixture.results.record("N8", {
    positiveShared: true,
    administratorOptIns: policyOptIns,
    separateSourceOwnerStepUp: true,
    projectBoundCuratedRejected: true,
    priorSummaryGrants: preserved,
    meExcluded: true,
    unscopedExcluded: true,
    mixedExcluded: true,
    nonConversationExcluded: true
  });
  return { grantId: shared.grantId, positiveAssertionId: positive.assertionId };
}

/** Classification commits only after the Team copy and semantic vector withdraw. */
export async function runHq713MemoryScopeChangeControl(
  fixture: Hq713Fixture,
  input: { grantId: string; positiveAssertionId: string }
): Promise<void> {
  const beforeUpdate = await fixture.team.db.query<{
    source_revision: string;
    curated_source_update_receipt: Record<string, unknown> | null;
  }>(
    `select source_revision::text,curated_source_update_receipt
       from team_memory_share_grants where id=$1`,
    [input.grantId]
  );
  const initialTeamGrant = beforeUpdate.rows[0];
  assert.ok(
    initialTeamGrant,
    "Current Team grant is required for scope change"
  );
  const initialPending = await fixture.team.db.query<{ id: string }>(
    `select id from pending_share_operations
      where grant_id=$1 and state='activated' order by created_at limit 1`,
    [input.grantId]
  );
  const originalPendingShareId = initialPending.rows[0]?.id;
  assert.ok(originalPendingShareId, "Continuous Curated source operation");
  const priorGeneration = Number(
    initialTeamGrant.curated_source_update_receipt?.generation ?? 0
  );
  assert.ok(Number.isSafeInteger(priorGeneration) && priorGeneration >= 0);
  const detail = await fixture.bob.personal.request(
    "GET",
    `/v1/memory/curated/assertions/${input.positiveAssertionId}`,
    { expectedStatus: 200 }
  );
  const before = record(
    record(detail.body, "Curated owner read").assertion,
    "Curated assertion"
  );
  assert.equal(before.scope, "project");
  const version = before.classificationVersion;
  assert.equal(typeof version, "number", "Curated assertion version");
  fixture.dropNextTeamCuratedUpdateResponse();
  fixture.blockTeamCuratedWithdrawal();
  const pending = await (async () => {
    try {
      const changed = await fixture.bob.personal.request(
        "PATCH",
        `/v1/memory/curated/assertions/${input.positiveAssertionId}`,
        {
          body: { scope: "me", expected_version: version },
          expectedStatus: 202
        }
      );
      const operation = record(
        record(changed.body, "pending classification").operation,
        "operation"
      );
      assert.ok(
        ["pending", "ready"].includes(String(operation.state)),
        "Team outage must leave classification retryable"
      );
      const stillProject = await fixture.bob.personal.request(
        "GET",
        `/v1/memory/curated/assertions/${input.positiveAssertionId}`,
        { expectedStatus: 200 }
      );
      const oldAssertion = record(
        record(stillProject.body, "pending owner read").assertion,
        "pending assertion"
      );
      assert.equal(
        oldAssertion.scope,
        "project",
        "Scope changed before Team ACK"
      );
      assert.equal(
        oldAssertion.classificationVersion,
        version,
        "Classification version advanced before Team ACK"
      );
      return operation;
    } finally {
      fixture.resumeTeamCuratedWithdrawal();
    }
  })();
  let after: Record<string, unknown> | null = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const current = await fixture.bob.personal.request(
      "GET",
      `/v1/memory/curated/assertions/${input.positiveAssertionId}`,
      { expectedStatus: 200 }
    );
    const assertion = record(
      record(current.body, "classification retry").assertion,
      "assertion"
    );
    if (assertion.scope === "me") {
      after = assertion;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(after, "Curated classification did not resume after Team recovery");
  assert.equal(after.classificationVersion, (version as number) + 1);
  let droppedGeneration: number | null = null;
  let emptyUpdate: Record<string, unknown> | null = null;
  const updateDeadline = Date.now() + 75_000;
  while (Date.now() < updateDeadline) {
    const receipt = await fixture.team.db.query<{
      source_revision: string;
      curated_source_update_receipt: Record<string, unknown> | null;
    }>(
      `select source_revision::text,curated_source_update_receipt
         from team_memory_share_grants where id=$1`,
      [input.grantId]
    );
    const current = receipt.rows[0];
    assert.ok(current, "Curated grant vanished during update retry");
    assert.equal(
      current.source_revision,
      initialTeamGrant.source_revision,
      "Classification changed the Captured Session source cursor"
    );
    const update = current.curated_source_update_receipt;
    const currentGeneration = Number(update?.generation ?? 0);
    if (
      droppedGeneration === null &&
      fixture.teamCuratedUpdateResponseDrops() === 1 &&
      currentGeneration > priorGeneration
    ) {
      droppedGeneration = currentGeneration;
    }
    if (
      update &&
      droppedGeneration !== null &&
      currentGeneration > droppedGeneration &&
      Number(update.itemCount) === 0 &&
      fixture.teamCuratedUpdateResponseDrops() === 1
    ) {
      const localWork = await fixture.personalDb(fixture.bob).query<{
        delivered_generation: string;
      }>(
        `select delivered_generation::text
           from collaboration_curated_grant_source_work
          where original_pending_share_id=$1`,
        [originalPendingShareId]
      );
      if (
        Number(localWork.rows[0]?.delivered_generation) >= currentGeneration
      ) {
        emptyUpdate = update;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(
    emptyUpdate,
    "Continuous Curated source did not durably publish signed empty removal"
  );
  const eligible = await fixture.team.db.query<{ count: string }>(
    `select count(*)::text as count
       from team_memory_curated_item_eligibility eligibility
       join team_memory_semantic_items item
         on item.id=eligibility.semantic_item_id
      where item.share_grant_id=$1 and eligibility.blocked_at is null`,
    [input.grantId]
  );
  assert.equal(
    eligible.rows[0]?.count,
    "0",
    "Unknown ACK retry left duplicate eligible Curated items"
  );
  const teamRead = await fixture.alice.team.request(
    "GET",
    `${teamGrantPath(fixture, input.grantId)}?representation=curated_assertions`,
    {}
  );
  assert.ok([200, 403, 404].includes(teamRead.status));
  if (teamRead.status === 200) {
    const teamMaterial = JSON.stringify(
      record(teamRead.body, "post-change Team read")
    );
    assert.ok(
      !teamMaterial.includes(
        nonemptyString(after.assertionText, "classified assertion text")
      ),
      "Old Project assertion remains in Team representation after classification"
    );
  }
  const answer = await answerTeam(
    fixture,
    fixture.alice,
    nonemptyString(after.assertionText, "classified assertion text"),
    "curated_memory_search"
  );
  assert.equal(
    teamEvidenceForGrant(answer, input.grantId).length,
    0,
    "Withdrawn Curated vector remains in Team semantic recall"
  );
  fixture.results.record("I27.scope-change", {
    pendingOperationId: pending.id,
    scopeHeldDuringTeamOutage: true,
    classificationCommitted: true,
    sameCursorSignedEmptyGeneration: emptyUpdate.generation,
    droppedGeneration,
    droppedCommittedUpdateResponse: fixture.teamCuratedUpdateResponseDrops(),
    teamRepresentationStatus: teamRead.status,
    withdrawnAtCommittedRead: true
  });
}

/** Project-plus-Me stays inside the local Personal selector; Team uses its own scope. */
export async function runHq713MemorySelectorControl(
  fixture: Hq713Fixture
): Promise<void> {
  const marker = `hq713-selector-${randomUUID()}`;
  const otherProjectResponse = await fixture.bob.personal.request(
    "POST",
    "/v1/projects",
    {
      body: { name: "Other HQ-713 Project", idempotencyKey: randomUUID() },
      expectedStatus: 201
    }
  );
  const otherProjectId = nonemptyString(
    record(otherProjectResponse.body, "other Personal Project").id,
    "other Personal Project ID"
  );
  const linked = await fixture.seedCapturedSession(fixture.bob, {
    projectId: fixture.ids.bobPersonalProjectId,
    sessionLabel: `${marker}-linked`
  });
  const other = await fixture.seedCapturedSession(fixture.bob, {
    projectId: otherProjectId,
    sessionLabel: `${marker}-other`
  });
  const labels = {
    linked: `${marker}-linked-assertion`,
    me: `${marker}-me-assertion`,
    other: `${marker}-other-assertion`,
    unscoped: `${marker}-unscoped-assertion`
  };
  await fixture.seedCuratedAssertion(fixture.bob, {
    projectId: fixture.ids.bobPersonalProjectId,
    scope: "project",
    text: labels.linked,
    sourceItemIds: linked.sourceItemIds.slice(0, 1)
  });
  await fixture.seedCuratedAssertion(fixture.bob, {
    projectId: fixture.ids.bobPersonalProjectId,
    scope: "me",
    text: labels.me,
    sourceItemIds: linked.sourceItemIds.slice(0, 1)
  });
  await fixture.seedCuratedAssertion(fixture.bob, {
    projectId: otherProjectId,
    scope: "project",
    text: labels.other,
    sourceItemIds: other.sourceItemIds.slice(0, 1)
  });
  await fixture.seedCuratedAssertion(fixture.bob, {
    projectId: fixture.ids.bobPersonalProjectId,
    scope: "unscoped",
    text: labels.unscoped,
    sourceItemIds: linked.sourceItemIds.slice(0, 1)
  });
  const personal = await fixture.bob.personalTokenClient.request(
    "POST",
    "/v1/memory/search",
    {
      body: {
        query: marker,
        search_domain: "project",
        project_id: fixture.ids.bobPersonalProjectId,
        personal_project_and_me: true,
        retrieval_stage: "curated_memory_search",
        limit: 50
      },
      expectedStatus: 200
    }
  );
  const personalHits = list(
    record(personal.body, "Personal search").hits,
    "Personal hits"
  );
  const personalText = JSON.stringify(personalHits);
  assert.ok(
    personalText.includes(labels.linked),
    "Linked Project Memory absent"
  );
  assert.ok(
    personalText.includes(labels.me),
    "Me Memory absent from Project-plus-Me"
  );
  assert.ok(
    !personalText.includes(labels.other),
    "Other Project Memory leaked"
  );
  const team = await fixture.bob.team.request("POST", "/v1/memory/search", {
    body: {
      query: marker,
      search_domain: "global",
      team_workspace_id: fixture.ids.workspaceId,
      retrieval_stage: "curated_memory_search",
      limit: 50
    },
    expectedStatus: 200
  });
  const teamHits = list(record(team.body, "Team search").hits, "Team hits");
  assert.ok(
    teamHits.every((hit) => record(hit, "Team hit").visibility === "team"),
    "Team selector returned Personal evidence"
  );
  const mixedSelector = await fixture.bob.team.request(
    "POST",
    "/v1/memory/search",
    {
      body: {
        query: marker,
        search_domain: "project",
        project_id: fixture.ids.bobPersonalProjectId,
        personal_project_and_me: true,
        team_workspace_id: fixture.ids.workspaceId
      }
    }
  );
  assert.equal(mixedSelector.status, 400);
  fixture.results.record("I30", {
    linkedProjectFound: true,
    meFound: true,
    otherProjectExcluded: true,
    teamGlobalScope: true,
    mixedSelectorStatus: mixedSelector.status,
    teamBackendId: fixture.teamBackendId
  });
}

/** A current Team credential is rechecked for every persisted citation read. */
export async function runHq713MemoryCitationControl(
  fixture: Hq713Fixture,
  shared: Hq713SharedSession
): Promise<string[]> {
  const query = shared.summaryText;
  const answers = [
    await answerTeam(fixture, fixture.bob, query),
    await answerTeam(fixture, fixture.bob, query)
  ];
  const ordinals = answers.map((answer) => {
    const citations = list(answer.citations, "Team citations");
    assert.ok(citations.length > 0, "Each recall must produce a citation");
    return citations.map((citation) => record(citation, "Team citation"));
  });
  const questionIds: string[] = [];
  for (let index = 0; index < answers.length; index += 1) {
    const answer = answers[index];
    assert.ok(answer);
    questionIds.push(
      await persistHq713TeamQuestion(fixture, fixture.bob, answer, query)
    );
  }
  for (const id of questionIds) {
    const reload = await fixture.bob.teamBrowser.request(
      "GET",
      `/v1/memory/questions/${id}`,
      { expectedStatus: 200 }
    );
    const question = record(
      record(reload.body, "question reload").question,
      "question"
    );
    assert.ok(list(question.citations, "reloaded citations").length > 0);
    const detail = await fixture.bob.team.request(
      "GET",
      `/v1/memory/questions/${id}/citations/0`,
      { expectedStatus: 200 }
    );
    assert.ok(record(detail.body, "citation detail").detail);
  }
  fixture.results.record("I28.question-history", {
    persistedQuestionCount: questionIds.length,
    citationCounts: ordinals.map((entries) => entries.length),
    detailBeforeRevocation: true
  });
  // The caller revokes Team access later; recheck these exact retained IDs then.
  return questionIds;
}

export async function runHq713MemoryCitationRevocationControl(
  fixture: Hq713Fixture,
  questionIds: string[]
): Promise<void> {
  assert.ok(
    questionIds.length >= 2,
    "Citation revocation needs two persisted recall results"
  );
  for (const id of questionIds) {
    const detail = await fixture.bob.team.request(
      "GET",
      `/v1/memory/questions/${id}/citations/0`,
      {}
    );
    assert.ok(
      [403, 404].includes(detail.status),
      `Revoked Team access still resolved citation ${id} (${detail.status})`
    );
  }
  fixture.results.record("I28.question-history-revoked", {
    checkedCitationCount: questionIds.length,
    currentlyUnavailable: true
  });
}
