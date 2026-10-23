import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerWorkspaceProjectRoutes } from "./workspace-project-routes.js";

describe("Project contribution content boundary", () => {
  it("shows a validated Note event but never falls back to captured-chat raw events", async () => {
    const userId = randomUUID();
    const projectId = randomUUID();
    const teamId = randomUUID();
    const workspaceId = randomUUID();
    const noteGrantId = randomUUID();
    const chatGrantId = randomUUID();
    const logicalMemoryId = randomUUID();
    const createdAt = "2026-10-23T12:00:00.000Z";
    const project = { id: projectId, teamId, workspaceId, version: 1 };
    const readGrantRepresentation = vi.fn(
      async (
        _actor: unknown,
        input: { shareGrantId: string; representation: string }
      ) => {
        if (input.representation !== "memory_events") return null;
        return {
          grant: {
            teamId,
            teamWorkspaceId: workspaceId,
            logicalMemoryId,
            createdAt
          },
          representation: {
            representation: "memory_events",
            sourceRevision: 1
          },
          items: [
            {
              itemType: "user_message",
              schemaVersion: 1,
              sourceId: randomUUID(),
              sourceLogicalMemoryId: logicalMemoryId,
              sourceRevision: 1,
              occurredAt: createdAt,
              content: {
                text:
                  input.shareGrantId === noteGrantId
                    ? "Published Note content"
                    : "Private captured transcript"
              }
            }
          ]
        };
      }
    );
    const app = Fastify();
    registerWorkspaceProjectRoutes(app, {
      repository: {
        getLifecycleReview: vi.fn(async () => ({ project })),
        getProjectContributionAttributions: vi.fn(async () => [
          {
            shareGrantId: noteGrantId,
            sourceKind: "personal_note",
            contributorDisplayName: "Bob",
            groupName: "Atlas",
            noLongerInGroup: false
          },
          {
            shareGrantId: chatGrantId,
            sourceKind: "captured_session",
            contributorDisplayName: "Bob",
            groupName: "Atlas",
            noLongerInGroup: false
          }
        ])
      } as never,
      requireRepository: () =>
        ({
          listWorkspaceGrants: vi.fn(async () => ({
            entries: [
              {
                shareGrantId: noteGrantId,
                activeRepresentation: "memory_events"
              },
              {
                shareGrantId: chatGrantId,
                activeRepresentation: "memory_events"
              }
            ],
            hasMore: false
          })),
          readGrantRepresentation
        }) as never,
      auth: {
        authenticateSessionOrDeviceCredential: vi.fn(async () => ({
          id: userId
        }))
      } as never,
      readRateLimit: async () => undefined,
      writeRateLimit: async () => undefined
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/workspace-projects/${projectId}/contributions`
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().contributions).toMatchObject([
        {
          shareGrantId: noteGrantId,
          title: "Note contribution",
          summaries: [{ text: "Published Note content" }]
        }
      ]);
      expect(response.body).not.toContain("Private captured transcript");
      expect(
        readGrantRepresentation.mock.calls.some(
          ([, input]) =>
            input.shareGrantId === chatGrantId &&
            input.representation === "memory_events"
        )
      ).toBe(false);
    } finally {
      await app.close();
    }
  });
});
