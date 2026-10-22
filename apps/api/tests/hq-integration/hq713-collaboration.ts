import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createWorkspaceProjectClient } from "../../../desktop/src/koed-server/workspace-project-client.js";
import type { Hq713Fixture } from "./hq713-fixture.js";
import { openHq713WorkItemStream } from "./hq713-realtime.js";

type Project = { id: string; version: number; name: string };
type WorkItem = {
  id: string;
  title: string;
  goal: string;
  status: string;
  stepLabel?: string | null;
  version: number;
  dispatchKey?: string | null;
};

const projectPath = (fixture: Hq713Fixture) =>
  `/v1/workspace-projects/${fixture.ids.workspaceProjectId}`;

const readItems = async (fixture: Hq713Fixture, actor: "alice" | "bob") => {
  const response = await fixture[actor].team.request<{
    workItems?: WorkItem[];
    items?: WorkItem[];
  }>("GET", `${projectPath(fixture)}/work-items`, { expectedStatus: 200 });
  const items = response.body.workItems ?? response.body.items;
  assert.ok(Array.isArray(items), "Team Work Item list is malformed");
  return items;
};

export const runHq713ShareAndJoin = async (fixture: Hq713Fixture) => {
  const { alice, bob, ids } = fixture;
  const [aliceView, bobView] = await Promise.all([
    alice.team.request<Project>("GET", projectPath(fixture), {
      expectedStatus: 200
    }),
    bob.team.request<Project>("GET", projectPath(fixture), {
      expectedStatus: 200
    })
  ]);
  assert.equal(aliceView.body.id, ids.workspaceProjectId);
  assert.equal(bobView.body.id, ids.workspaceProjectId);
  assert.equal(bobView.body.name, "landing");
  const members = await bob.team.request<{ members?: unknown[] }>(
    "GET",
    `${projectPath(fixture)}/members`,
    { expectedStatus: 200 }
  );
  assert.ok(JSON.stringify(members.body).includes(bob.teamUserId));
  const aliceLink = await alice.personalEdge.request<{
    workspaceProjectId: string;
  }>(
    "GET",
    `/v1/projects/${ids.alicePersonalProjectId}/workspace-project-link`,
    { expectedStatus: 200 }
  );
  assert.equal(aliceLink.body.workspaceProjectId, ids.workspaceProjectId);
  const bearerProof = await bob.team.request(
    "GET",
    `${projectPath(fixture)}/member-link-proof`,
    {
      headers: { authorization: bob.personalTokenAuthorization },
      expectedStatus: [401, 403]
    }
  );
  fixture.results.record("I13-I14-step1-step2-share-join", {
    teamProjectId: ids.workspaceProjectId,
    ownerPersonalProjectId: ids.alicePersonalProjectId,
    memberId: bob.teamUserId,
    memberCount: members.body.members?.length ?? null,
    bearerProofDenied: bearerProof.status
  });
  await runHq713PrivateProjectHq(fixture);
};

export const runHq713PrivateProjectHq = async (fixture: Hq713Fixture) => {
  const executions: string[] = [];
  for (const [actor, projectId] of [
    [fixture.alice, fixture.ids.alicePersonalProjectId],
    [fixture.bob, fixture.ids.bobPersonalProjectId]
  ] as const) {
    const chief = await actor.personalEdge.request<{ agent: { id: string } }>(
      "POST",
      "/v1/agents/chief:ensure",
      {
        body: { aiClientInstanceId: actor.aiClientInstanceId },
        expectedStatus: 200
      }
    );
    assert.ok(chief.body.agent.id);
    const path = `/v1/projects/${projectId}/hq/conversation`;
    const reserved = await actor.personalEdge.request<{
      projectId: string;
      executionId: string | null;
    }>("POST", path, { expectedStatus: 200 });
    assert.equal(reserved.body.projectId, projectId);
    const started = await actor.personalEdge.request<{
      execution: { id: string; projectId: string };
      command: { id: string };
    }>("POST", `${path}:start`, {
      body: { prompt: `Privately plan ${actor.name}'s landing Project` },
      expectedStatus: 202
    });
    assert.equal(started.body.execution.projectId, projectId);
    const read = await actor.personalEdge.request<{
      conversation: { projectId: string; executionId: string | null };
    }>("GET", path, { expectedStatus: 200 });
    assert.equal(read.body.conversation?.projectId, projectId);
    assert.equal(
      read.body.conversation?.executionId,
      started.body.execution.id
    );
    executions.push(started.body.execution.id);
  }
  assert.notEqual(executions[0], executions[1]);
  const [aliceFromBob, bobFromAlice] = await Promise.all([
    fixture.alice.personalEdge.request(
      "GET",
      `/v1/projects/${fixture.ids.bobPersonalProjectId}/hq/conversation`,
      { expectedStatus: [403, 404] }
    ),
    fixture.bob.personalEdge.request(
      "GET",
      `/v1/projects/${fixture.ids.alicePersonalProjectId}/hq/conversation`,
      { expectedStatus: [403, 404] }
    )
  ]);
  const teamExecution = await fixture.team.db.query<{ count: number }>(
    "select count(*)::int as count from managed_conversation_executions where id=any($1::uuid[])",
    [executions]
  );
  assert.equal(teamExecution.rows[0]?.count, 0);
  fixture.results.record("HQ713-step2-private-project-HQ", {
    alicePersonalProjectId: fixture.ids.alicePersonalProjectId,
    bobPersonalProjectId: fixture.ids.bobPersonalProjectId,
    privateExecutionIds: executions,
    crossPersonalReadStatuses: [aliceFromBob.status, bobFromAlice.status],
    teamExecutionCount: teamExecution.rows[0]?.count
  });
};

export const runHq713LiveWorkItemCas = async (fixture: Hq713Fixture) => {
  const path = `${projectPath(fixture)}/work-items`;
  const title = `Bob task ${randomUUID()}`;
  const realtime = await openHq713WorkItemStream(fixture);
  try {
    const created = await fixture.bob.team.request<WorkItem>("POST", path, {
      body: {
        idempotencyKey: randomUUID(),
        kind: "todo",
        title,
        goal: "Prove Team Work Item synchronization and compare-and-set edits",
        status: "todo"
      },
      expectedStatus: 201
    });
    assert.equal(created.body.title, title);
    // Shared Project lifecycle events deliberately require a fresh authorized
    // snapshot. The Desktop refreshes its shared store on this recovery signal.
    const live = await realtime.waitForRefresh();
    const seenByAlice = (await readItems(fixture, "alice")).find(
      (item) => item.id === created.body.id
    );
    assert.ok(seenByAlice, "Alice must observe Bob's committed Work Item");
    assert.equal(seenByAlice.title, title);
    assert.equal(seenByAlice.version, created.body.version);
    const version = seenByAlice.version;
    const attempts = await Promise.all([
      fixture.alice.team.request<WorkItem & { current?: WorkItem }>(
        "PATCH",
        `${path}/${created.body.id}`,
        {
          body: { expectedVersion: version, title: "Alice's concurrent edit" },
          expectedStatus: [200, 409]
        }
      ),
      fixture.bob.team.request<WorkItem & { current?: WorkItem }>(
        "PATCH",
        `${path}/${created.body.id}`,
        {
          body: { expectedVersion: version, title: "Bob's concurrent edit" },
          expectedStatus: [200, 409]
        }
      )
    ]);
    assert.deepEqual(
      attempts.map((attempt) => attempt.status).sort(),
      [200, 409]
    );
    const winner = attempts.find((attempt) => attempt.status === 200)!;
    const loser = attempts.find((attempt) => attempt.status === 409)!;
    assert.equal(loser.body.current?.title, winner.body.title);
    assert.equal(winner.body.version, version + 1);
    const final = (await readItems(fixture, "bob")).find(
      (item) => item.id === created.body.id
    );
    assert.equal(final?.title, winner.body.title);
    fixture.results.record("HQ713-step4-work-item-CAS", {
      itemId: created.body.id,
      realSseRefresh: live,
      initialVersion: version,
      winnerVersion: winner.body.version,
      conflictStatus: loser.status,
      finalTitle: final?.title
    });
    return final;
  } finally {
    await realtime.close();
  }
};

export const runHq713PrivateAgentBoundary = async (fixture: Hq713Fixture) => {
  const path = `${projectPath(fixture)}/work-items`;
  const created = await fixture.bob.team.request<WorkItem>("POST", path, {
    body: {
      idempotencyKey: randomUUID(),
      kind: "todo",
      title: "Write release checklist",
      goal: "Prepare a release checklist",
      status: "todo"
    },
    expectedStatus: 201
  });
  const agent = await fixture.bob.personalEdge.request<{
    agent: { id: string };
  }>("POST", "/v1/agents", {
    body: {
      name: `Bob private HQ713 agent ${randomUUID()}`,
      role: null,
      look: {},
      aiClientInstanceId: fixture.bob.aiClientInstanceId,
      defaultPermissionMode: "supervised",
      defaultModel: null
    },
    expectedStatus: 201
  });
  const lifecycle = await fixture.bob.team.request<{
    version: number;
    memberVersion: number;
    canWrite: boolean;
  }>("GET", `${projectPath(fixture)}/lifecycle`, { expectedStatus: 200 });
  assert.equal(lifecycle.body.canWrite, true);
  const dispatch = await fixture.bob.personalEdge.request<{
    executionId: string;
    dispatchKey: string;
    reused: boolean;
  }>(
    "POST",
    `/v1/projects/${fixture.ids.bobPersonalProjectId}/shared-work-items/${created.body.id}/dispatch`,
    {
      body: {
        agentId: agent.body.agent.id,
        expectedProjectVersion: lifecycle.body.version,
        expectedMemberVersion: lifecycle.body.memberVersion,
        expectedWorkItemVersion: created.body.version
      },
      expectedStatus: 202
    }
  );
  assert.equal(dispatch.body.reused, false);
  assert.equal(
    dispatch.body.dispatchKey,
    `shared-work-item:${fixture.ids.workspaceProjectId}:${created.body.id}:${created.body.version}`
  );
  const privateExecution = await fixture.bob.personalBrowser.request<{
    execution: { id: string; projectId: string; executionGeneration: number };
  }>("GET", `/v1/managed-conversations/${dispatch.body.executionId}`, {
    expectedStatus: 200
  });
  assert.equal(privateExecution.body.execution.id, dispatch.body.executionId);
  assert.equal(
    privateExecution.body.execution.projectId,
    fixture.ids.bobPersonalProjectId
  );
  const privateRow = await fixture.personalDb(fixture.bob).query<{
    owner_user_id: string;
    project_id: string;
  }>("select owner_user_id, project_id from managed_conversation_executions where id=$1", [dispatch.body.executionId]);
  assert.equal(privateRow.rows[0]?.owner_user_id, fixture.bob.id);
  assert.equal(
    privateRow.rows[0]?.project_id,
    fixture.ids.bobPersonalProjectId
  );
  await fixture.bob.personalRunner.request(
    "GET",
    `/v1/managed-conversation-runner/executions/${dispatch.body.executionId}/shared-authority`,
    { expectedStatus: 200 }
  );
  const binding = await fixture.bob.personalRunner.request<{ ready: boolean }>(
    "POST",
    `/v1/managed-conversation-runner/executions/${dispatch.body.executionId}/runtime-binding-ready`,
    {
      body: {
        executionGeneration: privateExecution.body.execution.executionGeneration
      },
      expectedStatus: 200
    }
  );
  assert.equal(binding.body.ready, true);
  const claim = await fixture.bob.personalRunner.request<{
    commands: Array<{
      id: string;
      executionId: string;
      leaseToken: string | null;
    }>;
  }>("POST", "/v1/managed-conversation-runner/commands/claim", {
    body: { runnerId: `hq713-${randomUUID()}`, limit: 8, leaseMs: 30_000 },
    expectedStatus: 200
  });
  const privateCommand = claim.body.commands.find(
    (command) => command.executionId === dispatch.body.executionId
  );
  const commandRows = await fixture
    .personalDb(fixture.bob)
    .query(
      "select id, state, command_kind, target_device_id, target_deployment_id from managed_conversation_commands where execution_id=$1",
      [dispatch.body.executionId]
    );
  assert.ok(
    privateCommand?.leaseToken,
    `Bob's private runner must claim the dispatch: ${JSON.stringify({ claim: claim.body, rows: commandRows.rows })}`
  );
  await fixture.bob.personalEdge.request(
    "POST",
    `/v1/managed-conversations/${dispatch.body.executionId}/shared-progress`,
    {
      body: { commandId: privateCommand.id },
      expectedStatus: 200
    }
  );
  const aliceView = (await readItems(fixture, "alice")).find(
    (item) => item.id === created.body.id
  );
  assert.equal(aliceView?.status, "doing");
  assert.equal(aliceView.stepLabel, "Working now");
  assert.ok(!("conversationSessionId" in aliceView));
  assert.ok(!("conversationContent" in aliceView));
  const aliceTeamVisible = JSON.stringify(aliceView);
  assert.ok(!aliceTeamVisible.includes(dispatch.body.executionId));
  assert.ok(!aliceTeamVisible.includes(agent.body.agent.id));
  assert.ok(
    !aliceTeamVisible.includes("This is your private Managed Conversation")
  );
  const alicePersonalRead = await fixture.alice.personalBrowser.request(
    "GET",
    `/v1/managed-conversations/${dispatch.body.executionId}`,
    { expectedStatus: [403, 404] }
  );
  const alicePrivateRead = await fixture.alice.personalRunner.request(
    "GET",
    `/v1/managed-conversation-runner/executions/${dispatch.body.executionId}/shared-authority`,
    { expectedStatus: [403, 404] }
  );
  fixture.results.record("HQ713-step5-private-agent-boundary", {
    itemId: created.body.id,
    privateAgentId: agent.body.agent.id,
    privateExecutionId: dispatch.body.executionId,
    runnerCommandId: privateCommand.id,
    alicePersonalReadStatus: alicePersonalRead.status,
    alicePrivateReadStatus: alicePrivateRead.status,
    status: aliceView.status,
    stepLabel: aliceView.stepLabel,
    visibleFields: Object.keys(aliceView)
  });
};

export const runHq713OfflineReadOnly = async (fixture: Hq713Fixture) => {
  const path = projectPath(fixture);
  let invalidations = 0;
  const unusedPersonal = async (): Promise<never> => {
    throw new Error("Personal copy is outside the read-only refresh scenario");
  };
  const client = createWorkspaceProjectClient({
    sendTeam: async (route, init) => {
      const response = await fixture.bob.team.request(
        init?.method ?? "GET",
        route,
        {
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
        }
      );
      if (response.status >= 400)
        throw Object.assign(new Error(`Team HTTP ${response.status}`), {
          statusCode: response.status
        });
      return response.body;
    },
    loadPersonalCopy: unusedPersonal,
    markPersonalMoved: unusedPersonal,
    onAuthoritativeInvalidation: async () => {
      invalidations += 1;
    },
    loadPersonalSource: unusedPersonal,
    loadLinkedPersonalSources: async () => []
  });
  const prior = await client.refresh(fixture.ids.workspaceProjectId);
  assert.equal(prior.project?.id, fixture.ids.workspaceProjectId);
  assert.equal(prior.readOnly, false);
  assert.equal(
    prior.sources.length,
    0,
    "Scenario has no local Source reconciliation"
  );
  fixture.blockTeamPath("GET", path);
  try {
    const offline = await client.refresh(fixture.ids.workspaceProjectId);
    assert.equal(offline.project?.id, fixture.ids.workspaceProjectId);
    assert.equal(offline.readOnly, true);
    assert.match(offline.notice ?? "", /unavailable/i);
    assert.deepEqual(offline.workItems, prior.workItems);
    await assert.rejects(
      client.createWorkItem(fixture.ids.workspaceProjectId, {
        idempotencyKey: randomUUID(),
        kind: "todo",
        title: "Offline write",
        goal: "Must not write",
        status: "todo"
      }),
      /read-only/
    );
    assert.equal(invalidations, 0);
    fixture.results.record("HQ713-step7-Team-offline", {
      priorProjectId: prior.project?.id,
      cachedProjectId: offline.project?.id,
      cachedWorkItemCount: offline.workItems.length,
      readOnly: offline.readOnly,
      notice: offline.notice
    });
  } finally {
    fixture.resumeTeamPath("GET", path);
  }
  const restored = await client.refresh(fixture.ids.workspaceProjectId);
  assert.equal(restored.project?.id, fixture.ids.workspaceProjectId);
  assert.equal(restored.readOnly, false);
};

export const runHq713InterruptedFirstShare = async (fixture: Hq713Fixture) => {
  const { alice, ids } = fixture;
  const personal = await alice.personal.request<{ id: string }>(
    "POST",
    "/v1/projects",
    {
      body: { name: "second-share", idempotencyKey: randomUUID() },
      expectedStatus: 201
    }
  );
  const newWorkspaceBody = {
    teamId: ids.teamId,
    name: "Second share workspace"
  };
  const workspaceGrant = await fixture.approveActionGrant(alice, {
    action: "team.workspace.create",
    body: newWorkspaceBody
  });
  const workspace = await alice.team.request<{ teamWorkspace: { id: string } }>(
    "POST",
    "/v1/team-workspaces",
    {
      body: newWorkspaceBody,
      headers: { "x-koed-action-grant": workspaceGrant.secret },
      expectedStatus: 200
    }
  );
  const targetWorkspaceId = workspace.body.teamWorkspace.id;
  const shareAttemptKey = randomUUID();
  const prepared = await alice.personalEdge.request<{
    snapshot: {
      personalProjectVersion: number;
      workItems: unknown[];
      sources: unknown[];
      decks: unknown[];
    };
  }>(
    "POST",
    `/v1/local-edge/projects/${personal.body.id}/workspace-project-prepare`,
    {
      body: {
        teamBackendId: fixture.teamBackendId,
        shareAttemptKey,
        targetTeamId: ids.teamId,
        targetWorkspaceId
      },
      expectedStatus: 200
    }
  );
  const createBody = {
    teamId: ids.teamId,
    workspaceId: targetWorkspaceId,
    name: "second-share",
    key: "SECOND",
    shareAttemptKey
  };
  const first = await alice.team.request<Project>(
    "POST",
    "/v1/workspace-projects",
    {
      body: createBody,
      expectedStatus: 201
    }
  );
  // The interruption is after the Team row exists and before the copy commits.
  const resumed = await alice.team.request<Project>(
    "POST",
    "/v1/workspace-projects",
    {
      body: createBody,
      expectedStatus: 201
    }
  );
  assert.equal(resumed.body.id, first.body.id);
  const copy = await alice.team.request<{
    id: string;
    copiedAt: string | null;
  }>("POST", `/v1/workspace-projects/${first.body.id}/first-share-copy`, {
    body: {
      expectedVersion: first.body.version,
      personalProjectVersion: prepared.body.snapshot.personalProjectVersion,
      workItems: prepared.body.snapshot.workItems,
      sources: prepared.body.snapshot.sources,
      decks: prepared.body.snapshot.decks
    },
    expectedStatus: 200
  });
  assert.ok(copy.body.copiedAt);
  const list = await alice.team.request<Project[]>(
    "GET",
    `/v1/teams/${ids.teamId}/workspace-projects`,
    { expectedStatus: 200 }
  );
  const occurrenceCount = list.body.filter(
    (project) => project.id === first.body.id
  ).length;
  assert.equal(occurrenceCount, 1);
  fixture.results.record("HQ713-step10-interrupted-first-share", {
    shareAttemptKey,
    projectId: first.body.id,
    resumeId: resumed.body.id,
    occurrenceCount
  });
};
