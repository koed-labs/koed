import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MemoryApiClient } from "../../../../packages/mcp-server/src/index.js";
import { MemoryToolExecutor } from "../../../../packages/mcp-server/src/memory-tool-executor.js";
import { createMemoryAnswerTaskCoordinator } from "../../../../packages/mcp-server/src/memory-answer-task-coordinator.js";
import { MemoryAnswerTaskScheduler } from "../../../../packages/mcp-server/src/memory-answer-task-scheduler.js";
import { runScriptedMemoryAnswerFirstPass } from "../../../../packages/mcp-server/src/answer-worker.js";
import type { Hq713Fixture } from "./hq713-fixture.js";
import type { Hq713ManagedCitationContext } from "./hq713-managed-citations.js";

/** Instrument the production HTTP client without replacing its responses. */
class ObservedMemoryClient extends MemoryApiClient {
  readonly calls: Array<{
    branch: "personal" | "team";
    backendId?: string;
    input: Record<string, unknown>;
  }> = [];
  override async search(input: Parameters<MemoryApiClient["search"]>[0]) {
    this.calls.push({ branch: "personal", input: { ...input } });
    return super.search(input);
  }
  override async teamMemorySearch(
    ...args: Parameters<MemoryApiClient["teamMemorySearch"]>
  ) {
    this.calls.push({
      branch: "team",
      backendId: args[0],
      input: { ...args[1] }
    });
    return super.teamMemorySearch(...args);
  }
}

/** Real durable tasks, claim authority, local-edge routing and retrieval. The
 * only deterministic test component is local AI-client answer wording: it uses
 * the actual retrieved evidence and never supplies authority or invented data. */
export async function runHq713RuntimeSelectorControl(
  fixture: Hq713Fixture,
  managed: Pick<
    Hq713ManagedCitationContext,
    "executionId" | "executionGeneration"
  >
) {
  const actor = fixture.bob;
  const client = new ObservedMemoryClient({
    apiUrl: actor.personal.baseUrl,
    authorizationProvider: async () => actor.personalTokenAuthorization
  });
  const environment = { ...process.env, KOED_HOME: actor.koedHome };
  const coordinator = createMemoryAnswerTaskCoordinator(client, environment);
  const executor = new MemoryToolExecutor(client, environment, {
    answerWithMemoryWorker: async (_payload, options) => {
      assert.ok(options?.client);
      const first = await runScriptedMemoryAnswerFirstPass({
        client: options.client,
        query: "hq713",
        retrievalScope: options.retrievalScope ?? "personal",
        searchDomain: options.searchDomain ?? "global",
        projectId: options.projectId,
        teamWorkspaceId: options.teamWorkspaceId,
        limit: 20,
        maxSearches: 1
      });
      assert.deepEqual(
        first.errors,
        [],
        "Fixture retrieval must succeed before synthesizing"
      );
      return {
        markdown: first.evidence.length
          ? "Retrieved the authorized fixture evidence."
          : "No authorized fixture evidence was found.",
        evidenceBundle: {
          evidence: first.evidence,
          retrieval: { searches: first.searches.length }
        },
        citations: first.citations,
        retrieval: { evidenceCount: first.evidence.length },
        localMemoryWorker: {
          provider: "codex",
          promptVersion: "hq713-test-driver",
          jobId: randomUUID(),
          model: "local-deterministic-fixture",
          usedFallback: false
        }
      };
    }
  });
  const failures: string[] = [];
  const scheduler = new MemoryAnswerTaskScheduler(
    coordinator,
    {
      executeMemoryAnswerTask: async (...args) => {
        try {
          return await executor.executeMemoryAnswerTask(...args);
        } catch (error) {
          failures.push(
            error instanceof Error ? error.message : "Unknown execution error"
          );
          throw error;
        }
      }
    },
    {
      executionContextForTask: coordinator.executionContextForTask
    }
  );
  const input = {
    query: "hq713",
    search_domain: "project",
    project_id: "forged-personal-project",
    session_id: randomUUID(),
    managed_project_recall: {
      execution_id: managed.executionId,
      execution_generation: managed.executionGeneration
    },
    response_detail: "with_citations",
    include_evidence: false,
    retrieval_hints: {},
    limit: 20
  };
  try {
    const task = await scheduler.start({
      origin: "mcp",
      invocationKey: randomUUID(),
      toolInput: input,
      caller: { cwd: actor.koedHome }
    });
    const completed = await scheduler.waitForTerminal(
      task.id,
      AbortSignal.timeout(30_000)
    );
    assert.equal(
      completed.status,
      "completed",
      JSON.stringify({
        code: completed.lastErrorCode,
        message: completed.lastErrorMessage,
        failures,
        apiErrors: fixture.apiErrors()
      })
    );
    assert.equal(completed.result?.availability, "team_checked");
    assert.equal(
      completed.result?.selected_personal_project_id,
      fixture.ids.bobPersonalProjectId
    );
    assert.equal(
      completed.result?.selected_team_backend_id,
      fixture.teamBackendId
    );
    const personal = client.calls.filter(({ branch }) => branch === "personal");
    const team = client.calls.filter(({ branch }) => branch === "team");
    assert.ok(personal.length > 0 && team.length > 0);
    for (const call of personal) {
      assert.equal(call.input.search_domain, "project");
      assert.equal(call.input.project_id, fixture.ids.bobPersonalProjectId);
      assert.equal(call.input.personal_project_and_me, true);
      assert.equal(call.input.session_id, undefined);
    }
    for (const call of team) {
      assert.equal(call.backendId, fixture.teamBackendId);
      assert.equal(call.input.search_domain, "global");
      assert.equal(call.input.team_workspace_id, fixture.ids.workspaceId);
      assert.equal(call.input.project_id, undefined);
      assert.equal(call.input.personal_project_and_me, undefined);
      assert.ok(
        call.input.authorization_boundary,
        "Team claim must supply current authority"
      );
    }
    fixture.results.record("I30.runtime-selectors", {
      taskId: task.id,
      personalCalls: personal.length,
      teamCalls: team.length,
      trustedBackend: fixture.teamBackendId
    });
    fixture.blockTeamPath("POST", "/v1/memory/answer-tasks");
    try {
      const offline = await scheduler.start({
        origin: "mcp",
        invocationKey: randomUUID(),
        toolInput: input,
        caller: { cwd: actor.koedHome }
      });
      const partial = await scheduler.waitForTerminal(
        offline.id,
        AbortSignal.timeout(30_000)
      );
      assert.equal(partial.status, "completed");
      assert.equal(partial.result?.availability, "team_not_checked");
      assert.match(
        String(partial.result?.team_not_checked_notice),
        /not checked/
      );
      fixture.results.record("I30.runtime-Team-unavailable", {
        taskId: offline.id,
        availability: partial.result?.availability
      });
    } finally {
      fixture.resumeTeamPath("POST", "/v1/memory/answer-tasks");
    }
  } finally {
    await scheduler.close();
    client.closeBackgroundRequests();
  }
}
