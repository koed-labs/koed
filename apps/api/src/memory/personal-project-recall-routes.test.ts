import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { registerPersonalProjectRoutes } from "./personal-project-routes.js";
import type { ApiRouteContext } from "../server/context.js";

it("resolves Project recall using the authenticated owner and an exact capture binding", async () => {
  const owner = randomUUID(),
    sessionId = randomUUID();
  const result = {
    sessionId,
    target: {
      kind: "projects",
      callerSessionId: sessionId,
      projects: [{ ownerUserId: owner, projectId: randomUUID() }]
    }
  };
  const resolvePersonalProjectRecall = vi.fn().mockResolvedValue(result);
  const app = Fastify();
  registerPersonalProjectRoutes(app, {
    auth: { authenticate: async () => ({ id: owner }) },
    rateLimit: {
      memoryRead: async () => undefined,
      memoryWrite: async () => undefined
    },
    requireRepository: () => ({ resolvePersonalProjectRecall })
  } as unknown as ApiRouteContext);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/personal/projects/resolve-recall",
      payload: {
        externalSessionId: "native-conversation",
        sourceRuntime: "codex-cli"
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
    expect(resolvePersonalProjectRecall).toHaveBeenCalledWith(
      { userId: owner },
      { externalSessionId: "native-conversation", sourceRuntime: "codex-cli" }
    );
    resolvePersonalProjectRecall.mockClear();
    for (const payload of [
      { sessionId, ownerUserId: randomUUID() },
      {},
      { cwd: "/recorded/checkout" }
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/personal/projects/resolve-recall",
            payload
          })
        ).statusCode
      ).toBeGreaterThanOrEqual(400);
      expect(resolvePersonalProjectRecall).not.toHaveBeenCalled();
    }
    resolvePersonalProjectRecall.mockRejectedValueOnce(
      Object.assign(
        new Error("Conversation does not belong to an available Project"),
        { statusCode: 409 }
      )
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/personal/projects/resolve-recall",
          payload: { sessionId }
        })
      ).statusCode
    ).toBe(409);
    for (const [code, retryable] of [
      ["personal_project_membership_pending", true],
      ["personal_conversation_pending", true],
      ["personal_project_membership_missing", false]
    ] as const) {
      resolvePersonalProjectRecall.mockRejectedValueOnce(
        Object.assign(new Error("Explicit resolution outcome"), {
          statusCode: 409,
          code,
          retryable
        })
      );
      const pending = await app.inject({
        method: "POST",
        url: "/v1/personal/projects/resolve-recall",
        payload: { sessionId }
      });
      expect(pending.statusCode).toBe(409);
      expect(pending.json()).toEqual({
        error: "Explicit resolution outcome",
        code,
        retryable
      });
    }
  } finally {
    await app.close();
  }
});
