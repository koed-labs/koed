import Fastify from "fastify";
import { repositoryScopeId, type RepositoryIdentity } from "@koed/shared";
import { describe, expect, it, vi } from "vitest";
import type { ApiRouteContext } from "../server/context.js";
import { registerCaptureRoutes } from "./capture-routes.js";

const sessionId = "00000000-0000-4000-8000-000000000001";
const identity: RepositoryIdentity = {
  kind: "portable_repository",
  key: "gr_fixture",
  root: "/fixture/checkout",
  branch: "main",
  reason: "origin",
  checkoutId: "fixture_checkout",
  originatingDeviceId: "fixture_device",
  selectedRemote: "origin",
  anchorDisplay: "example.test/team/fixture"
};

describe("Captured Session lookup repository boundary", () => {
  it("checks effective identity and keeps authorized unresolved history inspectable", async () => {
    const app = Fastify();
    let effective: RepositoryIdentity | null = identity;
    let available = true;
    const getCapturedSession = vi.fn(async () =>
      available
        ? {
            id: sessionId,
            project: { id: "legacy-display-id", name: "Legacy Project" },
            repositoryAssignment: {
              state: effective ? "recorded" : "historical_unresolved",
              effective
            }
          }
        : null
    );
    registerCaptureRoutes(app, {
      requireRepository: () => ({ getCapturedSession }),
      auth: { authenticateApiToken: async () => ({ id: "owner" }) },
      capture: {},
      rateLimit: {
        aiClientControl: async () => {},
        memoryRead: async () => {},
        memoryWrite: async () => {}
      }
    } as unknown as ApiRouteContext);
    const lookup = (scope?: string) =>
      app.inject({
        method: "GET",
        url: `/v1/sessions/${sessionId}${scope ? `?project_id=${encodeURIComponent(scope)}` : ""}`
      });
    try {
      expect(
        (
          await lookup(
            repositoryScopeId({
              ...identity,
              root: "/another-clone",
              originatingDeviceId: "another-device"
            })
          )
        ).statusCode
      ).toBe(200);
      expect((await lookup("legacy-display-id")).statusCode).toBe(404);
      expect(
        (await lookup(repositoryScopeId({ ...identity, key: "gr_other" })))
          .statusCode
      ).toBe(404);
      effective = { ...identity, key: "gr_reassigned" };
      expect((await lookup(repositoryScopeId(identity))).statusCode).toBe(404);
      expect((await lookup(repositoryScopeId(effective))).statusCode).toBe(200);
      effective = {
        ...identity,
        kind: "device_local_repository",
        key: "dl_fixture"
      };
      expect(
        (
          await lookup(
            repositoryScopeId({
              ...effective,
              originatingDeviceId: "another-device"
            })
          )
        ).statusCode
      ).toBe(404);
      expect((await lookup(repositoryScopeId(effective))).statusCode).toBe(200);
      for (const unresolved of [
        null,
        {
          ...identity,
          kind: "unresolved" as const,
          key: null,
          reason: "selection_missing" as const
        }
      ]) {
        effective = unresolved;
        expect((await lookup(repositoryScopeId(identity))).statusCode).toBe(
          404
        );
        expect((await lookup()).statusCode).toBe(200);
      }
      available = false;
      expect((await lookup()).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
