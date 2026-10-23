import Fastify from "fastify";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ApiRouteContext } from "../server/context.js";
import { registerTeamSharingRoutes } from "./sharing-routes.js";

describe("Team sharing route", () => {
  it("uses current Team read authority and rejects renderer selected filters", async () => {
    const actorId = "11111111-1111-4111-8111-111111111111";
    const authenticate = vi.fn(async () => ({ id: actorId }));
    const query = vi.fn(async () => ({ rows: [] }));
    const app = Fastify();
    registerTeamSharingRoutes(app, {
      pool: {
        connect: async () => ({ query, release: vi.fn() })
      } as unknown as pg.Pool,
      auth: {
        authenticateSessionOrDeviceCredential: authenticate
      } as unknown as ApiRouteContext["auth"],
      readRateLimit: async () => undefined
    });
    try {
      const read = await app.inject({ method: "GET", url: "/v1/me/sharing" });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual({
        projects: [],
        invitations: [],
        workspaceAccess: []
      });
      expect(authenticate).toHaveBeenCalledWith(
        expect.anything(),
        "team_workspace_read",
        expect.anything()
      );
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("m.user_id=$1"),
        [actorId]
      );
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/me/sharing?userId=someone-else"
          })
        ).statusCode
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
});
