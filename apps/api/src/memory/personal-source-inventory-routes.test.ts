import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  repositoryScopeId,
  personalSourceInventoryCursorSchema,
  type RepositoryIdentity
} from "@koed/shared";
import type { LcmGraphProjectThreads } from "@koed/db";
import type { ApiRouteContext } from "../server/context.js";
import { registerPersonalSourceInventoryRoutes } from "./personal-source-inventory-routes.js";
import { loadPersonalInventory } from "../../../desktop/src/koed-server/personal-inventory.js";
import { PersonalMemoryStore } from "../../../desktop/src/renderer/state/personal-memory.js";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";

const owner = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = (key: string): RepositoryIdentity => ({
  kind: "portable_repository",
  key,
  root: "/same/checkout",
  branch: "main",
  checkoutId: "checkout_one",
  originatingDeviceId: "device_one",
  selectedRemote: "origin",
  anchorDisplay: "example.test/same",
  reason: "origin"
});
const row = (n: number, repository: RepositoryIdentity) => ({
  // A provider ID alone cannot establish Conversation equality.
  id: "same-provider-thread",
  name: `Conversation ${n}`,
  sessionId: uuid(n + 100),
  logicalMemoryId: null,
  sourceReferences: [
    {
      sessionId: uuid(n + 100),
      logicalSessionId: uuid(n + 1000),
      logicalMemoryId: null
    }
  ],
  sourceAiClient: "codex" as const,
  projectId: repositoryScopeId(repository),
  projectName: "Same name",
  projectPath: "/same/checkout",
  projectAssignmentSource: "detected" as const,
  capturedProjectProvenance: { capturedCwd: "/same/checkout" },
  repositoryAssignment: {
    state: "recorded" as const,
    version: 1,
    automatic: repository,
    override: null,
    effective: repository
  },
  eventCount: 2,
  invalidatedCount: 0,
  latestAt: "2026-10-27T10:00:00.000Z",
  sample: "A decision",
  threadKind: "conversation" as const,
  parentThreadId: null,
  parentSessionId: null
});

describe("separated source inventory", () => {
  it("reaches a source beyond 500 Conversations through API, Desktop loading and state without merging labels or repeated provider IDs", async () => {
    const a = identity("gr_a"),
      b = identity("gr_z");
    const rows = [
      ...Array.from({ length: 600 }, (_, n) => row(n, a)),
      row(600, b)
    ];
    const replica = {
      ...row(601, a),
      sourceReferences: [
        {
          sessionId: uuid(701),
          logicalSessionId: uuid(1000),
          logicalMemoryId: null
        }
      ]
    };
    rows.push(replica);
    const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    rows.sort(
      (a, b) =>
        compare(a.projectId, b.projectId) ||
        compare(a.id, b.id) ||
        compare(a.sessionId, b.sessionId)
    );
    const graph = vi.fn(
      async (
        actor: { userId: string },
        input: {
          inventoryAfter?: {
            projectId: string;
            threadId: string;
            sessionId: string;
          };
          limit?: number;
        }
      ) => {
        expect(actor).toEqual({ userId: owner });
        const after = input.inventoryAfter;
        const page = rows
          .filter(
            (row) =>
              !after ||
              compare(row.projectId, after.projectId) > 0 ||
              (row.projectId === after.projectId &&
                (compare(row.id, after.threadId) > 0 ||
                  (row.id === after.threadId &&
                    compare(row.sessionId, after.sessionId) > 0)))
          )
          .slice(0, input.limit);
        const groups = new Map<string, LcmGraphProjectThreads>();
        for (const thread of page) {
          const group = groups.get(thread.projectId) ?? {
            id: thread.projectId,
            name: thread.projectName,
            path: thread.projectPath,
            eventCount: 0,
            threads: []
          };
          group.threads.push(thread);
          group.eventCount += thread.eventCount;
          groups.set(group.id, group);
        }
        return [...groups.values()];
      }
    );
    const writes = vi.fn(() => {
      throw new Error("Inventory must not mutate organization");
    });
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) =>
      reply
        .code(error instanceof Error && error.name === "ZodError" ? 400 : 500)
        .send({ error: "Invalid request" })
    );
    registerPersonalSourceInventoryRoutes(app, {
      auth: {
        authenticate: async (request: {
          headers: Record<string, unknown>;
        }) => ({ id: request.headers["x-owner"] === "other" ? other : owner })
      },
      rateLimit: { memoryRead: async () => undefined },
      requireRepository: () => ({
        listLcmGraphThreads: graph,
        listConversationPresentationStates: async () => [],
        createNamedPersonalProject: writes,
        addPersonalProjectRepositoryRule: writes
      })
    } as unknown as ApiRouteContext);
    try {
      let firstCursor: string | null = null;
      const paths: string[] = [];
      const inventory = await loadPersonalInventory(async (path) => {
        paths.push(path);
        if (
          path === "/v1/personal/projects/inventory" ||
          path === "/v1/personal/folders/inventory"
        )
          return { projects: [] };
        const result = await app.inject({ method: "GET", url: path });
        expect(result.statusCode).toBe(200);
        const body = result.json();
        firstCursor ??= body.nextCursor;
        return body;
      });
      expect(inventory.projects).toHaveLength(2);
      expect(
        inventory.projects.find((group) => group.id === repositoryScopeId(a))
          ?.threads
      ).toHaveLength(600);
      expect(
        inventory.projects.find((group) => group.id === repositoryScopeId(a))
          ?.eventCount
      ).toBe(1200);
      expect(
        inventory.projects.find((group) => group.id === repositoryScopeId(b))
          ?.threads
      ).toHaveLength(1);
      const duplicated = inventory.projects[0]!.threads.find(
        (thread) => thread.sourceReferences?.length === 2
      );
      expect(duplicated?.sourceReferences?.map((ref) => ref.sessionId)).toEqual(
        [uuid(100), uuid(701)]
      );
      expect(
        paths.filter((path) => path.startsWith("/v1/personal/sources"))
      ).toHaveLength(7);
      expect(writes).not.toHaveBeenCalled();
      const loadEventPage = vi.fn(async () => []);
      const store = new PersonalMemoryStore({
        listProjects: async () => inventory.projects,
        listProjectMetadata: async () => [],
        loadEventPage,
        subscribe: () => () => undefined
      } as unknown as PersonalDesktopApi);
      const snapshot = await store.loadProjects();
      expect(snapshot.error).toBeNull();
      expect(snapshot.inventory.projects).toHaveLength(0);
      expect(snapshot.inventory.gitSources).toHaveLength(2);
      expect(snapshot.inventory.localCheckouts).toEqual([]);
      expect(snapshot.threadsByKey.size).toBe(601);
      const linked = snapshot.inventory.gitSources
        .flatMap((group) => group.threads)
        .find((thread) => thread.sessionId === uuid(100))!;
      await store.loadInitial(linked);
      expect(loadEventPage).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "same-provider-thread",
          sessionId: uuid(100),
          projectId: repositoryScopeId(a)
        })
      );
      expect(
        [...snapshot.projectsById.values()].reduce(
          (sum, group) => sum + group.threads.length,
          0
        )
      ).toBe(601);
      const calls = graph.mock.calls.length;
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/v1/personal/sources/inventory?${new URLSearchParams({ cursor: firstCursor! })}`,
            headers: { "x-owner": "other" }
          })
        ).statusCode
      ).toBe(404);
      expect(graph).toHaveBeenCalledTimes(calls);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/personal/sources/inventory?cursor=broken"
          })
        ).statusCode
      ).toBe(400);
      expect(
        personalSourceInventoryCursorSchema.parse(JSON.parse(firstCursor!))
          .ownerUserId
      ).toBe(owner);
    } finally {
      await app.close();
    }
  });
});
