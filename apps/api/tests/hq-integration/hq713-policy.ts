import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { crossIdentitySyncDeterministicUuid } from "@koed/shared";
import type { Hq713Actor, Hq713Fixture } from "./hq713-fixture.js";

type JsonObject = Record<string, unknown>;

const object = (value: unknown, label: string): JsonObject => {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    label
  );
  return value as JsonObject;
};

const string = (value: unknown, label: string): string => {
  assert.ok(typeof value === "string" && value.length > 0, label);
  return value;
};

const number = (value: unknown, label: string): number => {
  assert.ok(typeof value === "number" && Number.isSafeInteger(value), label);
  return value;
};

/**
 * Publishes an initial Captured Session through the real Project Share Policy
 * protocol. All policy, approval, issue, and Pending Share transitions use the
 * production HTTP endpoints; the final issue-status poll only observes them.
 */
export async function shareHq713CapturedSessionViaProjectPolicy(
  fixture: Hq713Fixture,
  actor: Hq713Actor,
  input: {
    sessionId: string;
    workspaceProjectId: string;
    teamWorkspaceId: string;
    summaryText: string;
  }
): Promise<{ grantId: string; logicalMemoryId: string }> {
  const personalProjectId =
    actor.name === "alice"
      ? fixture.ids.alicePersonalProjectId
      : fixture.ids.bobPersonalProjectId;
  const expectedLogicalMemoryId = crossIdentitySyncDeterministicUuid({
    protocol: "koed.captured-session-sync/v1",
    sourceDeploymentId: actor.deploymentId,
    sourceUserId: actor.id,
    originSessionId: input.sessionId,
    identity: "logical-memory"
  });
  const projectPath = `/v1/local-edge/projects/${personalProjectId}/project-share-policy`;
  const teamPath = `/v1/workspace-projects/${input.workspaceProjectId}/share-policy`;
  const statusBefore = object(
    (
      await actor.team.request("GET", `${teamPath}/status`, {
        expectedStatus: 200
      })
    ).body,
    "Project policy status"
  );
  assert.equal(
    statusBefore.status,
    "absent",
    "N2 needs a fresh Project policy"
  );
  assert.equal(statusBefore.workspaceId, input.teamWorkspaceId);
  const expectedPolicyVersion = number(
    statusBefore.policyVersion,
    "Project policy version"
  );
  const manifest = object(
    (
      await actor.personalEdge.request("POST", `${projectPath}/manifest`, {
        body: {
          teamBackendId: fixture.teamBackendId,
          workspaceProjectId: input.workspaceProjectId
        },
        expectedStatus: 200
      })
    ).body,
    "Trusted Personal Project manifest"
  );
  const entries = manifest.entries;
  assert.ok(Array.isArray(entries), "Trusted source entries");
  const captured = entries
    .map((entry) => object(entry, "Trusted source entry"))
    .find((entry) => entry.sessionId === input.sessionId);
  if (!captured) {
    const diagnostic = await fixture.personalDb(actor).query<{
      visibility: string;
      assigned_project: string | null;
      source_kind: string | null;
      source_adapter_version: string | null;
      external_session_id: string | null;
      project_assignment_version: number;
      artifact_exists: boolean;
      logical_exists: boolean;
      revision_exists: boolean;
      latest_source_revision: string | null;
    }>(
      `select s.visibility,s.automatic_personal_project_id as assigned_project,
         s.source_kind,s.source_adapter_version,s.external_session_id,
         s.project_assignment_version,
         exists(select 1 from conversation_source_artifacts a
           where a.session_id=s.id and a.owner_user_id=$2 and a.replica_role='origin_local') as artifact_exists,
         exists(select 1 from local_captured_session_logical_memories l
           where l.local_session_id=s.id and l.owner_user_id=$2) as logical_exists,
         exists(select 1 from captured_session_source_revisions r
           where r.source_session_id=s.id) as revision_exists,
         (select m.latest_source_revision::text
            from local_captured_session_logical_memories l
            join logical_memories m on m.id=l.logical_memory_id
           where l.local_session_id=s.id and l.owner_user_id=$2
           limit 1) as latest_source_revision
       from sessions s where s.id=$1 and s.owner_user_id=$2`,
      [input.sessionId, actor.id]
    );
    assert.fail(
      `Exact Captured Session absent from trusted Project manifest: ${JSON.stringify(
        {
          entryCount: entries.length,
          captured: diagnostic.rows[0] ?? null
        }
      )}`
    );
  }
  assert.ok(
    String(captured.reviewLabel).trim().length > 0,
    "Native review must label the exact captured source"
  );
  const logicalMemoryId = string(
    captured.logicalMemoryId,
    "Captured logical memory ID"
  );
  assert.equal(logicalMemoryId, expectedLogicalMemoryId);
  const personalRelationship = await fixture
    .personalDb(actor)
    .query<{ count: string }>(
      `select count(*)::text as count from cross_identity_sync_relationships
      where logical_memory_id=$1`,
      [logicalMemoryId]
    );
  const teamPreApproval = await fixture.team.db.query<{
    relationships: string;
    artifacts: string;
    grants: string;
  }>(
    `select
       (select count(*)::text from cross_identity_sync_relationships
         where logical_memory_id=$1) as relationships,
       (select count(*)::text from shared_source_artifacts
         where logical_memory_id=$1) as artifacts,
       (select count(*)::text from team_memory_share_grants
         where logical_memory_id=$1) as grants`,
    [logicalMemoryId]
  );
  assert.equal(
    Number(personalRelationship.rows[0]?.count),
    0,
    "Native Project policy review must precede cross-identity source sync"
  );
  assert.deepEqual(
    teamPreApproval.rows[0],
    {
      relationships: "0",
      artifacts: "0",
      grants: "0"
    },
    "Team source content and grants must remain absent before Native policy approval"
  );
  const receipt = object(
    (
      await actor.team.request("POST", `${teamPath}/manifests`, {
        body: {
          expectedPolicyVersion,
          personalProjectBindingHash: manifest.personalProjectBindingHash,
          signingPublicKey: manifest.signingPublicKey,
          entries
        },
        expectedStatus: 201
      })
    ).body,
    "Team policy manifest receipt"
  );
  const manifestId = string(receipt.manifestId, "Team manifest ID");
  const manifestHash = string(receipt.manifestHash, "Team manifest hash");
  assert.deepEqual(
    receipt.entries,
    entries,
    "Team receipt must preserve exact source manifest"
  );
  assert.equal(
    receipt.personalProjectBindingHash,
    manifest.personalProjectBindingHash
  );
  assert.equal(receipt.signingPublicKey, manifest.signingPublicKey);
  const reviewQuery = new URLSearchParams({
    expectedPolicyVersion: String(expectedPolicyVersion),
    manifestHash
  });
  const review = object(
    (
      await actor.team.request(
        "GET",
        `${teamPath}/manifests/${manifestId}/review?${reviewQuery}`,
        { expectedStatus: 200 }
      )
    ).body,
    "Exact Team Native review"
  );
  assert.equal(review.manifestId, manifestId);
  assert.equal(review.manifestHash, manifestHash);
  const sources = review.reviewSources;
  assert.ok(Array.isArray(sources), "Team Native review sources");
  assert.ok(
    sources.some((source) => {
      const entry = object(source, "Native review source");
      return (
        entry.sessionId === input.sessionId &&
        entry.reviewLabel === captured.reviewLabel
      );
    }),
    "Team Native review must show the captured source"
  );

  const requestId = randomUUID();
  const intent = {
    intent: "collaboration.project_share_policy_enable",
    commandRequestId: requestId,
    teamId: string(review.teamId, "Policy Team ID"),
    projectId: input.workspaceProjectId,
    expectedPolicyVersion,
    manifestId,
    manifestHash
  };
  const approved = await fixture.localActionGrant(actor, intent);
  assert.deepEqual(
    approved.intent,
    intent,
    "The approved intent must remain exact"
  );
  const grantId = string(
    approved.reference.id,
    "Native Action Grant reference"
  );
  const payload = {
    expectedPolicyVersion,
    manifestId,
    manifestHash,
    signingPublicKey: manifest.signingPublicKey,
    authority: {
      action: "workspace.memory.share_owned",
      source: "device_action_grant",
      referenceId: grantId
    },
    currentEntries: entries
  };
  const action = {
    teamBackendId: fixture.teamBackendId,
    workspaceProjectId: input.workspaceProjectId,
    actionGrant: approved.reference,
    intent,
    payload
  };
  const started = object(
    (
      await actor.personalEdge.request(
        "POST",
        `${projectPath}/attempts/start`,
        {
          body: { ...action, clientRequestId: requestId },
          expectedStatus: 200
        }
      )
    ).body,
    "Durable Personal Project policy attempt"
  );
  assert.equal(started.state, "pending");
  const attemptId = string(started.attemptId, "Project policy attempt ID");
  const consumed = await actor.personalEdge.request(
    "POST",
    `${projectPath}/consume`,
    {
      body: action,
      expectedStatus: 200
    }
  );
  const effect = object(consumed.body, "Team Project policy enable effect");
  assert.equal(effect.version, expectedPolicyVersion + 1);
  const finalized = object(
    (
      await actor.personalEdge.request(
        "POST",
        `${projectPath}/attempts/finalize`,
        {
          body: { attemptId },
          expectedStatus: 200
        }
      )
    ).body,
    "Durable Project policy execution receipt"
  );
  assert.equal(finalized.state, "finalized");
  assert.equal(finalized.action, "enable");
  assert.equal(finalized.version, expectedPolicyVersion + 1);
  const active = object(
    (
      await actor.team.request("GET", `${teamPath}/status`, {
        expectedStatus: 200
      })
    ).body,
    "Active Project policy status"
  );
  assert.equal(active.status, "active");
  assert.equal(active.policyVersion, expectedPolicyVersion + 1);
  assert.equal(active.manifestHash, null);
  const activeSources = active.reviewSources;
  assert.ok(Array.isArray(activeSources), "Active policy review sources");
  assert.ok(
    activeSources.some((source) => {
      const entry = object(source, "Active policy source");
      return (
        entry.sessionId === input.sessionId &&
        entry.reviewLabel === captured.reviewLabel &&
        entry.eligible === true
      );
    }),
    "Activated policy must retain the exact eligible captured source"
  );
  const prepared = object(
    await fixture.localCommand(
      actor,
      "collaboration.prepare_shared_memory_source",
      {
        sessionId: input.sessionId,
        consentedAt: new Date().toISOString()
      }
    ),
    "Approved Project policy source preparation"
  );
  assert.equal(prepared.ok, true);
  const staged = object(
    (
      await actor.personalEdge.request("POST", `${projectPath}/stage-initial`, {
        body: {
          teamBackendId: fixture.teamBackendId,
          workspaceProjectId: input.workspaceProjectId,
          sessionId: input.sessionId,
          expectedPolicyVersion: expectedPolicyVersion + 1
        },
        expectedStatus: 200
      })
    ).body,
    "Policy initial pending share"
  );
  assert.equal(staged.state, "staged");
  const pendingShareId = string(
    staged.pendingShareId,
    "Policy pending share ID"
  );
  const issuePath = `${teamPath}/issues/${input.sessionId}/status?policyVersion=${expectedPolicyVersion + 1}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    const issue = object(
      (
        await actor.team.request("GET", issuePath, {
          expectedStatus: 200
        })
      ).body,
      "Project policy issue status"
    );
    assert.equal(issue.pendingShareId, pendingShareId);
    assert.equal(issue.logicalMemoryId, logicalMemoryId);
    if (issue.state === "activated") {
      return {
        grantId: string(
          issue.shareGrantId,
          "Activated Project policy grant ID"
        ),
        logicalMemoryId
      };
    }
    assert.equal(
      issue.state,
      "staged",
      `Project policy issue stopped: ${String(issue.state)}`
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const pending = await fixture.team.db.query<{
    state: string;
    stage: string;
    source_update_state: string;
    redacted_failure_code: string | null;
  }>(
    `select state,stage,source_update_state,redacted_failure_code
       from pending_share_operations where id=$1`,
    [pendingShareId]
  );
  assert.fail(
    `Project policy Pending Share ${pendingShareId} did not activate: ${JSON.stringify(pending.rows[0] ?? null)}`
  );
}
