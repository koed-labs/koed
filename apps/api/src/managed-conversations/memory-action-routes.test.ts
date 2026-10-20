import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storeDesktopLocalCredential } from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";
import { registerManagedMemoryActionRoutes } from "./memory-action-routes.js";

const executionId = "00000000-0000-4000-8000-000000003071";
const actionId = "00000000-0000-4000-8000-000000003072";
const ownerId = "00000000-0000-4000-8000-000000003073";
const assertionId = "00000000-0000-4000-8000-000000003074";
const path = `/v1/managed-conversations/${executionId}/memory-actions`;
const record = {
  id: actionId,
  executionId,
  actionKind: "forget",
  state: "completed",
  result: {
    outcome: "forgotten",
    message: "Forgot this memory.",
    assertionId,
    suppressionToken: "123456"
  },
  request: { userPrompt: "private User text" },
  createdAt: "2026-10-20T10:00:00Z",
  completedAt: "2026-10-20T10:01:00Z"
};

describe("owner memory action routes", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  const homes: string[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    for (const home of homes.splice(0))
      rmSync(home, { recursive: true, force: true });
  });
  const fixture = (
    operationFamilies: (
      | "personal_collaboration_read"
      | "personal_collaboration_write"
    )[] = ["personal_collaboration_read", "personal_collaboration_write"]
  ) => {
    const home = mkdtempSync(join(tmpdir(), "koed-memory-action-route-"));
    homes.push(home);
    const desktop = storeDesktopLocalCredential(home, {
      ownerUserId: ownerId,
      operationFamilies
    });
    const repository = {
      getManagedConversationExecution: vi.fn(async () => ({
        id: executionId,
        ownerUserId: ownerId
      })),
      listManagedMemoryActionResults: vi.fn(async () => [record]),
      unsuppressCuratedMemoryAssertion: vi.fn(async () => ({
        id: assertionId
      })),
      undoManagedMemoryAction: vi.fn(
        async (
          _actor: { userId: string },
          _input: { actionId: string; executionId: string },
          unsuppress: (id: string, token: string) => Promise<unknown>
        ) => {
          await unsuppress(assertionId, "123456");
          return {
            ...record,
            result: { outcome: "undone", message: "Restored this memory." }
          };
        }
      )
    };
    const authenticateSession = vi.fn(async (request: FastifyRequest) => {
      if (request.headers.cookie !== "owner-session")
        throw Object.assign(new Error("Session required"), { statusCode: 401 });
      return { id: ownerId };
    });
    const app = Fastify();
    apps.push(app);
    registerManagedMemoryActionRoutes(app, {
      config: { deploymentProfile: "developer", koedHome: home },
      auth: { authenticateSession },
      requireRepository: () => repository,
      rateLimit: {
        memoryRead: async () => undefined,
        memoryWrite: async () => undefined
      }
    } as unknown as ApiRouteContext);
    return { app, repository, desktop };
  };

  it("returns durable display data without User text or suppression receipt", async () => {
    const { app, repository, desktop } = fixture();
    const response = await app.inject({
      method: "GET",
      url: path,
      headers: { authorization: desktop.authorization }
    });
    expect(response.statusCode).toBe(200);
    expect(repository.listManagedMemoryActionResults).toHaveBeenCalledWith(
      { userId: ownerId },
      executionId
    );
    expect(response.body).not.toContain("123456");
    expect(response.body).not.toContain("private User text");
    expect(response.json().actions[0]).toMatchObject({
      id: actionId,
      outcome: "forgotten"
    });
  });

  it("uses the stored exact receipt for owner Undo and rejects renderer authority payloads", async () => {
    const { app, repository, desktop } = fixture();
    const response = await app.inject({
      method: "POST",
      url: `${path}/${actionId}/undo`,
      headers: { authorization: desktop.authorization }
    });
    expect(response.statusCode).toBe(200);
    expect(repository.unsuppressCuratedMemoryAssertion).toHaveBeenCalledWith(
      { userId: ownerId },
      assertionId,
      { suppressionToken: "123456" }
    );
    expect(response.json().action.outcome).toBe("undone");
    repository.undoManagedMemoryAction.mockClear();
    const spoof = await app.inject({
      method: "POST",
      url: `${path}/${actionId}/undo`,
      headers: { authorization: desktop.authorization },
      payload: { ownerUserId: ownerId, suppressionToken: "other-token" }
    });
    expect(spoof.statusCode).not.toBe(200);
    expect(repository.undoManagedMemoryAction).not.toHaveBeenCalled();
  });

  it("rejects Personal tokens, device credentials, forged Desktop proof, and read-only Desktop writes", async () => {
    const { app, repository } = fixture(["personal_collaboration_read"]);
    for (const authorization of [
      "Bearer model-token",
      "Koed-Device fixture:secret",
      "Koed-Desktop forged"
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `${path}/${actionId}/undo`,
        headers: { authorization }
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }
    const readOnly = fixture(["personal_collaboration_read"]);
    const denied = await readOnly.app.inject({
      method: "POST",
      url: `${path}/${actionId}/undo`,
      headers: { authorization: readOnly.desktop.authorization }
    });
    expect(denied.statusCode).toBe(401);
    expect(repository.undoManagedMemoryAction).not.toHaveBeenCalled();
    expect(readOnly.repository.undoManagedMemoryAction).not.toHaveBeenCalled();
  });

  it("accepts the existing owner session and hides another owner's execution", async () => {
    const { app, repository } = fixture();
    expect(
      (
        await app.inject({
          method: "GET",
          url: path,
          headers: { cookie: "owner-session" }
        })
      ).statusCode
    ).toBe(200);
    repository.getManagedConversationExecution.mockResolvedValue({
      id: executionId,
      ownerUserId: assertionId
    });
    repository.listManagedMemoryActionResults.mockClear();
    expect(
      (
        await app.inject({
          method: "GET",
          url: path,
          headers: { cookie: "owner-session" }
        })
      ).statusCode
    ).toBe(404);
    expect(repository.listManagedMemoryActionResults).not.toHaveBeenCalled();
  });
});
