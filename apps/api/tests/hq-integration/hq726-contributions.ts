import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createMemorySourceRepository } from "@koed/db";
import {
  crossIdentitySyncDeterministicUuid,
  highRiskActionGrantCommitment
} from "@koed/shared";
import type { Hq713Actor, Hq713Fixture } from "./hq713-fixture.js";
import { answerTeam, teamEvidenceForGrant } from "./hq713-memory.js";

type Contribution = { grantId: string; summaryText: string };
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

// Source Access has separate consent and can predate this test. Seed its prior
// committed capability; the test exercises the real reviewed withdrawal only.
const seedExistingTranscriptAccess = async (
  fixture: Hq713Fixture,
  grantId: string
) => {
  const parent = await fixture.team.db.query<{ session_id: string }>(
    `select source_binding.source_session_id as session_id
       from team_memory_share_grants share_grant
       join logical_memory_source_revision_bindings source_binding
         on source_binding.source_revision_id=share_grant.source_revision_id
      where share_grant.id=$1 and share_grant.owner_user_id=$2`,
    [grantId, fixture.bob.teamUserId]
  );
  assert.equal(parent.rows.length, 1);
  const session = parent.rows[0]!;
  assert.ok(session.session_id);
  await fixture.team.db.query(
    `insert into sessions(id,owner_user_id,source_runtime,capture_method,
                          external_session_id)
     values ($1,$2,'codex','api',$3)
     on conflict (id) do nothing`,
    [
      session.session_id,
      fixture.bob.teamUserId,
      `hq726-prior-${session.session_id}`
    ]
  );
  const sourceGenerationId = randomUUID();
  const artifact = await createMemorySourceRepository(
    fixture.team.db
  ).ensureConversationSourceArtifact(
    { userId: fixture.bob.teamUserId },
    {
      sessionId: session.session_id,
      logicalSourceId: randomUUID(),
      sourceGenerationId,
      replicaRole: "origin_local",
      sourceKind: "codex",
      sourceRuntime: "codex",
      externalSessionId: `hq726-prior-${session.session_id}`,
      sourceFingerprint: digest(`hq726-source:${sourceGenerationId}`),
      artifactFormat: "codex_rollout_jsonl",
      artifactFormatVersion: 1,
      sourceAdapterVersion: "codex-transcript-v1",
      journalStartOffset: 0,
      journalStartLine: 0,
      liveStartOffset: 0,
      liveStartLine: 0,
      currentSourceLength: 24,
      sourceCreatedAt: new Date().toISOString(),
      storageProvider: "filesystem",
      storagePrefix: `hq726-source-${sourceGenerationId}`,
      originDeploymentId: `deployment-${sourceGenerationId}`,
      originDeviceId: `device-${sourceGenerationId}`,
      originKeyId: `key-${sourceGenerationId}`,
      originPublicKey: "a".repeat(43),
      redactedSourceLabel: "HQ-726 captured source"
    }
  );
  const headDigest = digest(`hq726-head:${artifact.id}`);
  await fixture.team.db.query(
    `insert into conversation_source_segments
       (artifact_id,segment_index,source_start_offset,source_end_offset,
        source_start_line,source_end_line,plaintext_digest,plaintext_size,
        stored_size,storage_key,storage_provider,signed_manifest,
        origin_signature,manifest_digest,previous_content_digest,content_digest)
     values ($1,0,0,24,0,1,$2,24,24,$3,'filesystem',
             '{"version":1}'::jsonb,$4,$5,null,$6)`,
    [
      artifact.id,
      digest(`hq726-plaintext:${artifact.id}`),
      `${artifact.storagePrefix}/0.jsonl`,
      "a".repeat(86),
      digest(`hq726-manifest:${artifact.id}`),
      headDigest
    ]
  );
  await fixture.team.db.query(
    `update conversation_source_artifacts
        set current_journal_sequence=0,provider_cursor_offset=24,
            provider_cursor_line=1,current_source_length=24,
            lifecycle='finalized',closure_hash=$2,closure_manifest=$3::jsonb,
            closure_signature=$4,finalized_at=now(),source_modified_at=now()
      where id=$1`,
    [
      artifact.id,
      digest(`hq726-closure:${artifact.id}`),
      JSON.stringify({
        version: 1,
        segmentCount: 1,
        chainHeadDigest: headDigest
      }),
      "a".repeat(86)
    ]
  );
  await fixture.team.db.query(
    `insert into team_conversation_source_grants
       (share_grant_id,artifact_id,logical_source_id,source_generation_id,
        owner_user_id,session_id,team_id,team_workspace_id,mode,
        mutation_id,granted_by_user_id,creator_authority)
     select share_grant.id,$2,$3,$4,share_grant.owner_user_id,$5,
            share_grant.team_id,share_grant.team_workspace_id,
            'snapshot',$6,share_grant.owner_user_id,'prior_separate_consent'
       from team_memory_share_grants share_grant
      where share_grant.id=$1 and share_grant.owner_user_id=$7`,
    [
      grantId,
      artifact.id,
      artifact.logicalSourceId,
      artifact.sourceGenerationId,
      session.session_id,
      randomUUID(),
      fixture.bob.teamUserId
    ]
  );
};

const publish = async (
  fixture: Hq713Fixture,
  label: string,
  bound = true
): Promise<Contribution> => {
  const summaryText = `${label}-${randomUUID()}`;
  const source = await fixture.seedCapturedSession(fixture.bob, {
    projectId: fixture.ids.bobPersonalProjectId,
    sessionLabel: summaryText
  });
  const shared = await fixture.shareCapturedSession(fixture.bob, {
    sessionId: source.sessionId,
    ...(bound ? { workspaceProjectId: fixture.ids.workspaceProjectId } : {}),
    teamWorkspaceId: fixture.ids.workspaceId,
    summaryText,
    includeCuratedMemory: false
  });
  return { grantId: shared.grantId, summaryText };
};

const grantVersion = async (fixture: Hq713Fixture, grantId: string) => {
  const result = await fixture.team.db.query<{
    grant_version: number;
    lifecycle: string;
    frozen_at: Date | null;
  }>(
    `select grant_version,lifecycle,frozen_at from team_memory_share_grants where id=$1`,
    [grantId]
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
};

const projectVersion = async (fixture: Hq713Fixture) => {
  const result = await fixture.team.db.query<{ version: number }>(
    `select version from workspace_projects where id=$1`,
    [fixture.ids.workspaceProjectId]
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.version;
};

const recallCount = async (
  fixture: Hq713Fixture,
  actor: Hq713Actor,
  source: Contribution
) =>
  teamEvidenceForGrant(
    await answerTeam(fixture, actor, source.summaryText, "scoped_leaf_search"),
    source.grantId
  ).length;

const contributions = async (fixture: Hq713Fixture) => {
  const response = await fixture.alice.team.request<{
    contributions: {
      shareGrantId: string;
      contributorDisplayName: string;
      groupName: string;
      noLongerInGroup: boolean | null;
      summaries: { text: string }[];
    }[];
  }>(
    "GET",
    `/v1/workspace-projects/${fixture.ids.workspaceProjectId}/contributions`,
    { expectedStatus: 200 }
  );
  return response.body.contributions;
};

export async function runHq726Contributions(
  fixture: Hq713Fixture
): Promise<void> {
  const { teamId, workspaceId, workspaceProjectId } = fixture.ids;
  const active = await publish(fixture, "hq726-active");
  const frozen = await publish(fixture, "hq726-frozen");
  const independent = await publish(fixture, "hq726-independent", false);
  assert.ok((await recallCount(fixture, fixture.alice, active)) > 0);
  assert.ok((await recallCount(fixture, fixture.alice, frozen)) > 0);
  const authorRevoke = async (source: Contribution) =>
    fixture.bob.teamBrowser.request(
      "POST",
      `/v1/shared-memory/share-grants/${source.grantId}/revoke`,
      {
        body: {
          mutationId: randomUUID(),
          teamId,
          teamWorkspaceId: workspaceId,
          expectedGrantVersion: (await grantVersion(fixture, source.grantId))
            .grant_version,
          reasonCode: "author_revoked",
          authority: {
            action: "workspace.memory.share_owned",
            source: "browser_session"
          }
        },
        expectedStatus: 403
      }
    );
  const activeRefusal = await authorRevoke(active);
  assert.match(
    JSON.stringify(activeRefusal.body),
    /stays with it.*Make it private/
  );
  fixture.results.record("I720.2.chat", {
    authorRevokeStatus: activeRefusal.status,
    retainedRecall: (await recallCount(fixture, fixture.alice, active)) > 0
  });

  await seedExistingTranscriptAccess(fixture, active.grantId);
  const priorTranscript = await fixture.team.db.query<{ lifecycle: string }>(
    `select lifecycle from team_conversation_source_grants where share_grant_id=$1`,
    [active.grantId]
  );
  assert.equal(priorTranscript.rows[0]?.lifecycle, "active");
  const transcriptRevokeInput = {
    mutationId: randomUUID(),
    teamId,
    shareGrantId: active.grantId,
    expectedVersion: 1,
    reasonCode: "author_revoked"
  };
  const transcriptRevokeRequestId = randomUUID();
  const transcriptRevokeReview = await fixture.localActionGrant(fixture.bob, {
    intent: "collaboration.revoke_conversation_source",
    commandRequestId: transcriptRevokeRequestId,
    ...transcriptRevokeInput
  });
  const transcriptRevoked = await fixture.localCommand(
    fixture.bob,
    "collaboration.revoke_conversation_source",
    { ...transcriptRevokeInput, actionGrant: transcriptRevokeReview.reference },
    { requestId: transcriptRevokeRequestId }
  );
  assert.equal(transcriptRevoked.ok, true);
  const revokedTranscript = await fixture.team.db.query<{
    lifecycle: string;
    version: number;
  }>(
    `select lifecycle,version from team_conversation_source_grants where share_grant_id=$1`,
    [active.grantId]
  );
  assert.deepEqual(revokedTranscript.rows[0], {
    lifecycle: "revoked",
    version: 2
  });
  const deniedTranscript = await fixture.alice.team.request(
    "GET",
    `/v1/shared-memory/share-grants/${active.grantId}/transcript/manifest`,
    { expectedStatus: [403, 404] }
  );
  assert.ok((await recallCount(fixture, fixture.alice, active)) > 0);
  fixture.results.record("I720.2.transcript", {
    sourceAccessRevoked: true,
    transcriptReadStatus: deniedTranscript.status,
    summaryRetained: true
  });

  const noteText = `hq726-note-${randomUUID()}`;
  const personalNote = await fixture.bob.personal.request<{
    note: {
      noteId: string;
      revision: number;
      revisionId: string;
      memoryEventId: string;
    };
  }>("POST", "/v1/collaboration/personal/notes", {
    body: { bodyText: noteText },
    headers: { "idempotency-key": randomUUID() },
    expectedStatus: 201
  });
  const note = personalNote.body.note;
  const uploaded = await fixture.bob.team.request<{
    id: string;
    version: number;
  }>("POST", `/v1/workspace-projects/${workspaceProjectId}/sources`, {
    body: {
      sourceProjectSourceId: randomUUID(),
      name: "Bob's uploaded Note",
      kind: "note",
      status: "ready",
      personalNoteId: note.noteId,
      personalNoteRevisionId: note.revisionId
    },
    expectedStatus: 201
  });
  const noteShared = await fixture.sharePersonalNote(fixture.bob, {
    noteId: note.noteId,
    noteRevision: note.revision,
    memoryEventId: note.memoryEventId,
    logicalMemoryId: crossIdentitySyncDeterministicUuid({
      protocol: "koed.personal-note-share/v1",
      sourceDeploymentId: fixture.bob.deploymentId,
      sourceOwnerPrincipalId: fixture.bob.id,
      noteId: note.noteId,
      identity: "logical-memory"
    }),
    teamWorkspaceId: workspaceId,
    noteText
  });
  await fixture.bob.team.request(
    "POST",
    `/v1/workspace-projects/${workspaceProjectId}/share-grant-bindings`,
    {
      body: {
        shareGrantId: noteShared.grantId,
        expectedGrantVersion: (await grantVersion(fixture, noteShared.grantId))
          .grant_version,
        workspaceProjectSourceId: uploaded.body.id
      },
      expectedStatus: 201
    }
  );
  const noteContribution: Contribution = {
    grantId: noteShared.grantId,
    summaryText: noteText
  };
  const assertNoteRecall = async (stage: string) => {
    const answer = await fixture.alice.team.request<Record<string, unknown>>(
      "POST",
      "/v1/memory/answer",
      {
        body: {
          query: noteText,
          search_domain: "global",
          team_workspace_id: workspaceId,
          retrieval_stage: "fresh_pending_search"
        },
        expectedStatus: 200
      }
    );
    const hits = teamEvidenceForGrant(answer.body, noteShared.grantId).filter(
      (hit) =>
        hit.sourceType === "memory_event" &&
        hit.retrievalStage === "fresh_pending_search" &&
        typeof hit.summaryText === "string" &&
        hit.summaryText.includes(noteText)
    );
    assert.ok(hits.length > 0, `${stage}: exact Note grant Memory Answer hit`);
    return hits.length;
  };
  const shownNote = (await contributions(fixture)).find(
    (item) => item.shareGrantId === noteShared.grantId
  );
  assert.ok(shownNote?.summaries.some((item) => item.text.includes(noteText)));
  const noteRecallBeforeDelete = await assertNoteRecall(
    "Before source deletion"
  );
  const noteRefusal = await authorRevoke(noteContribution);
  assert.match(
    JSON.stringify(noteRefusal.body),
    /stays with it.*Make it private/
  );
  fixture.results.record("I720.2.note", {
    authorRevokeStatus: noteRefusal.status,
    readOnlyNoteContribution: true
  });
  const deleteBody = {
    expectedProjectVersion: await projectVersion(fixture),
    expectedSourceVersion: uploaded.body.version
  };
  const deleteApproval = await fixture.approveActionGrant(fixture.bob, {
    action: "project_source.team_metadata.delete",
    teamId,
    projectId: workspaceProjectId,
    sourceId: uploaded.body.id,
    body: deleteBody
  });
  await fixture.bob.team.request(
    "POST",
    `/v1/workspace-projects/${workspaceProjectId}/sources/${uploaded.body.id}/delete`,
    {
      body: deleteBody,
      headers: { "x-koed-action-grant": deleteApproval.secret },
      expectedStatus: 200
    }
  );
  const sourceList = await fixture.alice.team.request<{
    items: { id: string }[];
  }>("GET", `/v1/workspace-projects/${workspaceProjectId}/sources`, {
    expectedStatus: 200
  });
  assert.ok(
    sourceList.body.items.every((item) => item.id !== uploaded.body.id)
  );
  assert.ok((await grantVersion(fixture, noteShared.grantId)).frozen_at);
  const retainedNote = (await contributions(fixture)).find(
    (item) => item.shareGrantId === noteShared.grantId
  );
  assert.ok(
    retainedNote?.summaries.some((item) => item.text.includes(noteText))
  );
  const noteRecallAfterDelete = await assertNoteRecall("After source deletion");
  fixture.results.record("I720.5", {
    sourceHidden: true,
    noteGrantFrozen: true,
    retainedNoteContent: true,
    noteRecallBeforeDelete,
    noteRecallAfterDelete,
    sourceId: uploaded.body.id
  });

  const independentBefore = await grantVersion(fixture, independent.grantId);
  const revoked = await fixture.bob.teamBrowser.request(
    "POST",
    `/v1/shared-memory/share-grants/${independent.grantId}/revoke`,
    {
      body: {
        mutationId: randomUUID(),
        teamId,
        teamWorkspaceId: workspaceId,
        expectedGrantVersion: independentBefore.grant_version,
        reasonCode: "author_revoked",
        authority: {
          action: "workspace.memory.share_owned",
          source: "browser_session"
        }
      },
      expectedStatus: 200
    }
  );
  assert.equal(await recallCount(fixture, fixture.alice, independent), 0);
  fixture.results.record("I720.4", {
    revokeStatus: revoked.status,
    recalledAfterRevoke: false
  });

  const review = await fixture.bob.team.request<{
    project: { version: number };
    actorMemberVersion: number;
  }>("GET", `/v1/workspace-projects/${workspaceProjectId}/lifecycle-review`, {
    expectedStatus: 200
  });
  const leaveBody = {
    expectedProjectVersion: review.body.project.version,
    expectedMemberVersion: review.body.actorMemberVersion
  };
  const leaveApproval = await fixture.approveActionGrant(fixture.bob, {
    action: "workspace_project.leave",
    teamId,
    projectId: workspaceProjectId,
    body: leaveBody
  });
  await fixture.bob.team.request(
    "POST",
    `/v1/workspace-projects/${workspaceProjectId}/leave`,
    {
      body: leaveBody,
      headers: { "x-koed-action-grant": leaveApproval.secret },
      expectedStatus: 200
    }
  );
  assert.ok((await grantVersion(fixture, frozen.grantId)).frozen_at);
  assert.ok((await recallCount(fixture, fixture.alice, frozen)) > 0);
  const projectLeft = (await contributions(fixture)).find(
    (item) => item.shareGrantId === frozen.grantId
  );
  assert.ok(projectLeft);
  assert.ok(
    projectLeft.summaries.some((item) => item.text.includes(frozen.summaryText))
  );
  assert.equal(projectLeft.noLongerInGroup, false);
  fixture.results.record("I720.1", {
    retainedRecall: true,
    contributorDisplayName: projectLeft.contributorDisplayName,
    noLongerInGroup: projectLeft.noLongerInGroup
  });
  const frozenRefusal = await authorRevoke(frozen);
  assert.match(
    JSON.stringify(frozenRefusal.body),
    /stays with it.*Make it private/
  );

  const staleBody = {
    mutationId: randomUUID(),
    expectedProjectVersion: await projectVersion(fixture),
    expectedGrantVersion: (await grantVersion(fixture, active.grantId))
      .grant_version
  };
  const route = `/v1/workspace-projects/${workspaceProjectId}/contributions/${active.grantId}/remove`;
  const staleApproval = await fixture.approveActionGrant(fixture.alice, {
    action: "workspace_project.contribution_remove",
    teamId,
    projectId: workspaceProjectId,
    shareGrantId: active.grantId,
    body: staleBody
  });
  await fixture.team.db.query(
    `update workspace_projects set version=version+1 where id=$1`,
    [workspaceProjectId]
  );
  await fixture.alice.team.request("POST", route, {
    body: staleBody,
    headers: { "x-koed-action-grant": staleApproval.secret },
    expectedStatus: 409
  });
  const afterStale = await fixture.team.db.query<{ count: number }>(
    `select count(*)::int as count from audit_events
      where action='workspace_project.contribution_remove' and target_id=$1`,
    [active.grantId]
  );
  assert.equal(afterStale.rows[0]?.count, 0);
  assert.notEqual(
    (await grantVersion(fixture, active.grantId)).lifecycle,
    "revoked"
  );
  const removeBody = {
    ...staleBody,
    mutationId: randomUUID(),
    expectedProjectVersion: await projectVersion(fixture)
  };
  const bobApproval = await fixture.bob.team.request(
    "POST",
    "/v1/high-risk/action-grants",
    {
      body: {
        version: 1,
        clientRequestId: randomUUID(),
        grantCommitment: highRiskActionGrantCommitment(
          `hrg_${randomUUID().replaceAll("-", "")}`
        ),
        intent: {
          action: "workspace_project.contribution_remove",
          teamId,
          projectId: workspaceProjectId,
          shareGrantId: active.grantId,
          body: removeBody
        }
      },
      expectedStatus: 403
    }
  );
  assert.equal(bobApproval.status, 403);
  const ownerApproval = await fixture.approveActionGrant(fixture.alice, {
    action: "workspace_project.contribution_remove",
    teamId,
    projectId: workspaceProjectId,
    shareGrantId: active.grantId,
    body: removeBody
  });
  assert.equal(ownerApproval.status.approvalTier, "native_review");
  const removed = await fixture.alice.team.request("POST", route, {
    body: removeBody,
    headers: { "x-koed-action-grant": ownerApproval.secret },
    expectedStatus: 200
  });
  const replay = await fixture.alice.team.request("POST", route, {
    body: removeBody,
    headers: { "x-koed-action-grant": ownerApproval.secret },
    expectedStatus: 200
  });
  assert.deepEqual(replay.body, removed.body);
  assert.equal(await recallCount(fixture, fixture.alice, active), 0);
  assert.ok((await recallCount(fixture, fixture.alice, frozen)) > 0);
  const noteRecallAfterOtherRemoval = await assertNoteRecall(
    "After another contribution's owner removal"
  );
  const audits = await fixture.team.db.query<{ count: number }>(
    `select count(*)::int as count from audit_events
      where action='workspace_project.contribution_remove' and target_id=$1`,
    [active.grantId]
  );
  assert.equal(audits.rows[0]?.count, 1);
  fixture.results.record("I720.3", {
    removedGrantId: active.grantId,
    recallDenied: true,
    otherContributionRetained: true,
    noteRecallAfterOtherRemoval,
    auditCount: 1,
    replayReceiptUnchanged: true
  });

  const accessMembers = await fixture.alice.team.request<{
    members: {
      userId: string;
      workspaceAccess: {
        teamWorkspaceId: string;
        access: string;
        version: number;
      }[];
    }[];
  }>("GET", `/v1/teams/${teamId}/members/manage`, { expectedStatus: 200 });
  const disabledWorkspaceAccess = accessMembers.body.members
    .find((member) => member.userId === fixture.bob.teamUserId)
    ?.workspaceAccess.find((access) => access.teamWorkspaceId === workspaceId);
  assert.equal(disabledWorkspaceAccess?.access, "disabled");
  assert.ok(disabledWorkspaceAccess);
  const restoreReadBody = {
    userId: fixture.bob.teamUserId,
    access: "read",
    canShareOwnedMemory: false,
    expectedVersion: disabledWorkspaceAccess.version
  };
  const restoreReadApproval = await fixture.approveActionGrant(fixture.alice, {
    action: "team.workspace.access_update",
    teamId,
    teamWorkspaceId: workspaceId,
    body: restoreReadBody
  });
  const restoredRead = await fixture.alice.team.request<{
    access: { access: string; version: number };
  }>("PUT", `/v1/team-workspaces/${workspaceId}/access`, {
    body: restoreReadBody,
    headers: { "x-koed-action-grant": restoreReadApproval.secret },
    expectedStatus: 200
  });
  assert.equal(restoredRead.body.access.access, "read");
  assert.equal(
    restoredRead.body.access.version,
    disabledWorkspaceAccess.version + 1
  );
  const projectMembership = await fixture.team.db.query<{ access: string }>(
    `select project_member.access
       from workspace_project_members project_member
       join team_memberships member on member.id=project_member.team_member_id
      where project_member.workspace_project_id=$1 and member.user_id=$2`,
    [workspaceProjectId, fixture.bob.teamUserId]
  );
  assert.equal(projectMembership.rows[0]?.access, "disabled");
  assert.ok((await grantVersion(fixture, frozen.grantId)).frozen_at);
  const bobAnswer = await answerTeam(
    fixture,
    fixture.bob,
    frozen.summaryText,
    "scoped_leaf_search"
  );
  assert.ok(
    teamEvidenceForGrant(bobAnswer, frozen.grantId).length > 0,
    "Bob must have current Team recall before Agent task acceptance"
  );
  assert.ok(typeof bobAnswer.markdown === "string" && bobAnswer.markdown);
  const taskQuery = frozen.summaryText;
  const taskInput = {
    origin: "mcp",
    invocation_key: `hq726-question-${randomUUID()}`,
    request: {
      input: {
        query: taskQuery,
        search_domain: "global",
        team_workspace_id: workspaceId,
        team_backend_id: fixture.teamBackendId,
        include_evidence: true
      },
      caller: { cwd: "" }
    },
    max_queued: 16
  };

  // The Project leave/removal above changed the Workspace's frozen grant set.
  // This task captures the current authority after Alice restores only
  // Workspace read access, so member disablement causes the commit denial.
  const acceptedTask = await fixture.bob.team.request<{
    task: { id: string };
  }>("POST", "/v1/memory/answer-tasks", {
    body: taskInput,
    expectedStatus: 200
  });
  const taskId = acceptedTask.body.task.id;
  assert.ok(taskId);
  const leaseOwner = `hq726-task-${randomUUID()}`;
  const claimedTask = await fixture.bob.team.request<{
    task: {
      id: string;
      fenceGeneration: number;
      executionAuthority: { scope: string };
    };
  }>("POST", "/v1/memory/answer-tasks/claim", {
    body: {
      scope_filter: "team",
      task_id: taskId,
      lease_owner: leaseOwner,
      lease_ms: 300_000
    },
    expectedStatus: 200
  });
  assert.equal(claimedTask.body.task.id, taskId);
  assert.equal(claimedTask.body.task.executionAuthority.scope, "team");
  const fenceGeneration = claimedTask.body.task.fenceGeneration;
  assert.ok(Number.isSafeInteger(fenceGeneration) && fenceGeneration > 0);
  const beforeDisableTask = await fixture.bob.team.request<{
    task: { id: string; status: string };
  }>("GET", `/v1/memory/answer-tasks/${taskId}`, { expectedStatus: 200 });
  assert.equal(beforeDisableTask.body.task.id, taskId);
  assert.equal(beforeDisableTask.body.task.status, "running");

  const managedMembers = await fixture.alice.team.request<{
    members: { userId: string; version: number; status: string }[];
  }>("GET", `/v1/teams/${teamId}/members/manage`, { expectedStatus: 200 });
  const bobMember = managedMembers.body.members.find(
    (member) => member.userId === fixture.bob.teamUserId
  );
  assert.equal(bobMember?.status, "enabled");
  assert.ok(bobMember);
  const disableBody = { expectedVersion: bobMember.version };
  const disableApproval = await fixture.approveActionGrant(fixture.alice, {
    action: "team.member.disable",
    teamId,
    userId: fixture.bob.teamUserId,
    body: disableBody
  });
  const disabled = await fixture.alice.team.request<{
    membership: { status: string; version: number };
  }>("POST", `/v1/teams/${teamId}/members/${fixture.bob.teamUserId}/disable`, {
    body: disableBody,
    headers: { "x-koed-action-grant": disableApproval.secret },
    expectedStatus: 200
  });
  assert.equal(disabled.body.membership.status, "disabled");
  assert.equal(disabled.body.membership.version, bobMember.version + 1);
  const attemptedCommit = await fixture.bob.team.request(
    "POST",
    `/v1/memory/answer-tasks/${taskId}/complete`,
    {
      body: {
        lease_owner: leaseOwner,
        fence_generation: fenceGeneration,
        final_question: {
          idempotency_key: `hq726-final-${randomUUID()}`,
          query: taskQuery,
          origin: "mcp_memory_answer",
          retrieval_scope: "personal",
          team_workspace_id: workspaceId,
          search_domain: "global",
          status: "answered",
          answer_markdown: bobAnswer.markdown,
          evidence: bobAnswer.evidence,
          citations: bobAnswer.citations,
          retrieval: bobAnswer.retrieval
        },
        result: { markdown: bobAnswer.markdown }
      },
      expectedStatus: [401, 403]
    }
  );
  const uncommitted = await fixture.team.db.query<{
    question_id: string | null;
    status: string;
  }>(
    `select question_id,status from memory_answer_tasks where id=$1 and owner_user_id=$2`,
    [taskId, fixture.bob.teamUserId]
  );
  assert.equal(uncommitted.rows[0]?.question_id, null);
  assert.notEqual(uncommitted.rows[0]?.status, "completed");
  const finalQuestion = await fixture.team.db.query<{ count: number }>(
    `select count(*)::int as count from memory_questions
      where owner_user_id=$1 and idempotency_key=$2`,
    [fixture.bob.teamUserId, `memory-answer-task:${taskId}`]
  );
  assert.equal(finalQuestion.rows[0]?.count, 0);
  const deniedTaskRead = await fixture.bob.team.request(
    "GET",
    `/v1/memory/answer-tasks/${taskId}`,
    { expectedStatus: [401, 403] }
  );
  const deniedNewTask = await fixture.bob.team.request(
    "POST",
    "/v1/memory/answer-tasks",
    {
      body: { ...taskInput, invocation_key: `hq726-after-${randomUUID()}` },
      expectedStatus: [401, 403]
    }
  );
  assert.ok((await recallCount(fixture, fixture.alice, frozen)) > 0);
  const teamLeft = (await contributions(fixture)).find(
    (item) => item.shareGrantId === frozen.grantId
  );
  assert.ok(teamLeft);
  assert.equal(teamLeft.noLongerInGroup, true);
  const bobDenied = await fixture.bob.team.request(
    "POST",
    "/v1/memory/answer",
    {
      body: {
        query: frozen.summaryText,
        search_domain: "global",
        team_workspace_id: workspaceId,
        retrieval_stage: "scoped_leaf_search"
      },
      expectedStatus: [401, 403]
    }
  );
  fixture.results.record("I720.6", {
    retainedRecall: true,
    contributorDisplayName: teamLeft.contributorDisplayName,
    noLongerInGroup: true,
    departedAuthorRecallStatus: bobDenied.status,
    agentCommitDenied: attemptedCommit.status,
    taskReadDenied: deniedTaskRead.status,
    newTaskDenied: deniedNewTask.status,
    currentTeamDisabled: disabled.body.membership.status
  });
}
