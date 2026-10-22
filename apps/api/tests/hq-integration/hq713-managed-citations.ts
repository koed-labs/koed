import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { Hq713Actor, Hq713Fixture } from "./hq713-fixture.js";
import {
  answerTeam,
  persistHq713TeamQuestion,
  teamEvidenceForGrant,
  type Hq713SharedSession
} from "./hq713-memory.js";

type Value = Record<string, unknown>;

const object = (value: unknown, label: string): Value => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  return value as Value;
};
const array = (value: unknown, label: string): unknown[] => {
  assert.ok(Array.isArray(value), label);
  return value;
};
const string = (value: unknown, label: string): string => {
  assert.ok(typeof value === "string", label);
  assert.ok(value.length > 0, label);
  return value;
};
const number = (value: unknown, label: string): number => {
  assert.ok(typeof value === "number", label);
  assert.ok(Number.isSafeInteger(value) && value > 0, label);
  return value;
};

export interface Hq713ManagedCitationContext {
  executionId: string;
  executionGeneration: number;
  actorName: "bob";
  providerTurnId: string;
  aliases: string[];
  questionIds: string[];
}

export interface Hq713LeasedExecution {
  executionId: string;
  executionGeneration: number;
  runnerId: string;
  commandId: string;
  leaseToken: string;
  sessionId: string;
  logicalSessionId: string;
  actorName: "alice" | "bob";
}

/** Launch, claim, and bind a real Personal managed execution over HTTP. */
export async function createHq713LeasedExecution(
  fixture: Hq713Fixture,
  actor: Hq713Actor = fixture.bob
): Promise<Hq713LeasedExecution> {
  assert.ok(
    actor.personalRunner,
    "Real Personal runner credential is required"
  );
  assert.ok(actor.managedLaunch, "Ready AI Client availability is required");
  const captured = await fixture.seedCapturedSession(actor, {
    projectId:
      actor.name === "bob"
        ? fixture.ids.bobPersonalProjectId
        : fixture.ids.alicePersonalProjectId,
    sessionLabel: `hq713-managed-${randomUUID()}`
  });
  const localSession = await fixture.personalDb(actor).query<{
    logical_session_id: string;
  }>("select logical_session_id from sessions where id=$1 and owner_user_id=$2", [captured.sessionId, actor.id]);
  assert.equal(
    localSession.rowCount,
    1,
    "Managed binding needs captured session"
  );
  const logicalSessionId = string(
    localSession.rows[0]?.logical_session_id,
    "captured logical session"
  );
  const launched = await actor.personal.request(
    "POST",
    "/v1/managed-conversations",
    {
      body: {
        projectId:
          actor.name === "bob"
            ? fixture.ids.bobPersonalProjectId
            : fixture.ids.alicePersonalProjectId,
        contextKind: "project",
        provider: "codex",
        aiClientInstanceId: actor.managedLaunch.instanceId,
        model: actor.managedLaunch.model,
        reasoningEffort: null,
        permissionMode: "supervised",
        runnerKind: "local_device",
        idempotencyKey: randomUUID()
      },
      expectedStatus: 202
    }
  );
  const launch = object(launched.body, "managed launch");
  const execution = object(launch.execution, "managed execution");
  const executionId = string(execution.id, "managed execution id");
  const generation = number(
    execution.executionGeneration,
    "execution generation"
  );
  const commandId = string(
    object(launch.command, "start command").id,
    "start command id"
  );
  await actor.personalRunner.request(
    "POST",
    `/v1/managed-conversation-runner/executions/${executionId}/runtime-binding-ready`,
    { body: { executionGeneration: generation }, expectedStatus: 200 }
  );
  const runnerId = `hq713-citation-${randomUUID()}`;
  const claimed = await actor.personalRunner.request(
    "POST",
    "/v1/managed-conversation-runner/commands/claim",
    { body: { runnerId, limit: 8, leaseMs: 180_000 }, expectedStatus: 200 }
  );
  const commands = array(
    object(claimed.body, "runner claim").commands,
    "claimed commands"
  ).map((item) => object(item, "claimed command"));
  const command = commands.find((item) => item.id === commandId);
  assert.ok(command, "Runner must claim the exact production start command");
  const leaseToken = string(command.leaseToken, "command lease token");
  const current = object(command.execution, "leased execution");
  assert.equal(
    current.id,
    executionId,
    "Claimed execution must match the new launch"
  );
  assert.equal(current.executionGeneration, generation);
  const stateVersion = number(current.stateVersion, "execution state version");
  const bound = await actor.personalRunner.request(
    "POST",
    `/v1/managed-conversation-runner/executions/${executionId}/runtime`,
    {
      body: {
        expectedStateVersion: stateVersion,
        executionGeneration: generation,
        runnerId,
        logicalSessionId,
        providerThreadId: `hq713-thread-${randomUUID()}`
      },
      expectedStatus: 200
    }
  );
  assert.equal(
    object(object(bound.body, "runtime bind").execution, "bound execution")
      .state,
    "running"
  );
  return {
    executionId,
    executionGeneration: generation,
    runnerId,
    commandId,
    leaseToken,
    sessionId: captured.sessionId,
    logicalSessionId,
    actorName: actor.name
  };
}

/** Two Team recalls become durable aliases in one live provider turn. */
export async function runHq713ManagedCitationControl(
  fixture: Hq713Fixture,
  shared: Hq713SharedSession,
  existingLease?: Hq713LeasedExecution
): Promise<Hq713ManagedCitationContext> {
  const leased = existingLease ?? (await createHq713LeasedExecution(fixture));
  assert.equal(leased.actorName, "bob", "Bob must own this citation turn");
  const actor = fixture.bob;
  const { executionId, commandId, leaseToken } = leased;
  const generation = leased.executionGeneration;
  const providerTurnId = `hq713-turn-${randomUUID()}`;
  const aliases: string[] = [];
  const questionIds: string[] = [];
  for (let call = 0; call < 2; call += 1) {
    const answer = await answerTeam(
      fixture,
      actor,
      shared.summaryText,
      "scoped_leaf_search"
    );
    assert.ok(
      teamEvidenceForGrant(answer, shared.grantId).length > 0,
      "Each managed recall must cite the active shared grant"
    );
    const citations = array(answer.citations, "Team answer citations").map(
      (item) => object(item, "Team answer citation")
    );
    assert.ok(
      citations.length > 0,
      `Team recall ${call + 1} must cite a source`
    );
    const questionId = await persistHq713TeamQuestion(
      fixture,
      actor,
      answer,
      shared.summaryText
    );
    questionIds.push(questionId);
    const receiptId = randomUUID();
    const observedCitations: Value[] = [];
    const verifiedTeamSources: Value[] = [];
    for (const [ordinal, citation] of citations.entries()) {
      const detailResponse = await actor.team.request(
        "GET",
        `/v1/memory/questions/${questionId}/citations/${ordinal}`,
        { expectedStatus: 200 }
      );
      const detail = object(
        object(detailResponse.body, "Team detail").detail,
        "verified Team detail"
      );
      const sourceId = string(
        citation.sourceId ?? citation.nodeId,
        "cited source id"
      );
      assert.equal(
        detail.sourceId,
        sourceId,
        "Team detail must match the observed citation"
      );
      const sourceType = string(citation.sourceType, "cited source type");
      assert.equal(detail.sourceType, sourceType, "Team detail source type");
      assert.equal(detail.teamWorkspaceId, fixture.ids.workspaceId);
      assert.ok(
        ["memory_node", "curated_memory", "memory_event"].includes(sourceType)
      );
      const alias = `r${receiptId.replaceAll("-", "")}c${ordinal + 1}`;
      aliases.push(alias);
      observedCitations.push({ ...citation, citationId: alias });
      verifiedTeamSources.push({
        sourceType,
        sourceId,
        teamWorkspaceId: fixture.ids.workspaceId,
        sourceOwnerPrincipalId: string(
          detail.sourceOwnerPrincipalId,
          "source owner"
        )
      });
    }
    const recorded = await actor.personalRunner.request(
      "POST",
      "/v1/managed-conversation-runner/turn-citations",
      {
        body: {
          executionId,
          executionGeneration: generation,
          commandId,
          leaseToken,
          providerTurnId,
          toolCallId: `hq713-tool-${call + 1}-${randomUUID()}`,
          questionId,
          receiptId,
          observedCitations,
          questionBackendId: fixture.teamBackendId,
          verifiedTeamSources
        },
        expectedStatus: 200
      }
    );
    const stored = array(
      object(recorded.body, "managed receipt").citations,
      "stored aliases"
    );
    assert.equal(
      stored.length,
      aliases.length,
      "Both tool calls must accumulate every observed turn citation"
    );
    assert.deepEqual(
      new Set(
        stored.map((item) =>
          string(object(item, "stored alias").alias, "stored alias ID")
        )
      ),
      new Set(aliases),
      "The runner response must retain the exact aliases across calls"
    );
  }
  const turnPath = `/v1/managed-conversations/${executionId}/turn-citations`;
  const byTurn = await actor.personal.request(
    "GET",
    `${turnPath}?providerTurnId=${encodeURIComponent(providerTurnId)}`,
    { expectedStatus: 200 }
  );
  const turnCitations = array(
    object(byTurn.body, "turn reload").citations,
    "reloaded turn citations"
  ).map((item) => object(item, "reloaded citation"));
  assert.equal(
    turnCitations.length,
    aliases.length,
    "Both recalls must persist in one turn"
  );
  assert.deepEqual(
    new Set(turnCitations.map((item) => item.alias)),
    new Set(aliases)
  );
  const byAlias = await actor.personal.request(
    "GET",
    `${turnPath}?aliases=${aliases.join(",")}`,
    { expectedStatus: 200 }
  );
  assert.equal(
    array(object(byAlias.body, "alias reload").citations, "alias citations")
      .length,
    aliases.length
  );
  for (const alias of aliases) {
    const entry = await actor.personal.request(
      "GET",
      `${turnPath}/${alias}?providerTurnId=${encodeURIComponent(providerTurnId)}`,
      { expectedStatus: 200 }
    );
    const locator = object(
      object(entry.body, "alias detail").sourceLocator,
      "source locator"
    );
    assert.equal(locator.backendId, fixture.teamBackendId);
    assert.equal(locator.visibility, "team");
    assert.ok(questionIds.includes(locator.questionId as string));
    await actor.team.request(
      "GET",
      `/v1/memory/questions/${locator.questionId}/citations/${locator.ordinal}`,
      { expectedStatus: 200 }
    );
  }
  fixture.results.record("I28.managed-turn", {
    executionId,
    providerTurnId,
    questionCount: questionIds.length,
    aliasCount: aliases.length,
    durableByTurn: true,
    durableByAlias: true,
    currentTeamDetails: true
  });
  return {
    executionId,
    executionGeneration: generation,
    actorName: "bob",
    providerTurnId,
    aliases,
    questionIds
  };
}

/** Run after the owning share grant is revoked through production HTTP. */
export async function runHq713ManagedCitationRevocationControl(
  fixture: Hq713Fixture,
  retained: Hq713ManagedCitationContext
): Promise<void> {
  assert.ok(
    retained.aliases.length >= 2,
    "Two retained citation aliases are required"
  );
  const path = `/v1/managed-conversations/${retained.executionId}/turn-citations`;
  const history = await fixture.bob.personal.request(
    "GET",
    `${path}?providerTurnId=${encodeURIComponent(retained.providerTurnId)}`,
    { expectedStatus: 200 }
  );
  const entries = array(
    object(history.body, "retained history").citations,
    "retained aliases"
  ).map((item) => object(item, "retained citation"));
  assert.equal(entries.length, retained.aliases.length);
  assert.ok(entries.every((entry) => entry.detailAvailable === false));
  for (const alias of retained.aliases) {
    const entry = await fixture.bob.personal.request(
      "GET",
      `${path}/${alias}?providerTurnId=${encodeURIComponent(retained.providerTurnId)}`,
      { expectedStatus: 200 }
    );
    const locator = object(
      object(entry.body, "retained alias").sourceLocator,
      "retained source locator"
    );
    const current = await fixture.bob.team.request(
      "GET",
      `/v1/memory/questions/${locator.questionId}/citations/${locator.ordinal}`
    );
    assert.ok(
      [403, 404].includes(current.status),
      "Revoked Team citation detail remains accessible"
    );
  }
  fixture.results.record("I28.managed-turn-revoked", {
    retainedAliasCount: entries.length,
    currentTeamDetailsDenied: true
  });
}
