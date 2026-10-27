import { z } from "zod";
import {
  personalDesktopProjectsDataSchema,
  deduplicatePersonalInventoryConversations,
  personalSourceInventoryCursorSchema
} from "@koed/shared";
import { PersonalMemoryBoundaryError } from "./personal-memory-boundary.js";
const objectValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const personalProjectsData = (
  payload: Record<string, unknown>,
  includeSubagents = false,
  deviceNames: Record<string, string> = {}
) => {
  const projects = Array.isArray(payload.projects) ? payload.projects : null;
  if (!projects) {
    throw new PersonalMemoryBoundaryError("invalid_response", false);
  }
  return personalDesktopProjectsDataSchema.parse({
    projects: projects.map((projectValue) => {
      const project = objectValue(projectValue) ?? {};
      const threadValues = Array.isArray(project.threads)
        ? project.threads
        : [];
      const threads = threadValues.map((threadValue) => {
        const thread = objectValue(threadValue) ?? {};
        const capturedCwd = objectValue(
          thread.capturedProjectProvenance
        )?.capturedCwd;
        return {
          id: thread.id,
          name: thread.name,
          sessionId: thread.sessionId,
          logicalMemoryId: thread.logicalMemoryId,
          namedProjectId: thread.namedProjectId,
          folderSelection: thread.folderSelection,
          sourceThreadId: thread.sourceThreadId,
          sourceProject: thread.sourceProject,
          membershipReasons: thread.membershipReasons,
          sourceReferences: thread.sourceReferences,
          sourceAiClient: thread.sourceAiClient,
          originDevice:
            typeof thread.originDeviceId === "string"
              ? {
                  id: thread.originDeviceId,
                  name:
                    deviceNames[thread.originDeviceId] ??
                    `Device ${thread.originDeviceId.slice(0, 8)}`
                }
              : null,
          projectId: thread.projectId,
          projectName: thread.projectName,
          projectPath: thread.projectPath,
          capturedCwd:
            typeof capturedCwd === "string" &&
            capturedCwd.trim().length > 0 &&
            capturedCwd.length <= 4096
              ? capturedCwd
              : null,
          projectAssignmentSource: thread.projectAssignmentSource,
          ...(thread.repositoryAssignment
            ? { repositoryAssignment: thread.repositoryAssignment }
            : {}),
          presentation: thread.presentation,
          eventCount: thread.eventCount,
          invalidatedCount: thread.invalidatedCount,
          latestAt: thread.latestAt,
          sample: thread.sample,
          threadKind: thread.threadKind,
          parentThreadId: thread.parentThreadId,
          parentSessionId: thread.parentSessionId
        };
      });
      const threadIds = new Set(
        threads.flatMap((thread) =>
          typeof thread.id === "string" ? [thread.id] : []
        )
      );
      const logicalBySession = new Map(
        threads.flatMap((thread) =>
          typeof thread.sessionId === "string" && typeof thread.id === "string"
            ? [[thread.sessionId, thread.id] as const]
            : []
        )
      );
      const logicalByProvider = new Map<string, string[]>();
      for (const thread of threads)
        if (
          typeof thread.sourceThreadId === "string" &&
          typeof thread.id === "string"
        )
          logicalByProvider.set(thread.sourceThreadId, [
            ...(logicalByProvider.get(thread.sourceThreadId) ?? []),
            thread.id
          ]);
      for (const thread of threads) {
        const providerParents =
          typeof thread.parentThreadId === "string"
            ? logicalByProvider.get(thread.parentThreadId)
            : undefined;
        thread.parentThreadId =
          (typeof thread.parentSessionId === "string"
            ? logicalBySession.get(thread.parentSessionId)
            : undefined) ??
          (providerParents?.length === 1
            ? providerParents[0]
            : thread.parentThreadId);
      }
      const visibleThreads = threads.filter((thread) => {
        const parentThreadId =
          typeof thread.parentThreadId === "string"
            ? thread.parentThreadId
            : null;
        const hasVisibleParent =
          parentThreadId !== null && threadIds.has(parentThreadId);
        return (
          includeSubagents ||
          !(thread.threadKind === "subagent" && hasVisibleParent)
        );
      });
      return {
        id: project.id,
        ownerUserId: project.ownerUserId,
        namedProject: project.namedProject,
        projectReference: project.projectReference,
        inclusionRules: project.inclusionRules,
        directInclusions: project.directInclusions,
        folder: project.folder,
        name: project.name,
        path: project.path,
        eventCount: visibleThreads.reduce(
          (total, thread) =>
            total +
            (typeof thread.eventCount === "number" ? thread.eventCount : 0),
          0
        ),
        threads: visibleThreads
      };
    })
  });
};

const sourcePageSchema = z
  .object({
    gitSources: z.array(z.unknown()),
    unresolved: z.array(z.unknown()),
    nextCursor: z.string().max(32768).nullable()
  })
  .strict();

export const loadNamedPersonalInventory = async (
  request: (path: string) => Promise<Record<string, unknown>>,
  deviceNames: Record<string, string> = {}
) =>
  personalProjectsData(
    await request("/v1/personal/projects/inventory"),
    false,
    deviceNames
  );

export const loadPersonalInventory = async (
  request: (path: string) => Promise<Record<string, unknown>>,
  deviceNames: Record<string, string> = {}
) => {
  const loadSources = async () => {
    const rawGroups = new Map<string, Record<string, unknown>>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = sourcePageSchema.parse(
        await request(
          `/v1/personal/sources/inventory${cursor ? `?${new URLSearchParams({ cursor })}` : ""}`
        )
      );
      for (const value of [...page.gitSources, ...page.unresolved]) {
        const group = objectValue(value);
        if (
          !group ||
          typeof group.id !== "string" ||
          !Array.isArray(group.threads)
        )
          throw new PersonalMemoryBoundaryError("invalid_response", false);
        const existing = rawGroups.get(group.id);
        rawGroups.set(group.id, {
          ...group,
          threads: [
            ...(Array.isArray(existing?.threads) ? existing.threads : []),
            ...group.threads
          ]
        });
      }
      cursor = page.nextCursor;
      if (cursor) {
        personalSourceInventoryCursorSchema.parse(JSON.parse(cursor));
        if (seenCursors.has(cursor))
          throw new PersonalMemoryBoundaryError("invalid_response", false);
        seenCursors.add(cursor);
      }
    } while (cursor);
    return personalProjectsData(
      { projects: [...rawGroups.values()] },
      false,
      deviceNames
    );
  };
  const [sources, named, folders] = await Promise.all([
    loadSources(),
    loadNamedPersonalInventory(request, deviceNames),
    request("/v1/personal/folders/inventory").then((data) =>
      personalProjectsData(data, false, deviceNames)
    )
  ]);
  return personalDesktopProjectsDataSchema.parse({
    projects: [...sources.projects, ...named.projects, ...folders.projects].map(
      (group) => {
        const threads = deduplicatePersonalInventoryConversations(
          group.threads
        );
        return {
          ...group,
          threads,
          eventCount: threads.reduce(
            (sum, thread) => sum + thread.eventCount,
            0
          )
        };
      }
    )
  });
};
