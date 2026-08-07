import { describe, expect, it } from "vitest";
import {
  PERSONAL_DESKTOP_CONTRACT_VERSION,
  personalDesktopRequestSchema,
  personalDesktopResultSchema
} from "./personal-desktop-contract.js";

const sessionId = "11111111-1111-4111-8111-111111111111";

describe("Personal Desktop IPC contract", () => {
  it("accepts only the three exact Personal Memory operations", () => {
    expect(
      personalDesktopRequestSchema.parse({
        contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
        operation: "personal.projects.list",
        input: {}
      })
    ).toMatchObject({ operation: "personal.projects.list" });
    expect(
      personalDesktopRequestSchema.parse({
        contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
        operation: "personal.events.load_page",
        input: {
          projectId: "project-1",
          threadId: "thread-1",
          limit: 50
        }
      })
    ).toMatchObject({ operation: "personal.events.load_page" });
    expect(
      personalDesktopRequestSchema.parse({
        contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
        operation: "personal.sessions.assign_project",
        input: { action: "move", sessionId, targetProjectId: "project-2" }
      })
    ).toMatchObject({ operation: "personal.sessions.assign_project" });
  });

  it.each([
    { apiToken: "raw-token" },
    { authorization: "Bearer raw-token" },
    { headers: { authorization: "Bearer raw-token" } },
    { url: "http://127.0.0.1:3000/v1/memory/graph/threads" },
    { path: "/v1/memory/graph/threads" },
    { remoteAuthority: "team.example.test" }
  ])("rejects renderer-provided transport authority: %j", (extra) => {
    expect(() =>
      personalDesktopRequestSchema.parse({
        contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
        operation: "personal.projects.list",
        input: { ...extra }
      })
    ).toThrow();
  });

  it("accepts bounded exact-event reconciliation without pagination authority", () => {
    const eventId = "22222222-2222-4222-8222-222222222222";
    expect(
      personalDesktopRequestSchema.parse({
        contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
        operation: "personal.events.load_page",
        input: {
          projectId: "project-1",
          threadId: "thread-1",
          limit: 500,
          eventIds: [eventId]
        }
      })
    ).toMatchObject({ input: { eventIds: [eventId] } });
    expect(() =>
      personalDesktopRequestSchema.parse({
        contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
        operation: "personal.events.load_page",
        input: {
          projectId: "project-1",
          threadId: "thread-1",
          limit: 500,
          eventIds: [eventId],
          cursor: {
            id: eventId,
            sourceSequence: 1,
            timestamp: "2026-07-23T00:00:01.000Z"
          }
        }
      })
    ).toThrow();
  });

  it("rejects generic assignment targets and credential-bearing results", () => {
    expect(() =>
      personalDesktopRequestSchema.parse({
        contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
        operation: "personal.sessions.assign_project",
        input: {
          action: "move",
          sessionId,
          targetProjectId: "project-2",
          path: "/work/project-2"
        }
      })
    ).toThrow();

    expect(() =>
      personalDesktopResultSchema.parse({
        contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
        operation: "personal.projects.list",
        ok: true,
        data: { projects: [], apiToken: "raw-token" }
      })
    ).toThrow();
  });
});
