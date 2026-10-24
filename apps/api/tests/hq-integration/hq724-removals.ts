import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  collaborationCommandResultSchema,
  type CollaborationRendererCommand,
  type SharingOverview
} from "@koed/shared";
import { collaborationCommandScope } from "../../src/local-edge/collaboration-command-registry.js";
import { createPersonalShareOriginRepository } from "@koed/db";
import { createCollaborationRendererClient } from "../../../desktop/src/collaboration/renderer-client.js";
import {
  RemovalCoordinator,
  type RemovalTarget
} from "../../../desktop/src/renderer/hq/sharing/removal-coordinator.js";
import type { Hq713Fixture } from "./hq713-fixture.js";

const realClient = async (fixture: Hq713Fixture) => {
  const reviews: Array<{ intent: string; tier: string }> = [];
  const sent: CollaborationRendererCommand[] = [];
  let dropCommittedReply = false;
  const client = createCollaborationRendererClient(
    {
      subscribe: () => () => undefined,
      async command(command) {
        if (
          [
            "collaboration.remove_project_member",
            "collaboration.revoke_invitation",
            "collaboration.disable_member"
          ].includes(command.command)
        )
          sent.push(structuredClone(command));
        const response = await fixture.alice.personalEdge.request(
          "POST",
          "/v1/local-edge/collaboration/command",
          {
            body: {
              ...(collaborationCommandScope(command) === "team"
                ? { upstream_backend_id: fixture.teamBackendId }
                : {}),
              command
            }
          }
        );
        assert.equal(
          response.status,
          200,
          `Real bridge ${command.command} HTTP status`
        );
        const result = collaborationCommandResultSchema.parse(response.body);
        if (
          result.ok &&
          result.command === "collaboration.request_action_grant"
        ) {
          assert.equal(command.command, "collaboration.request_action_grant");
          if (command.command !== "collaboration.request_action_grant")
            throw new Error("Wrong command");
          const status = result.data.status;
          const tier =
            command.input.intent.intent === "collaboration.revoke_invitation"
              ? "native_review"
              : "step_up";
          assert.equal(
            status.approvalTier,
            tier,
            "Existing approval tier is retained"
          );
          reviews.push({ intent: command.input.intent.intent, tier });
          if (command.input.intent.intent === "collaboration.disable_member") {
            assert.match(
              status.review?.description ?? "",
              /What Dave added stays/
            );
            assert.ok(
              status.review?.details.some(
                (detail) =>
                  detail.label === "Affected Projects" &&
                  detail.value.includes("landing")
              )
            );
          }
          if (status.state === "pending") {
            assert.ok(status.activationUrl);
            const selector = new URL(
              status.activationUrl,
              fixture.alice.team.baseUrl
            ).pathname
              .split("/")
              .at(-1);
            assert.ok(selector);
            const reviewed = await fixture.alice.teamBrowser.request<{
              status: { review: unknown };
            }>("GET", `/v1/high-risk/browser-activations/${selector}`, {
              expectedStatus: 200
            });
            assert.deepEqual(
              reviewed.body.status.review,
              status.review,
              "Browser reviews the exact request"
            );
            await fixture.alice.teamBrowser.request(
              "POST",
              `/v1/high-risk/browser-activations/${selector}/decision`,
              { body: { decision: "approve" }, expectedStatus: 200 }
            );
          }
        }
        if (
          result.ok &&
          command.command === "collaboration.remove_project_member" &&
          dropCommittedReply
        ) {
          dropCommittedReply = false;
          throw new Error("Fixture drops the committed removal reply");
        }
        return result;
      }
    },
    {
      confirmNativeReview: (review) => {
        assert.match(review.title, /invitation/i);
        return true;
      }
    }
  );
  await client.load();
  return {
    client,
    reviews,
    sent,
    dropNextCommittedReply: () => {
      dropCommittedReply = true;
    }
  };
};

const waitForPending = async (coordinator: RemovalCoordinator) => {
  for (let i = 0; i < 200; i++) {
    if (coordinator.current().phase === "pending") return;
    assert.notEqual(
      coordinator.current().phase,
      "complete",
      JSON.stringify(coordinator.current())
    );
    await delay(10);
  }
  assert.fail("Real reviewed removal did not enter its pending window");
};
const overview = async (fixture: Hq713Fixture) => {
  const result = await fixture.alice.personalEdge.request<SharingOverview>(
    "GET",
    "/v1/local-edge/sharing",
    { expectedStatus: 200 }
  );
  return result.body;
};

/** Real owner edge + Team HTTP and browser reviews; no simulated backend mutation. */
export const runHq724Invitations = async (fixture: Hq713Fixture) => {
  const { alice, bob } = fixture;
  const teamBody = { name: `Removal proof ${randomUUID().slice(0, 8)}` };
  const grant = await fixture.approveActionGrant(alice, {
    action: "team.create",
    body: teamBody
  });
  const team = await alice.team.request<{
    team: { id: string };
    defaultWorkspace: { id: string };
  }>("POST", "/v1/teams", {
    body: teamBody,
    headers: {
      "x-koed-action-grant": grant.secret,
      "idempotency-key": randomUUID()
    },
    expectedStatus: 200
  });
  const teamId = team.body.team.id,
    workspaceId = team.body.defaultWorkspace.id;
  const created = await alice.team.request<{ id: string; version: number }>(
    "POST",
    "/v1/workspace-projects",
    {
      body: {
        teamId,
        workspaceId,
        name: "Retained knowledge",
        key: `hq724-${randomUUID()}`,
        shareAttemptKey: randomUUID()
      },
      expectedStatus: 201
    }
  );
  const projectId = created.body.id;
  const origin = createPersonalShareOriginRepository(fixture.personalDb(alice));
  const captured = await fixture.seedCapturedSession(alice, {
    projectId: fixture.ids.alicePersonalProjectId,
    sessionLabel: "Plan next week"
  });
  const session = await fixture.personalDb(alice).query<{
    logical_session_id: string;
  }>("select logical_session_id from sessions where id=$1", [captured.sessionId]);
  const conversationId = session.rows[0]!.logical_session_id;
  const issue = async (email: string) => {
    const review = await alice.team.request<{ project: { version: number } }>(
      "GET",
      `/v1/workspace-projects/${projectId}/lifecycle-review`,
      { expectedStatus: 200 }
    );
    const body = {
      email,
      role: "member",
      defaultTeamWorkspaceId: workspaceId,
      workspaceProjectId: projectId,
      expectedWorkspaceProjectVersion: review.body.project.version,
      defaultWorkspaceAccess: "write",
      ttlHours: 24,
      inviterAgentDisplayName: "Cooper",
      actorKind: "agent_on_behalf",
      accessMode: "full_access"
    };
    const approval = await fixture.approveActionGrant(alice, {
      action: "team.invite.create",
      teamId,
      body
    });
    assert.equal(approval.status.approvalTier, "native_review");
    const response = await alice.team.request<{
      invite: { id: string; version: number };
      inviteToken: string;
    }>("POST", `/v1/teams/${teamId}/invites`, {
      body,
      headers: {
        "x-koed-action-grant": approval.secret,
        "idempotency-key": randomUUID()
      },
      expectedStatus: 200
    });
    // The owner edge normally records this private origin. Seed that provenance
    // here; its claimed-Agent producer is independently tested by HQ-721.
    await origin.recordInvitation({
      ownerUserId: alice.id,
      teamBackendId: fixture.teamBackendId,
      inviteId: response.body.invite.id,
      source: { originKind: "conversation", conversationId }
    });
    return response.body;
  };
  const driver = await realClient(fixture);
  try {
    const invite = await issue(`carol.${randomUUID()}@example.test`);
    const direct = await alice.team.request("GET", "/v1/me/sharing");
    assert.equal(direct.status, 200, JSON.stringify(direct.body));
    const before = await overview(fixture);
    const available = before.backends.find(
      (b) => b.backendId === fixture.teamBackendId && b.status === "available"
    );
    assert.ok(
      available && available.status === "available",
      JSON.stringify(before)
    );
    const row = available.data.projects
      .find((p) => p.id === projectId)
      ?.invitations.find((i) => i.id === invite.invite.id);
    assert.ok(row?.canCancel);
    assert.equal(row.origin.actorKind, "agent_on_behalf");
    assert.equal(row.origin.accessMode, "full_access");
    assert.deepEqual(row.origin.source, {
      kind: "conversation",
      conversationId
    });
    const coordinator = new RemovalCoordinator();
    const pending = coordinator.start([
      {
        name: "Carol",
        place: "Retained knowledge",
        prepare: () =>
          driver.client.prepareRevokeInvitation({
            backendId: fixture.teamBackendId,
            teamId,
            invitationId: invite.invite.id,
            expectedVersion: invite.invite.version
          }),
        reconcile: async () => {
          await overview(fixture);
        }
      }
    ]);
    await waitForPending(coordinator);
    assert.equal(
      driver.sent.length,
      0,
      "No invitation mutation before Undo closes"
    );
    await pending;
    assert.equal(coordinator.current().results[0]?.state, "done");
    const revoked = await fixture.team.db.query<{ revoked_at: Date | null }>(
      "select revoked_at from team_invites where id=$1",
      [invite.invite.id]
    );
    assert.ok(revoked.rows[0]?.revoked_at);
    fixture.results.record("I724.1", {
      realTeamAndPersonalHttp: true,
      invitationId: invite.invite.id,
      approvalTier: "native_review",
      agentMetadataOnEnrolledDevice: true,
      privateOriginSeeded: true,
      claimedOriginProducerProof: "collaboration-team-control.test.ts",
      noMutationDuringUndo: true
    });

    const acceptedInvite = await issue(bob.email);
    const acceptBody = { inviteToken: acceptedInvite.inviteToken };
    const acceptGrant = await fixture.approveActionGrant(bob, {
      action: "team.invite.accept",
      body: acceptBody
    });
    await bob.team.request("POST", "/v1/team-invites/accept", {
      body: acceptBody,
      headers: { "x-koed-action-grant": acceptGrant.secret },
      expectedStatus: 200
    });
    await bob.team.request("POST", `/v1/workspace-projects/${projectId}/join`, {
      expectedStatus: 200
    });
    await driver.client.listInvitations({ teamId });
    const acceptedOverview = await overview(fixture);
    const backend = acceptedOverview.backends.find(
      (b) => b.backendId === fixture.teamBackendId
    );
    assert.ok(backend && backend.status === "available");
    const member = backend.data.projects
      .find((p) => p.id === projectId)
      ?.members.find((m) => m.person.id === bob.teamUserId);
    assert.ok(member?.canRemove);
    assert.equal(member.origin.actorKind, "agent_on_behalf");
    assert.deepEqual(member.origin.source, {
      kind: "conversation",
      conversationId
    });
    const lifecycle = await driver.client.reviewProjectLifecycle({
      projectId,
      targetUserId: bob.teamUserId
    });
    assert.ok(lifecycle.targetMemberVersion);
    const removal = new RemovalCoordinator();
    driver.dropNextCommittedReply();
    await removal.start([
      {
        name: "Bob",
        place: "Retained knowledge",
        prepare: () =>
          driver.client.prepareRemoveProjectMember({
            backendId: fixture.teamBackendId,
            teamId,
            projectId,
            targetUserId: bob.teamUserId,
            expectedProjectVersion: lifecycle.project.version,
            expectedMemberVersion: lifecycle.targetMemberVersion!
          }),
        reconcile: async () => {
          await overview(fixture);
        }
      }
    ]);
    assert.equal(
      removal.current().results[0]?.state,
      "done",
      JSON.stringify(removal.current())
    );
    const removalCommands = driver.sent.filter(
      (c) => c.command === "collaboration.remove_project_member"
    );
    assert.equal(
      removalCommands.length,
      2,
      "Committed lost reply replays the same operation once"
    );
    assert.deepEqual(
      removalCommands[0],
      removalCommands[1],
      "N30 retains the exact request, mutation identity and approval"
    );
    assert.equal(
      driver.reviews.filter(
        (r) => r.intent === "collaboration.remove_project_member"
      ).length,
      1
    );
    const after = await alice.team.request<{ project: { version: number } }>(
      "GET",
      `/v1/workspace-projects/${projectId}/lifecycle-review`,
      { expectedStatus: 200 }
    );
    assert.equal(
      after.body.project.version,
      lifecycle.project.version + 1,
      "Only one removal occurred"
    );
    fixture.results.record("I724.2", {
      realAcceptedInvite: true,
      shareOriginRetained: true,
      removalTier: "step_up",
      lostResponseRecovered: true,
      identicalRetry: true,
      projectVersionAdvancedOnce: true
    });
  } finally {
    driver.client.dispose();
  }
};

export const runHq724Sequential = async (fixture: Hq713Fixture) => {
  const { alice, bob, ids } = fixture;
  const carolId = randomUUID(),
    carolMemberId = randomUUID();
  // A third member's setup is data-only. Every reviewed removal below uses
  // the production owner edge, Team route and real Step-up browser decision.
  await fixture.team.db.query(
    "insert into users(id,email,display_name) values($1,$2,'Carol')",
    [carolId, `carol.${randomUUID()}@example.test`]
  );
  await fixture.team.db.query(
    "insert into team_memberships(id,team_id,user_id,role,status) values($1,$2,$3,'member','enabled')",
    [carolMemberId, ids.teamId, carolId]
  );
  await fixture.team.db.query(
    "insert into team_workspace_access_grants(team_workspace_id,team_id,user_id,access,can_share_owned_memory,granted_by_user_id) values($1,$2,$3,'write',true,$4)",
    [ids.workspaceId, ids.teamId, carolId, alice.teamUserId]
  );
  await fixture.team.db.query(
    "insert into workspace_project_members(workspace_project_id,team_member_id,access) values($1,$2,'write')",
    [ids.workspaceProjectId, carolMemberId]
  );
  const driver = await realClient(fixture);
  const reviewedVersions: number[] = [];
  const reconcile = async () => {
    await overview(fixture);
  };
  const target = (
    name: string,
    userId: string,
    fail = false
  ): RemovalTarget => ({
    name,
    place: "landing",
    async prepare() {
      const review = await driver.client.reviewProjectLifecycle({
        projectId: ids.workspaceProjectId,
        targetUserId: userId
      });
      assert.ok(review.targetMemberVersion);
      reviewedVersions.push(review.project.version);
      const prepared = await driver.client.prepareRemoveProjectMember({
        backendId: fixture.teamBackendId,
        teamId: ids.teamId,
        projectId: ids.workspaceProjectId,
        targetUserId: userId,
        expectedProjectVersion: review.project.version,
        expectedMemberVersion: review.targetMemberVersion
      });
      return {
        ...prepared,
        async execute() {
          const path = `/v1/workspace-projects/${ids.workspaceProjectId}/members/${userId}/remove`;
          if (fail) fixture.blockTeamPath("POST", path);
          try {
            await prepared.execute();
          } finally {
            if (fail) fixture.resumeTeamPath("POST", path);
          }
        }
      };
    },
    reconcile
  });
  const access = async (userId: string) => {
    const result = await fixture.team.db.query<{ access: string }>(
      "select link.access from workspace_project_members link join team_memberships member on member.id=link.team_member_id where link.workspace_project_id=$1 and member.user_id=$2",
      [ids.workspaceProjectId, userId]
    );
    return result.rows[0]?.access;
  };
  try {
    const coordinator = new RemovalCoordinator();
    const unsubscribe = coordinator.subscribe(() => {
      if (
        coordinator.current().phase === "pending" &&
        coordinator.current().index === 2
      )
        queueMicrotask(() => coordinator.undo());
    });
    const pending = coordinator.start([
      target("Bob", bob.teamUserId),
      target("Carol", carolId)
    ]);
    await waitForPending(coordinator);
    assert.equal(
      driver.reviews.length,
      1,
      "Second review waits for first target"
    );
    assert.equal(
      driver.sent.length,
      0,
      "No removal before first Undo window ends"
    );
    await pending;
    unsubscribe();
    assert.deepEqual(
      coordinator.current().results.map((r) => r.state),
      ["done", "not attempted"]
    );
    assert.equal(
      reviewedVersions[1],
      reviewedVersions[0]! + 1,
      "Second review reads the incremented Project version"
    );
    assert.equal(await access(bob.teamUserId), "disabled");
    assert.equal(await access(carolId), "write");
    // Set up another Project member for the independent failure repetition.
    const daveId = randomUUID(),
      daveMemberId = randomUUID();
    await fixture.team.db.query(
      "insert into users(id,email,display_name) values($1,$2,'Dave')",
      [daveId, `dave.${randomUUID()}@example.test`]
    );
    await fixture.team.db.query(
      "insert into team_memberships(id,team_id,user_id,role,status) values($1,$2,$3,'member','enabled')",
      [daveMemberId, ids.teamId, daveId]
    );
    await fixture.team.db.query(
      "insert into team_workspace_access_grants(team_workspace_id,team_id,user_id,access,can_share_owned_memory,granted_by_user_id) values($1,$2,$3,'write',true,$4)",
      [ids.workspaceId, ids.teamId, daveId, alice.teamUserId]
    );
    await fixture.team.db.query(
      "insert into workspace_project_members(workspace_project_id,team_member_id,access) values($1,$2,'write')",
      [ids.workspaceProjectId, daveMemberId]
    );
    const failed = new RemovalCoordinator();
    await failed.start([
      target("Carol", carolId),
      target("Dave", daveId, true)
    ]);
    assert.deepEqual(
      failed.current().results.map((r) => r.state),
      ["done", "failed"]
    );
    assert.equal(await access(carolId), "disabled");
    assert.equal(await access(daveId), "write");
    assert.ok(failed.current().results[1]?.reason);
    assert.equal(reviewedVersions[3], reviewedVersions[2]! + 1);
    const groupPrepared = await driver.client.prepareDisableMember({
      backendId: fixture.teamBackendId,
      teamId: ids.teamId,
      userId: daveId,
      expectedVersion: 1
    });
    const group = new RemovalCoordinator();
    await group.start([
      {
        name: "Dave",
        place: "group",
        prepare: async () => groupPrepared,
        reconcile
      }
    ]);
    assert.equal(
      group.current().results[0]?.state,
      "done",
      JSON.stringify(group.current())
    );
    const disabled = await fixture.team.db.query<{ status: string }>(
      "select status from team_memberships where id=$1",
      [daveMemberId]
    );
    assert.equal(disabled.rows[0]?.status, "disabled");
    fixture.results.record("I724.3", {
      realMemberRemoval: true,
      secondReviewAfterFirst: true,
      freshProjectVersions: reviewedVersions,
      undoPreservedSecondMember: true,
      forcedSecondFailurePreservedAccess: true,
      perTargetOutcomes: true
    });
  } finally {
    driver.client.dispose();
  }
};
