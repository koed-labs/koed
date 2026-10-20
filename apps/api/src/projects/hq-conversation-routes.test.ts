import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { ProjectNotFoundError } from "@koed/db";
import {
  deleteDesktopLocalCredential,
  storeDesktopLocalCredential
} from "@koed/shared";
import { registerProjectRoutes } from "./routes.js";

const owner = randomUUID();
const projectId = randomUUID();
const deletedId = randomUUID();
const createdAt = "2026-10-20T00:00:00.000Z";
const project = {
  id: projectId,
  name: "Atlas",
  key: "ATLAS",
  folderPath: null,
  lifecycle: "active",
  deletionPhase: null,
  deleteBatchId: null,
  deletedAt: null,
  createdAt,
  updatedAt: createdAt,
  version: 1
};
const sections = Object.fromEntries(
  ["conversations", "workItems", "sources", "decks", "scheduledJobs"].map(
    (key) => [key, { availability: "not_implemented" }]
  )
);

describe("Project HQ conversation HTTP route", () => {
  it("keeps GET pure, reserves only on explicit owner-authorized POST, and rejects deleted Projects", async () => {
    const home = mkdtempSync(join(tmpdir(), "koed-hq-reserve-"));
    const app = Fastify();
    const executionId = randomUUID();
    const capturedSessionId = randomUUID();
    let conversation: {
      projectId: string;
      executionId: string | null;
      createdAt: string;
    } | null = null;
    let execution: {
      state: string;
      capturedSessionId: string | null;
      threadId: string | null;
      graphProjectId: string | null;
      graphThreadId: string | null;
      provider: string;
      aiClientInstanceId: string;
    } | null = null;
    const repository = {
      hq: vi.fn(async (ownerId: string, id: string) => {
        if (ownerId !== owner || id !== projectId)
          throw new ProjectNotFoundError("Project not found");
        return { project, sections };
      }),
      reserveHqConversation: vi.fn(async (ownerId: string, id: string) => {
        if (ownerId !== owner || id === deletedId || id !== projectId)
          throw new ProjectNotFoundError("Project not found");
        conversation = { projectId: id, executionId: null, createdAt };
        return conversation;
      }),
      readHqConversation: vi.fn(async (ownerId: string, id: string) => {
        if (ownerId !== owner || id === deletedId || id !== projectId)
          throw new ProjectNotFoundError("Project not found");
        return { conversation, execution };
      })
    };
    const fallback = vi.fn(async () => {
      throw Object.assign(new Error("Session required"), { statusCode: 401 });
    });
    registerProjectRoutes(app, {
      repository: repository as never,
      managedRepository: null,
      sourceCoordinator: null,
      deploymentProfile: "local_personal",
      koedHome: home,
      auth: { authenticateSessionOrDeviceCredential: fallback } as never,
      readRateLimit: async () => undefined,
      writeRateLimit: async () => undefined
    });
    try {
      const readOnly = storeDesktopLocalCredential(home, {
        ownerUserId: owner,
        operationFamilies: ["personal_collaboration_read"]
      });
      const denied = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/hq/conversation`,
        headers: { authorization: readOnly.authorization }
      });
      expect(denied.statusCode).toBe(401);
      expect(repository.reserveHqConversation).not.toHaveBeenCalled();
      const initial = await app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/hq/conversation`,
        headers: { authorization: readOnly.authorization }
      });
      expect(initial.statusCode, initial.body).toBe(200);
      expect(initial.json()).toEqual({ conversation: null, execution: null });
      expect(repository.reserveHqConversation).not.toHaveBeenCalled();
      deleteDesktopLocalCredential(home);
      const desktop = storeDesktopLocalCredential(home, {
        ownerUserId: owner,
        operationFamilies: [
          "personal_collaboration_read",
          "personal_collaboration_write"
        ]
      });
      const headers = { authorization: desktop.authorization };
      const read = await app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/hq`,
        headers
      });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json()).toMatchObject({ project: { id: projectId } });
      expect(repository.reserveHqConversation).not.toHaveBeenCalled();
      const created = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/hq/conversation`,
        headers
      });
      expect(created.statusCode, created.body).toBe(200);
      expect(created.json()).toEqual({
        projectId,
        executionId: null,
        createdAt
      });
      expect(repository.reserveHqConversation).toHaveBeenCalledExactlyOnceWith(
        owner,
        projectId
      );
      const reserved = await app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/hq/conversation`,
        headers
      });
      expect(reserved.statusCode, reserved.body).toBe(200);
      expect(reserved.json()).toEqual({
        conversation: { projectId, executionId: null, createdAt },
        execution: null
      });
      expect(repository.reserveHqConversation).toHaveBeenCalledTimes(1);
      // The managed start route updates this owner-scoped identity; GET reads it without reserving again.
      conversation = { projectId, executionId, createdAt };
      execution = {
        state: "stopped",
        capturedSessionId,
        threadId: "provider-hq-thread",
        graphProjectId: "/local/project-folder",
        graphThreadId: "graph-hq-thread",
        provider: "codex",
        aiClientInstanceId: "codex.default"
      };
      const started = await app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/hq/conversation`,
        headers
      });
      expect(started.statusCode, started.body).toBe(200);
      expect(started.json()).toEqual({ conversation, execution });
      expect(repository.reserveHqConversation).toHaveBeenCalledTimes(1);
      const foreignRead = await app.inject({
        method: "GET",
        url: `/v1/projects/${deletedId}/hq/conversation`,
        headers
      });
      expect(foreignRead.statusCode).toBe(404);
      const deleted = await app.inject({
        method: "POST",
        url: `/v1/projects/${deletedId}/hq/conversation`,
        headers
      });
      expect(deleted.statusCode).toBe(404);
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
