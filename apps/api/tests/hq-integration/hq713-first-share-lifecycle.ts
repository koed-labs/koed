import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Hq713Fixture } from "./hq713-fixture.js";

type Project = { id: string; version: number; copiedAt?: string | null };
type Snapshot = {
  personalProjectVersion: number;
  workItems: unknown[];
  sources: unknown[];
  decks: unknown[];
};
type FirstShare = {
  personalProjectId: string;
  workspaceId: string;
  attemptKey: string;
  sourceItemId: string;
  snapshot: Snapshot;
  createBody: {
    teamId: string;
    workspaceId: string;
    name: string;
    key: string;
    shareAttemptKey: string;
  };
};

const createWorkspace = async (fixture: Hq713Fixture, label: string) => {
  const body = { teamId: fixture.ids.teamId, name: `${label} ${randomUUID()}` };
  const grant = await fixture.approveActionGrant(fixture.alice, {
    action: "team.workspace.create",
    body
  });
  const response = await fixture.alice.team.request<{
    teamWorkspace: { id: string };
  }>("POST", "/v1/team-workspaces", {
    body,
    headers: { "x-koed-action-grant": grant.secret },
    expectedStatus: 200
  });
  return response.body.teamWorkspace.id;
};

const createFirstShare = async (
  fixture: Hq713Fixture,
  label: string
): Promise<FirstShare> => {
  const workspaceId = await createWorkspace(fixture, label);
  const personal = await fixture.alice.personal.request<{ id: string }>(
    "POST",
    "/v1/projects",
    {
      body: { name: label, idempotencyKey: randomUUID() },
      expectedStatus: 201
    }
  );
  const personalProjectId = personal.body.id;
  const item = await fixture.alice.personal.request<{ id: string }>(
    "POST",
    `/v1/projects/${personalProjectId}/work-items`,
    {
      body: {
        kind: "todo",
        title: `${label} private original`,
        goal: "Retain this original through first-share recovery",
        origin: "manual",
        idempotencyKey: randomUUID()
      },
      expectedStatus: 201
    }
  );
  const attemptKey = randomUUID();
  const prepared = await fixture.alice.personalEdge.request<{
    snapshot: Snapshot;
  }>(
    "POST",
    `/v1/local-edge/projects/${personalProjectId}/workspace-project-prepare`,
    {
      body: {
        teamBackendId: fixture.teamBackendId,
        shareAttemptKey: attemptKey,
        targetTeamId: fixture.ids.teamId,
        targetWorkspaceId: workspaceId
      },
      expectedStatus: 200
    }
  );
  assert.ok(prepared.body.snapshot.workItems.length > 0);
  return {
    personalProjectId,
    workspaceId,
    attemptKey,
    sourceItemId: item.body.id,
    snapshot: prepared.body.snapshot,
    createBody: {
      teamId: fixture.ids.teamId,
      workspaceId,
      name: label,
      key: `HQ${randomUUID().slice(0, 7).toUpperCase()}`,
      shareAttemptKey: attemptKey
    }
  };
};

const teamCreate = async (fixture: Hq713Fixture, share: FirstShare) =>
  (
    await fixture.alice.team.request<Project>(
      "POST",
      "/v1/workspace-projects",
      {
        body: share.createBody,
        expectedStatus: 201
      }
    )
  ).body;

const teamCopy = async (
  fixture: Hq713Fixture,
  share: FirstShare,
  project: Project
) =>
  (
    await fixture.alice.team.request<Project>(
      "POST",
      `/v1/workspace-projects/${project.id}/first-share-copy`,
      {
        body: {
          expectedVersion: project.version,
          personalProjectVersion: share.snapshot.personalProjectVersion,
          workItems: share.snapshot.workItems,
          sources: share.snapshot.sources,
          decks: share.snapshot.decks
        },
        expectedStatus: 200
      }
    )
  ).body;

const confirm = async (
  fixture: Hq713Fixture,
  share: FirstShare,
  workspaceProjectId: string,
  expectedStatus: number | number[]
) =>
  fixture.alice.personalEdge.request(
    "POST",
    `/v1/local-edge/projects/${share.personalProjectId}/workspace-project-confirm`,
    {
      body: {
        teamBackendId: fixture.teamBackendId,
        workspaceProjectId,
        expectedPersonalProjectVersion: share.snapshot.personalProjectVersion
      },
      expectedStatus
    }
  );

const assertOriginal = async (fixture: Hq713Fixture, share: FirstShare) => {
  const project = await fixture.personalDb(fixture.alice).query<{
    workspace_project_id: string | null;
    lifecycle: string;
  }>("select workspace_project_id,lifecycle from projects where id=$1 and owner_user_id=$2", [share.personalProjectId, fixture.alice.id]);
  assert.equal(project.rows.length, 1);
  assert.equal(project.rows[0]!.lifecycle, "active");
  const item = await fixture.personalDb(fixture.alice).query<{
    title: string;
    deleted_at: Date | null;
  }>("select title,deleted_at from project_work_items where id=$1 and owner_user_id=$2", [share.sourceItemId, fixture.alice.id]);
  assert.equal(item.rows.length, 1);
  assert.ok(item.rows[0]!.title.includes("private original"));
  assert.equal(item.rows[0]!.deleted_at, null);
  return project.rows[0]!.workspace_project_id;
};

const deleteTeamProject = async (fixture: Hq713Fixture, projectId: string) => {
  const review = await fixture.alice.team.request<{
    project: { version: number };
  }>("GET", `/v1/workspace-projects/${projectId}/lifecycle-review`, {
    expectedStatus: 200
  });
  const body = { expectedProjectVersion: review.body.project.version };
  const grant = await fixture.approveActionGrant(fixture.alice, {
    action: "workspace_project.delete",
    teamId: fixture.ids.teamId,
    projectId,
    body
  });
  const deleted = await fixture.alice.team.request<{ lifecycle: string }>(
    "POST",
    `/v1/workspace-projects/${projectId}/delete`,
    {
      body,
      headers: { "x-koed-action-grant": grant.secret },
      expectedStatus: 200
    }
  );
  assert.equal(deleted.body.lifecycle, "deleted");
};

/** An uncertain create reply is recovered from durable Personal and Team state. */
export const runHq713FirstShareReplyReplay = async (fixture: Hq713Fixture) => {
  const share = await createFirstShare(fixture, "HQ713 reply replay");
  const first = await teamCreate(fixture, share);
  // Treat the returned bytes as lost: recover solely through the stored
  // Personal attempt after a production Personal API restart, then replay
  // the same Team creation request.
  await fixture.restartPersonal(fixture.alice);
  const recovered = await fixture.alice.personalEdge.request<{
    attempt: { shareAttemptKey: string; targetWorkspaceId: string };
  }>(
    "GET",
    `/v1/local-edge/projects/${share.personalProjectId}/workspace-project-share-attempt`,
    { expectedStatus: 200 }
  );
  assert.equal(recovered.body.attempt.shareAttemptKey, share.attemptKey);
  assert.equal(recovered.body.attempt.targetWorkspaceId, share.workspaceId);
  const replay = await teamCreate(fixture, share);
  assert.equal(replay.id, first.id);
  const copied = await teamCopy(fixture, share, replay);
  assert.ok(copied.copiedAt);
  const confirmed = await confirm(fixture, share, replay.id, 200);
  assert.equal((confirmed.body as { moved: boolean }).moved, true);
  assert.equal(await assertOriginal(fixture, share), replay.id);
  fixture.results.record("I713.first-share-reply-replay", {
    projectId: replay.id,
    attemptKey: share.attemptKey,
    exactReplay: true,
    coldPersonalApiRestart: true,
    originalItemId: share.sourceItemId
  });
};

/** The Team target cannot drift between Personal preparation and confirmation. */
export const runHq713FirstShareTargetMismatch = async (
  fixture: Hq713Fixture
) => {
  const share = await createFirstShare(fixture, "HQ713 target mismatch");
  const wrongWorkspaceId = await createWorkspace(fixture, "Wrong target");
  const wrong = await fixture.alice.team.request<Project>(
    "POST",
    "/v1/workspace-projects",
    {
      body: { ...share.createBody, workspaceId: wrongWorkspaceId },
      expectedStatus: 201
    }
  );
  await teamCopy(fixture, share, wrong.body);
  const denied = await confirm(fixture, share, wrong.body.id, [403, 409]);
  assert.ok([403, 409].includes(denied.status));
  assert.equal(await assertOriginal(fixture, share), null);
  fixture.results.record("I713.first-share-target-mismatch", {
    intendedWorkspaceId: share.workspaceId,
    wrongWorkspaceId,
    wrongProjectId: wrong.body.id,
    confirmationStatus: denied.status,
    originalItemId: share.sourceItemId
  });
};

/** A canceled exact attempt fences a delayed Team-create replay. */
export const runHq713FirstShareDelayedCreate = async (
  fixture: Hq713Fixture
) => {
  const share = await createFirstShare(fixture, "HQ713 delayed create");
  const canceled = await fixture.alice.personalEdge.request<{
    canceled: boolean;
    shareAttemptKey: string;
  }>(
    "POST",
    `/v1/local-edge/projects/${share.personalProjectId}/workspace-project-share-cancel`,
    { body: {}, expectedStatus: 200 }
  );
  assert.equal(canceled.body.canceled, true);
  assert.equal(canceled.body.shareAttemptKey, share.attemptKey);
  const delayed = await fixture.alice.team.request(
    "POST",
    "/v1/workspace-projects",
    {
      body: share.createBody,
      expectedStatus: [403, 409]
    }
  );
  assert.ok([403, 409].includes(delayed.status));
  assert.equal(await assertOriginal(fixture, share), null);
  fixture.results.record("I713.first-share-delayed-create", {
    attemptKey: share.attemptKey,
    delayedCreateStatus: delayed.status,
    originalItemId: share.sourceItemId
  });
};

/** A deleted Team copy must release only its exact Personal attempt. */
export const runHq713FirstShareDeleteBeforeConfirm = async (
  fixture: Hq713Fixture
) => {
  const share = await createFirstShare(fixture, "HQ713 delete before confirm");
  const project = await teamCreate(fixture, share);
  await teamCopy(fixture, share, project);
  await deleteTeamProject(fixture, project.id);
  const denied = await confirm(fixture, share, project.id, [403, 409, 424]);
  assert.ok([403, 409, 424].includes(denied.status));
  assert.equal(await assertOriginal(fixture, share), null);
  const recovered = await fixture.alice.personalEdge.request<{
    canceled: boolean;
    shareAttemptKey: string;
  }>(
    "POST",
    `/v1/local-edge/projects/${share.personalProjectId}/workspace-project-share-cancel`,
    { body: {}, expectedStatus: 200 }
  );
  assert.equal(recovered.body.canceled, true);
  assert.equal(recovered.body.shareAttemptKey, share.attemptKey);
  assert.equal(await assertOriginal(fixture, share), null);

  const uncopiedShare = await createFirstShare(
    fixture,
    "HQ713 delete before first copy"
  );
  const uncopied = await teamCreate(fixture, uncopiedShare);
  assert.equal(uncopied.copiedAt ?? null, null);
  await deleteTeamProject(fixture, uncopied.id);
  const uncopiedRecovered = await fixture.alice.personalEdge.request<{
    canceled: boolean;
    shareAttemptKey: string;
  }>(
    "POST",
    `/v1/local-edge/projects/${uncopiedShare.personalProjectId}/workspace-project-share-cancel`,
    { body: {}, expectedStatus: 200 }
  );
  assert.equal(uncopiedRecovered.body.canceled, true);
  assert.equal(
    uncopiedRecovered.body.shareAttemptKey,
    uncopiedShare.attemptKey
  );
  assert.equal(await assertOriginal(fixture, uncopiedShare), null);
  fixture.results.record("I713.first-share-delete-before-confirm", {
    copiedTeamProjectId: project.id,
    uncopiedTeamProjectId: uncopied.id,
    copiedAttemptKey: share.attemptKey,
    uncopiedAttemptKey: uncopiedShare.attemptKey,
    deniedStatus: denied.status,
    copiedOriginalItemId: share.sourceItemId,
    uncopiedOriginalItemId: uncopiedShare.sourceItemId,
    exactTombstoneRecovery: true,
    noCopyReceiptRecovery: true
  });
};

/** A confirmed Personal link reconciles Team deletion without losing originals. */
export const runHq713FirstShareDeleteAfterConfirm = async (
  fixture: Hq713Fixture
) => {
  const share = await createFirstShare(fixture, "HQ713 delete after confirm");
  const project = await teamCreate(fixture, share);
  await teamCopy(fixture, share, project);
  const confirmed = await confirm(fixture, share, project.id, 200);
  assert.equal((confirmed.body as { moved: boolean }).moved, true);
  await deleteTeamProject(fixture, project.id);
  const reconciled = await fixture.alice.personalEdge.request<{
    cleared: boolean;
  }>(
    "POST",
    `/v1/local-edge/projects/${share.personalProjectId}/workspace-project-reconcile`,
    { body: {}, expectedStatus: 200 }
  );
  assert.equal(reconciled.body.cleared, true);
  await assertOriginal(fixture, share);
  fixture.results.record("I713.first-share-delete-after-confirm", {
    teamProjectId: project.id,
    originalItemId: share.sourceItemId,
    reconciled: true
  });
};

const setWorkspaceAccess = async (
  fixture: Hq713Fixture,
  workspaceId: string,
  targetUserId: string,
  access: "write" | "disabled",
  expectedVersion: number | null,
  actor: Hq713Fixture["alice"] = fixture.alice
) => {
  const body = {
    userId: targetUserId,
    access,
    expectedVersion
  };
  const grant = await fixture.approveActionGrant(actor, {
    action: "team.workspace.access_update",
    teamId: fixture.ids.teamId,
    teamWorkspaceId: workspaceId,
    body
  });
  const changed = await actor.team.request<{
    access: { access: string; version: number };
  }>("PUT", `/v1/team-workspaces/${workspaceId}/access`, {
    body,
    headers: { "x-koed-action-grant": grant.secret },
    expectedStatus: 200
  });
  assert.equal(changed.body.access.access, access);
  return changed.body.access.version;
};

const giveBobAdministration = async (
  fixture: Hq713Fixture,
  workspaceId: string
) => {
  const membership = await fixture.bob.team.request<{
    membership: { version: number };
  }>("GET", `/v1/teams/${fixture.ids.teamId}/membership`, {
    expectedStatus: 200
  });
  const body = {
    role: "admin",
    expectedVersion: membership.body.membership.version
  };
  const grant = await fixture.approveActionGrant(fixture.alice, {
    action: "team.member.role_update",
    teamId: fixture.ids.teamId,
    userId: fixture.bob.teamUserId,
    body
  });
  await fixture.alice.team.request(
    "PATCH",
    `/v1/teams/${fixture.ids.teamId}/members/${fixture.bob.teamUserId}/role`,
    {
      body,
      headers: { "x-koed-action-grant": grant.secret },
      expectedStatus: 200
    }
  );
  await setWorkspaceAccess(
    fixture,
    workspaceId,
    fixture.bob.teamUserId,
    "write",
    null
  );
};

const disableAliceWorkspaceAccess = async (
  fixture: Hq713Fixture,
  workspaceId: string
) => {
  await giveBobAdministration(fixture, workspaceId);
  const current = await fixture.alice.team.request<{
    access: { version: number; access: string };
  }>("GET", `/v1/team-workspaces/${workspaceId}/access`, {
    expectedStatus: 200
  });
  assert.equal(current.body.access.access, "write");
  return setWorkspaceAccess(
    fixture,
    workspaceId,
    fixture.alice.teamUserId,
    "disabled",
    current.body.access.version,
    fixture.bob
  );
};

/** Loss of Team access before confirmation must preserve the Personal fence. */
export const runHq713FirstShareAccessLossBeforeConfirm = async (
  fixture: Hq713Fixture
) => {
  const share = await createFirstShare(
    fixture,
    "HQ713 access loss before confirm"
  );
  const project = await teamCreate(fixture, share);
  await teamCopy(fixture, share, project);
  const disabledVersion = await disableAliceWorkspaceAccess(
    fixture,
    share.workspaceId
  );
  const denied = await confirm(fixture, share, project.id, [403, 409, 424]);
  assert.ok([403, 409, 424].includes(denied.status));
  const pending = await fixture.personalDb(fixture.alice).query<{
    state: string;
    share_attempt_key: string;
  }>(
    `select state,share_attempt_key from personal_workspace_project_share_attempts
      where owner_user_id=$1 and personal_project_id=$2`,
    [fixture.alice.id, share.personalProjectId]
  );
  assert.deepEqual(pending.rows, [
    {
      state: "pending",
      share_attempt_key: share.attemptKey
    }
  ]);
  assert.equal(await assertOriginal(fixture, share), null);
  const restoredVersion = await setWorkspaceAccess(
    fixture,
    share.workspaceId,
    fixture.alice.teamUserId,
    "write",
    disabledVersion,
    fixture.bob
  );
  assert.ok(restoredVersion > disabledVersion);
  await deleteTeamProject(fixture, project.id);
  const recovered = await fixture.alice.personalEdge.request<{
    canceled: boolean;
    shareAttemptKey: string;
  }>(
    "POST",
    `/v1/local-edge/projects/${share.personalProjectId}/workspace-project-share-cancel`,
    { body: {}, expectedStatus: 200 }
  );
  assert.equal(recovered.body.canceled, true);
  assert.equal(recovered.body.shareAttemptKey, share.attemptKey);
  assert.equal(await assertOriginal(fixture, share), null);
  fixture.results.record("I713.first-share-access-loss-before-confirm", {
    teamProjectId: project.id,
    deniedStatus: denied.status,
    pendingAttemptPreserved: true,
    administratorRestoredAccess: true,
    exactTerminalRecovery: true,
    originalItemId: share.sourceItemId
  });
};

/** Loss of Team access after confirmation never revives former access. */
export const runHq713FirstShareAccessLossAfterConfirm = async (
  fixture: Hq713Fixture
) => {
  const share = await createFirstShare(
    fixture,
    "HQ713 access loss after confirm"
  );
  const project = await teamCreate(fixture, share);
  await teamCopy(fixture, share, project);
  await confirm(fixture, share, project.id, 200);
  await disableAliceWorkspaceAccess(fixture, share.workspaceId);
  const denied = await fixture.alice.team.request(
    "GET",
    `/v1/workspace-projects/${project.id}/link-proof`,
    { expectedStatus: 403 }
  );
  assert.equal(denied.status, 403);
  const reconciled = await fixture.alice.personalEdge.request<{
    cleared: boolean;
  }>(
    "POST",
    `/v1/local-edge/projects/${share.personalProjectId}/workspace-project-reconcile`,
    { body: {}, expectedStatus: 200 }
  );
  assert.equal(reconciled.body.cleared, true);
  await assertOriginal(fixture, share);
  fixture.results.record("I713.first-share-access-loss-after-confirm", {
    teamProjectId: project.id,
    linkProofStatus: denied.status,
    originalItemId: share.sourceItemId,
    reconciled: true
  });
};
