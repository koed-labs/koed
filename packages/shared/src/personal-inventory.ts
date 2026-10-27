import { z } from "zod";
import { repositoryScopeId } from "./repository-recall.js";
import type { RepositoryAssignment } from "./repository-assignment.js";
import type { RepositoryIdentity } from "./repository-identity.js";
import {
  personalFolderScopeId,
  type PersonalFolderContext,
  type PersonalProjectReference
} from "./personal-source-contract.js";

export const personalSourceInventoryCursorSchema = z
  .object({
    ownerUserId: z.uuid(),
    after: z
      .object({
        projectId: z.string().min(1).max(8192),
        threadId: z.string().min(1).max(8192),
        sessionId: z.union([z.uuid(), z.literal("")])
      })
      .strict()
  })
  .strict();

export type PersonalInventoryGroup = {
  id: string;
  namedProject?: { projectId: string };
  projectReference?: PersonalProjectReference;
  folder?: PersonalFolderContext;
  repository?: RepositoryIdentity;
  threads: Array<{ repositoryAssignment?: RepositoryAssignment }>;
};

/** Names, paths and checkout display groupings never establish source identity. */
export const personalInventoryReference = (group: PersonalInventoryGroup) => {
  if (group.namedProject)
    return {
      kind: "project" as const,
      key: JSON.stringify({
        ownerUserId: group.projectReference?.ownerUserId,
        projectId: group.namedProject.projectId
      }),
      project: group.projectReference
    };
  if (group.folder)
    return {
      kind: "folder" as const,
      key: personalFolderScopeId(group.folder.reference),
      folder: group.folder.reference
    };
  const repository =
    group.repository ??
    group.threads.find((thread) => thread.repositoryAssignment?.effective)
      ?.repositoryAssignment?.effective;
  if (
    repository?.kind === "portable_repository" ||
    repository?.kind === "device_local_repository"
  )
    return {
      kind: "git" as const,
      key: repositoryScopeId(repository),
      repository
    };
  return {
    kind: "unresolved" as const,
    key: repository?.kind === "local_project" ? "unassigned" : group.id
  };
};

type Conversation = {
  id: string;
  sessionId?: string | null;
  logicalMemoryId?: string | null;
  latestAt: string;
  eventCount: number;
  invalidatedCount: number;
  sourceReferences?: Array<{
    sessionId: string;
    logicalSessionId: string;
    logicalMemoryId: string | null;
  }>;
  membershipReasons?: Array<{ kind: string }>;
};

export const personalInventoryConversationKey = (
  thread: Conversation
): string => {
  const source = thread.sourceReferences?.find(
    (ref) => ref.sessionId === thread.sessionId
  );
  if (source) return `logical-session:${source.logicalSessionId}`;
  if (thread.logicalMemoryId) return `logical-memory:${thread.logicalMemoryId}`;
  return thread.sessionId
    ? `session:${thread.sessionId}`
    : `thread:${thread.id}`;
};

/** Keep all local bindings for navigation, but count a logical Conversation once. */
export const deduplicatePersonalInventoryConversations = <
  T extends Conversation
>(
  threads: T[]
): T[] => {
  const byIdentity = new Map<string, T>();
  const unique = <V>(values: V[]) => [
    ...new Map(values.map((value) => [JSON.stringify(value), value])).values()
  ];
  for (const thread of threads) {
    const key = personalInventoryConversationKey(thread);
    const previous = byIdentity.get(key);
    if (!previous) {
      byIdentity.set(key, thread);
      continue;
    }
    const latest =
      Date.parse(thread.latestAt) > Date.parse(previous.latestAt)
        ? thread
        : previous;
    byIdentity.set(key, {
      ...latest,
      eventCount: Math.max(previous.eventCount, thread.eventCount),
      invalidatedCount: Math.max(
        previous.invalidatedCount,
        thread.invalidatedCount
      ),
      ...(previous.sourceReferences || thread.sourceReferences
        ? {
            sourceReferences: unique([
              ...(previous.sourceReferences ?? []),
              ...(thread.sourceReferences ?? [])
            ])
          }
        : {}),
      ...(previous.membershipReasons || thread.membershipReasons
        ? {
            membershipReasons: unique([
              ...(previous.membershipReasons ?? []),
              ...(thread.membershipReasons ?? [])
            ])
          }
        : {})
    });
  }
  return [...byIdentity.values()].sort(
    (a, b) =>
      Date.parse(b.latestAt) - Date.parse(a.latestAt) ||
      a.id.localeCompare(b.id)
  );
};

export const partitionPersonalInventory = <T extends PersonalInventoryGroup>(
  groups: T[]
) => {
  const inventory = {
    projects: [] as T[],
    gitSources: [] as T[],
    folders: [] as T[],
    unresolved: [] as T[]
  };
  for (const group of groups) {
    const reference = personalInventoryReference(group);
    switch (reference.kind) {
      case "project":
        inventory.projects.push(group);
        break;
      case "git":
        inventory.gitSources.push(group);
        break;
      case "folder":
        inventory.folders.push(group);
        break;
      case "unresolved":
        inventory.unresolved.push(group);
        break;
    }
  }
  return inventory;
};
