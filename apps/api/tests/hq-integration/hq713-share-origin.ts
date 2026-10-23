import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { Hq713Fixture } from "./hq713-fixture.js";

/** Real Personal edge and Team service, each backed by its own database. */
export const runHq713ShareOrigin = async (fixture: Hq713Fixture) => {
  const { alice, bob } = fixture;
  const teamBody = { name: `Origin proof ${randomUUID().slice(0, 8)}` };
  const teamGrant = await fixture.approveActionGrant(alice, {
    action: "team.create",
    body: teamBody
  });
  const created = await alice.team.request<{
    team: { id: string };
    defaultWorkspace: { id: string };
  }>("POST", "/v1/teams", {
    body: teamBody,
    headers: {
      "x-koed-action-grant": teamGrant.secret,
      "idempotency-key": randomUUID()
    },
    expectedStatus: 200
  });
  const teamId = created.body.team.id;
  const workspaceId = created.body.defaultWorkspace.id;
  const requestId = randomUUID();
  const inviteInput = {
    teamId,
    email: bob.email,
    role: "member",
    defaultWorkspaceId: workspaceId,
    defaultWorkspaceAccess: "write",
    ttlHours: 24
  };
  const approved = await fixture.localActionGrant(alice, {
    intent: "collaboration.create_invitation",
    commandRequestId: requestId,
    ...inviteInput
  });
  const issued = await fixture.localCommand(
    alice,
    "collaboration.create_invitation",
    { ...inviteInput, actionGrant: approved.reference },
    { requestId }
  );
  const invitation = (
    issued.data as {
      invitation: { id: string };
      invitationUrl: string;
    }
  ).invitation;
  assert.ok(invitation.id);
  const token = new URL(
    (issued.data as { invitationUrl: string }).invitationUrl
  ).searchParams.get("token");
  assert.ok(token, "The approved invitation returns a one-time token");
  const personalBefore = await fixture.personalDb(alice).query<{
    origin_kind: string;
    conversation_id: string | null;
  }>(
    `select origin_kind,conversation_id from share_origins
      where owner_user_id=$1 and team_backend_id=$2 and target_kind='invitation' and invite_id=$3`,
    [alice.id, fixture.teamBackendId, invitation.id]
  );
  assert.deepEqual(personalBefore.rows, [
    { origin_kind: "share_window", conversation_id: null }
  ]);
  // Exercise the accepted-invite transport with a named Personal-only origin.
  // The claimed managed-action producer is covered by its focused repository
  // tests; this service lane proves the value cannot cross the DB boundary.
  const personalConversationId = randomUUID();
  await fixture.personalDb(alice).query(
    `update share_origins set origin_kind='conversation',conversation_id=$4
      where owner_user_id=$1 and team_backend_id=$2 and target_kind='invitation' and invite_id=$3`,
    [alice.id, fixture.teamBackendId, invitation.id, personalConversationId]
  );
  const acceptedBody = { inviteToken: token };
  const acceptGrant = await fixture.approveActionGrant(bob, {
    action: "team.invite.accept",
    body: acceptedBody
  });
  const accepted = await bob.team.request<{
    invite: { resultingAccessGrantVersion: number; acceptedByUserId: string };
  }>("POST", "/v1/team-invites/accept", {
    body: acceptedBody,
    headers: { "x-koed-action-grant": acceptGrant.secret },
    expectedStatus: 200
  });
  const version = accepted.body.invite.resultingAccessGrantVersion;
  assert.equal(accepted.body.invite.acceptedByUserId, bob.teamUserId);
  assert.ok(version > 0);
  await fixture.localCommand(alice, "collaboration.list_invitations", {
    teamId,
    includeRevoked: false,
    cursor: null,
    limit: 20
  });
  const personalAccess = await fixture.personalDb(alice).query<{
    source_invite_id: string;
    origin_kind: string;
    conversation_id: string | null;
  }>(
    `select source_invite_id,origin_kind,conversation_id from share_origins
      where owner_user_id=$1 and team_backend_id=$2 and target_kind='workspace_access'
        and team_workspace_id=$3 and team_user_id=$4 and access_grant_version=$5`,
    [alice.id, fixture.teamBackendId, workspaceId, bob.teamUserId, version]
  );
  assert.deepEqual(personalAccess.rows, [
    {
      source_invite_id: invitation.id,
      origin_kind: "conversation",
      conversation_id: personalConversationId
    }
  ]);
  const teamRows = await fixture.team.db.query<{
    actor_kind: string | null;
    access_mode: string | null;
    resulting_access_grant_version: number;
  }>(
    `select actor_kind,access_mode,resulting_access_grant_version
       from team_invites where id=$1`,
    [invitation.id]
  );
  assert.deepEqual(teamRows.rows, [
    {
      actor_kind: "person",
      access_mode: null,
      resulting_access_grant_version: version
    }
  ]);
  const teamChatColumns = await fixture.team.db.query(
    `select column_name from information_schema.columns
      where table_name in ('team_invites','team_workspace_access_grants')
        and column_name='conversation_id'`
  );
  assert.equal(teamChatColumns.rowCount, 0);
  const teamInviteResponse = await alice.team.request(
    "GET",
    `/v1/teams/${teamId}/invites?includeRevoked=true`,
    { expectedStatus: 200 }
  );
  assert.equal(
    JSON.stringify(teamInviteResponse.body).includes(personalConversationId),
    false
  );
  assert.equal(
    JSON.stringify(accepted.body).includes(personalConversationId),
    false
  );
  const bobPersonalOrigin = await fixture
    .personalDb(bob)
    .query(
      "select 1 from share_origins where invite_id=$1 or source_invite_id=$1",
      [invitation.id]
    );
  assert.equal(bobPersonalOrigin.rowCount, 0);
  fixture.results.record("I724.2.data.N17.separate-backends", {
    teamId,
    invitationId: invitation.id,
    accessGrantVersion: version,
    personalOriginKind: "conversation",
    namedConversationSeededInPersonalDb: true,
    distinctDatabases: true,
    teamConversationColumnCount: 0,
    recipientPersonalOriginCount: 0
  });
};
