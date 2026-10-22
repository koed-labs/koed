import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedConversationRepository } from "@koed/db";
import { storeDesktopLocalCredential } from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";
import { registerManagedConversationRoutes } from "./routes.js";

const { readLinkedTeamCatchUp, ackLinkedTeamCatchUp } = vi.hoisted(() => ({
  readLinkedTeamCatchUp: vi.fn(),
  ackLinkedTeamCatchUp: vi.fn()
}));
vi.mock("../projects/team-catch-up.js", () => ({
  readLinkedTeamCatchUp,
  ackLinkedTeamCatchUp
}));

const homes: string[] = [];
afterEach(() => {
  readLinkedTeamCatchUp.mockReset();
  ackLinkedTeamCatchUp.mockReset();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("Project HQ Team terminal receipt route", () => {
  it("queues a private HQ welcome catch-up from Team welcome due without exposing Team message text", async () => {
    const home = mkdtempSync(join(tmpdir(), "koed-hq-team-welcome-"));
    homes.push(home);
    const ownerUserId = randomUUID();
    const projectId = randomUUID();
    const executionId = randomUUID();
    const commandId = randomUUID();
    const teamMessageSentinel = "PRIVATE_TEAM_WELCOME_MESSAGE_NEVER_FOR_AGENT";
    const teamWindow = {
      teamBackendId: "enrolled-team",
      workspaceProjectId: randomUUID(),
      teamPrincipalUserId: randomUUID(),
      memberId: randomUUID(),
      projectVersion: 4,
      memberVersion: 2,
      seenCursor: "team-seen",
      highCursor: "team-seen",
      welcomeDue: true,
      events: [],
      messages: [{ text: teamMessageSentinel }]
    };
    const pendingProjectHqTeamAck = vi.fn(async () => null);
    const getManagedConversationExecution = vi.fn(async () => ({
      id: executionId,
      ownerUserId,
      projectId,
      isProjectHq: true,
      hqPrivatePath: join(
        home,
        "managed-conversations",
        "project-hq",
        ownerUserId,
        projectId
      ),
      state: "running",
      executionGeneration: 3,
      logicalSessionId: randomUUID(),
      providerThreadId: "private-provider-thread"
    }));
    const enqueueManagedConversationCatchUp = vi.fn(
      async (
        ...args: Parameters<
          ManagedConversationRepository["enqueueManagedConversationCatchUp"]
        >
      ) => {
        expect(args).toHaveLength(2);
        return {
          id: commandId,
          state: "queued",
          commandKind: "hq_catch_up"
        };
      }
    );
    const repository = {
      pendingProjectHqTeamAck,
      getManagedConversationExecution,
      inspectProjectHqCatchUp: vi.fn(async () => ({
        disposition: "none",
        command: null
      })),
      enqueueManagedConversationCatchUp,
      resolveActivityDecisions: vi.fn(async () => [])
    };
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) =>
      reply
        .code((error as Error & { statusCode?: number }).statusCode ?? 500)
        .send({ message: (error as Error).message })
    );
    registerManagedConversationRoutes(
      app,
      {
        config: { deploymentProfile: "local_personal", koedHome: home },
        encryption: { envelopeEncryptionProvider: {} },
        auth: { authenticateSessionOrDeviceCredential: vi.fn() },
        rateLimit: {
          memoryRead: async () => undefined,
          memoryWrite: async () => undefined,
          managedConversationRead: async () => undefined,
          managedConversationWrite: async () => undefined
        },
        localEdge: { upstreamBackendsPath: join(home, "upstreams.json") },
        requireRepository: () => repository
      } as unknown as ApiRouteContext,
      { list: vi.fn() } as never,
      null,
      { resolveActivityOutcomes: vi.fn(async () => []) } as never,
      {
        seen: vi.fn(async () => ({
          cursor: "personal-seen",
          at: "2026-10-21T00:00:00Z"
        })),
        list: vi.fn(async () => ({
          items: [],
          hasMore: false,
          nextCursor: null
        }))
      } as never,
      {
        readHqConversation: vi.fn(async () => ({
          conversation: { executionId }
        }))
      } as never,
      true,
      {} as never
    );
    const authorization = storeDesktopLocalCredential(home, {
      ownerUserId,
      operationFamilies: ["personal_collaboration_write", "managed_execution"]
    }).authorization;
    try {
      readLinkedTeamCatchUp.mockResolvedValueOnce(teamWindow);
      const response = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/hq/catch-up`,
        headers: { authorization },
        payload: {}
      });
      expect(response.statusCode, response.body).toBe(202);
      expect(response.json()).toEqual({
        status: "queued",
        executionId,
        commandId,
        commandState: "queued"
      });
      expect(readLinkedTeamCatchUp).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ ownerUserId, personalProjectId: projectId })
      );
      expect(getManagedConversationExecution).toHaveBeenCalledExactlyOnceWith(
        { userId: ownerUserId },
        executionId
      );
      expect(enqueueManagedConversationCatchUp).toHaveBeenCalledExactlyOnceWith(
        { userId: ownerUserId },
        expect.objectContaining({
          projectId,
          executionId,
          executionGeneration: 3,
          seenCursor: "personal-seen",
          highWater: "personal-seen",
          events: [],
          teamWindow
        })
      );
      const queued = enqueueManagedConversationCatchUp.mock.calls[0]![1];
      expect(queued.prompt).toContain('"welcomeDue":true');
      expect(queued.prompt).toContain('"counts":{}');
      expect(queued.prompt).not.toContain(teamMessageSentinel);
      expect(queued.prompt).not.toContain('"messages"');
      expect(queued.inputDigest).toMatch(/^[a-f0-9]{64}$/);
      readLinkedTeamCatchUp.mockResolvedValueOnce({
        ...teamWindow,
        welcomeDue: false
      });
      const withoutWelcome = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/hq/catch-up`,
        headers: { authorization },
        payload: {}
      });
      expect(withoutWelcome.statusCode, withoutWelcome.body).toBe(200);
      expect(withoutWelcome.json()).toEqual({ status: "nothing" });
      expect(enqueueManagedConversationCatchUp).toHaveBeenCalledTimes(1);
      expect(pendingProjectHqTeamAck).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("retries the exact retained Team receipt before a new read, without a second AI turn", async () => {
    const home = mkdtempSync(join(tmpdir(), "koed-hq-team-route-"));
    homes.push(home);
    const ownerUserId = randomUUID();
    const projectId = randomUUID();
    const executionId = randomUUID();
    const commandId = randomUUID();
    const window = {
      teamBackendId: "enrolled-team",
      workspaceProjectId: randomUUID(),
      teamPrincipalUserId: randomUUID(),
      memberId: randomUUID(),
      projectVersion: 4,
      memberVersion: 2,
      seenCursor: "old",
      highCursor: "new",
      welcomeDue: true,
      events: []
    };
    const pendingProjectHqTeamAck = vi.fn(
      async (): Promise<{
        commandId: string;
        teamWindow: typeof window;
      } | null> => ({ commandId, teamWindow: window })
    );
    const markProjectHqTeamAck = vi.fn(async () => true);
    const enqueueManagedConversationCatchUp = vi.fn();
    const repository = {
      pendingProjectHqTeamAck,
      markProjectHqTeamAck,
      enqueueManagedConversationCatchUp,
      resolveActivityDecisions: vi.fn(async () => []),
      inspectProjectHqCatchUp: vi.fn(async () => ({
        disposition: "none",
        command: null
      }))
    };
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) =>
      reply
        .code((error as Error & { statusCode?: number }).statusCode ?? 500)
        .send({
          message: (error as Error).message
        })
    );
    registerManagedConversationRoutes(
      app,
      {
        config: { deploymentProfile: "local_personal", koedHome: home },
        encryption: { envelopeEncryptionProvider: {} },
        auth: { authenticateSessionOrDeviceCredential: vi.fn() },
        rateLimit: {
          memoryRead: async () => undefined,
          memoryWrite: async () => undefined,
          managedConversationRead: async () => undefined,
          managedConversationWrite: async () => undefined
        },
        localEdge: { upstreamBackendsPath: join(home, "upstreams.json") },
        requireRepository: () => repository
      } as unknown as ApiRouteContext,
      { list: vi.fn() } as never,
      null,
      { resolveActivityOutcomes: vi.fn(async () => []) } as never,
      {
        seen: vi.fn(async () => ({
          cursor: "personal-seen",
          at: "2026-10-21T00:00:00Z"
        })),
        list: vi.fn(async () => ({
          items: [],
          hasMore: false,
          nextCursor: null
        }))
      } as never,
      {
        readHqConversation: vi.fn(async () => ({
          conversation: { executionId }
        }))
      } as never,
      true,
      {} as never
    );
    const authorization = storeDesktopLocalCredential(home, {
      ownerUserId,
      operationFamilies: ["personal_collaboration_write", "managed_execution"]
    }).authorization;
    try {
      ackLinkedTeamCatchUp.mockRejectedValueOnce(
        Object.assign(new Error("Team acknowledgment response uncertain"), {
          statusCode: 424
        })
      );
      const first = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/hq/catch-up`,
        headers: { authorization },
        payload: {}
      });
      expect(first.statusCode, first.body).toBe(424);
      expect(markProjectHqTeamAck).not.toHaveBeenCalled();
      expect(readLinkedTeamCatchUp).not.toHaveBeenCalled();
      expect(enqueueManagedConversationCatchUp).not.toHaveBeenCalled();

      pendingProjectHqTeamAck
        .mockResolvedValueOnce({ commandId, teamWindow: window })
        .mockResolvedValueOnce(null);
      ackLinkedTeamCatchUp.mockResolvedValueOnce({
        memberId: window.memberId,
        cursor: window.highCursor,
        welcomeDue: false
      });
      readLinkedTeamCatchUp.mockResolvedValueOnce(null);
      const second = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/hq/catch-up`,
        headers: { authorization },
        payload: {}
      });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toMatchObject({ status: "nothing" });
      expect(ackLinkedTeamCatchUp).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerUserId,
          personalProjectId: projectId,
          window
        })
      );
      expect(markProjectHqTeamAck).toHaveBeenCalledExactlyOnceWith(
        { userId: ownerUserId },
        { projectId, executionId, commandId, teamWindow: window }
      );
      expect(enqueueManagedConversationCatchUp).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
