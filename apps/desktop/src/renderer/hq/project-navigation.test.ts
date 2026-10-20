import type { Project } from "@koed/shared";
import type { PersonalDesktopProjectThread } from "@koed/shared/personal-desktop";
import { describe, expect, it } from "vitest";
import type { DesktopProject } from "../../project-memory-ui.js";
import { projectNavigation, visibleHqProjects } from "./project-navigation.js";

const now = "2026-10-20T00:00:00.000Z";
const id = (tail: number) =>
  `00000000-0000-4000-8000-${String(tail).padStart(12, "0")}`;
const personal = (tail: number): Project => ({
  id: id(tail),
  name: `Personal ${tail}`,
  key: `P${tail}`,
  folderPath: null,
  lifecycle: "active",
  deletionPhase: null,
  deleteBatchId: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
  version: 1
});
const thread = (
  tail: number,
  personalProjectId: string | null,
  conversationTrashedAt: string | null = null
): PersonalDesktopProjectThread => ({
  id: `technical-thread-${tail}`,
  name: `Conversation ${tail}`,
  sessionId: id(tail),
  sourceAiClient: null,
  projectId: "technical-repository",
  personalProjectId,
  conversationTrashedAt,
  projectName: "Technical repository",
  projectPath: null,
  projectAssignmentSource: null,
  eventCount: 1,
  invalidatedCount: 0,
  latestAt: now,
  sample: "",
  presentation: null
});
const graph = (threads: PersonalDesktopProjectThread[]): DesktopProject => ({
  id: "technical-repository",
  name: "Technical repository",
  path: null,
  eventCount: threads.length,
  threads,
  contextKind: "project",
  catalogued: true,
  discoveredAt: now,
  lastSeenAt: now,
  localProjectId: "technical-repository",
  branch: null,
  remoteDisplay: null,
  isWorktree: false
});

describe("HQ Project navigation authority", () => {
  it("does not resurrect deleted or previously trashed Sessions as Chats", () => {
    const active = personal(1);
    const deleted = personal(2);
    const current = thread(11, active.id);
    const priorTrash = thread(12, active.id, now);
    const deletedChild = thread(13, deleted.id);
    const unmapped = thread(14, null);
    const unknown = { ...thread(15, null), personalProjectId: undefined };
    const captured = [
      graph([current, priorTrash, deletedChild, unmapped, unknown])
    ];
    const pendingDraft = { ...priorTrash, conversationTrashedAt: null };
    const merged = [
      graph([
        current,
        priorTrash,
        deletedChild,
        pendingDraft,
        { ...unmapped, personalProjectId: deleted.id },
        unknown
      ])
    ];
    const visible = visibleHqProjects([active], captured, merged);
    const navigation = projectNavigation([active], visible);
    expect(visible[0]?.threads.map(({ sessionId }) => sessionId)).toEqual([
      current.sessionId,
      unmapped.sessionId,
      unknown.sessionId
    ]);
    expect(navigation.projects[0]?.conversations[0]).toMatchObject({
      technicalProjectId: "technical-repository",
      thread: { sessionId: current.sessionId }
    });
    expect(navigation.loose.map(({ thread }) => thread.sessionId)).toEqual([
      unmapped.sessionId
    ]);

    // A restored batch clears only its own Session trash marker.
    const restored = graph([
      { ...current, conversationTrashedAt: null },
      priorTrash
    ]);
    expect(
      visibleHqProjects([active], [restored], [restored])[0]?.threads.map(
        ({ sessionId }) => sessionId
      )
    ).toEqual([current.sessionId]);
  });
});
