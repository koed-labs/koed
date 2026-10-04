import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { ApiRouteContext } from "../server/context.js";
import { registerPersonalStudioRemovalRoutes } from "./personal-removals-routes.js";

describe("Personal Studio removal routes", () => {
  it("persists owner-scoped removals and supports restore with aliases", async () => {
    const app = Fastify();
    const state = new Map<
      string,
      { kind: string; id: string; aliases: string[] }
    >();
    const repository = {
      listPersonalStudioRemovals: async ({ userId }: { userId: string }) =>
        [...state.entries()]
          .filter(([key]) => key.startsWith(`${userId}:`))
          .map(([, value]) => value),
      setPersonalStudioRemoval: async (
        { userId }: { userId: string },
        input: {
          kind: "project" | "conversation";
          id: string;
          aliases: string[];
          removed: boolean;
        }
      ) => {
        const key = `${userId}:${input.kind}:${input.id}`;
        if (input.removed) {
          state.set(key, {
            kind: input.kind,
            id: input.id,
            aliases: input.aliases
          });
        } else {
          state.delete(key);
        }
      }
    };
    const context = {
      auth: {
        authenticate: async (request: {
          headers: { authorization?: string };
        }) => {
          const userId = request.headers.authorization?.replace(/^Bearer /, "");
          if (!userId)
            throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
          return { id: userId };
        }
      }
    } as unknown as ApiRouteContext;
    registerPersonalStudioRemovalRoutes(
      app,
      context,
      () => repository as never
    );

    const unauthorized = await app.inject({
      method: "GET",
      url: "/v1/studio/personal-removals"
    });
    expect(unauthorized.statusCode).toBe(401);

    const removed = await app.inject({
      method: "PUT",
      url: "/v1/studio/personal-removals",
      headers: { authorization: "Bearer owner-a" },
      payload: {
        kind: "conversation",
        id: "managed:12345678-1234-4234-8234-123456789abc",
        aliases: ["codex:native%2Fthread-1"],
        removed: true
      }
    });
    expect(removed.statusCode).toBe(200);

    const ownerList = await app.inject({
      method: "GET",
      url: "/v1/studio/personal-removals",
      headers: { authorization: "Bearer owner-a" }
    });
    expect(ownerList.json()).toEqual({
      removals: [
        {
          kind: "conversation",
          id: "managed:12345678-1234-4234-8234-123456789abc",
          aliases: ["codex:native%2Fthread-1"]
        }
      ]
    });

    const otherOwnerList = await app.inject({
      method: "GET",
      url: "/v1/studio/personal-removals",
      headers: { authorization: "Bearer owner-b" }
    });
    expect(otherOwnerList.json()).toEqual({ removals: [] });

    const restored = await app.inject({
      method: "PUT",
      url: "/v1/studio/personal-removals",
      headers: { authorization: "Bearer owner-a" },
      payload: {
        kind: "conversation",
        id: "managed:12345678-1234-4234-8234-123456789abc",
        removed: false
      }
    });
    expect(restored.statusCode).toBe(200);
    expect((await ownerListRefresh(app, "owner-a")).json()).toEqual({
      removals: []
    });
    await app.close();
  });

  it("rejects path-like identifiers and malformed write bodies", async () => {
    const app = Fastify();
    const context = {
      auth: { authenticate: async () => ({ id: "owner" }) }
    } as unknown as ApiRouteContext;
    registerPersonalStudioRemovalRoutes(
      app,
      context,
      () =>
        ({
          listPersonalStudioRemovals: async () => [],
          setPersonalStudioRemoval: async () => undefined
        }) as never
    );
    const response = await app.inject({
      method: "PUT",
      url: "/v1/studio/personal-removals",
      payload: { kind: "conversation", id: "../secret", removed: true }
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

async function ownerListRefresh(
  app: ReturnType<typeof Fastify>,
  ownerId: string
) {
  return app.inject({
    method: "GET",
    url: "/v1/studio/personal-removals",
    headers: { authorization: `Bearer ${ownerId}` }
  });
}
