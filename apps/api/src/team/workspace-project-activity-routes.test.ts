import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerWorkspaceProjectRoutes } from "./workspace-project-routes.js";

describe("Team Project activity boundary", () => {
  it("reads public Project events for a current member and advances seen without Team message content", async () => {
    const app = Fastify();
    const projectId = randomUUID();
    const memberId = randomUUID();
    const userId = randomUUID();
    const cursor = "member-project-cursor";
    const seen = { cursor, seenAt: null, welcomeDue: true, memberId };
    const repository = {
      activitySeen: vi.fn(async () => seen),
      activityPage: vi.fn(async () => ({
        projectId,
        memberId,
        items: [
          {
            cursor,
            actorTeamMemberId: memberId,
            kind: "source_added",
            ref: randomUUID(),
            at: "2026-10-20T10:00:00.000Z"
          }
        ],
        hasMore: false,
        nextCursor: cursor
      })),
      acknowledgeActivity: vi.fn(async () => ({ ...seen, welcomeDue: false }))
    };
    const auth = vi.fn(async (_request: unknown, family: string) => {
      expect(family).toBe("team_workspace_read");
      return { id: userId };
    });
    registerWorkspaceProjectRoutes(app, {
      repository: repository as never,
      requireRepository: (() => ({})) as never,
      auth: { authenticateSessionOrDeviceCredential: auth } as never,
      readRateLimit: async () => undefined,
      writeRateLimit: async () => undefined
    });
    try {
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/v1/workspace-projects/${projectId}/activity/seen`
          })
        ).json()
      ).toEqual(seen);
      const page = (
        await app.inject({
          method: "GET",
          url: `/v1/workspace-projects/${projectId}/activity?after=${cursor}`
        })
      ).json();
      expect(page.items).toHaveLength(1);
      expect(JSON.stringify(page)).not.toContain("messageText");
      expect(repository.activityPage).toHaveBeenCalledWith(userId, projectId, {
        after: cursor,
        limit: 100
      });
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/v1/workspace-projects/${projectId}/activity/seen`,
            payload: { cursor, welcomeDelivered: true }
          })
        ).json().welcomeDue
      ).toBe(false);
      expect(repository.acknowledgeActivity).toHaveBeenCalledWith(
        userId,
        projectId,
        cursor,
        true
      );
    } finally {
      await app.close();
    }
  });
});
