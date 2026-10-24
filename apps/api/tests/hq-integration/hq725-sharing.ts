import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createMemorySourceRepository } from "@koed/db";
import { readManagedSharingOverview } from "../../../../packages/mcp-server/src/sharing-overview-tool.js";
import {
  sharingOverviewSchema,
  readDesktopLocalCredentialAuthorization,
  type KoedTextActionProjection
} from "@koed/shared";
import { createHq713LeasedExecution } from "./hq713-managed-citations.js";
import type { Hq713Fixture } from "./hq713-fixture.js";

/** The actual MCP reader calls listening owner-local and Team APIs. */
export async function runHq725SharingOverview(fixture: Hq713Fixture) {
  const { bob } = fixture;
  const leased = await createHq713LeasedExecution(fixture, bob);
  const environment = {
    KOED_HOME: bob.koedHome,
    KOED_MANAGED_RECALL_API_URL: bob.personalEdge.baseUrl,
    KOED_MANAGED_RECALL_EXECUTION_ID: leased.executionId,
    KOED_MANAGED_RECALL_EXECUTION_GENERATION: String(leased.executionGeneration)
  };
  const count = async () =>
    (
      await fixture.team.db.query<{ invites: string; access: string }>(
        `select (select count(*)::text from team_invites) invites,
            (select count(*)::text from team_workspace_access_grants) access`
      )
    ).rows;
  const before = await count();
  const page = await bob.personalEdge.request("GET", "/v1/local-edge/sharing", {
    expectedStatus: 200
  });
  const result = await readManagedSharingOverview({}, environment);
  assert.equal(result.version, 1);
  const overview = result.overview;
  const backend = overview.backends.find(
    (item) => item.backendId === fixture.teamBackendId
  );
  assert.equal(backend?.status, "available");
  if (backend?.status !== "available")
    throw new Error("Enrolled Team unavailable");
  const project = backend.data.projects.find(
    (item) => item.id === fixture.ids.workspaceProjectId
  );
  assert.ok(project, "The agent sees the currently authorized shared Project");
  assert.equal(
    project.ownedByMe,
    false,
    "Shared-with-me context keeps the other owner"
  );
  assert.equal(project.joinedByMe, true);
  const pageBackend = sharingOverviewSchema
    .parse(page.body)
    .backends.find((item) => item.backendId === fixture.teamBackendId);
  assert.equal(pageBackend?.status, "available");
  if (pageBackend?.status !== "available") throw new Error("Page unavailable");
  assert.deepEqual(
    backend.data,
    pageBackend.data,
    "Agent and page use the same live read model"
  );
  const filtered = await readManagedSharingOverview(
    {
      projectId: fixture.ids.workspaceProjectId,
      backendId: fixture.teamBackendId
    },
    environment
  );
  assert.ok(
    filtered.overview.backends.some(
      (item) =>
        item.status === "available" &&
        item.data.projects.some((row) => row.id === project.id)
    )
  );
  const person =
    project.members.find(
      (item) => item.person.id === fixture.alice.teamUserId
    ) ?? project.members[0];
  assert.ok(person);
  const named = await readManagedSharingOverview(
    { person: person.person.displayName },
    environment
  );
  assert.ok(
    named.overview.backends.some(
      (item) =>
        item.status === "available" &&
        item.data.projects.some((row) =>
          row.members.some(
            (member) => member.person.displayName === person.person.displayName
          )
        )
    )
  );
  assert.deepEqual(
    await count(),
    before,
    "Sharing overview creates no invitations or access grants"
  );
  const path = `/v1/managed-conversations/${leased.executionId}/sharing-overview?executionGeneration=${leased.executionGeneration}`;
  await bob.personalTokenClient.request("GET", path, { expectedStatus: 403 });
  await fixture.alice.personalEdge.request("GET", path, {
    expectedStatus: [404, 409]
  });
  await bob.personalEdge.request(
    "GET",
    path.replace(
      `executionGeneration=${leased.executionGeneration}`,
      `executionGeneration=${leased.executionGeneration + 1}`
    ),
    { expectedStatus: 409 }
  );
  const adminLease = await createHq713LeasedExecution(fixture, fixture.alice);
  // Managed Runtime binds its captured source locally after the HTTP runtime
  // identity is ready. Use that production repository operation in this fixture.
  const managed = createMemorySourceRepository(
    fixture.personalDb(fixture.alice),
    { envelopeEncryptionProvider: fixture.personalEncryptionProvider }
  );
  const execution = await managed.getManagedConversationExecution(
    { userId: fixture.alice.id },
    adminLease.executionId
  );
  assert.ok(execution?.providerThreadId);
  const binding = await managed.bindManagedConversationLocalRuntime(
    { userId: fixture.alice.id },
    {
      executionId: adminLease.executionId,
      deploymentId: fixture.alice.deploymentId,
      deviceId: fixture.alice.deviceId,
      executionGeneration: adminLease.executionGeneration,
      localSessionId: adminLease.sessionId,
      providerThreadId: execution.providerThreadId,
      transcriptPath: null,
      managedHome: fixture.alice.koedHome
    }
  );
  assert.equal(binding.localSessionId, adminLease.sessionId);
  const runnerLease = await fixture.alice.personalRunner.request<{
    acquired: boolean;
  }>(
    "POST",
    `/v1/managed-conversation-runner/executions/${adminLease.executionId}/acquire`,
    {
      body: {
        executionGeneration: adminLease.executionGeneration,
        runnerId: adminLease.runnerId,
        leaseMs: 180_000
      },
      expectedStatus: 200
    }
  );
  assert.equal(
    runnerLease.body.acquired,
    true,
    "Actual runner must hold the execution lease for text-action production"
  );
  const admin = await readManagedSharingOverview(
    {},
    {
      KOED_HOME: fixture.alice.koedHome,
      KOED_MANAGED_RECALL_API_URL: fixture.alice.personalEdge.baseUrl,
      KOED_MANAGED_RECALL_EXECUTION_ID: adminLease.executionId,
      KOED_MANAGED_RECALL_EXECUTION_GENERATION: String(
        adminLease.executionGeneration
      )
    }
  );
  const rosterBackend = admin.teams.find(
    (item) => item.backendId === fixture.teamBackendId
  );
  assert.equal(
    rosterBackend?.status,
    "available",
    "Admin Team roster is reachable"
  );
  if (rosterBackend?.status !== "available")
    throw new Error("Missing authorized Team roster");
  const roster = rosterBackend.teams.find(
    (item) => item.teamId === fixture.ids.teamId
  );
  assert.ok(roster);
  assert.equal(
    roster.people.find((item) => item.id === bob.teamUserId)?.canRemove,
    true
  );
  assert.equal(
    roster.people.find((item) => item.id === fixture.alice.teamUserId)
      ?.canRemove,
    false,
    "Own membership is not a removal target"
  );
  fixture.results.record("I725.overview", {
    authenticated: true,
    readOnly: true,
    sameLivePageData: true,
    projectFilter: true,
    personFilter: true,
    apiTokenRejected: true,
    otherOwnerRejected: true,
    staleGenerationRejected: true
  });
  // Use a real human-origin prompt, not a seeded proposal or invented authority.
  const alice = fixture.alice;
  const inviteRequest = randomUUID();
  const inviteInput = {
    teamId: fixture.ids.teamId,
    email: `sharing-${randomUUID()}@example.test`,
    role: "member",
    defaultWorkspaceId: fixture.ids.workspaceId,
    defaultWorkspaceAccess: "read",
    ttlHours: 24
  };
  const inviteGrant = await fixture.localActionGrant(alice, {
    intent: "collaboration.create_invitation",
    commandRequestId: inviteRequest,
    ...inviteInput
  });
  const issued = await fixture.localCommand(
    alice,
    "collaboration.create_invitation",
    { ...inviteInput, actionGrant: inviteGrant.reference },
    { requestId: inviteRequest }
  );
  const invitation = (
    issued.data as { invitation: { id: string; version: number } }
  ).invitation;
  assert.ok(invitation.id);
  assert.ok(invitation.version);
  const completedStart = await alice.personalRunner.request<{
    completed: boolean;
  }>(
    "POST",
    `/v1/managed-conversation-runner/commands/${adminLease.commandId}/complete`,
    { body: { leaseToken: adminLease.leaseToken }, expectedStatus: 200 }
  );
  assert.equal(completedStart.body.completed, true);
  // This fixture normally advertises start only. Advertise the send operation
  // for this HTTP prompt proof without changing any production capability gate.
  const advertised = await fixture.personalDb(alice).query(
    `update ai_client_capability_snapshots set capabilities=jsonb_set(capabilities,
      '{descriptors,managed_conversation_send}',
      '{"id":"managed_conversation_send","support":"supported","readiness":"ready","diagnostics":[]}'::jsonb)
      where owner_user_id=$1 and instance_id=$2`,
    [alice.id, alice.managedLaunch.instanceId]
  );
  assert.equal(advertised.rowCount, 1);
  const prompt = await alice.personal.request<{ command: { id: string } }>(
    "POST",
    `/v1/managed-conversations/${adminLease.executionId}/prompts`,
    {
      body: {
        executionGeneration: adminLease.executionGeneration,
        idempotencyKey: randomUUID(),
        clientUserMessageId: randomUUID(),
        prompt: "Cancel the selected invitation in Sharing"
      },
      headers: {
        authorization: readDesktopLocalCredentialAuthorization(alice.koedHome)!
          .authorization
      },
      expectedStatus: 202
    }
  );
  const claimedPrompt = await alice.personalRunner.request<{
    commands: Array<{ id: string; leaseToken: string }>;
  }>("POST", "/v1/managed-conversation-runner/commands/claim", {
    body: { runnerId: adminLease.runnerId, limit: 8, leaseMs: 180_000 },
    expectedStatus: 200
  });
  const command = claimedPrompt.body.commands.find(
    (item) => item.id === prompt.body.command.id
  );
  assert.ok(
    command?.leaseToken,
    "Human prompt must be claimed through real runner API"
  );
  const authorityDiagnostic = await fixture.personalDb(alice).query(
    `select
    execution.state execution_state,command.state command_state,
    (command.lease_expires_at>now()) command_lease,
    (execution.runner_lease_expires_at>now()) runner_lease,
    (command.execution_generation=execution.execution_generation) generation_matches,
    binding.local_session_id is not null as has_local_session,
    (binding.execution_generation=command.execution_generation) binding_generation_matches,
    (session.logical_session_id=execution.logical_session_id) logical_matches,
    origin.source_kind human_origin, (origin.request_digest=command.request_digest) origin_digest_matches
    from managed_conversation_commands command join managed_conversation_executions execution on execution.id=command.execution_id
    left join managed_conversation_runtime_bindings binding on binding.execution_id=execution.id and binding.owner_user_id=execution.owner_user_id
    left join sessions session on session.id=binding.local_session_id
    left join managed_conversation_text_human_origins origin on origin.command_id=command.id
    where command.id=$1`,
    [command.id]
  );
  assert.deepEqual(
    authorityDiagnostic.rows,
    [
      {
        execution_state: "running",
        command_state: "dispatching",
        command_lease: true,
        runner_lease: true,
        generation_matches: true,
        has_local_session: true,
        binding_generation_matches: true,
        logical_matches: true,
        human_origin: "human_prompt",
        origin_digest_matches: true
      }
    ],
    "Real human-origin authority must be complete before delivery"
  );
  const actionPath = `/v1/managed-conversations/${adminLease.executionId}/text-actions`;
  const proposed = await alice.personalEdge.request<{
    action: KoedTextActionProjection;
  }>("POST", actionPath, {
    body: {
      name: "sharing_remove",
      arguments: {
        targets: [
          {
            kind: "team_invitation",
            backendId: fixture.teamBackendId,
            teamId: fixture.ids.teamId,
            invitationId: invitation.id
          }
        ]
      },
      executionGeneration: adminLease.executionGeneration,
      commandId: command.id,
      leaseToken: command.leaseToken,
      providerTurnId: randomUUID(),
      toolCallId: randomUUID()
    },
    expectedStatus: 202
  });
  assert.equal(proposed.body.action.state, "awaiting_review");
  const reviewed = await alice.personalEdge.request<{
    action: KoedTextActionProjection;
  }>("POST", `${actionPath}/${proposed.body.action.id}/review`, {
    body: {
      expectedRevision: proposed.body.action.revision,
      decision: "approve"
    },
    expectedStatus: 200
  });
  const claimedAction = await alice.personalEdge.request<{
    action: KoedTextActionProjection;
  }>("POST", `${actionPath}/${reviewed.body.action.id}/claim`, {
    body: { expectedRevision: reviewed.body.action.revision },
    expectedStatus: 200
  });
  const completePath = `${actionPath}/${claimedAction.body.action.id}/complete`;
  const completeBody = { expectedRevision: claimedAction.body.action.revision };
  await alice.personalEdge.request("POST", completePath, {
    body: completeBody,
    expectedStatus: 409
  });
  const removeRequest = randomUUID();
  const removeInput = {
    teamId: fixture.ids.teamId,
    invitationId: invitation.id,
    expectedVersion: invitation.version
  };
  const removalGrant = await fixture.localActionGrant(alice, {
    intent: "collaboration.revoke_invitation",
    commandRequestId: removeRequest,
    ...removeInput
  });
  const removed = await fixture.localCommand(
    alice,
    "collaboration.revoke_invitation",
    { ...removeInput, actionGrant: removalGrant.reference },
    { requestId: removeRequest }
  );
  assert.equal(removed.ok, true);
  const settled = await alice.personalEdge.request<{
    action: KoedTextActionProjection;
  }>("POST", completePath, { body: completeBody, expectedStatus: 200 });
  assert.equal(settled.body.action.state, "applied");
  fixture.results.record("I725.removal", {
    humanOrigin: true,
    leasedCommand: true,
    exactBackend: true,
    noPrematureCompletion: true,
    nativeReviewedRevocation: true,
    authoritativeLifecycleReceipt: true
  });
  fixture.blockTeamPath("GET", "/v1/me/sharing");
  try {
    const offline = await readManagedSharingOverview(
      { projectId: randomUUID(), backendId: fixture.teamBackendId },
      environment
    );
    const unavailable = offline.overview.backends.find(
      (item) => item.backendId === fixture.teamBackendId
    );
    assert.equal(
      unavailable?.status,
      "unavailable",
      "Filtering cannot turn an unreachable Team into an absent Project"
    );
    if (unavailable?.status !== "unavailable")
      throw new Error("Missing explicit unavailability");
    assert.equal(unavailable.reason, "unreachable");
    fixture.results.record("N725.27.real", {
      backendId: unavailable.backendId,
      explicitUnavailable: true,
      reason: unavailable.reason,
      projectFilterRetainsFailure: true
    });
  } finally {
    fixture.resumeTeamPath("GET", "/v1/me/sharing");
  }
}
