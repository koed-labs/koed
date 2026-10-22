import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { Hq713Actor, Hq713Fixture } from "./hq713-fixture.js";
import {
  answerTeam,
  teamEvidenceForGrant,
  waitForHq713TeamEmbedding
} from "./hq713-memory.js";

type PolicyScope = "team" | "workspace";

type PolicyState = {
  policy_id: string;
  version: number;
  maximum_fidelity: string;
  include_curated_memory: boolean;
};

type GrantState = {
  id: string;
  grant_version: number;
  lifecycle: string;
  source_revision: string;
  include_curated_memory: boolean;
  team_policy_id: string;
  team_policy_version: number;
  workspace_policy_id: string;
  workspace_policy_version: number;
  frozen_at: Date | null;
  freeze_manifest_hash: string | null;
  freeze_representation_count: number | null;
  revoked_at: Date | null;
};

const policyState = async (
  fixture: Hq713Fixture,
  scope: PolicyScope
): Promise<PolicyState> => {
  const table =
    scope === "team"
      ? "team_representation_policies"
      : "workspace_representation_policies";
  const rows = await fixture.team.db.query<PolicyState>(
    `select policy_id,version,maximum_fidelity,include_curated_memory
       from ${table}
      where team_id=$1 ${scope === "workspace" ? "and team_workspace_id=$2" : ""}
        and superseded_at is null`,
    scope === "workspace"
      ? [fixture.ids.teamId, fixture.ids.workspaceId]
      : [fixture.ids.teamId]
  );
  assert.equal(rows.rows.length, 1, `${scope} policy must be unique`);
  return rows.rows[0]!;
};

const grantState = async (
  fixture: Hq713Fixture,
  grantId: string
): Promise<GrantState> => {
  const rows = await fixture.team.db.query<GrantState>(
    `select id,grant_version,lifecycle,source_revision::text,
            include_curated_memory,team_policy_id,team_policy_version,
            workspace_policy_id,workspace_policy_version,frozen_at,
            freeze_manifest_hash,freeze_representation_count,revoked_at
       from team_memory_share_grants where id=$1`,
    [grantId]
  );
  assert.equal(rows.rows.length, 1, "Exact Team grant must exist");
  return rows.rows[0]!;
};

/** Bounded state only; never include source material, credentials, or error text. */
const continuousPublicationDiagnostic = async (
  fixture: Hq713Fixture,
  input: { grantId: string; logicalMemoryId: string }
) => {
  const target = await fixture.team.db.query<{
    state: string;
    source_cursor: string;
    target_processing_cursor: string;
    last_error_class: string | null;
  }>(
    `select state,source_cursor::text,target_processing_cursor::text,last_error_class
       from cross_identity_sync_relationships
      where logical_memory_id=$1 and side='target' and local_user_id=$2
      order by created_at desc limit 1`,
    [input.logicalMemoryId, fixture.bob.teamUserId]
  );
  const replica = await fixture.team.db.query<{
    latest_revision: string;
    freshness_status: string;
  }>(
    `select latest_revision::text,freshness_status from memory_replicas
      where id=(select remote_replica_id from team_memory_share_grants where id=$1)`,
    [input.grantId]
  );
  const logical = await fixture.team.db.query<{
    latest_source_revision: string;
  }>(`select latest_source_revision::text from logical_memories where id=$1`, [
    input.logicalMemoryId
  ]);
  const bindings = await fixture.team.db.query<{
    source_revision: string;
    source_kind: string;
    source_session_id: string | null;
  }>(
    `select source_revision::text,source_kind,source_session_id
       from logical_memory_source_revision_bindings
      where logical_memory_id=$1
      order by source_revision desc limit 6`,
    [input.logicalMemoryId]
  );
  const representations = await fixture.team.db.query<{
    representation: string;
    source_revision: string;
    state: string;
  }>(
    `select representation,source_revision::text,state
       from team_memory_representations
      where share_grant_id=$1
      order by source_revision desc,created_at desc limit 6`,
    [input.grantId]
  );
  const previews = await fixture.team.db.query<{
    representation: string;
    source_revision: string;
    status: string;
    failure_code: string | null;
    last_error_class: string | null;
  }>(
    `select representation,source_revision::text,status,failure_code,last_error_class
       from shared_source_semantic_previews
      where logical_memory_id=$1 and owner_user_id=$2
      order by source_revision desc,created_at desc limit 6`,
    [input.logicalMemoryId, fixture.bob.teamUserId]
  );
  const inbox = await fixture.team.db.query<{
    state: string;
    attempt_count: number;
    max_attempts: number;
    last_error_message: string | null;
  }>(
    `select entry.state,entry.attempt_count,entry.max_attempts,
            entry.last_error_message
       from sync_inbox_entries entry
       join cross_identity_sync_relationships relationship
         on relationship.id=entry.sync_relationship_id
      where relationship.logical_memory_id=$1 and relationship.side='target'
      order by entry.created_at desc limit 4`,
    [input.logicalMemoryId]
  );
  return {
    target: target.rows[0] ?? null,
    replica: replica.rows[0] ?? null,
    logical: logical.rows[0] ?? null,
    bindings: bindings.rows,
    representations: representations.rows,
    previews: previews.rows,
    inbox: inbox.rows,
    continuousPublicationErrors: fixture
      .apiErrors()
      .filter((entry) => entry.path === "continuous-publication")
      .slice(-4)
      .map(({ errorName, message, stack }) => ({
        errorName,
        message,
        location: stack?.match(/shared-memory-repository\.ts:\d+/)?.[0] ?? null
      }))
  };
};

const grantRead = (
  fixture: Hq713Fixture,
  actor: Hq713Actor,
  grantId: string,
  representation: "lcm_leaves" | "curated_assertions"
) =>
  actor.team.request(
    "GET",
    `/v1/shared-memory/teams/${fixture.ids.teamId}/workspaces/${fixture.ids.workspaceId}/share-grants/${grantId}?representation=${representation}`
  );

const summaryRecall = async (
  fixture: Hq713Fixture,
  grantId: string,
  marker: string
) => {
  const answer = await answerTeam(
    fixture,
    fixture.alice,
    marker,
    "scoped_leaf_search"
  );
  assert.ok(
    teamEvidenceForGrant(answer, grantId).some((item) =>
      String(item.summaryText).includes(marker)
    ),
    `Previously published summary ${grantId} must remain recallable`
  );
};

const publishSummary = async (
  fixture: Hq713Fixture,
  marker: string,
  sourceItemCount = 1
) => {
  const captured = await fixture.seedCapturedSession(fixture.bob, {
    projectId: fixture.ids.bobPersonalProjectId,
    sessionLabel: marker,
    sourceItemCount
  });
  const shared = await fixture.shareCapturedSession(fixture.bob, {
    sessionId: captured.sessionId,
    workspaceProjectId: fixture.ids.workspaceProjectId,
    teamWorkspaceId: fixture.ids.workspaceId,
    summaryText: marker,
    includeCuratedMemory: false
  });
  await waitForHq713TeamEmbedding(fixture, shared.grantId, "lcm_leaves");
  await summaryRecall(fixture, shared.grantId, marker);
  const grant = await grantState(fixture, shared.grantId);
  assert.equal(grant.include_curated_memory, false);
  assert.equal(grant.lifecycle, "active");
  return { ...captured, ...shared, marker, grant };
};

/** The real Personal delete coordinator requests and consumes a Native grant freeze. */
const freezeByChatDeletion = async (
  fixture: Hq713Fixture,
  input: { sessionId: string; grantId: string }
): Promise<GrantState> => {
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
    await fixture.bob.personal.request<DeleteStatus>(
      "DELETE",
      `/v1/memory/graph/sessions/${input.sessionId}`,
      { body: { batchId }, expectedStatus: [200, 202] }
    )
  ).body;
  const reviewed = new Set<string>();
  for (let attempt = 0; attempt < 8 && !deletion.complete; attempt++) {
    for (const review of deletion.pendingReviews) {
      assert.equal(review.backendId, fixture.teamBackendId);
      assert.equal(review.shareGrantId, input.grantId);
      if (reviewed.has(review.actionGrantId)) continue;
      reviewed.add(review.actionGrantId);
      const reservation = await fixture.bob.personalEdge.request(
        "GET",
        `/v1/memory/graph/sessions/${input.sessionId}/delete-reviews/${review.actionGrantId}?batchId=${batchId}`,
        { expectedStatus: 200 }
      );
      assert.equal(
        (reservation.body as { shareGrantId: string }).shareGrantId,
        input.grantId
      );
      const confirmed = await fixture.localCommand(
        fixture.bob,
        "collaboration.confirm_action_grant",
        { actionGrant: { id: review.actionGrantId }, decision: "approve" }
      );
      assert.equal(
        (confirmed.data as { status: { state: string } }).status.state,
        "approved"
      );
    }
    deletion = (
      await fixture.bob.personal.request<DeleteStatus>(
        "POST",
        `/v1/memory/graph/sessions/${input.sessionId}/delete-progress`,
        { body: { batchId }, expectedStatus: [200, 202] }
      )
    ).body;
  }
  assert.equal(deletion.complete, true, "Real Native freeze must finish");
  assert.ok(reviewed.size > 0, "Native review of exact grant is required");
  const frozen = await grantState(fixture, input.grantId);
  assert.ok(frozen.frozen_at instanceof Date);
  assert.match(frozen.freeze_manifest_hash ?? "", /^[0-9a-f]{64}$/);
  assert.ok((frozen.freeze_representation_count ?? 0) > 0);
  assert.equal(frozen.revoked_at, null);
  return frozen;
};

export type Hq713PriorSummaryGrants = Awaited<
  ReturnType<typeof prepareHq713PriorSummaryGrants>
>;

/** Establish active, frozen and revoked summary grants before administrator opt-in. */
export async function prepareHq713PriorSummaryGrants(fixture: Hq713Fixture) {
  const prefix = `hq713-before-curated-${randomUUID()}`;
  const active = await publishSummary(fixture, `${prefix}-active`, 2);
  const frozen = await publishSummary(fixture, `${prefix}-frozen`);
  const revoked = await publishSummary(fixture, `${prefix}-revoked`);
  const frozenAfter = await freezeByChatDeletion(fixture, frozen);
  assert.equal(frozenAfter.source_revision, frozen.grant.source_revision);
  await fixture.makeChatPrivate(fixture.bob, {
    sessionId: revoked.sessionId,
    grantId: revoked.grantId,
    projectId: fixture.ids.bobPersonalProjectId
  });
  const revokedAfter = await grantState(fixture, revoked.grantId);
  assert.ok(revokedAfter.revoked_at instanceof Date);
  const postRevocation = await grantRead(
    fixture,
    fixture.alice,
    revoked.grantId,
    "lcm_leaves"
  );
  assert.ok([403, 404].includes(postRevocation.status));
  return {
    active,
    frozen: { ...frozen, grant: frozenAfter },
    revoked: { ...revoked, grant: revokedAfter }
  };
}

/** Each administrator approves its own immutable Team or Workspace policy change. */
export async function optInHq713CuratedPolicies(fixture: Hq713Fixture) {
  const beforeTeam = await policyState(fixture, "team");
  const beforeWorkspace = await policyState(fixture, "workspace");
  assert.equal(beforeTeam.include_curated_memory, false);
  assert.equal(beforeWorkspace.include_curated_memory, false);
  const changed = [] as Array<{ scope: PolicyScope; version: number }>;
  const approvals = new Set<string>();
  for (const scope of ["team", "workspace"] as const) {
    const before = scope === "team" ? beforeTeam : beforeWorkspace;
    const mutationId = randomUUID();
    const path =
      scope === "team"
        ? `/v1/shared-memory/teams/${fixture.ids.teamId}/policy/curated-opt-in`
        : `/v1/shared-memory/teams/${fixture.ids.teamId}/workspaces/${fixture.ids.workspaceId}/policy/curated-opt-in`;
    const body = {
      mutationId,
      policyId: before.policy_id,
      expectedCurrentVersion: before.version,
      maximumFidelity: before.maximum_fidelity,
      includeCuratedMemory: true,
      authority: {
        action: "workspace.memory.share_owned",
        source: "device_action_grant",
        referenceId: ""
      }
    };
    const approved = await fixture.approveActionGrant(fixture.alice, {
      action:
        scope === "team"
          ? "shared_memory.team_policy.curated_opt_in"
          : "shared_memory.workspace_policy.curated_opt_in",
      teamId: fixture.ids.teamId,
      ...(scope === "workspace"
        ? { teamWorkspaceId: fixture.ids.workspaceId }
        : {}),
      mutationId,
      policyId: before.policy_id,
      expectedCurrentVersion: before.version,
      maximumFidelity: before.maximum_fidelity
    });
    assert.equal(
      approved.status.approvalTier,
      "step_up",
      `${scope} Curated opt-in needs its own administrator Step-up`
    );
    assert.ok(approved.status.review, "Exact policy review must be displayed");
    assert.ok(
      !approvals.has(approved.clientRequestId),
      "Team and Workspace require distinct administrator approvals"
    );
    approvals.add(approved.clientRequestId);
    body.authority.referenceId = approved.clientRequestId;
    const response = await fixture.alice.team.request("POST", path, {
      body,
      headers: { "x-koed-action-grant": approved.secret },
      expectedStatus: 200
    });
    const policy = (response.body as { policy: Record<string, unknown> })
      .policy;
    assert.equal(policy.policyId, before.policy_id);
    assert.equal(policy.version, before.version + 1);
    assert.equal(policy.maximumFidelity, before.maximum_fidelity);
    assert.equal(policy.includeCuratedMemory, true);
    const observed = await policyState(fixture, scope);
    assert.equal(observed.policy_id, before.policy_id);
    assert.equal(observed.version, before.version + 1);
    assert.equal(observed.include_curated_memory, true);
    if (scope === "team")
      assert.deepEqual(
        await policyState(fixture, "workspace"),
        beforeWorkspace,
        "Team opt-in must not silently approve Workspace Curated use"
      );
    changed.push({ scope, version: observed.version });
  }
  return changed;
}

/** Opt-in cannot retroactively expand or revive earlier grants. */
export async function assertHq713PriorSummaryGrantsAfterOptIn(
  fixture: Hq713Fixture,
  before: Hq713PriorSummaryGrants,
  excludedCuratedText: string
) {
  for (const source of [before.active, before.frozen, before.revoked]) {
    const current = await grantState(fixture, source.grantId);
    assert.equal(current.id, source.grant.id);
    assert.equal(current.grant_version, source.grant.grant_version);
    assert.equal(current.include_curated_memory, false);
    assert.equal(current.team_policy_id, source.grant.team_policy_id);
    assert.equal(current.team_policy_version, source.grant.team_policy_version);
    assert.equal(current.workspace_policy_id, source.grant.workspace_policy_id);
    assert.equal(
      current.workspace_policy_version,
      source.grant.workspace_policy_version
    );
    assert.equal(current.lifecycle, source.grant.lifecycle);
    assert.equal(current.source_revision, source.grant.source_revision);
    assert.equal(
      current.frozen_at?.getTime(),
      source.grant.frozen_at?.getTime()
    );
    assert.equal(
      current.freeze_manifest_hash,
      source.grant.freeze_manifest_hash
    );
    assert.equal(
      current.freeze_representation_count,
      source.grant.freeze_representation_count
    );
    assert.equal(
      current.revoked_at?.getTime(),
      source.grant.revoked_at?.getTime()
    );
    const curated = await grantRead(
      fixture,
      fixture.alice,
      source.grantId,
      "curated_assertions"
    );
    assert.ok([200, 403, 404].includes(curated.status));
    if (curated.status === 200)
      assert.ok(!JSON.stringify(curated.body).includes(excludedCuratedText));
  }
  await summaryRecall(fixture, before.active.grantId, before.active.marker);
  await summaryRecall(fixture, before.frozen.grantId, before.frozen.marker);
  const revokedRead = await grantRead(
    fixture,
    fixture.alice,
    before.revoked.grantId,
    "lcm_leaves"
  );
  assert.ok(
    [403, 404].includes(revokedRead.status),
    "Administrator opt-in must not reopen a revoked grant"
  );
  const revokedRecall = await answerTeam(
    fixture,
    fixture.alice,
    before.revoked.marker,
    "scoped_leaf_search"
  );
  assert.equal(
    teamEvidenceForGrant(revokedRecall, before.revoked.grantId).length,
    0
  );
  const curatedRecall = await answerTeam(
    fixture,
    fixture.alice,
    excludedCuratedText,
    "curated_memory_search"
  );
  for (const source of [before.active, before.frozen, before.revoked])
    assert.equal(teamEvidenceForGrant(curatedRecall, source.grantId).length, 0);
  const sourceDb = fixture.personalDb(fixture.bob);
  const sourceProgress = async () => {
    const result = await sourceDb.query<{
      state: string;
      source_cursor: string;
    }>(
      `select state,source_cursor::text from cross_identity_sync_relationships
        where logical_memory_id=$1 and side='source' and local_user_id=$2
        order by created_at desc limit 1`,
      [before.active.logicalMemoryId, fixture.bob.id]
    );
    assert.equal(result.rows.length, 1, "Active source sync relationship");
    return result.rows[0]!;
  };
  const sourceBefore = await sourceProgress();
  assert.ok(
    !["paused", "revoked", "failed"].includes(sourceBefore.state),
    "Existing continuous consent must be live before opt-in"
  );
  const advanced = await fixture.advanceCapturedSession(fixture.bob, {
    sessionId: before.active.sessionId,
    projectId: fixture.ids.bobPersonalProjectId,
    sessionLabel: before.active.marker
  });
  assert.ok(advanced.sourceCursor !== null);
  let sourceAfter = await sourceProgress();
  const deadline = Date.now() + 10_000;
  while (
    BigInt(sourceAfter.source_cursor) <= BigInt(sourceBefore.source_cursor) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    sourceAfter = await sourceProgress();
  }
  assert.ok(
    !["paused", "revoked", "failed"].includes(sourceAfter.state),
    "Administrator opt-in must not suspend old summary source"
  );
  assert.ok(
    BigInt(sourceAfter.source_cursor) > BigInt(sourceBefore.source_cursor),
    "Pre-opt-in continuous source consent must still advance"
  );
  const laterSummaryText = advanced.laterSummaryText;
  assert.ok(laterSummaryText.includes(before.active.marker));
  let activeAfterAdvance = await grantState(fixture, before.active.grantId);
  const publicationDeadline = Date.now() + 20_000;
  while (
    BigInt(activeAfterAdvance.source_revision) <=
      BigInt(before.active.grant.source_revision) &&
    Date.now() < publicationDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    activeAfterAdvance = await grantState(fixture, before.active.grantId);
  }
  if (
    BigInt(activeAfterAdvance.source_revision) <=
    BigInt(before.active.grant.source_revision)
  ) {
    const diagnostic = await continuousPublicationDiagnostic(fixture, {
      grantId: before.active.grantId,
      logicalMemoryId: before.active.logicalMemoryId
    });
    assert.fail(
      `Active pre-opt-in Share Grant must publish a later Team source revision: ${JSON.stringify(
        {
          beforeRevision: before.active.grant.source_revision,
          afterRevision: activeAfterAdvance.source_revision,
          source: sourceAfter,
          ...diagnostic
        }
      )}`
    );
  }
  assert.equal(activeAfterAdvance.lifecycle, "active");
  assert.equal(activeAfterAdvance.include_curated_memory, false);
  let laterRecall = await answerTeam(
    fixture,
    fixture.alice,
    laterSummaryText,
    "scoped_leaf_search"
  );
  const recallDeadline = Date.now() + 20_000;
  while (
    !teamEvidenceForGrant(laterRecall, before.active.grantId).some((item) =>
      String(item.summaryText).includes(laterSummaryText)
    ) &&
    Date.now() < recallDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    laterRecall = await answerTeam(
      fixture,
      fixture.alice,
      laterSummaryText,
      "scoped_leaf_search"
    );
  }
  assert.ok(
    teamEvidenceForGrant(laterRecall, before.active.grantId).some((item) =>
      String(item.summaryText).includes(laterSummaryText)
    ),
    "Alice must recall the new Team summary on the original grant"
  );
  const curatedAfterAdvance = await grantRead(
    fixture,
    fixture.alice,
    before.active.grantId,
    "curated_assertions"
  );
  assert.ok([200, 403, 404].includes(curatedAfterAdvance.status));
  if (curatedAfterAdvance.status === 200)
    assert.ok(
      !JSON.stringify(curatedAfterAdvance.body).includes(excludedCuratedText),
      "Continued summary capture must not inherit Curated permission"
    );
  const excludedAfterAdvance = await answerTeam(
    fixture,
    fixture.alice,
    excludedCuratedText,
    "curated_memory_search"
  );
  assert.equal(
    teamEvidenceForGrant(excludedAfterAdvance, before.active.grantId).length,
    0,
    "Active pre-opt-in grant gained Curated recall after source advancement"
  );
  return {
    activeGrantId: before.active.grantId,
    frozenGrantId: before.frozen.grantId,
    revokedGrantId: before.revoked.grantId,
    frozenHash: before.frozen.grant.freeze_manifest_hash,
    frozenSourceRevision: before.frozen.grant.source_revision,
    previousConsentPreserved: true,
    activeSourceAdvanced: true,
    activeTeamRevisionAdvanced: true,
    activeLaterSummaryRecall: true
  };
}
