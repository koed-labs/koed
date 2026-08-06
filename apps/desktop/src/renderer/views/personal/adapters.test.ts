import type { PersonalDesktopProjectThread } from "@koed/shared/personal-desktop";
import { describe, expect, it } from "vitest";

import {
  personalMemorySharingSource,
  suggestedWorkspaceId,
  writableWorkspaceDestinations,
  type WorkspaceShareCandidate
} from "./adapters.js";

const thread = {
  eventCount: 2,
  latestAt: "2026-08-05T12:00:00.000Z",
  name: "Local capture",
  projectName: "koed",
  sample: "Share preview",
  sessionId: "00000000-0000-4000-8000-000000000001"
} satisfies Pick<
  PersonalDesktopProjectThread,
  "eventCount" | "latestAt" | "name" | "projectName" | "sample" | "sessionId"
>;

const candidate = (
  workspaceId: string,
  overrides: Partial<WorkspaceShareCandidate> = {}
): WorkspaceShareCandidate => ({
  access: "write",
  authorized: true,
  lifecycle: "active",
  name: `Workspace ${workspaceId}`,
  teamId: "team-1",
  teamLifecycle: "active",
  teamName: "Koed",
  workspaceId,
  ...overrides
});

describe("Personal Memory collaboration adapters", () => {
  it("joins sharing metadata only through the stable Captured Session id", () => {
    const source = personalMemorySharingSource(thread, [
      {
        entryId: "entry-1",
        logicalMemoryId: "logical-1",
        sessionId: thread.sessionId!,
        syncState: "ready"
      },
      {
        entryId: "same-title-is-not-an-identity",
        logicalMemoryId: null,
        sessionId: "different-session",
        syncState: "not_started"
      }
    ]);

    expect(source).toEqual({
      entryId: "entry-1",
      localEntry: null,
      logicalMemoryId: "logical-1",
      sessionId: thread.sessionId,
      syncState: "ready"
    });
    expect(personalMemorySharingSource(thread, [])).toEqual({
      entryId: thread.sessionId,
      localEntry: {
        id: thread.sessionId,
        logicalMemoryId: null,
        title: thread.name,
        projectName: thread.projectName,
        updatedAt: thread.latestAt,
        preview: thread.sample,
        eventCount: thread.eventCount,
        hasSynchronizedRevision: false,
        syncState: "not_started"
      },
      logicalMemoryId: null,
      sessionId: thread.sessionId,
      syncState: "not_started"
    });
    expect(
      personalMemorySharingSource({ ...thread, sessionId: null }, [])
    ).toBeNull();
  });

  it("accepts only current writable authorized Workspace destinations", () => {
    const destinations = writableWorkspaceDestinations([
      candidate("writable"),
      candidate("read-only", { access: "read" }),
      candidate("revoked", { authorized: false }),
      candidate("archived", { lifecycle: "archived" }),
      candidate("team-suspended", { teamLifecycle: "suspended" })
    ]);

    expect(destinations.map(({ workspaceId }) => workspaceId)).toEqual([
      "writable"
    ]);
  });

  it("uses Project mapping as a suggestion only after destination authorization", () => {
    const destinations = writableWorkspaceDestinations([
      candidate("authorized")
    ]);
    expect(
      suggestedWorkspaceId("project-1", destinations, [
        { projectId: "project-1", workspaceId: "unauthorized" }
      ])
    ).toBeNull();
    expect(
      suggestedWorkspaceId("project-1", destinations, [
        { projectId: "project-1", workspaceId: "authorized" }
      ])
    ).toBe("authorized");
  });
});
