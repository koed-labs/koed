import {
  personalDesktopSessionProjectDataSchema,
  personalDesktopSessionProjectInputSchema,
  type PersonalDesktopSessionProjectInput
} from "@koed/shared/personal-desktop";
import { projectListSchema } from "@koed/shared/project-contract";
import { z } from "zod";
import type { ProjectsAuthority } from "./projects-client.js";

const responseSchema = z
  .object({
    session: z
      .object({
        id: z.uuid(),
        project: z
          .object({ id: z.string().trim().min(1).max(512) })
          .passthrough()
          .nullable(),
        projectOverride: z
          .object({ id: z.string().trim().min(1).max(512) })
          .passthrough()
          .nullable(),
        projectOverridePersonalProjectId: z.uuid().nullable(),
        automaticPersonalProjectId: z.uuid().nullable()
      })
      .passthrough(),
    pending: z.boolean().optional(),
    batchId: z.uuid().optional(),
    moveBatchId: z.uuid().optional(),
    pendingReviews: z
      .array(
        z.object({ bindingId: z.uuid(), actionGrantId: z.uuid() }).strict()
      )
      .max(1000)
      .optional()
  })
  .passthrough();

/** Resolve first-class Projects under one owner profile; dispatch placement once. */
export const createChatMovePlacementClient = (input: {
  authority: () => Promise<ProjectsAuthority>;
  requestJson: (
    path: string,
    init: RequestInit,
    authority: ProjectsAuthority
  ) => Promise<Record<string, unknown>>;
}) => {
  const sameAuthority = (a: ProjectsAuthority, b: ProjectsAuthority) =>
    a.key === b.key && a.ownerId === b.ownerId;

  return {
    async assign(raw: PersonalDesktopSessionProjectInput) {
      const request = personalDesktopSessionProjectInputSchema.parse(raw);
      if (request.expectedProjectId === undefined)
        throw new Error(
          "Conversation move requires expected Project placement."
        );
      const bound = await input.authority();
      const assertAuthority = async () => {
        if (!sameAuthority(bound, await input.authority()))
          throw new Error("Conversation move owner profile changed.");
      };
      if (!bound.canWrite)
        throw new Error("Conversation move write authority is unavailable.");

      let body: Record<string, unknown>;
      if (request.action === "move") {
        if (!z.uuid().safeParse(request.targetProjectId).success)
          throw new Error(
            "Conversation move target must be a first-class Project ID."
          );
        const seenCursors = new Set<string>();
        const seenProjects = new Set<string>();
        let cursor: string | null = null;
        let target:
          | z.infer<typeof projectListSchema>["projects"][number]
          | undefined;
        do {
          await assertAuthority();
          const query = new URLSearchParams({ limit: "100" });
          if (cursor) query.set("cursor", cursor);
          const page = projectListSchema.parse(
            await input.requestJson(
              `/v1/projects?${query}`,
              { method: "GET" },
              bound
            )
          );
          await assertAuthority();
          for (const project of page.projects) {
            if (seenProjects.has(project.id))
              throw new Error("Duplicate Project in move destination list.");
            seenProjects.add(project.id);
            if (project.id === request.targetProjectId) target = project;
          }
          cursor = page.nextCursor;
          if (cursor && seenCursors.has(cursor))
            throw new Error("Repeated Project move destination cursor.");
          if (cursor) seenCursors.add(cursor);
        } while (cursor);
        if (!target || target.lifecycle !== "active")
          throw new Error("Conversation move destination is unavailable.");
        body = {
          action: "move",
          expectedProjectId: request.expectedProjectId,
          project: {
            id: target.id,
            name: target.name,
            path: target.folderPath
          }
        };
      } else if (request.action === "undo_move") {
        body = {
          action: "undo_move",
          batchId: request.batchId,
          expectedProjectId: request.expectedProjectId
        };
      } else {
        body = {
          action: request.action,
          expectedProjectId: request.expectedProjectId
        };
      }

      await assertAuthority();
      const payload = await input.requestJson(
        `/v1/memory/graph/sessions/${encodeURIComponent(request.sessionId)}/project`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        },
        bound
      );
      await assertAuthority();
      const response = responseSchema.parse(payload);
      if (response.session.id !== request.sessionId)
        throw new Error("Conversation move response session changed.");
      const projectId = response.session.projectOverride
        ? response.session.projectOverridePersonalProjectId
        : response.session.automaticPersonalProjectId;
      if (response.pending) {
        if (
          !response.batchId ||
          projectId !== request.expectedProjectId ||
          (request.action !== "move" && request.action !== "loose")
        )
          throw new Error("Conversation move pending placement changed.");
      } else if (
        (request.action === "move" && projectId !== request.targetProjectId) ||
        (request.action === "loose" && projectId !== null)
      ) {
        throw new Error("Conversation move final placement changed.");
      }
      return personalDesktopSessionProjectDataSchema.parse({
        projectId,
        ...(response.pending !== undefined
          ? { pending: response.pending }
          : {}),
        ...(response.batchId ? { batchId: response.batchId } : {}),
        ...(response.moveBatchId ? { moveBatchId: response.moveBatchId } : {}),
        ...(response.pendingReviews
          ? { pendingReviews: response.pendingReviews }
          : {})
      });
    }
  };
};
