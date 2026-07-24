import type { MemorySourceRepository, TeamWorkspaceRecord } from "@koed/db";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import { registerTeamRoutes } from "./routes.js";
import { createTeamWorkspaceSchema } from "./schemas.js";

const teamId = "7bd960fe-6ff0-4bff-8101-4232aa61cb69";
const userId = "a7df776f-74d7-4d8d-b941-a8fed118eba1";

const workspaceRecord = (description: string | null): TeamWorkspaceRecord => ({
  id: randomUUID(),
  teamId,
  name: "Workspace",
  description,
  version: 1,
  lifecycle: "active",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  archivedAt: null,
  retentionPolicyId: null,
  retentionPolicyVersion: null,
  retainUntil: null,
  purgeCompletedAt: null
});

const createRouteFixture = async () => {
  const createTeamWorkspace = vi.fn(
    async (
      _actor: { userId: string },
      input: { description?: string | null }
    ) => workspaceRecord(input.description ?? null)
  );
  const repository = {
    createTeamWorkspace
  } as unknown as MemorySourceRepository;
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      error instanceof z.ZodError
        ? 400
        : typeof error === "object" &&
            error !== null &&
            "statusCode" in error &&
            typeof error.statusCode === "number"
          ? error.statusCode
          : 500;
    return reply.status(statusCode).send({
      error:
        error instanceof z.ZodError
          ? "Invalid request payload"
          : error instanceof Error
            ? error.message
            : String(error)
    });
  });
  registerTeamRoutes(app, {
    config: { deploymentProfile: "developer" },
    requireRepository: () => repository,
    auth: {
      hashSecret: (value: string) => value,
      authenticateSession: vi.fn(),
      authenticateSessionContext: vi.fn(async () => ({
        sessionId: randomUUID(),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        user: {
          id: userId,
          email: "owner@example.test",
          displayName: "Owner",
          passwordHash: null
        }
      })),
      authenticateDeviceCredential: vi.fn(),
      authenticateSessionOrDeviceCredential: vi.fn()
    },
    rateLimit: {
      auth: async () => undefined,
      memoryRead: async () => undefined,
      memoryWrite: async () => undefined
    }
  } as unknown as ApiRouteContext);
  await app.ready();
  return { app, createTeamWorkspace };
};

describe("Team Workspace description API boundary", () => {
  it("normalizes a supplied description and preserves null or absence", () => {
    expect(
      createTeamWorkspaceSchema.parse({
        teamId,
        name: "Workspace",
        description: "  Re\u0301sume\u0301 notes  "
      }).description
    ).toBe("Résumé notes");
    expect(
      createTeamWorkspaceSchema.parse({
        teamId,
        name: "Workspace",
        description: null
      }).description
    ).toBeNull();
    expect(
      createTeamWorkspaceSchema.parse({ teamId, name: "Workspace" }).description
    ).toBeUndefined();
  });

  it("accepts exactly 1024 UTF-8 bytes and rejects larger or empty values", () => {
    const exactly1024Bytes = "é".repeat(512);
    const over1024Bytes = `${exactly1024Bytes}a`;
    expect(
      createTeamWorkspaceSchema.parse({
        teamId,
        name: "Workspace",
        description: exactly1024Bytes
      }).description
    ).toBe(exactly1024Bytes);
    expect(() =>
      createTeamWorkspaceSchema.parse({
        teamId,
        name: "Workspace",
        description: over1024Bytes
      })
    ).toThrow("Description must contain at most 1024 UTF-8 bytes");
    expect(() =>
      createTeamWorkspaceSchema.parse({
        teamId,
        name: "Workspace",
        description: "   "
      })
    ).toThrow();
  });

  it("passes only the normalized description through the Workspace route", async () => {
    const fixture = await createRouteFixture();
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/teams/${teamId}/workspaces`,
      payload: {
        name: "Workspace",
        description: "  Re\u0301sume\u0301 notes  "
      }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(200);
    expect(fixture.createTeamWorkspace).toHaveBeenCalledWith(
      { userId },
      { teamId, name: "Workspace", description: "Résumé notes" }
    );
    expect(response.json().teamWorkspace.description).toBe("Résumé notes");
  });

  it("rejects invalid UTF-8 byte lengths before calling the repository", async () => {
    const fixture = await createRouteFixture();
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/teams/${teamId}/workspaces`,
      payload: {
        name: "Workspace",
        description: `${"é".repeat(512)}a`
      }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(400);
    expect(fixture.createTeamWorkspace).not.toHaveBeenCalled();
  });
});
