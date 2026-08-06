import type {
  PersonalDesktopProjectThread,
  PersonalDesktopSessionProjectInput
} from "@koed/shared/personal-desktop";
import type { PersonalMemoryEntry } from "@koed/shared";

export type PersonalMemorySharingRecord = {
  entryId: string;
  logicalMemoryId: string | null;
  sessionId: string;
  syncState:
    | "not_started"
    | "paused"
    | "processing"
    | "partially_available"
    | "ready"
    | "stale"
    | "failed"
    | "revoked";
};

export type PersonalMemorySharingSource = {
  entryId: string;
  localEntry: PersonalMemoryEntry | null;
  logicalMemoryId: string | null;
  sessionId: string;
  syncState: PersonalMemorySharingRecord["syncState"];
};

export type WorkspaceShareCandidate = {
  access: "read" | "write";
  authorized: boolean;
  lifecycle: "active" | "archived" | "suspended" | "removed";
  name: string;
  teamId: string;
  teamLifecycle: "active" | "suspended" | "removed";
  teamName: string;
  workspaceId: string;
};

export type WritableWorkspaceDestination = Pick<
  WorkspaceShareCandidate,
  "name" | "teamId" | "teamName" | "workspaceId"
>;

export type ProjectWorkspaceSuggestion = {
  projectId: string;
  workspaceId: string;
};

export type ShareToWorkspaceRequest = {
  destinations: readonly WritableWorkspaceDestination[];
  source: PersonalMemorySharingSource;
  suggestedWorkspaceId: string | null;
};

export const personalMemorySharingSource = (
  thread: Pick<
    PersonalDesktopProjectThread,
    "eventCount" | "latestAt" | "name" | "projectName" | "sample" | "sessionId"
  >,
  records: readonly PersonalMemorySharingRecord[]
): PersonalMemorySharingSource | null => {
  if (!thread.sessionId) return null;
  const record = records.find(
    (candidate) => candidate.sessionId === thread.sessionId
  );
  if (!record) {
    return {
      entryId: thread.sessionId,
      localEntry: {
        id: thread.sessionId,
        logicalMemoryId: null,
        title: thread.name.trim() || "Untitled session",
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
    };
  }
  return {
    entryId: record.entryId,
    localEntry: null,
    logicalMemoryId: record.logicalMemoryId,
    sessionId: record.sessionId,
    syncState: record.syncState
  };
};

export const writableWorkspaceDestinations = (
  candidates: readonly WorkspaceShareCandidate[]
): WritableWorkspaceDestination[] =>
  candidates
    .filter(
      (candidate) =>
        candidate.authorized &&
        candidate.access === "write" &&
        candidate.lifecycle === "active" &&
        candidate.teamLifecycle === "active"
    )
    .map(({ name, teamId, teamName, workspaceId }) => ({
      name,
      teamId,
      teamName,
      workspaceId
    }))
    .sort(
      (left, right) =>
        left.teamName.localeCompare(right.teamName) ||
        left.name.localeCompare(right.name)
    );

export const suggestedWorkspaceId = (
  projectId: string,
  destinations: readonly WritableWorkspaceDestination[],
  suggestions: readonly ProjectWorkspaceSuggestion[]
): string | null => {
  const suggestedId = suggestions.find(
    (suggestion) => suggestion.projectId === projectId
  )?.workspaceId;
  return suggestedId &&
    destinations.some((destination) => destination.workspaceId === suggestedId)
    ? suggestedId
    : null;
};

export type SessionProjectAssignment = PersonalDesktopSessionProjectInput;
