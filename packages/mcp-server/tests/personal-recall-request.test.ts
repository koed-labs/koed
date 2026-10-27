import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { personalFolderScopeId } from "@koed/shared";
import { MemoryApiClient } from "../src/index.js";
import { memoryAnswerAdapterInputSchema } from "../src/memory-tool-schemas.js";
import { pinPersonalRecallRequest } from "../src/personal-recall-request.js";
import { createMemoryAnswerTaskCoordinator } from "../src/memory-answer-task-coordinator.js";
import { MemoryToolExecutor } from "../src/memory-tool-executor.js";

const ownerUserId = randomUUID();
const projectId = randomUUID();
const folder = {
  ownerUserId,
  folderId: randomUUID(),
  originatingDeploymentId: "fixture-deployment",
  originatingDeviceId: "fixture-device",
  originatingProfileId: "fixture-profile",
  directoryIncarnationId: randomUUID()
};
const cases = [
  {
    target: { kind: "project" as const, project: { ownerUserId, projectId } },
    scope: projectId
  },
  {
    target: { kind: "folder" as const, folder },
    scope: personalFolderScopeId(folder)
  }
];
const access = () =>
  ({ user: { id: ownerUserId } }) as Awaited<
    ReturnType<MemoryApiClient["accessCheck"]>
  >;

describe("public Personal recall targets", () => {
  it.each(cases)(
    "pins $target.kind to the authenticated owner before task acceptance",
    async ({ target, scope }) => {
      const client = new MemoryApiClient({
        apiUrl: "https://unavailable.fixture"
      });
      vi.spyOn(client, "accessCheck").mockResolvedValue(access());
      const accept = vi
        .spyOn(client, "acceptMemoryAnswerTask")
        .mockResolvedValue({
          task: { id: randomUUID(), teamWorkspaceId: null }
        } as Awaited<ReturnType<MemoryApiClient["acceptMemoryAnswerTask"]>>);
      const coordinator = createMemoryAnswerTaskCoordinator(client, {
        KOED_HOME: "/fixture/no-enrollment"
      });
      const input = memoryAnswerAdapterInputSchema.parse({
        query: "Synthetic decision",
        recall_target: target
      });
      await coordinator.acceptMemoryAnswerTask({
        origin: "mcp",
        request: { input, caller: { cwd: "/unrelated/checkout" } },
        max_queued: 4
      });
      expect(accept.mock.calls[0]![0].request).toMatchObject({
        requestVersion: 1,
        selection: {
          version: 1,
          ownerUserId,
          target,
          callerRepositoryContext: null
        },
        input: {
          search_domain: "project",
          project_id: scope,
          repository_context: null
        }
      });
      expect(
        (accept.mock.calls[0]![0].request.input as Record<string, unknown>)
          .recall_target
      ).toBeUndefined();
    }
  );

  it.each(cases)(
    "keeps $target.kind on every expansion in direct execution",
    async ({ target }) => {
      const expand = vi.fn<MemoryApiClient["expand"]>(async () => ({
        expanded: { sourceItems: [], sources: [] }
      }));
      const client = {
        accessCheck: vi.fn(async () => access()),
        listLocalMemoryAgentSettings: vi.fn(async () => ({ settings: [] })),
        expand
      } as unknown as MemoryApiClient;
      const executor = new MemoryToolExecutor(
        client,
        {},
        {
          answerWithMemoryWorker: async (_payload, options) => {
            await options?.client?.expand(randomUUID(), {
              searchDomain: "global"
            });
            throw new Error("Expansion boundary reached");
          }
        }
      );
      await expect(
        executor.execute(
          "memory_answer",
          { query: "Decision", recall_target: target },
          { cwd: "/unrelated/checkout" }
        )
      ).rejects.toThrow("Expansion boundary reached");
      expect(expand.mock.calls[0]?.[1]).toMatchObject({
        personalSelection: { version: 1, ownerUserId, target }
      });
    }
  );

  it.each([
    { search_domain: "project" },
    { project_id: projectId },
    { session_id: randomUUID() },
    { team_workspace_id: randomUUID() },
    { team_backend_id: "team" }
  ])("rejects conflicting selectors and Team routing: %j", (extra) => {
    expect(
      memoryAnswerAdapterInputSchema.safeParse({
        query: "Decision",
        recall_target: cases[0]!.target,
        ...extra
      }).success
    ).toBe(false);
  });

  it("rejects another owner's target before acceptance", async () => {
    const client = { accessCheck: vi.fn(async () => access()) };
    await expect(
      pinPersonalRecallRequest(
        {
          query: "Decision",
          recall_target: {
            kind: "project",
            project: { ownerUserId: randomUUID(), projectId }
          }
        },
        client
      )
    ).rejects.toThrow("another owner");
    await expect(
      pinPersonalRecallRequest(
        {
          query: "Decision",
          recall_target: {
            kind: "folder",
            folder: { ...folder, ownerUserId: randomUUID() }
          }
        },
        client
      )
    ).rejects.toThrow("another owner");
  });
});
