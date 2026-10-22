import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  collaborationSnapshotSchema,
  readDesktopLocalCredentialAuthorization,
  readLocalEdgeUpstreamRegistry
} from "@koed/shared";
import { createWorkspaceProjectTransport } from "../../../desktop/src/koed-server/workspace-project-transport.js";
import { createWorkspaceProjectPersonalClient } from "../../../desktop/src/koed-server/workspace-project-personal-client.js";
import { createProjectSharePolicyService } from "../../../desktop/src/koed-server/project-share-policy-service.js";
import { projectShareContextFromAuthority } from "../../../desktop/src/koed-server/workspace-project-share-context.js";
import type { Hq713Fixture } from "./hq713-fixture.js";
import {
  answerTeam,
  teamEvidenceForGrant,
  waitForHq713TeamEmbedding
} from "./hq713-memory.js";

type Json = Record<string, unknown>;
const record = (value: unknown): Json => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Json;
};

/** Empty Native review is enabled before a new captured chat exists. */
export const runHq713FuturePolicy = async (fixture: Hq713Fixture) => {
  const actor = fixture.alice;
  const personalProjectId = fixture.ids.alicePersonalProjectId;
  const workspaceProjectId = fixture.ids.workspaceProjectId;
  const teamPath = `/v1/workspace-projects/${workspaceProjectId}/share-policy`;
  const localPath = `/v1/local-edge/projects/${personalProjectId}/project-share-policy`;
  // Establish the verified checkout before policy enablement through the
  // ordinary capture path. Its source is deleted before Native review, so the
  // initial policy legitimately has an empty eligible manifest.
  const warmup = await fixture.seedCapturedSession(actor, {
    projectId: personalProjectId,
    sessionLabel: `HQ713 pre-policy checkout ${randomUUID()}`
  });
  const deletionBatchId = randomUUID();
  let deletion = record(
    (
      await actor.personal.request(
        "DELETE",
        `/v1/memory/graph/sessions/${warmup.sessionId}`,
        { body: { batchId: deletionBatchId }, expectedStatus: [200, 202] }
      )
    ).body
  );
  assert.equal(deletion.sessionId, warmup.sessionId);
  assert.equal(deletion.batchId, deletionBatchId);
  for (let attempt = 0; attempt < 8 && !deletion.complete; attempt++) {
    assert.deepEqual(
      deletion.pendingReviews,
      [],
      "Unshared warmup must not require a Team grant freeze"
    );
    deletion = record(
      (
        await actor.personal.request(
          "POST",
          `/v1/memory/graph/sessions/${warmup.sessionId}/delete-progress`,
          { body: { batchId: deletionBatchId }, expectedStatus: [200, 202] }
        )
      ).body
    );
  }
  assert.equal(deletion.complete, true);
  assert.deepEqual(deletion.pendingReviews, []);
  const prePolicy = await fixture.personalDb(actor).query<{
    trashed_at: Date | null;
    project_share_capture_policy_version: number | null;
  }>(
    `select trashed_at,project_share_capture_policy_version
       from sessions where id=$1 and owner_user_id=$2`,
    [warmup.sessionId, actor.id]
  );
  assert.ok(prePolicy.rows[0]?.trashed_at instanceof Date);
  assert.equal(prePolicy.rows[0]?.project_share_capture_policy_version, null);
  const absent = record(
    (
      await actor.team.request("GET", `${teamPath}/status`, {
        expectedStatus: 200
      })
    ).body
  );
  assert.equal(absent.status, "absent");
  const policyVersion = Number(absent.policyVersion);
  assert.ok(Number.isInteger(policyVersion));
  const manifest = record(
    (
      await actor.personalEdge.request("POST", `${localPath}/manifest`, {
        body: { teamBackendId: fixture.teamBackendId, workspaceProjectId },
        expectedStatus: 200
      })
    ).body
  );
  assert.deepEqual(
    manifest.entries,
    [],
    "Native review must begin with no source"
  );
  const issued = record(
    (
      await actor.team.request("POST", `${teamPath}/manifests`, {
        body: {
          expectedPolicyVersion: policyVersion,
          personalProjectBindingHash: manifest.personalProjectBindingHash,
          signingPublicKey: manifest.signingPublicKey,
          entries: []
        },
        expectedStatus: 201
      })
    ).body
  );
  const manifestId = String(issued.manifestId);
  const manifestHash = String(issued.manifestHash);
  const query = new URLSearchParams({
    expectedPolicyVersion: String(policyVersion),
    manifestHash
  });
  const review = record(
    (
      await actor.team.request(
        "GET",
        `${teamPath}/manifests/${manifestId}/review?${query}`,
        {
          expectedStatus: 200
        }
      )
    ).body
  );
  assert.deepEqual(review.reviewSources, []);
  const requestId = randomUUID();
  const intent = {
    intent: "collaboration.project_share_policy_enable",
    commandRequestId: requestId,
    teamId: fixture.ids.teamId,
    projectId: workspaceProjectId,
    expectedPolicyVersion: policyVersion,
    manifestId,
    manifestHash
  };
  const approved = await fixture.localActionGrant(actor, intent);
  const payload = {
    expectedPolicyVersion: policyVersion,
    manifestId,
    manifestHash,
    signingPublicKey: manifest.signingPublicKey,
    authority: {
      action: "workspace.memory.share_owned",
      source: "device_action_grant",
      referenceId: approved.reference.id
    },
    currentEntries: []
  };
  const action = {
    teamBackendId: fixture.teamBackendId,
    workspaceProjectId,
    actionGrant: approved.reference,
    intent,
    payload
  };
  const started = record(
    (
      await actor.personalEdge.request("POST", `${localPath}/attempts/start`, {
        body: { ...action, clientRequestId: requestId },
        expectedStatus: 200
      })
    ).body
  );
  assert.equal(started.state, "pending");
  await actor.personalEdge.request("POST", `${localPath}/consume`, {
    body: action,
    expectedStatus: 200
  });
  const finalized = record(
    (
      await actor.personalEdge.request(
        "POST",
        `${localPath}/attempts/finalize`,
        {
          body: { attemptId: started.attemptId },
          expectedStatus: 200
        }
      )
    ).body
  );
  assert.equal(finalized.state, "finalized");
  const active = record(
    (
      await actor.team.request("GET", `${teamPath}/status`, {
        expectedStatus: 200
      })
    ).body
  );
  assert.equal(active.status, "active");
  assert.equal(active.policyVersion, policyVersion + 1);
  assert.deepEqual(active.reviewSources, []);

  const sessionLabel = `HQ713 future capture ${randomUUID()}`;
  const captured = await fixture.seedCapturedSession(actor, {
    projectId: personalProjectId,
    sessionLabel,
    prepareAssociationBeforeCreate: true
  });
  const captureProof = await fixture.personalDb(actor).query<{
    created_at: Date;
    automatic_personal_project_id: string | null;
    project_share_capture_policy_version: number | null;
    project_share_capture_workspace_project_id: string | null;
    project_share_capture_device_credential_id: string | null;
    project_share_capture_link_epoch: string | null;
    project_share_capture_context_version: number | null;
    project_share_capture_prepared_at: Date | null;
  }>(
    `select created_at,automatic_personal_project_id,
            project_share_capture_policy_version,
            project_share_capture_workspace_project_id,
            project_share_capture_device_credential_id,
            project_share_capture_link_epoch,
            project_share_capture_context_version,
            project_share_capture_prepared_at
       from sessions where id=$1 and owner_user_id=$2`,
    [captured.sessionId, actor.id]
  );
  assert.equal(captureProof.rows.length, 1);
  const proof = captureProof.rows[0]!;
  assert.equal(proof.automatic_personal_project_id, personalProjectId);
  assert.equal(proof.project_share_capture_policy_version, policyVersion + 1);
  assert.equal(
    proof.project_share_capture_workspace_project_id,
    workspaceProjectId
  );
  assert.ok(proof.project_share_capture_device_credential_id);
  assert.ok(proof.project_share_capture_link_epoch);
  assert.ok(proof.project_share_capture_context_version);
  assert.ok(proof.project_share_capture_prepared_at instanceof Date);
  assert.ok(proof.project_share_capture_prepared_at <= proof.created_at);
  const identity = new AsyncLocalStorage<string>();
  const key = `${actor.id}:${fixture.teamBackendId}`;
  const authorization = readDesktopLocalCredentialAuthorization(actor.koedHome);
  assert.ok(authorization?.authorization);
  const authority = async () => ({
    key,
    ownerId: actor.id,
    apiOrigin: actor.personal.baseUrl,
    authorization: authorization.authorization,
    canWrite: true
  });
  const transport = createWorkspaceProjectTransport({
    identity,
    authority,
    fetch: globalThis.fetch,
    koedHome: actor.koedHome
  });
  const personal = createWorkspaceProjectPersonalClient(
    transport.sendPersonal,
    transport.teamCredential
  );
  const observed: {
    activeProjects: unknown | null;
    candidates: unknown | null;
    reconciliation: unknown | null;
  } = { activeProjects: null, candidates: null, reconciliation: null };
  const listActive = personal.activeProjectSharePolicies.bind(personal);
  personal.activeProjectSharePolicies = async (...args) => {
    const page = await listActive(...args);
    observed.activeProjects = page;
    return page;
  };
  const listCandidates =
    personal.futureProjectShareSourceCandidates.bind(personal);
  personal.futureProjectShareSourceCandidates = async (...args) => {
    const page = await listCandidates(...args);
    observed.candidates = page;
    return page;
  };
  const reconcileFuture =
    personal.reconcileFutureProjectSharePolicy.bind(personal);
  personal.reconcileFutureProjectSharePolicy = async (...args) => {
    const page = await reconcileFuture(...args);
    observed.reconciliation = page;
    return page;
  };
  const service = createProjectSharePolicyService({
    identity,
    authority,
    futureEligible: () => true,
    personal,
    loadContext: async () => {
      const load = await fixture.localCommand(
        actor,
        "collaboration.load",
        {
          forceRemoteNavigation: true
        },
        { personal: true }
      );
      const snapshot = collaborationSnapshotSchema.parse(
        record(load.data).snapshot
      );
      return projectShareContextFromAuthority(
        readLocalEdgeUpstreamRegistry(
          join(actor.koedHome, "config", "upstream-backends.json")
        ),
        snapshot
      );
    },
    sendPolicy: transport.sendProjectPolicy,
    sendCollaboration: async (command, context) => {
      assert.equal(context.ownerId, actor.id);
      assert.equal(context.signal.aborted, false);
      const response = await fixture.localCommand(
        actor,
        command.command,
        command.input as Record<string, unknown>,
        { requestId: command.requestId }
      );
      assert.equal(context.signal.aborted, false);
      return response;
    },
    confirmNative: async () => {
      assert.fail(
        "Future policy sweep must not request another Native approval"
      );
    }
  });
  const sweep = await identity.run(key, () =>
    service.futureSweep.reconcile(key, new AbortController().signal)
  );
  assert.equal(typeof sweep.hasMore, "boolean");
  const candidateFacts = await fixture.personalDb(actor).query<{
    source_artifacts: string;
    local_issues: string;
    session_grants: string;
    explicit_offers: string;
    private_rows: string;
  }>(
    `select
       (select count(*)::text from conversation_source_artifacts
         where session_id=$1 and owner_user_id=$2 and replica_role='origin_local') as source_artifacts,
       (select count(*)::text from project_share_local_issues
         where session_id=$1 and owner_user_id=$2) as local_issues,
       (select count(*)::text from project_policy_session_grants
         where session_id=$1 and owner_user_id=$2) as session_grants,
       (select count(*)::text from project_share_explicit_offers
         where session_id=$1 and owner_user_id=$2) as explicit_offers,
       (select count(*)::text from project_share_private_conversations
         where owner_user_id=$2 and external_conversation_id=$3) as private_rows`,
    [captured.sessionId, actor.id, captured.externalSessionId]
  );
  assert.ok(
    observed.activeProjects && observed.candidates && observed.reconciliation,
    JSON.stringify({
      observed,
      sweep,
      candidateFacts: candidateFacts.rows[0],
      futureFailures: fixture.futureFailures()
    })
  );
  const issuePath = `${teamPath}/issues/${captured.sessionId}/status?policyVersion=${policyVersion + 1}`;
  let grantId: string | null = null;
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = record(
      (
        await actor.team.request("GET", issuePath, {
          expectedStatus: 200
        })
      ).body
    );
    if (status.state === "activated") {
      grantId = String(status.shareGrantId);
      assert.equal(status.logicalMemoryId, captured.logicalMemoryId);
      break;
    }
    assert.equal(
      status.state,
      "staged",
      JSON.stringify({
        status,
        observed,
        sweep,
        candidateFacts: candidateFacts.rows[0],
        futureFailures: fixture.futureFailures()
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(
    grantId,
    "Future captured source must activate through Team Pending Share"
  );
  await waitForHq713TeamEmbedding(fixture, grantId, "lcm_leaves");
  const answer = await answerTeam(fixture, fixture.bob, sessionLabel);
  const evidence = teamEvidenceForGrant(answer, grantId);
  assert.ok(evidence.length > 0, "New future source must be recalled by Bob");
  fixture.results.record("I713.future-empty-policy", {
    policyVersion: policyVersion + 1,
    sessionId: captured.sessionId,
    logicalMemoryId: captured.logicalMemoryId,
    grantId,
    teamEvidenceCount: evidence.length,
    desktopFutureSweep: true
  });
};
