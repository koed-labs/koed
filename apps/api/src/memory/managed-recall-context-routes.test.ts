import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import {
  deleteDesktopLocalCredential,
  storeDesktopLocalCredential
} from "@koed/shared";
import { describe, expect, it, vi } from "vitest";
import { registerManagedRecallContextRoutes } from "./managed-recall-context-routes.js";

describe("managed recall context route owner boundary", () => {
  it("requires a local owner credential and current generation, command lease, and Project link", async () => {
    const home = mkdtempSync(join(tmpdir(), "koed-managed-recall-route-"));
    const ownerUserId = randomUUID();
    const executionId = randomUUID();
    const credential = storeDesktopLocalCredential(home, {
      ownerUserId,
      operationFamilies: ["personal_collaboration_read", "managed_execution"]
    });
    const context = {
      linked: true,
      personalProjectId: randomUUID(),
      teamBackendId: "team-one",
      teamWorkspaceId: randomUUID(),
      workspaceProjectId: randomUUID(),
      projectVersion: 2
    };
    const execution = {
      id: executionId,
      ownerUserId,
      executionGeneration: 4,
      state: "running"
    };
    const command = {
      id: randomUUID(),
      executionId,
      executionGeneration: 4,
      state: "dispatching",
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    };
    const repository = {
      getManagedConversationExecution: vi.fn(async () => execution),
      getLatestManagedConversationCommandForExecution: vi.fn(
        async () => command
      ),
      getManagedConversationRecallContext: vi.fn(async () => context)
    };
    const app = Fastify();
    registerManagedRecallContextRoutes(app, {
      repository: repository as never,
      auth: {
        authenticateSessionOrDeviceCredential: vi.fn(async () => {
          throw Object.assign(new Error("API Token denied"), {
            statusCode: 403
          });
        })
      } as never,
      deploymentProfile: "local_personal",
      koedHome: home,
      readRateLimit: async () => undefined
    });
    const url = `/v1/managed-conversations/${executionId}/recall-context?executionGeneration=4`;
    const request = (authorization: string, requestUrl = url) =>
      app.inject({
        method: "GET",
        url: requestUrl,
        headers: { authorization },
        remoteAddress: "127.0.0.1"
      });
    try {
      expect((await request(credential.authorization)).json()).toEqual(context);
      expect(
        repository.getManagedConversationRecallContext
      ).toHaveBeenCalledWith(
        { userId: ownerUserId },
        { executionId, executionGeneration: 4 }
      );
      expect((await request("Bearer personal-token")).statusCode).toBe(409);
      expect(
        (await request("Koed-Desktop invalid")).statusCode
      ).toBeGreaterThanOrEqual(400);
      expect(
        (
          await request(
            credential.authorization,
            `/v1/managed-conversations/${executionId}/recall-context?executionGeneration=3`
          )
        ).statusCode
      ).toBe(409);
      repository.getManagedConversationExecution.mockResolvedValueOnce({
        ...execution,
        ownerUserId: randomUUID()
      });
      expect((await request(credential.authorization)).statusCode).toBe(409);
      repository.getLatestManagedConversationCommandForExecution.mockResolvedValueOnce(
        {
          ...command,
          state: "completed"
        }
      );
      expect((await request(credential.authorization)).statusCode).toBe(409);
      repository.getLatestManagedConversationCommandForExecution.mockResolvedValueOnce(
        {
          ...command,
          leaseExpiresAt: new Date(Date.now() - 1000).toISOString()
        }
      );
      expect((await request(credential.authorization)).statusCode).toBe(409);
      repository.getManagedConversationRecallContext.mockResolvedValueOnce(
        null as never
      );
      expect((await request(credential.authorization)).statusCode).toBe(409);
      deleteDesktopLocalCredential(home);
      const readOnly = storeDesktopLocalCredential(home, {
        ownerUserId,
        operationFamilies: ["personal_collaboration_read"]
      });
      expect((await request(readOnly.authorization)).statusCode).toBe(409);
    } finally {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
