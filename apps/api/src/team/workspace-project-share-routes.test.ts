import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { WorkspaceProjectRepository } from "@koed/db";
import type { ApiRouteContext } from "../server/context.js";
import { registerWorkspaceProjectRoutes } from "./workspace-project-routes.js";

const userId = randomUUID();
const teamId = randomUUID();
const workspaceId = randomUUID();
const projectId = randomUUID();

const fixture = async () => {
  const shareTarget = vi.fn(async () => ({
    teamId,
    workspaceId,
    ownerUserId: userId,
    canStart: true
  }));
  const cancelShareAttempt = vi.fn(async () => ({
    canceled: true,
    receiptId: randomUUID(),
    teamId,
    workspaceId,
    ownerUserId: userId,
    shareAttemptKey: "exact-attempt"
  }));
  const members = vi.fn(async () => ({
    projectId,
    version: 1,
    people: []
  }));
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      error instanceof z.ZodError
        ? 400
        : error instanceof Error &&
            "statusCode" in error &&
            typeof error.statusCode === "number"
          ? error.statusCode
          : 500;
    return reply.code(statusCode).send({
      error: error instanceof Error ? error.message : "Unknown test route error"
    });
  });
  const authenticateSessionOrDeviceCredential = vi.fn<
    (request: unknown, operationFamily: string) => Promise<{ id: string }>
  >(async () => ({ id: userId }));
  registerWorkspaceProjectRoutes(app, {
    repository: {
      shareTarget,
      cancelShareAttempt,
      members
    } as unknown as WorkspaceProjectRepository,
    requireRepository: () => {
      throw new Error("Action Grant path unused");
    },
    auth: {
      authenticateSessionOrDeviceCredential
    } as unknown as ApiRouteContext["auth"],
    readRateLimit: async () => undefined,
    writeRateLimit: async () => undefined
  });
  await app.ready();
  return {
    app,
    shareTarget,
    cancelShareAttempt,
    members,
    authenticateSessionOrDeviceCredential
  };
};

describe("HQ701 Team Share routes", () => {
  it("derives the current principal for target, cancellation, and enabled people", async () => {
    const f = await fixture();
    try {
      const target = await f.app.inject({
        method: "GET",
        url: `/v1/teams/${teamId}/workspaces/${workspaceId}/share-target?shareAttemptKey=exact-attempt`
      });
      expect(target.statusCode).toBe(200);
      expect(f.shareTarget).toHaveBeenCalledWith(
        userId,
        teamId,
        workspaceId,
        "exact-attempt"
      );
      const cancel = await f.app.inject({
        method: "POST",
        url: `/v1/teams/${teamId}/workspaces/${workspaceId}/share-attempt-cancellations`,
        payload: {
          shareAttemptKey: "exact-attempt",
          expectedOwnerUserId: userId
        }
      });
      expect(cancel.statusCode).toBe(200);
      expect(f.cancelShareAttempt).toHaveBeenCalledWith(userId, {
        teamId,
        workspaceId,
        shareAttemptKey: "exact-attempt"
      });
      const people = await f.app.inject({
        method: "GET",
        url: `/v1/workspace-projects/${projectId}/members`
      });
      expect(people.statusCode).toBe(200);
      expect(f.members).toHaveBeenCalledWith(userId, projectId);
      expect(
        f.authenticateSessionOrDeviceCredential.mock.calls.map(
          (call) => call[1]
        )
      ).toEqual([
        "team_workspace_read",
        "team_workspace_write",
        "team_workspace_read"
      ]);
    } finally {
      await f.app.close();
    }
  });

  it("rejects a renderer-selected foreign principal and unknown cancellation fields before writing", async () => {
    const f = await fixture();
    try {
      const path = `/v1/teams/${teamId}/workspaces/${workspaceId}/share-attempt-cancellations`;
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: path,
            payload: {
              shareAttemptKey: "exact-attempt",
              expectedOwnerUserId: randomUUID()
            }
          })
        ).statusCode
      ).toBe(403);
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: path,
            payload: {
              shareAttemptKey: "exact-attempt",
              expectedOwnerUserId: userId,
              projectId
            }
          })
        ).statusCode
      ).toBe(400);
      expect(f.cancelShareAttempt).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });
});
