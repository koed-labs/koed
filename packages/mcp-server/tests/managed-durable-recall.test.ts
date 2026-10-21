import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryAnswerTask } from "@koed/shared";
import type { MemoryApiClient } from "../src/index.js";
import type { LocalRuntimeCallerContext } from "../src/local-runtime-protocol.js";

const readContext = vi.hoisted(() => vi.fn());
vi.mock("../src/managed-project-recall-context.js", () => ({
  readManagedProjectRecallContext: readContext
}));

import { MemoryToolExecutor } from "../src/memory-tool-executor.js";

const linked = {
  linked: true as const,
  personalProjectId: randomUUID(),
  teamBackendId: "team-primary",
  teamWorkspaceId: randomUUID(),
  workspaceProjectId: randomUUID(),
  projectVersion: 3
};
const source = (visibility: "personal" | "team") => ({
  sourceType: "memory_node",
  sourceId: randomUUID(),
  visibility
});
const executionInput = {
  query: "What changed in the Project?",
  search_domain: "project",
  managed_project_recall: {
    execution_id: randomUUID(),
    execution_generation: 2
  }
};
const create = () => {
  const client = {
    config: { apiUrl: "http://127.0.0.1:3300" }
  } as MemoryApiClient;
  const executor = new MemoryToolExecutor(client, { KOED_HOME: "/koed-owned" });
  const personalQuestion = randomUUID();
  const personalSource = source("personal");
  const execute = vi
    .spyOn(executor, "executeMemoryAnswer")
    .mockImplementation(async (input, _caller, options) => {
      options.onFinalQuestionPrepared?.({
        query: input.query,
        searchDomain: input.search_domain,
        projectId: input.project_id
      });
      return {
        question_id: personalQuestion,
        markdown: "Personal Project decision",
        citations: [personalSource]
      };
    });
  return { executor, execute, personalQuestion };
};

describe("durable managed Project recall execution", () => {
  beforeEach(() => {
    readContext.mockReset().mockResolvedValue(linked);
  });

  it("persists two branch receipts from one parent task with a global Team child", async () => {
    const { executor, execute, personalQuestion } = create();
    const teamQuestion = randomUUID();
    const teamSource = source("team");
    const child: MemoryAnswerTask = {
      id: randomUUID(),
      origin: "mcp",
      invocationKey: null,
      questionId: teamQuestion,
      status: "completed",
      statusMessage: null,
      attemptCount: 1,
      maxAttempts: 3,
      fenceGeneration: 1,
      cancelRequestedAt: null,
      startedAt: null,
      lastProgressAt: null,
      completedAt: new Date().toISOString(),
      failedAt: null,
      cancelledAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      version: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      teamWorkspaceId: linked.teamWorkspaceId,
      result: {
        question_id: teamQuestion,
        team_backend_id: linked.teamBackendId,
        markdown: "Teammate summary",
        citations: [teamSource]
      }
    };
    const childInput = vi.fn(
      async (
        ...invocation: [
          Record<string, unknown>,
          LocalRuntimeCallerContext,
          string
        ]
      ) => {
        void invocation;
        return child;
      }
    );
    const result = await executor.executeMemoryAnswerTask(
      executionInput,
      { cwd: "/unrelated-project" },
      randomUUID(),
      undefined,
      undefined,
      {
        getExecutionAuthority: () => ({ scope: "personal" }),
        startCombinedTeamChild: childInput,
        getCombinedTeamChild: vi.fn(async () => child)
      }
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        search_domain: "project",
        project_id: linked.personalProjectId,
        personal_project_and_me: true
      }),
      expect.anything(),
      expect.anything(),
      undefined
    );
    expect(childInput.mock.calls[0]![0]).toMatchObject({
      search_domain: "global",
      team_workspace_id: linked.teamWorkspaceId,
      team_backend_id: linked.teamBackendId
    });
    expect(childInput.mock.calls[0]![0]).not.toHaveProperty("project_id");
    expect(result.result).toMatchObject({
      status: "completed",
      availability: "team_checked",
      recalls: [
        { question_id: personalQuestion },
        { question_id: teamQuestion, team_backend_id: linked.teamBackendId }
      ]
    });
  });

  it("returns an explicit persisted partial answer if Team cannot be checked", async () => {
    const { executor } = create();
    const result = await executor.executeMemoryAnswerTask(
      executionInput,
      { cwd: "/other" },
      randomUUID(),
      undefined,
      undefined,
      {
        getExecutionAuthority: () => ({ scope: "personal" }),
        startCombinedTeamChild: async () => {
          throw new Error("remote unavailable");
        },
        getCombinedTeamChild: vi.fn()
      }
    );
    expect(result.result).toMatchObject({
      status: "partial",
      availability: "team_not_checked",
      recalls: [{ label: "Personal Project and Me" }]
    });
    expect(result.result.combined_text).toContain(
      "Team memory was not checked"
    );
  });

  it("keeps a private managed Project in the bounded Personal branch", async () => {
    const privateContext = {
      linked: false as const,
      personalProjectId: linked.personalProjectId,
      projectVersion: 3
    };
    readContext.mockResolvedValue(privateContext);
    const { executor, execute } = create();
    const startTeam = vi.fn();
    const result = await executor.executeMemoryAnswerTask(
      {
        ...executionInput,
        project_id: randomUUID(),
        search_domain: "global"
      },
      { cwd: "/untrusted-team-repository" },
      randomUUID(),
      undefined,
      undefined,
      {
        getExecutionAuthority: () => ({ scope: "personal" }),
        startCombinedTeamChild: startTeam,
        getCombinedTeamChild: vi.fn()
      }
    );
    expect(execute.mock.calls[0]![0]).toMatchObject({
      search_domain: "project",
      project_id: privateContext.personalProjectId,
      personal_project_and_me: true
    });
    expect(startTeam).not.toHaveBeenCalled();
    expect(result.result).not.toHaveProperty("recalls");
  });

  it("fails closed when the current link version changes before task completion", async () => {
    readContext
      .mockResolvedValueOnce(linked)
      .mockResolvedValueOnce({ ...linked, projectVersion: 4 });
    const { executor } = create();
    await expect(
      executor.executeMemoryAnswerTask(
        executionInput,
        { cwd: "/other" },
        randomUUID(),
        undefined,
        undefined,
        {
          getExecutionAuthority: () => ({ scope: "personal" }),
          startCombinedTeamChild: async () => {
            throw new Error("remote unavailable");
          },
          getCombinedTeamChild: vi.fn()
        }
      )
    ).rejects.toThrow("link changed");
  });

  it.each([
    { reason: "shutdown", userCancellation: false, expectedCancels: 0 },
    { reason: "user cancelled", userCancellation: true, expectedCancels: 1 }
  ])(
    "keeps the durable Team child retryable on $reason",
    async ({ reason, userCancellation, expectedCancels }) => {
      const { executor } = create();
      const controller = new AbortController();
      const child = { id: randomUUID(), status: "accepted" as const };
      const cancel = vi.fn(async () => ({
        ...child,
        status: "cancelled" as const
      }));
      await expect(
        executor.executeMemoryAnswerTask(
          executionInput,
          { cwd: "/other" },
          randomUUID(),
          controller.signal,
          undefined,
          {
            getExecutionAuthority: () => ({ scope: "personal" }),
            isUserCancellation: () => userCancellation,
            startCombinedTeamChild: vi.fn(async () => child as never),
            runCombinedTeamChild: async () => {
              controller.abort(new Error(reason));
              throw controller.signal.reason;
            },
            getCombinedTeamChild: vi.fn(),
            cancelCombinedTeamChild: cancel as never
          }
        )
      ).rejects.toThrow(reason);
      expect(cancel).toHaveBeenCalledTimes(expectedCancels);
    }
  );

  it("does not manufacture progress while an accepted Team child is stalled", async () => {
    const { executor } = create();
    const controller = new AbortController();
    const onProgress = vi.fn();
    const child = {
      id: randomUUID(),
      status: "accepted" as const,
      version: 1,
      lastProgressAt: null
    };
    let reads = 0;
    const get = vi.fn(async () => {
      reads++;
      if (reads === 3) controller.abort(new Error("shutdown"));
      return child as never;
    });
    await expect(
      executor.executeMemoryAnswerTask(
        executionInput,
        { cwd: "/other" },
        randomUUID(),
        controller.signal,
        onProgress,
        {
          getExecutionAuthority: () => ({ scope: "personal" }),
          isUserCancellation: () => false,
          startCombinedTeamChild: vi.fn(async () => child as never),
          getCombinedTeamChild: get,
          cancelCombinedTeamChild: vi.fn() as never
        }
      )
    ).rejects.toThrow("aborted");
    expect(reads).toBe(3);
    expect(onProgress).not.toHaveBeenCalled();
  });
});
