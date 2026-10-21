import {
  workspaceProjectCopySchema,
  workspaceProjectCreateSchema,
  workspaceProjectRecordSchema,
  workspaceProjectWorkItemCreateSchema,
  workspaceProjectWorkItemSchema,
  workspaceProjectSourceSchema,
  workspaceProjectSourceCreateSchema,
  workspaceProjectSourcePatchSchema,
  workspaceProjectActivitySummarySchema,
  workspaceProjectWorkItemPatchSchema,
  type WorkspaceProjectCopy,
  type WorkspaceProjectCreate,
  type WorkspaceProjectWorkItem,
  type WorkspaceProjectSource,
  type WorkspaceProjectWorkItemCreate,
  type WorkspaceProjectWorkItemPatch
} from "@koed/shared";
import { z } from "zod";

const projectSchema = workspaceProjectRecordSchema;
const lifecycleSchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  memberVersion: z.number().int().positive(),
  canWrite: z.boolean(),
  active: z.boolean()
});

export type WorkspaceProjectState = {
  project: z.infer<typeof projectSchema> | null;
  memberVersion: number | null;
  workItems: WorkspaceProjectWorkItem[];
  sources: WorkspaceProjectSource[];
  activity: z.infer<typeof workspaceProjectActivitySummarySchema> | null;
  readOnly: boolean;
  notice: string | null;
};

export const createWorkspaceProjectClient = (input: {
  sendTeam(path: string, init?: RequestInit): Promise<unknown>;
  // Trusted owner-local Personal backend data. A renderer never supplies this
  // copy manifest or a Note revision identity to the Team write.
  loadPersonalCopy(
    projectId: string,
    teamBackendId: string,
    shareAttemptKey: string,
    targetTeamId: string,
    targetWorkspaceId: string
  ): Promise<
    Omit<WorkspaceProjectCopy, "expectedVersion"> & {
      personalProjectVersion: number;
    }
  >;
  markPersonalMoved(
    projectId: string,
    workspaceProjectId: string,
    teamBackendId: string,
    workspaceId: string,
    expectedPersonalProjectVersion: number
  ): Promise<void>;
  onAuthoritativeInvalidation(projectId: string): Promise<void>;
  loadPersonalSource(
    projectId: string,
    sourceId: string,
    workspaceProjectId: string
  ): Promise<{
    id: string;
    name: string;
    kind: string;
    status: string;
    personalNoteId: string | null;
    personalNoteRevisionId: string | null;
  }>;
  loadLinkedPersonalSources(workspaceProjectId: string): Promise<
    Array<{
      id: string;
      name: string;
      kind: string;
      status: string;
      personalNoteId: string | null;
      personalNoteRevisionId: string | null;
    }>
  >;
}) => {
  const emptyState: WorkspaceProjectState = {
    project: null,
    memberVersion: null,
    workItems: [],
    sources: [],
    activity: null,
    readOnly: true,
    notice: null
  };
  const states = new Map<string, WorkspaceProjectState>();
  let lastProjectId: string | null = null;
  const current = (projectId: string) => states.get(projectId) ?? emptyState;
  const set = (projectId: string, state: WorkspaceProjectState) => {
    lastProjectId = projectId;
    states.set(projectId, state);
    return state;
  };
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const path = (id: string) =>
    `/v1/workspace-projects/${encodeURIComponent(id)}`;
  return {
    snapshot: (projectId?: string) => current(projectId ?? lastProjectId ?? ""),
    async refresh(projectId: string) {
      try {
        const lifecycle = lifecycleSchema.parse(
          await input.sendTeam(path(projectId) + "/lifecycle")
        );
        if (!lifecycle.active) {
          await input.onAuthoritativeInvalidation(projectId);
          return set(projectId, {
            project: null,
            memberVersion: null,
            workItems: [],
            sources: [],
            activity: null,
            readOnly: true,
            notice: "This shared Project is no longer available."
          });
        }
        const project = projectSchema.parse(
          await input.sendTeam(path(projectId))
        );
        const workItems: z.infer<typeof workspaceProjectWorkItemSchema>[] = [];
        let nextOffset: number | null = 0;
        while (nextOffset !== null) {
          const query = new URLSearchParams({
            offset: String(nextOffset),
            expectedProjectVersion: String(project.version)
          });
          const page = z
            .object({
              items: z.array(workspaceProjectWorkItemSchema),
              nextOffset: z.number().int().nonnegative().nullable(),
              projectVersion: z.number().int().positive()
            })
            .parse(
              await input.sendTeam(
                path(projectId) + "/work-items?" + query.toString()
              )
            );
          if (
            page.projectVersion !== project.version ||
            (page.nextOffset !== null && page.nextOffset <= nextOffset)
          )
            throw Object.assign(
              new Error("Shared Project changed during refresh"),
              { statusCode: 409 }
            );
          workItems.push(...page.items);
          nextOffset = page.nextOffset;
        }
        let sources: WorkspaceProjectSource[] = [];
        let sourceOffset: number | null = 0;
        while (sourceOffset !== null) {
          const query = new URLSearchParams({
            offset: String(sourceOffset),
            expectedProjectVersion: String(project.version)
          });
          const page = z
            .object({
              items: z.array(workspaceProjectSourceSchema),
              nextOffset: z.number().int().nonnegative().nullable(),
              projectVersion: z.number().int().positive()
            })
            .parse(
              await input.sendTeam(
                path(projectId) + "/sources?" + query.toString()
              )
            );
          if (
            page.projectVersion !== project.version ||
            (page.nextOffset !== null && page.nextOffset <= sourceOffset)
          )
            throw Object.assign(
              new Error("Shared Project changed during Source refresh"),
              { statusCode: 409 }
            );
          sources.push(...page.items);
          sourceOffset = page.nextOffset;
        }
        const activity = workspaceProjectActivitySummarySchema.parse(
          await input.sendTeam(path(projectId) + "/activity/summary")
        );
        if (lifecycle.canWrite && sources.length) {
          // Source content and Note revisions remain on the uploader's Personal backend.
          // Only that backend can attest to revision changes after extraction.
          let personalSources: Awaited<
            ReturnType<typeof input.loadLinkedPersonalSources>
          > = [];
          try {
            personalSources = await input.loadLinkedPersonalSources(projectId);
          } catch {
            /* Other members have no local uploader Source records. */
          }
          const ownById = new Map(
            personalSources.map((source) => [source.id, source])
          );
          for (const source of sources) {
            const own = ownById.get(source.sourceProjectSourceId);
            if (
              !own ||
              (own.personalNoteId === source.personalNoteId &&
                own.personalNoteRevisionId === source.personalNoteRevisionId &&
                own.status === source.status)
            )
              continue;
            try {
              const updated = workspaceProjectSourceSchema.parse(
                await input.sendTeam(
                  path(projectId) + `/sources/${encodeURIComponent(source.id)}`,
                  json("PATCH", {
                    expectedVersion: source.version,
                    personalNoteId: own.personalNoteId,
                    personalNoteRevisionId: own.personalNoteRevisionId,
                    status: own.status
                  })
                )
              );
              sources = sources.map((row) =>
                row.id === source.id ? updated : row
              );
            } catch {
              /* A later refresh retries after conflict or reconnection. */
            }
          }
        }
        return set(projectId, {
          project,
          memberVersion: lifecycle.memberVersion,
          workItems,
          sources,
          activity,
          readOnly: !lifecycle.canWrite,
          notice: lifecycle.canWrite
            ? null
            : "You can read this shared Project. Editing requires write access."
        });
      } catch (error) {
        const statusCode =
          error && typeof error === "object" && "statusCode" in error
            ? Number(error.statusCode)
            : null;
        if (statusCode === 401 || statusCode === 403 || statusCode === 404)
          return set(projectId, {
            ...emptyState,
            notice: "You no longer have access to this shared Project."
          });
        if (statusCode === 409)
          return set(projectId, {
            ...current(projectId),
            readOnly: true,
            notice:
              "This shared Project changed while loading. Refresh to see current records."
          });
        return set(projectId, {
          ...current(projectId),
          readOnly: true,
          notice:
            "Team service is unavailable. Shared Project changes are paused."
        });
      }
    },
    async firstShare(
      inputValue: WorkspaceProjectCreate & {
        personalProjectId: string;
        teamBackendId: string;
      }
    ) {
      const value = workspaceProjectCreateSchema.parse({
        teamId: inputValue.teamId,
        workspaceId: inputValue.workspaceId,
        name: inputValue.name,
        key: inputValue.key,
        shareAttemptKey: inputValue.shareAttemptKey
      });
      const personal = await input.loadPersonalCopy(
        inputValue.personalProjectId,
        inputValue.teamBackendId,
        inputValue.shareAttemptKey,
        value.teamId,
        value.workspaceId
      );
      const project = projectSchema.parse(
        await input.sendTeam("/v1/workspace-projects", json("POST", value))
      );
      const copy = workspaceProjectCopySchema.parse({
        expectedVersion: project.version,
        personalProjectVersion: personal.personalProjectVersion,
        workItems: personal.workItems,
        sources: personal.sources,
        decks: personal.decks
      });
      const copied = projectSchema.parse(
        await input.sendTeam(
          path(project.id) + "/first-share-copy",
          json("POST", { ...copy, expectedVersion: project.version })
        )
      );
      if (!copied.copiedAt)
        throw new Error("Team collaboration copy was not confirmed");
      await input.markPersonalMoved(
        inputValue.personalProjectId,
        project.id,
        inputValue.teamBackendId,
        project.workspaceId,
        personal.personalProjectVersion
      );
      set(project.id, { ...current(project.id), project: copied });
      return copied;
    },
    async createWorkItem(
      projectId: string,
      value: WorkspaceProjectWorkItemCreate
    ) {
      const state = current(projectId);
      if (state.readOnly || state.project?.id !== projectId)
        throw new Error("Shared Project is read-only");
      const item = workspaceProjectWorkItemSchema.parse(
        await input.sendTeam(
          path(projectId) + "/work-items",
          json("POST", workspaceProjectWorkItemCreateSchema.parse(value))
        )
      );
      set(projectId, { ...state, workItems: [...state.workItems, item] });
      return item;
    },
    async attachSource(
      workspaceProjectId: string,
      personalProjectId: string,
      sourceId: string
    ) {
      const state = current(workspaceProjectId);
      if (state.readOnly || state.project?.id !== workspaceProjectId)
        throw new Error("Shared Project is read-only");
      const personal = await input.loadPersonalSource(
        personalProjectId,
        sourceId,
        workspaceProjectId
      );
      const value = workspaceProjectSourceCreateSchema.parse({
        sourceProjectSourceId: personal.id,
        name: personal.name,
        kind: personal.kind,
        status: personal.status,
        personalNoteId: personal.personalNoteId,
        personalNoteRevisionId: personal.personalNoteRevisionId
      });
      const source = workspaceProjectSourceSchema.parse(
        await input.sendTeam(
          path(workspaceProjectId) + "/sources",
          json("POST", value)
        )
      );
      set(workspaceProjectId, {
        ...state,
        sources: [...state.sources, source]
      });
      return source;
    },
    async patchSource(
      workspaceProjectId: string,
      sourceId: string,
      value: z.infer<typeof workspaceProjectSourcePatchSchema>
    ) {
      const state = current(workspaceProjectId);
      if (state.readOnly || state.project?.id !== workspaceProjectId)
        throw new Error("Shared Project is read-only");
      const source = workspaceProjectSourceSchema.parse(
        await input.sendTeam(
          path(workspaceProjectId) + `/sources/${encodeURIComponent(sourceId)}`,
          json("PATCH", workspaceProjectSourcePatchSchema.parse(value))
        )
      );
      set(workspaceProjectId, {
        ...state,
        sources: state.sources
          .filter((row) => row.id !== sourceId || !value.deleted)
          .map((row) => (row.id === sourceId ? source : row))
      });
      return source;
    },
    async patchWorkItem(
      projectId: string,
      itemId: string,
      patch: WorkspaceProjectWorkItemPatch
    ) {
      const state = current(projectId);
      if (state.readOnly || state.project?.id !== projectId)
        throw new Error("Shared Project is read-only");
      const item = workspaceProjectWorkItemSchema.parse(
        await input.sendTeam(
          path(projectId) + `/work-items/${encodeURIComponent(itemId)}`,
          json("PATCH", workspaceProjectWorkItemPatchSchema.parse(patch))
        )
      );
      set(projectId, {
        ...state,
        workItems: state.workItems.map((existing) =>
          existing.id === itemId ? item : existing
        )
      });
      return item;
    }
  };
};
