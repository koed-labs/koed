import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Hq713Actor, Hq713Fixture } from "./hq713-fixture.js";
import { answerTeam, teamEvidenceForGrant } from "./hq713-memory.js";

type SharedSource = {
  sessionId: string;
  grantId: string;
  logicalMemoryId: string;
  sourceItemIds: string[];
  summaryText: string;
  expiresAt?: string;
};
type GrantState = {
  id: string;
  owner_user_id: string;
  grant_version: number;
  source_revision: number | null;
  frozen_at: Date | null;
  freeze_manifest_hash: string | null;
  freeze_representation_count: number | null;
  revoked_at: Date | null;
};

const activeProjectReview = async (actor: Hq713Actor, projectId: string) => {
  const response = await actor.team.request(
    "GET",
    `/v1/workspace-projects/${projectId}/lifecycle-review`,
    {
      expectedStatus: 200
    }
  );
  return response.body as {
    project: { id: string; teamId: string; version: number };
    actorMemberVersion: number;
  };
};

const publishProjectConversation = async (
  fixture: Hq713Fixture,
  actor: Hq713Actor,
  personalProjectId: string,
  label: string,
  expiryDurationMs?: number
): Promise<SharedSource> => {
  const marker = `${label}-${randomUUID()}`;
  const captured = await fixture.seedCapturedSession(actor, {
    projectId: personalProjectId,
    sessionLabel: marker
  });
  const expiresAt = expiryDurationMs
    ? new Date(Date.now() + expiryDurationMs).toISOString()
    : undefined;
  const shared = await fixture.shareCapturedSession(actor, {
    sessionId: captured.sessionId,
    workspaceProjectId: fixture.ids.workspaceProjectId,
    teamWorkspaceId: fixture.ids.workspaceId,
    summaryText: marker,
    includeCuratedMemory: false,
    ...(expiresAt ? { expiresAt } : {})
  });
  return { ...captured, ...shared, summaryText: marker, expiresAt };
};

const createProjectJob = async (
  actor: Hq713Actor,
  personalProjectId: string,
  sessionId: string
): Promise<string> => {
  const agent = await actor.personalEdge.request("POST", "/v1/agents", {
    body: {
      name: `HQ713 lifecycle helper ${randomUUID()}`,
      role: null,
      look: {},
      aiClientInstanceId: actor.aiClientInstanceId,
      defaultPermissionMode: "supervised",
      defaultModel: null
    },
    expectedStatus: 201
  });
  const agentId = (agent.body as { agent: { id: string } }).agent.id;
  const job = await actor.personalEdge.request("POST", "/v1/scheduled-jobs", {
    body: {
      requestId: randomUUID(),
      agentId,
      conversationSessionId: sessionId,
      projectId: personalProjectId,
      title: "HQ713 Project lifecycle job",
      instruction: "Review the shared plan",
      schedule: { kind: "daily", at: "09:00", tz: "Europe/Oslo" }
    },
    expectedStatus: 201
  });
  return (job.body as { id: string }).id;
};

const grantState = async (
  fixture: Hq713Fixture,
  grantId: string,
  requireProjectBinding = true
): Promise<GrantState> => {
  const response = await fixture.team.db.query<GrantState>(
    `select grant_row.id,grant_row.owner_user_id,grant_row.grant_version,grant_row.source_revision,
            grant_row.frozen_at,grant_row.freeze_manifest_hash,grant_row.freeze_representation_count,
            grant_row.revoked_at
       from team_memory_share_grants grant_row
      where grant_row.id=$1
        and ($2::boolean=false or exists (
          select 1 from workspace_project_share_grant_bindings binding
           where binding.share_grant_id=grant_row.id
             and binding.workspace_project_id=$3))`,
    [grantId, requireProjectBinding, fixture.ids.workspaceProjectId]
  );
  assert.equal(
    response.rows.length,
    1,
    "Exact Share Grant must exist at the requested binding"
  );
  return response.rows[0]!;
};

const assertFrozen = (
  before: GrantState,
  after: GrantState,
  allowInFlightAdvance = false
) => {
  assert.equal(after.id, before.id);
  assert.ok(after.frozen_at instanceof Date, "Grant must freeze atomically");
  assert.match(after.freeze_manifest_hash ?? "", /^[0-9a-f]{64}$/);
  assert.ok((after.freeze_representation_count ?? -1) >= 1);
  assert.equal(after.revoked_at, null, "D9 retains the Share Grant");
  if (allowInFlightAdvance)
    assert.ok((after.source_revision ?? 0) >= (before.source_revision ?? 0));
  else assert.equal(after.source_revision, before.source_revision);
};

const assertTeamRecall = async (
  fixture: Hq713Fixture,
  recipient: Hq713Actor,
  source: SharedSource
) => {
  const answer = await answerTeam(
    fixture,
    recipient,
    source.summaryText,
    "scoped_leaf_search"
  );
  const evidence = teamEvidenceForGrant(answer, source.grantId);
  assert.ok(
    evidence.length > 0,
    "Frozen published material must remain in Team recall"
  );
  assert.ok(
    evidence.some((item) =>
      String(item.summaryText).includes(source.summaryText)
    ),
    "Team recall must retain the last actually published summary"
  );
  return evidence.length;
};

const assertFrozenAfterLaterSource = async (
  fixture: Hq713Fixture,
  sourceOwner: Hq713Actor,
  recipient: Hq713Actor,
  source: SharedSource,
  personalProjectId: string,
  expectSyncObservation = true
) => {
  const frozen = await grantState(fixture, source.grantId);
  assert.ok(frozen.frozen_at instanceof Date);
  const personalDb = fixture.personalDb(sourceOwner);
  const sourceItems = async () => {
    const rows = await personalDb.query<{
      id: string;
      raw_text: string | null;
      source_hash: string;
      projection_status: string;
    }>(
      `select id,raw_text,source_hash,projection_status
         from conversation_items
        where session_id=$1 and owner_user_id=$2 and personal_deleted_at is null`,
      [source.sessionId, sourceOwner.id]
    );
    return rows.rows;
  };
  const beforeItems = await sourceItems();
  const priorIds = new Set(beforeItems.map((item) => item.id));
  assert.ok(
    source.sourceItemIds.length > 0 &&
      source.sourceItemIds.every((id) => priorIds.has(id)),
    "Previously published canonical source items must remain present"
  );
  const sourceRelationship = async () => {
    const rows = await fixture.personalDb(sourceOwner).query<{
      state: string;
      source_cursor: string;
      target_processing_cursor: string;
    }>(
      `select state,source_cursor::text,target_processing_cursor::text
         from cross_identity_sync_relationships
        where logical_memory_id=$1 and side='source' and local_user_id=$2
        order by created_at desc limit 1`,
      [source.logicalMemoryId, sourceOwner.id]
    );
    const relationship = rows.rows[0];
    assert.ok(relationship, "Actual source sync relationship must exist");
    return relationship;
  };
  const beforeRelationship = await sourceRelationship();
  const advanced = await fixture.advanceCapturedSession(sourceOwner, {
    sessionId: source.sessionId,
    projectId: personalProjectId,
    sessionLabel: source.summaryText
  });
  const afterItems = await sourceItems();
  assert.equal(
    afterItems.length,
    beforeItems.length + 1,
    "The same Personal Conversation must retain its source and gain one item"
  );
  const laterItems = afterItems.filter((item) => !priorIds.has(item.id));
  assert.equal(
    laterItems.length,
    1,
    "Real Personal capture must append exactly one raw Conversation Item"
  );
  const laterItem = laterItems[0]!;
  assert.equal(laterItem.raw_text, advanced.laterText);
  assert.equal(
    laterItem.source_hash,
    createHash("sha256").update(advanced.laterText).digest("hex")
  );
  assert.equal(laterItem.projection_status, "projected");
  const canonical = await personalDb.query<{
    event_count: number;
    node_count: number;
  }>(
    `select count(distinct event.id)::int as event_count,
            count(distinct node.id)::int as node_count
       from memory_event_sources source
       join memory_events event on event.id=source.memory_event_id
       left join memory_node_sources node_source
         on node_source.memory_event_id=event.id
       left join memory_nodes node
         on node.id=node_source.memory_node_id
        and node.session_id=$2 and node.owner_user_id=$3
      where source.conversation_item_id=$1
        and event.session_id=$2 and event.owner_user_id=$3`,
    [laterItem.id, source.sessionId, sourceOwner.id]
  );
  assert.equal(canonical.rows[0]?.event_count, 1);
  assert.ok(
    (canonical.rows[0]?.node_count ?? 0) >= 1,
    "Later raw source must have a canonical event and Personal LCM leaf"
  );
  // An active source can advance the real sync cursor or be suspended after
  // freeze. A soft-trashed Chat can retain Personal capture while remaining
  // ineligible for export, so its cursor is only observed.
  const deadline = Date.now() + (expectSyncObservation ? 8_000 : 0);
  let relationship = beforeRelationship;
  while (expectSyncObservation) {
    relationship = await sourceRelationship();
    if (
      relationship.state === "paused" ||
      relationship.state === "revoked" ||
      BigInt(relationship.source_cursor) >
        BigInt(beforeRelationship.source_cursor)
    )
      break;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!expectSyncObservation) relationship = await sourceRelationship();
  const sourceSyncObserved =
    relationship.state === "paused" ||
    relationship.state === "revoked" ||
    BigInt(relationship.source_cursor) >
      BigInt(beforeRelationship.source_cursor);
  if (expectSyncObservation)
    assert.ok(
      sourceSyncObserved,
      "Production source sync worker must observe later input or suspend the frozen source"
    );
  const stillFrozen = await grantState(fixture, source.grantId);
  assertFrozen(frozen, stillFrozen);
  assert.equal(stillFrozen.freeze_manifest_hash, frozen.freeze_manifest_hash);
  assert.equal(
    stillFrozen.freeze_representation_count,
    frozen.freeze_representation_count
  );
  const answer = await answerTeam(
    fixture,
    recipient,
    advanced.laterSummaryText,
    "scoped_leaf_search"
  );
  const grantEvidence = teamEvidenceForGrant(answer, source.grantId);
  assert.ok(
    grantEvidence.every(
      (item) => !String(item.summaryText).includes(advanced.laterSummaryText)
    ),
    "Frozen grant must exclude the later canonical source marker"
  );
  await assertTeamRecall(fixture, recipient, source);
  return {
    oldGrantId: source.grantId,
    pinnedSourceRevision: frozen.source_revision,
    initialSourceItemIds: source.sourceItemIds,
    laterSourceItemId: laterItem.id,
    laterText: advanced.laterText,
    laterSummaryText: advanced.laterSummaryText,
    canonicalEventCount: canonical.rows[0]!.event_count,
    canonicalNodeCount: canonical.rows[0]!.node_count,
    laterSourceItemCount: afterItems.length,
    frozenManifestHash: frozen.freeze_manifest_hash,
    frozenRepresentationCount: frozen.freeze_representation_count,
    laterMarkerExcluded: true,
    sourceSyncState: relationship.state,
    sourceSyncObserved,
    priorSourceSyncCursor: beforeRelationship.source_cursor,
    sourceSyncCursor: relationship.source_cursor,
    targetSyncCursor: relationship.target_processing_cursor
  };
};

/** A single owner Chat deletion freezes its exact grant through Native review. */
export async function runHq713ChatDeleteFreeze(
  fixture: Hq713Fixture
): Promise<void> {
  const source = await publishProjectConversation(
    fixture,
    fixture.alice,
    fixture.ids.alicePersonalProjectId,
    "hq713-chat-delete-alice"
  );
  await assertTeamRecall(fixture, fixture.bob, source);
  const before = await grantState(fixture, source.grantId);
  assert.equal(before.frozen_at, null);
  const batchId = randomUUID();
  type DeleteStatus = {
    sessionId: string;
    batchId: string;
    complete: boolean;
    pendingReviews: Array<{
      backendId: string;
      shareGrantId: string;
      actionGrantId: string;
    }>;
  };
  let deletion = (
    await fixture.alice.personal.request<DeleteStatus>(
      "DELETE",
      `/v1/memory/graph/sessions/${source.sessionId}`,
      { body: { batchId }, expectedStatus: [200, 202] }
    )
  ).body;
  assert.equal(deletion.sessionId, source.sessionId);
  assert.equal(deletion.batchId, batchId);
  const reviewed = new Set<string>();
  for (let attempt = 0; attempt < 8 && !deletion.complete; attempt++) {
    for (const review of deletion.pendingReviews) {
      assert.equal(review.backendId, fixture.teamBackendId);
      assert.equal(review.shareGrantId, source.grantId);
      if (reviewed.has(review.actionGrantId)) continue;
      reviewed.add(review.actionGrantId);
      const reservation = await fixture.alice.personalEdge.request(
        "GET",
        `/v1/memory/graph/sessions/${source.sessionId}/delete-reviews/${review.actionGrantId}?batchId=${batchId}`,
        { expectedStatus: 200 }
      );
      assert.equal(
        (reservation.body as { shareGrantId: string }).shareGrantId,
        source.grantId
      );
      const result = await fixture.localCommand(
        fixture.alice,
        "collaboration.confirm_action_grant",
        { actionGrant: { id: review.actionGrantId }, decision: "approve" }
      );
      assert.equal(
        (result.data as { status: { state: string } }).status.state,
        "approved"
      );
    }
    deletion = (
      await fixture.alice.personal.request<DeleteStatus>(
        "POST",
        `/v1/memory/graph/sessions/${source.sessionId}/delete-progress`,
        { body: { batchId }, expectedStatus: [200, 202] }
      )
    ).body;
  }
  assert.equal(
    deletion.complete,
    true,
    "Chat delete must finish via real HTTP"
  );
  assert.ok(
    reviewed.size > 0,
    "Exact Share Grant required Native freeze review"
  );
  const frozen = await grantState(fixture, source.grantId);
  assertFrozen(before, frozen);
  const deleted = await fixture.personalDb(fixture.alice).query<{
    trashed_at: Date | null;
  }>("select trashed_at from sessions where id=$1 and owner_user_id=$2", [source.sessionId, fixture.alice.id]);
  assert.ok(deleted.rows[0]?.trashed_at instanceof Date);
  const postDeleteAdvance = await assertFrozenAfterLaterSource(
    fixture,
    fixture.alice,
    fixture.bob,
    source,
    fixture.ids.alicePersonalProjectId,
    false
  );
  const stillTrashed = await fixture.personalDb(fixture.alice).query<{
    trashed_at: Date | null;
  }>("select trashed_at from sessions where id=$1 and owner_user_id=$2", [source.sessionId, fixture.alice.id]);
  assert.equal(
    stillTrashed.rows[0]?.trashed_at?.getTime(),
    deleted.rows[0]?.trashed_at?.getTime(),
    "Later Personal capture must not resurrect the trashed Conversation"
  );
  const retainedEvidence = await assertTeamRecall(fixture, fixture.bob, source);
  fixture.results.record("I713.chat-delete-freeze", {
    sessionId: source.sessionId,
    grantId: source.grantId,
    batchId,
    reviewedGrantIds: [...reviewed],
    frozenHash: frozen.freeze_manifest_hash,
    frozenCount: frozen.freeze_representation_count,
    postDeleteAdvance,
    retainedEvidence
  });
  const revoked = await fixture.alice.teamBrowser.request<{
    grant: { id: string; lifecycle: string };
  }>("POST", `/v1/shared-memory/share-grants/${source.grantId}/revoke`, {
    body: {
      mutationId: randomUUID(),
      teamId: fixture.ids.teamId,
      teamWorkspaceId: fixture.ids.workspaceId,
      expectedGrantVersion: frozen.grant_version,
      reasonCode: "owner_revoked",
      authority: {
        action: "workspace.memory.share_owned",
        source: "browser_session"
      }
    },
    expectedStatus: 200
  });
  assert.equal(revoked.body.grant.id, source.grantId);
  assert.equal(revoked.body.grant.lifecycle, "revoked");
  const revokedRead = await fixture.bob.team.request(
    "GET",
    `/v1/shared-memory/teams/${fixture.ids.teamId}/workspaces/${fixture.ids.workspaceId}/share-grants/${source.grantId}?representation=lcm_leaves`
  );
  assert.ok([403, 404].includes(revokedRead.status));
  const revokedAnswer = await answerTeam(
    fixture,
    fixture.bob,
    source.summaryText,
    "scoped_leaf_search"
  );
  assert.equal(teamEvidenceForGrant(revokedAnswer, source.grantId).length, 0);
  fixture.results.record("N11.revocation", {
    grantId: source.grantId,
    frozenHash: frozen.freeze_manifest_hash,
    revokedReadStatus: revokedRead.status,
    revokedRecallDenied: true
  });
}

/** Steps 8–9 and N6: D9 retains recall but never resumes old grants. */
export async function runHq713DeleteRestore(
  fixture: Hq713Fixture
): Promise<void> {
  const { workspaceProjectId, teamId, workspaceId } = fixture.ids;
  const alice = await publishProjectConversation(
    fixture,
    fixture.alice,
    fixture.ids.alicePersonalProjectId,
    "hq713-delete-alice"
  );
  const independentWorkspaceBody = {
    name: `HQ713 independent ${randomUUID()}`
  };
  const workspaceApproval = await fixture.approveActionGrant(fixture.alice, {
    action: "team.workspace.create",
    teamId,
    body: independentWorkspaceBody
  });
  const independentWorkspace = await fixture.alice.team.request<{
    teamWorkspace: { id: string };
  }>("POST", `/v1/teams/${teamId}/workspaces`, {
    body: independentWorkspaceBody,
    headers: { "x-koed-action-grant": workspaceApproval.secret },
    expectedStatus: 200
  });
  const independentWorkspaceId = independentWorkspace.body.teamWorkspace.id;
  const bobAccessBody = {
    userId: fixture.bob.teamUserId,
    access: "read",
    canShareOwnedMemory: false,
    expectedVersion: null
  };
  const accessApproval = await fixture.approveActionGrant(fixture.alice, {
    action: "team.workspace.access_update",
    teamId,
    teamWorkspaceId: independentWorkspaceId,
    body: bobAccessBody
  });
  await fixture.alice.team.request(
    "PUT",
    `/v1/team-workspaces/${independentWorkspaceId}/access`,
    {
      body: bobAccessBody,
      headers: { "x-koed-action-grant": accessApproval.secret },
      expectedStatus: 200
    }
  );
  // This independent Workspace grant tracks the same captured source. Project
  // deletion may freeze its Project-bound sibling but must not stop this one.
  const independent = await fixture.shareCapturedSession(fixture.alice, {
    sessionId: alice.sessionId,
    teamWorkspaceId: independentWorkspaceId,
    summaryText: alice.summaryText,
    includeCuratedMemory: false
  });
  assert.notEqual(independent.grantId, alice.grantId);
  const independentBefore = await grantState(
    fixture,
    independent.grantId,
    false
  );
  assert.equal(independentBefore.frozen_at, null);
  const bob = await publishProjectConversation(
    fixture,
    fixture.bob,
    fixture.ids.bobPersonalProjectId,
    "hq713-delete-bob",
    120_000
  );
  const bobExpiryAt = bob.expiresAt!;
  const bobJobId = await createProjectJob(
    fixture.bob,
    fixture.ids.bobPersonalProjectId,
    bob.sessionId
  );
  await assertTeamRecall(fixture, fixture.bob, alice);
  await assertTeamRecall(fixture, fixture.alice, bob);
  const openedThread = await fixture.alice.team.request(
    "POST",
    `/v2/collaboration/teams/${teamId}/projects/${workspaceProjectId}/thread/open`,
    { body: {}, expectedStatus: 200 }
  );
  assert.ok((openedThread.body as { thread: { id: string } }).thread.id);
  const beforeAlice = await grantState(fixture, alice.grantId);
  const beforeBob = await grantState(fixture, bob.grantId);
  assert.equal(beforeAlice.frozen_at, null);
  assert.equal(beforeBob.frozen_at, null);

  const review = await activeProjectReview(fixture.alice, workspaceProjectId);
  const body = { expectedProjectVersion: review.project.version };
  const approved = await fixture.approveActionGrant(fixture.alice, {
    action: "workspace_project.delete",
    teamId,
    projectId: workspaceProjectId,
    body
  });
  // Hold the exact grant row while a real source-sync publication and the
  // project-delete HTTP freeze both enter the database. Releasing the row
  // makes their order observable without altering any business state.
  const lock = await fixture.team.db.connect();
  const observer = await fixture.team.db.connect().catch((error: unknown) => {
    lock.release();
    throw error;
  });
  let deleted: Awaited<ReturnType<Hq713Actor["team"]["request"]>>;
  let racingSource: Awaited<ReturnType<Hq713Fixture["advanceCapturedSession"]>>;
  let publicationWaiters: number;
  let freezeWaiters: number;
  let freezeCompletedWhilePublicationBlocked: boolean;
  try {
    await lock.query("begin");
    const holder = await lock.query<{ pid: number }>(
      "select pg_backend_pid() as pid"
    );
    const holderPid = holder.rows[0]!.pid;
    await lock.query(
      "select id from team_memory_share_grants where id=$1 for update",
      [alice.grantId]
    );
    const blockedByHolder = async () => {
      const waiting = await observer.query<{ count: number }>(
        `select count(*)::int as count from pg_stat_activity
          where pid<>$1 and $1=any(pg_blocking_pids(pid))`,
        [holderPid]
      );
      return waiting.rows[0]?.count ?? 0;
    };
    const waitForBlocked = async (minimum: number) => {
      const deadline = Date.now() + 15_000;
      do {
        const count = await blockedByHolder();
        if (count >= minimum) return count;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      assert.fail(`N11 grant race did not observe ${minimum} blocked writers`);
    };
    racingSource = await fixture.advanceCapturedSession(fixture.alice, {
      sessionId: alice.sessionId,
      projectId: fixture.ids.alicePersonalProjectId,
      sessionLabel: alice.summaryText
    });
    publicationWaiters = await waitForBlocked(1);
    const deletion = fixture.alice.team.request(
      "POST",
      `/v1/workspace-projects/${workspaceProjectId}/delete`,
      {
        body,
        headers: { "x-koed-action-grant": approved.secret },
        expectedStatus: 200
      }
    );
    void deletion.catch(() => undefined);
    freezeCompletedWhilePublicationBlocked = await Promise.race([
      deletion.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000))
    ]);
    freezeWaiters = await blockedByHolder();
    assert.ok(freezeWaiters >= 1, "Publication must stay in flight at freeze");
    if (freezeCompletedWhilePublicationBlocked) {
      const frozenWhileBlocked = await observer.query<{
        frozen_at: Date | null;
      }>("select frozen_at from team_memory_share_grants where id=$1", [
        alice.grantId
      ]);
      assert.ok(
        frozenWhileBlocked.rows[0]?.frozen_at instanceof Date,
        "HTTP freeze must close the grant while publication is blocked"
      );
    }
    await lock.query("commit");
    deleted = await deletion;
  } finally {
    await lock.query("rollback").catch(() => undefined);
    lock.release();
    observer.release();
  }
  assert.deepEqual(deleted.body, {
    projectId: workspaceProjectId,
    lifecycle: "deleted"
  });
  const list = await fixture.bob.team.request(
    "GET",
    `/v1/teams/${teamId}/workspace-projects`,
    {
      expectedStatus: 200
    }
  );
  assert.ok(
    !JSON.stringify(list.body).includes(workspaceProjectId),
    "Deleted Project must disappear for Bob"
  );
  const lifecycle = await fixture.bob.team.request(
    "GET",
    `/v1/workspace-projects/${workspaceProjectId}/lifecycle`,
    {
      expectedStatus: 200
    }
  );
  assert.equal((lifecycle.body as { active: boolean }).active, false);
  const afterAlice = await grantState(fixture, alice.grantId);
  const afterBob = await grantState(fixture, bob.grantId);
  assertFrozen(beforeAlice, afterAlice, true);
  assertFrozen(beforeBob, afterBob);
  const racingRead = await fixture.bob.team.request(
    "GET",
    `/v1/shared-memory/teams/${teamId}/workspaces/${workspaceId}/share-grants/${alice.grantId}?representation=lcm_leaves`,
    { expectedStatus: 200 }
  );
  const racingMarkerIncluded = JSON.stringify(racingRead.body).includes(
    racingSource.laterSummaryText
  );
  assert.equal(
    racingMarkerIncluded,
    (afterAlice.source_revision ?? 0) > (beforeAlice.source_revision ?? 0),
    "Frozen closure must match whichever publication linearized before freeze"
  );
  const thread = await fixture.team.db.query<{ lifecycle: string }>(
    `select lifecycle from collaboration_threads
      where workspace_project_id=$1 and kind='project_thread'`,
    [workspaceProjectId]
  );
  assert.ok(
    thread.rows.length > 0,
    "Shared Project must have a Project Thread"
  );
  assert.ok(thread.rows.every((row) => row.lifecycle === "archived"));
  const retained = await fixture.team.db.query<{ lifecycle: string }>(
    "select lifecycle from team_workspaces where id=$1",
    [workspaceId]
  );
  assert.equal(retained.rows[0]?.lifecycle, "active", "D9 keeps the Workspace");
  const aliceEvidence = await assertTeamRecall(fixture, fixture.bob, alice);
  const bobEvidence = await assertTeamRecall(fixture, fixture.alice, bob);
  const postDeleteAdvance = await assertFrozenAfterLaterSource(
    fixture,
    fixture.alice,
    fixture.bob,
    alice,
    fixture.ids.alicePersonalProjectId
  );
  const independentDeadline = Date.now() + 15_000;
  let independentAfter = await grantState(fixture, independent.grantId, false);
  while (
    (independentAfter.source_revision ?? 0) <=
      (independentBefore.source_revision ?? 0) &&
    Date.now() < independentDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    independentAfter = await grantState(fixture, independent.grantId, false);
  }
  assert.equal(independentAfter.frozen_at, null);
  assert.ok(
    (independentAfter.source_revision ?? 0) >
      (independentBefore.source_revision ?? 0),
    "Independent grant for the same source must continue publishing"
  );
  let independentEvidence: ReturnType<typeof teamEvidenceForGrant>;
  const independentRecallDeadline = Date.now() + 15_000;
  do {
    const independentAnswer = (
      await fixture.bob.team.request<Record<string, unknown>>(
        "POST",
        "/v1/memory/answer",
        {
          body: {
            query: postDeleteAdvance.laterSummaryText,
            search_domain: "global",
            team_workspace_id: independentWorkspaceId,
            retrieval_stage: "scoped_leaf_search"
          },
          expectedStatus: 200
        }
      )
    ).body;
    independentEvidence = teamEvidenceForGrant(
      independentAnswer,
      independent.grantId
    );
    if (
      independentEvidence.some((item) =>
        String(item.summaryText).includes(postDeleteAdvance.laterSummaryText)
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < independentRecallDeadline);
  assert.ok(
    independentEvidence.some((item) =>
      String(item.summaryText).includes(postDeleteAdvance.laterSummaryText)
    ),
    "Independent grant must expose the later publication through Team recall"
  );

  const reconciled = await fixture.bob.personalEdge.request(
    "POST",
    `/v1/local-edge/projects/${fixture.ids.bobPersonalProjectId}/workspace-project-reconcile`,
    { body: {}, expectedStatus: 200 }
  );
  assert.equal((reconciled.body as { cleared: boolean }).cleared, true);
  assert.ok(
    (reconciled.body as { detached: number }).detached >= 1,
    "Bob's own captured Conversation must detach to Just me"
  );
  const bobSession = await fixture.personalDb(fixture.bob).query<{
    automatic_personal_project_id: string | null;
    project_override_personal_project_id: string | null;
  }>(
    `select automatic_personal_project_id,project_override_personal_project_id
       from sessions where id=$1 and owner_user_id=$2`,
    [bob.sessionId, fixture.bob.id]
  );
  assert.equal(bobSession.rows.length, 1);
  assert.equal(bobSession.rows[0]?.automatic_personal_project_id, null);
  assert.equal(bobSession.rows[0]?.project_override_personal_project_id, null);
  const pausedJob = await fixture.personalDb(fixture.bob).query<{
    paused: boolean;
    paused_reason: string | null;
  }>("select paused,paused_reason from scheduled_jobs where id=$1 and owner_user_id=$2", [bobJobId, fixture.bob.id]);
  assert.equal(pausedJob.rows[0]?.paused, true);
  assert.ok(pausedJob.rows[0]?.paused_reason);
  const restoredList = await fixture.alice.team.request(
    "GET",
    "/v1/workspace-projects/restorable",
    {
      expectedStatus: 200
    }
  );
  const restorable = restoredList.body as Array<{
    projectId: string;
    version: number;
  }>;
  const deletedRecord = restorable.find(
    (item) => item.projectId === workspaceProjectId
  );
  assert.ok(deletedRecord, "Owner must see the 30-day restore record");
  const restored = await fixture.alice.team.request(
    "POST",
    `/v1/workspace-projects/${workspaceProjectId}/restore`,
    {
      body: { expectedProjectVersion: deletedRecord.version },
      expectedStatus: 200
    }
  );
  assert.equal((restored.body as { lifecycle: string }).lifecycle, "active");
  const resumed = await fixture.team.db.query<{
    access: string;
    disabled_at: Date | null;
  }>(
    `select link.access,link.disabled_at from workspace_project_members link
       join team_memberships member on member.id=link.team_member_id
      where link.workspace_project_id=$1 and member.user_id=$2`,
    [workspaceProjectId, fixture.bob.teamUserId]
  );
  assert.deepEqual(
    resumed.rows.map((row) => row.access),
    ["disabled"]
  );
  assert.ok(resumed.rows[0]?.disabled_at, "Restore must not revive Bob's link");
  const bobProofAfterRestore = await fixture.bob.team.request(
    "GET",
    `/v1/workspace-projects/${workspaceProjectId}/member-link-proof`,
    { expectedStatus: 403 }
  );
  assert.equal(bobProofAfterRestore.status, 403);
  assertFrozen(afterAlice, await grantState(fixture, alice.grantId));
  assertFrozen(afterBob, await grantState(fixture, bob.grantId));
  await assertTeamRecall(fixture, fixture.alice, bob);
  const activeThread = await fixture.team.db.query<{ lifecycle: string }>(
    `select lifecycle from collaboration_threads
      where workspace_project_id=$1 and kind='project_thread'`,
    [workspaceProjectId]
  );
  assert.ok(activeThread.rows.every((row) => row.lifecycle === "active"));
  fixture.results.record("I713.8", {
    workspaceProjectId,
    frozenGrantIds: [alice.grantId, bob.grantId],
    aliceEvidence,
    bobEvidence,
    bobReconciled: true,
    pausedJobId: bobJobId,
    retainedWorkspaceId: workspaceId,
    postDeleteAdvance
  });
  fixture.results.record("I713.9", {
    workspaceProjectId,
    restoredProjectVersion: (restored.body as { version: number }).version,
    bobLinkStillDisabled: true,
    grantsStillFrozen: true
  });
  fixture.results.record("N6", {
    restoredProjectId: workspaceProjectId,
    bobAccessRevived: false,
    grantAdvancementResumed: false
  });
  fixture.results.record("I24", postDeleteAdvance);
  fixture.results.record("N11.post-freeze", postDeleteAdvance);
  fixture.results.record("N11.independent-grant", {
    frozenGrantId: alice.grantId,
    independentGrantId: independent.grantId,
    independentWorkspaceId,
    independentSourceRevisionBefore: independentBefore.source_revision,
    independentSourceRevisionAfter: independentAfter.source_revision,
    laterSourceItemId: postDeleteAdvance.laterSourceItemId,
    laterMarkerVisible: independentEvidence.length > 0
  });
  fixture.results.record("N11.in-flight-freeze", {
    grantId: alice.grantId,
    sourceRevisionBefore: beforeAlice.source_revision,
    sourceRevisionAtFreeze: afterAlice.source_revision,
    racingSourceItemId: racingSource.rawSourceItemId,
    racingMarkerIncluded,
    publicationWaiters,
    freezeWaiters,
    freezeCompletedWhilePublicationBlocked,
    frozenManifestHash: afterAlice.freeze_manifest_hash
  });
  const preview = await fixture.team.db.query<{
    sanitized_source_preview_id: string;
  }>(
    `select frozen.source_binding_snapshot->>'sanitizedSourcePreviewId'
              as sanitized_source_preview_id
       from team_memory_representations representation
       join team_memory_grant_freeze_representations frozen
         on frozen.frozen_representation_id=representation.id
      where representation.share_grant_id=$1
        and representation.representation='lcm_leaves'
        and representation.frozen_snapshot=true
        and representation.state='available'`,
    [alice.grantId]
  );
  assert.equal(preview.rows.length, 1);
  assert.match(
    preview.rows[0]?.sanitized_source_preview_id ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  );
  assert.equal(
    await fixture.invalidateTeamSemanticPreview({
      ownerTeamUserId: fixture.alice.teamUserId,
      semanticPreviewId: preview.rows[0]!.sanitized_source_preview_id
    }),
    true
  );
  const suppressedRead = await fixture.bob.team.request(
    "GET",
    `/v1/shared-memory/teams/${teamId}/workspaces/${workspaceId}/share-grants/${alice.grantId}?representation=lcm_leaves`
  );
  assert.ok([403, 404].includes(suppressedRead.status));
  const suppressedAnswer = await answerTeam(
    fixture,
    fixture.bob,
    alice.summaryText,
    "scoped_leaf_search"
  );
  assert.equal(teamEvidenceForGrant(suppressedAnswer, alice.grantId).length, 0);
  fixture.results.record("N11.suppression", {
    grantId: alice.grantId,
    previewId: preview.rows[0]!.sanitized_source_preview_id,
    readStatus: suppressedRead.status,
    recallDenied: true
  });
  while (Date.now() <= Date.parse(bobExpiryAt) + 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const expiredRead = await fixture.alice.team.request(
    "GET",
    `/v1/shared-memory/teams/${teamId}/workspaces/${workspaceId}/share-grants/${bob.grantId}?representation=lcm_leaves`
  );
  assert.ok([403, 404].includes(expiredRead.status));
  const expiredAnswer = await answerTeam(
    fixture,
    fixture.alice,
    bob.summaryText,
    "scoped_leaf_search"
  );
  assert.equal(teamEvidenceForGrant(expiredAnswer, bob.grantId).length, 0);
  fixture.results.record("N11.expiry", {
    grantId: bob.grantId,
    consentExpiresAt: bobExpiryAt,
    frozenHash: afterBob.freeze_manifest_hash,
    readStatus: expiredRead.status,
    recallDenied: true
  });
}

/** Step 11: a Project self-leave keeps membership; Team leave freezes recall. */
export async function runHq713Leave(fixture: Hq713Fixture): Promise<void> {
  const { teamId, workspaceProjectId } = fixture.ids;
  const bob = await publishProjectConversation(
    fixture,
    fixture.bob,
    fixture.ids.bobPersonalProjectId,
    "hq713-team-leave-bob"
  );
  const before = await grantState(fixture, bob.grantId);
  assert.equal(before.frozen_at, null);
  await assertTeamRecall(fixture, fixture.alice, bob);
  const project = await activeProjectReview(fixture.bob, workspaceProjectId);
  const leaveProjectBody = {
    expectedProjectVersion: project.project.version,
    expectedMemberVersion: project.actorMemberVersion
  };
  const projectApproval = await fixture.approveActionGrant(fixture.bob, {
    action: "workspace_project.leave",
    teamId,
    projectId: workspaceProjectId,
    body: leaveProjectBody
  });
  const leftProject = await fixture.bob.team.request(
    "POST",
    `/v1/workspace-projects/${workspaceProjectId}/leave`,
    {
      body: leaveProjectBody,
      headers: { "x-koed-action-grant": projectApproval.secret },
      expectedStatus: 200
    }
  );
  assert.equal((leftProject.body as { access: string }).access, "disabled");
  const departedProjectProof = await fixture.bob.team.request(
    "GET",
    `/v1/workspace-projects/${workspaceProjectId}/member-link-proof`,
    { expectedStatus: 403 }
  );
  assert.equal(departedProjectProof.status, 403);
  assertFrozen(before, await grantState(fixture, bob.grantId));
  const membershipAfterProjectLeave = await fixture.bob.team.request(
    "GET",
    `/v1/teams/${teamId}/membership`,
    { expectedStatus: 200 }
  );
  const member = (
    membershipAfterProjectLeave.body as {
      membership: { status: string; version: number };
    }
  ).membership;
  assert.equal(
    member.status,
    "enabled",
    "Project leave preserves global Team membership"
  );
  const frozenEvidence = await assertTeamRecall(fixture, fixture.alice, bob);

  const leaveTeamBody = { expectedVersion: member.version };
  const teamApproval = await fixture.approveActionGrant(fixture.bob, {
    action: "team.leave",
    teamId,
    body: leaveTeamBody
  });
  assert.equal(teamApproval.status.approvalTier, "native_review");
  const leftTeam = await fixture.bob.team.request(
    "POST",
    `/v1/teams/${teamId}/leave`,
    {
      body: leaveTeamBody,
      headers: { "x-koed-action-grant": teamApproval.secret },
      expectedStatus: 200
    }
  );
  assert.equal(
    (leftTeam.body as { membership: { status: string } }).membership.status,
    "disabled"
  );
  const retainedEvidence = await assertTeamRecall(fixture, fixture.alice, bob);
  const postLeaveAdvance = await assertFrozenAfterLaterSource(
    fixture,
    fixture.bob,
    fixture.alice,
    bob,
    fixture.ids.bobPersonalProjectId
  );
  const localReconcile = await fixture.bob.personalEdge.request(
    "POST",
    `/v1/local-edge/projects/${fixture.ids.bobPersonalProjectId}/workspace-project-reconcile`,
    { body: {}, expectedStatus: 200 }
  );
  assert.equal((localReconcile.body as { cleared: boolean }).cleared, true);
  const ownSession = await fixture.personalDb(fixture.bob).query<{
    automatic_personal_project_id: string | null;
    project_override_personal_project_id: string | null;
  }>(
    `select automatic_personal_project_id,project_override_personal_project_id
       from sessions where id=$1 and owner_user_id=$2`,
    [bob.sessionId, fixture.bob.id]
  );
  assert.equal(ownSession.rows.length, 1);
  assert.equal(ownSession.rows[0]?.automatic_personal_project_id, null);
  assert.equal(ownSession.rows[0]?.project_override_personal_project_id, null);
  const bobDenied = await fixture.bob.team.request(
    "POST",
    "/v1/memory/answer",
    {
      body: {
        query: bob.summaryText,
        search_domain: "global",
        team_workspace_id: fixture.ids.workspaceId,
        retrieval_stage: "scoped_leaf_search"
      },
      expectedStatus: [401, 403]
    }
  );
  assert.ok([401, 403].includes(bobDenied.status));
  fixture.results.record("I713.11", {
    bobGrantId: bob.grantId,
    membershipAfterProjectLeave: member.status,
    membershipAfterTeamLeave: "disabled",
    retainedEvidence,
    bobTeamRecallStatus: bobDenied.status,
    postLeaveAdvance
  });
  fixture.results.record("I713.11.project-leave", {
    bobGrantId: bob.grantId,
    frozenEvidence,
    globalMembershipPreserved: true
  });
}

type OwnedWorld = {
  teamId: string;
  workspaceId: string;
  projectId: string;
  personalProjectId: string;
};

const createBobOwnedWorld = async (
  fixture: Hq713Fixture
): Promise<OwnedWorld> => {
  const name = `HQ713 copy-back ${randomUUID()}`;
  const teamBody = { name };
  const teamApproval = await fixture.approveActionGrant(fixture.bob, {
    action: "team.create",
    body: teamBody
  });
  const team = await fixture.bob.team.request("POST", "/v1/teams", {
    body: teamBody,
    headers: {
      "x-koed-action-grant": teamApproval.secret,
      "idempotency-key": randomUUID()
    },
    expectedStatus: 200
  });
  const createdTeam = team.body as {
    team: { id: string };
    defaultWorkspace: { id: string };
  };
  const teamId = createdTeam.team.id;
  const workspaceId = createdTeam.defaultWorkspace.id;
  const local = await fixture.bob.personal.request("POST", "/v1/projects", {
    body: { name: "Bob copy-back", idempotencyKey: randomUUID() },
    expectedStatus: 201
  });
  const personalProjectId = (local.body as { id: string }).id;
  const shareAttemptKey = randomUUID();
  const prepared = await fixture.bob.personalEdge.request<{
    snapshot: {
      personalProjectVersion: number;
      workItems: unknown[];
      sources: unknown[];
      decks: unknown[];
    };
  }>(
    "POST",
    `/v1/local-edge/projects/${personalProjectId}/workspace-project-prepare`,
    {
      body: {
        teamBackendId: fixture.teamBackendId,
        shareAttemptKey,
        targetTeamId: teamId,
        targetWorkspaceId: workspaceId
      },
      expectedStatus: 200
    }
  );
  assert.ok(prepared.body);
  const project = await fixture.bob.team.request(
    "POST",
    "/v1/workspace-projects",
    {
      body: {
        teamId,
        workspaceId,
        name: "Bob copy-back",
        key: `COPY${randomUUID().slice(0, 8)}`,
        shareAttemptKey
      },
      expectedStatus: 201
    }
  );
  const createdProject = project.body as { id: string; version: number };
  const source = prepared.body.snapshot;
  const copied = await fixture.bob.team.request(
    "POST",
    `/v1/workspace-projects/${createdProject.id}/first-share-copy`,
    {
      body: {
        expectedVersion: createdProject.version,
        personalProjectVersion: source.personalProjectVersion,
        workItems: source.workItems,
        sources: source.sources,
        decks: source.decks
      },
      expectedStatus: 200
    }
  );
  assert.ok((copied.body as { copiedAt: string | null }).copiedAt);
  const confirmed = await fixture.bob.personalEdge.request(
    "POST",
    `/v1/local-edge/projects/${personalProjectId}/workspace-project-confirm`,
    {
      body: {
        teamBackendId: fixture.teamBackendId,
        workspaceProjectId: createdProject.id,
        expectedPersonalProjectVersion: source.personalProjectVersion
      },
      expectedStatus: 200
    }
  );
  assert.ok(confirmed.body);
  const link = await fixture.bob.personal.request(
    "GET",
    `/v1/projects/${personalProjectId}/workspace-project-link`,
    { expectedStatus: 200 }
  );
  assert.equal(
    (link.body as { workspaceProjectId: string }).workspaceProjectId,
    createdProject.id
  );
  return {
    teamId,
    workspaceId,
    projectId: createdProject.id,
    personalProjectId
  };
};

/** Step 14 and I25: exact owned-set approval, recovery, and idempotent copy. */
export async function runHq713OwnedLeave(fixture: Hq713Fixture): Promise<void> {
  const owned = await createBobOwnedWorld(fixture);
  const item = await fixture.bob.team.request(
    "POST",
    `/v1/workspace-projects/${owned.projectId}/work-items`,
    {
      body: {
        idempotencyKey: randomUUID(),
        kind: "todo",
        title: "Copy this owned task",
        goal: "Retain it in Bob's Personal Project"
      },
      expectedStatus: 201
    }
  );
  const itemId = (item.body as { id: string }).id;
  const stagePath = "/v1/local-edge/workspace-project-team-leave-stage";
  const stageBody = {
    teamBackendId: fixture.teamBackendId,
    teamId: owned.teamId
  };
  const refused = await fixture.bob.personalEdge.request("POST", stagePath, {
    body: stageBody,
    expectedStatus: [403, 409]
  });
  assert.match(JSON.stringify(refused.body), /last.*owner|owner.*leave/i);
  const noCopy = await fixture.personalDb(fixture.bob).query<{ n: string }>(
    `select count(*)::text as n from personal_workspace_project_copyback_stages
      where workspace_project_id=$1`,
    [owned.projectId]
  );
  assert.equal(
    Number(noCopy.rows[0]?.n),
    0,
    "Last-owner refusal precedes copy-back"
  );
  const stillActive = await fixture.bob.team.request(
    "GET",
    `/v1/workspace-projects/${owned.projectId}/lifecycle`,
    { expectedStatus: 200 }
  );
  assert.equal((stillActive.body as { active: boolean }).active, true);

  const inviteProject = await fixture.bob.team.request(
    "GET",
    `/v1/workspace-projects/${owned.projectId}/lifecycle`,
    { expectedStatus: 200 }
  );
  const unjoinedProof = await fixture.alice.team.request(
    "GET",
    `/v1/workspace-projects/${owned.projectId}/member-link-proof`,
    { expectedStatus: 403 }
  );
  assert.equal(unjoinedProof.status, 403);
  const invitation = {
    defaultTeamWorkspaceId: owned.workspaceId,
    workspaceProjectId: owned.projectId,
    expectedWorkspaceProjectVersion: (inviteProject.body as { version: number })
      .version,
    defaultWorkspaceAccess: "write",
    email: fixture.alice.email,
    role: "member",
    ttlHours: 24
  };
  const inviteApproval = await fixture.approveActionGrant(fixture.bob, {
    action: "team.invite.create",
    teamId: owned.teamId,
    body: invitation
  });
  const invite = await fixture.bob.team.request(
    "POST",
    `/v1/teams/${owned.teamId}/invites`,
    {
      body: invitation,
      headers: { "x-koed-action-grant": inviteApproval.secret },
      expectedStatus: 200
    }
  );
  const acceptedBody = {
    inviteToken: (invite.body as { inviteToken: string }).inviteToken
  };
  const acceptApproval = await fixture.approveActionGrant(fixture.alice, {
    action: "team.invite.accept",
    body: acceptedBody
  });
  await fixture.alice.team.request("POST", "/v1/team-invites/accept", {
    body: acceptedBody,
    headers: { "x-koed-action-grant": acceptApproval.secret },
    expectedStatus: 200
  });
  await fixture.alice.team.request(
    "POST",
    `/v1/workspace-projects/${owned.projectId}/join`,
    { expectedStatus: 200 }
  );
  const joinedProof = await fixture.alice.team.request(
    "GET",
    `/v1/workspace-projects/${owned.projectId}/member-link-proof`,
    { expectedStatus: 200 }
  );
  assert.equal(
    (joinedProof.body as { memberUserId: string }).memberUserId,
    fixture.alice.teamUserId
  );
  const aliceMember = await fixture.alice.team.request(
    "GET",
    `/v1/teams/${owned.teamId}/membership`,
    { expectedStatus: 200 }
  );
  const version = (aliceMember.body as { membership: { version: number } })
    .membership.version;
  const roleBody = { role: "owner", expectedVersion: version };
  const transferApproval = await fixture.approveActionGrant(fixture.bob, {
    action: "team.member.role_update",
    teamId: owned.teamId,
    userId: fixture.alice.teamUserId,
    body: roleBody
  });
  await fixture.bob.team.request(
    "PATCH",
    `/v1/teams/${owned.teamId}/members/${fixture.alice.teamUserId}/role`,
    {
      body: roleBody,
      headers: { "x-koed-action-grant": transferApproval.secret },
      expectedStatus: 200
    }
  );
  const staleStage = await fixture.bob.personalEdge.request("POST", stagePath, {
    body: stageBody,
    expectedStatus: 200
  });
  const staleReview = staleStage.body as {
    expectedTeamVersion: number;
    expectedMembershipVersion: number;
    expectedOwnedWorkspaceProjects: Array<{ id: string; version: number }>;
    copyManifestHash: string;
  };
  const staleBody = {
    expectedVersion: staleReview.expectedMembershipVersion,
    expectedTeamVersion: staleReview.expectedTeamVersion,
    expectedOwnedWorkspaceProjects: staleReview.expectedOwnedWorkspaceProjects,
    copyManifestHash: staleReview.copyManifestHash
  };
  const staleApproval = await fixture.approveActionGrant(fixture.bob, {
    action: "team.leave",
    teamId: owned.teamId,
    body: staleBody
  });
  assert.equal(staleApproval.status.approvalTier, "step_up");
  await fixture.bob.team.request(
    "POST",
    `/v1/workspace-projects/${owned.projectId}/work-items`,
    {
      body: {
        idempotencyKey: randomUUID(),
        kind: "todo",
        title: "Changed after leave review",
        goal: "Force exact owned Project version revalidation"
      },
      expectedStatus: 201
    }
  );
  const staleUse = await fixture.bob.team.request(
    "POST",
    `/v1/teams/${owned.teamId}/leave`,
    {
      body: staleBody,
      headers: { "x-koed-action-grant": staleApproval.secret },
      expectedStatus: [403, 409]
    }
  );
  assert.ok([403, 409].includes(staleUse.status));
  const stillUncopied = await fixture
    .personalDb(fixture.bob)
    .query<{ n: string }>(
      `select count(*)::text as n from personal_workspace_project_copyback_stages
      where workspace_project_id=$1`,
      [owned.projectId]
    );
  assert.equal(Number(stillUncopied.rows[0]?.n), 0);
  const stage = await fixture.bob.personalEdge.request("POST", stagePath, {
    body: stageBody,
    expectedStatus: 200
  });
  const reviewed = stage.body as typeof staleReview;
  assert.notEqual(reviewed.copyManifestHash, staleReview.copyManifestHash);
  assert.deepEqual(
    reviewed.expectedOwnedWorkspaceProjects.map((row) => row.id),
    [owned.projectId]
  );
  assert.match(reviewed.copyManifestHash, /^[0-9a-f]{64}$/);
  const approvedBody = {
    expectedVersion: reviewed.expectedMembershipVersion,
    expectedTeamVersion: reviewed.expectedTeamVersion,
    expectedOwnedWorkspaceProjects: reviewed.expectedOwnedWorkspaceProjects,
    copyManifestHash: reviewed.copyManifestHash
  };
  const leaveApproval = await fixture.approveActionGrant(fixture.bob, {
    action: "team.leave",
    teamId: owned.teamId,
    body: approvedBody
  });
  assert.equal(leaveApproval.status.approvalTier, "step_up");
  const preparedLeave = await fixture.bob.team.request(
    "POST",
    `/v1/teams/${owned.teamId}/leave`,
    {
      body: approvedBody,
      headers: { "x-koed-action-grant": leaveApproval.secret },
      expectedStatus: 200
    }
  );
  const operation = (
    preparedLeave.body as {
      operation: {
        operationId: string;
        continuation: string;
        copyManifestHash: string;
        state: string;
      };
    }
  ).operation;
  assert.equal(operation.state, "prepared");
  assert.equal(operation.copyManifestHash, reviewed.copyManifestHash);
  // Simulate process interruption at the durable prepared boundary. Recovery
  // is a read-only HTTP operation; no second leave mutation is issued.
  const recovered = await fixture.bob.team.request(
    "POST",
    `/v1/teams/${owned.teamId}/leave-operations/recover`,
    {
      body: { operationIds: [operation.operationId], includePrepared: true },
      expectedStatus: 200
    }
  );
  assert.ok(JSON.stringify(recovered.body).includes(operation.operationId));
  const copyBody = {
    ...stageBody,
    operationId: operation.operationId,
    continuation: operation.continuation,
    copyManifestHash: operation.copyManifestHash
  };
  const firstCopy = await fixture.bob.personalEdge.request(
    "POST",
    "/v1/local-edge/workspace-project-team-leave-copy",
    { body: copyBody, expectedStatus: 200 }
  );
  const copied = firstCopy.body as {
    stages: Array<{ workspaceProjectId: string; stageId: string }>;
  };
  assert.equal(copied.stages.length, 1);
  assert.equal(copied.stages[0]?.workspaceProjectId, owned.projectId);
  assert.ok(copied.stages[0]?.stageId);
  const secondCopy = await fixture.bob.personalEdge.request(
    "POST",
    "/v1/local-edge/workspace-project-team-leave-copy",
    { body: copyBody, expectedStatus: 200 }
  );
  assert.deepEqual(
    (secondCopy.body as { stages: unknown[] }).stages,
    copied.stages
  );
  const finished = await fixture.bob.team.request(
    "POST",
    `/v1/teams/${owned.teamId}/leave-operations/${operation.operationId}/finish`,
    {
      body: {
        continuation: operation.continuation,
        copyManifestHash: operation.copyManifestHash
      },
      expectedStatus: 200
    }
  );
  assert.ok(finished.body);
  const activated = await fixture.bob.personalEdge.request(
    "POST",
    "/v1/local-edge/workspace-project-team-leave-finish",
    {
      body: {
        ...copyBody,
        stageIds: [copied.stages[0]!.stageId]
      },
      expectedStatus: 200
    }
  );
  assert.ok(activated.body);
  const personalCopy = await fixture.personalDb(fixture.bob).query<{
    n: string;
  }>(`select count(*)::text as n from project_work_items where project_id=$1 and title=$2`, [owned.personalProjectId, "Copy this owned task"]);
  assert.equal(
    Number(personalCopy.rows[0]?.n),
    1,
    "Owned Work Item copies back once"
  );
  const itemProof = await fixture.team.db.query<{ lifecycle: string }>(
    "select lifecycle from workspace_projects where id=$1",
    [owned.projectId]
  );
  assert.equal(itemProof.rows[0]?.lifecycle, "deleted");
  const links = await fixture.team.db.query<{ access: string }>(
    "select access from workspace_project_members where workspace_project_id=$1",
    [owned.projectId]
  );
  assert.ok(links.rows.length >= 2);
  assert.ok(links.rows.every((row) => row.access === "disabled"));
  fixture.results.record("I713.14", {
    teamId: owned.teamId,
    ownedProjectId: owned.projectId,
    workItemId: itemId,
    recoveredOperationId: operation.operationId,
    stageId: copied.stages[0]!.stageId,
    personalCopies: Number(personalCopy.rows[0]?.n),
    lastOwnerStatus: refused.status
  });
  fixture.results.record("I25", {
    ownedProjectId: owned.projectId,
    lastOwnerRejectedBeforeCopy: true,
    staleReviewStatus: staleUse.status,
    readOnlyRecovery: true,
    copyBackIdempotent: true
  });
}
