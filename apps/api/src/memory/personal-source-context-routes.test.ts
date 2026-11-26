import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerPersonalSourceContextRoutes } from "./personal-source-context-routes.js";
import type { ApiRouteContext } from "../server/context.js";

describe("Conversation organization route", () => {
  it("uses authenticated ownership and rejects caller authority before the repository", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000001",
      userId = "00000000-0000-4000-8000-000000000002";
    const axis = {
      revision: 1,
      original: { state: "unresolved", reason: "historical_unresolved" },
      correction: { state: "original" }
    };
    const edit = {
      expectedContext: {
        sessionId,
        logicalSessionId: sessionId,
        git: axis,
        folder: axis
      },
      reviewedProjects: [],
      memberships: [],
      corrections: [{ axis: "git", action: "reset", expectedVersion: 1 }]
    };
    const organize = vi.fn(async () => ({ saved: true })),
      write = vi.fn(async () => {});
    const app = Fastify();
    registerPersonalSourceContextRoutes(app, {
      requireRepository: () => ({ organizePersonalConversation: organize }),
      auth: { authenticate: async () => ({ id: userId }) },
      rateLimit: { memoryRead: async () => {}, memoryWrite: write }
    } as unknown as ApiRouteContext);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/personal/sessions/${sessionId}/organization`,
        payload: edit
      });
      expect(response.statusCode).toBe(200);
      expect(organize).toHaveBeenCalledWith({ userId }, sessionId, edit);
      const denied = await app.inject({
        method: "POST",
        url: `/v1/personal/sessions/${sessionId}/organization`,
        payload: { ...edit, userId: "another-owner" }
      });
      expect(denied.statusCode).toBeGreaterThanOrEqual(400);
      expect(organize).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("passes Git inference intent only to the dedicated preview route", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const userId = "00000000-0000-4000-8000-000000000002";
    const correction = {
      axis: "git",
      action: "set",
      expectedVersion: 1,
      inferenceIntent: "user-confirmed-unknown",
      repository: {
        kind: "portable_repository",
        key: "gr_reviewed",
        root: null,
        branch: null,
        reason: "origin",
        checkoutId: null,
        originatingDeviceId: "device",
        selectedRemote: "origin",
        anchorDisplay: "example.test/repo"
      }
    };
    const axis = {
      revision: 1,
      original: { state: "unresolved", reason: "historical_unresolved" },
      correction: { state: "original" }
    };
    const preview = vi.fn(async () => ({
      preview: { inferenceIntent: correction.inferenceIntent }
    }));
    const organize = vi.fn();
    const app = Fastify();
    registerPersonalSourceContextRoutes(app, {
      requireRepository: () => ({
        previewPersonalSourceCorrection: preview,
        organizePersonalConversation: organize
      }),
      auth: { authenticate: async () => ({ id: userId }) },
      rateLimit: { memoryRead: async () => {}, memoryWrite: async () => {} }
    } as unknown as ApiRouteContext);
    try {
      const base = `/v1/personal/sessions/${sessionId}`;
      const accepted = await app.inject({
        method: "POST",
        url: `${base}/source-context/reviews`,
        payload: correction
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json().preview.inferenceIntent).toBe(
        correction.inferenceIntent
      );
      expect(preview).toHaveBeenCalledWith({ userId }, sessionId, correction);
      const denied = await app.inject({
        method: "POST",
        url: `${base}/organization`,
        payload: {
          expectedContext: {
            sessionId,
            logicalSessionId: sessionId,
            git: axis,
            folder: axis
          },
          reviewedProjects: [],
          memberships: [],
          corrections: [correction]
        }
      });
      expect(denied.statusCode).toBeGreaterThanOrEqual(400);
      expect(organize).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("accepts only bounded exact Folder proposals on the read-only evidence route", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000001",
      userId = "00000000-0000-4000-8000-000000000002";
    const folder = {
      ownerUserId: userId,
      folderId: "folder",
      originatingDeploymentId: "deployment",
      originatingDeviceId: "device",
      originatingProfileId: "profile",
      directoryIncarnationId: "incarnation"
    };
    const evidence = vi.fn(async () => ({ ownerUserId: userId, evidence: [] }));
    const read = vi.fn(async () => {});
    const write = vi.fn(async () => {});
    const app = Fastify();
    registerPersonalSourceContextRoutes(app, {
      requireRepository: () => ({ getPersonalFolderHintEvidence: evidence }),
      auth: { authenticate: async () => ({ id: userId }) },
      rateLimit: { memoryRead: read, memoryWrite: write }
    } as unknown as ApiRouteContext);
    try {
      const ok = await app.inject({
        method: "POST",
        url: "/v1/personal/sessions/folder-hint-evidence",
        payload: { sessionIds: [sessionId], proposedFolders: [folder] }
      });
      expect(ok.statusCode).toBe(200);
      expect(evidence).toHaveBeenCalledWith(
        { userId },
        { sessionIds: [sessionId], proposedFolders: [folder] }
      );
      expect(read).toHaveBeenCalledOnce();
      expect(write).not.toHaveBeenCalled();
      for (const payload of [
        { sessionIds: [] },
        { sessionIds: Array(51).fill(sessionId) },
        { sessionIds: [sessionId], includeKnownFolders: true },
        { sessionIds: [sessionId], proposedFolders: Array(101).fill(folder) },
        { sessionIds: [sessionId], userId: "another-owner" }
      ]) {
        const denied = await app.inject({
          method: "POST",
          url: "/v1/personal/sessions/folder-hint-evidence",
          payload
        });
        expect(denied.statusCode).toBeGreaterThanOrEqual(400);
      }
      expect(evidence).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("rejects owner-only Folder observation requests without invoking a repository write", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000001",
      userId = "00000000-0000-4000-8000-000000000002";
    const record = vi.fn(async () => ({ recorded: true }));
    const app = Fastify();
    registerPersonalSourceContextRoutes(app, {
      requireRepository: () => ({ recordPersonalFolderObservation: record }),
      auth: { authenticate: async () => ({ id: userId }) },
      rateLimit: { memoryRead: async () => {}, memoryWrite: async () => {} }
    } as unknown as ApiRouteContext);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/personal/sessions/${sessionId}/folder-observation`,
        payload: { observation: { identity: {} } }
      });
      expect(record).not.toHaveBeenCalled();
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
