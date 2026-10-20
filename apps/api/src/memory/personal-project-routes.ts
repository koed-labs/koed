import {
  graphThreadIndexResponseSchema,
  graphEventsQuerySchema,
  graphEventDetailQuerySchema
} from "./graph-schemas.js";
import type { PersonalSelectionSnapshot } from "@koed/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  personalIdentifierSchema,
  personalMembershipReviewInputSchema,
  personalMembershipReviewApplySchema,
  personalProjectCreateSchema,
  personalProjectUpdateSchema,
  personalProjectVersionSchema,
  personalProjectRuleInputSchema,
  personalProjectAddBackSchema,
  personalProjectAddSessionSchema
} from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";
import { listSelectedPersonalThreads } from "./personal-selection-inventory.js";

const projectParams = z.object({ projectId: z.uuid() }).strict();
const inclusionParams = projectParams
  .extend({ inclusionId: z.uuid() })
  .strict();

const selectionFor = (
  ownerUserId: string,
  projectId: string
): PersonalSelectionSnapshot => ({
  version: 1,
  ownerUserId,
  target: { kind: "project", project: { ownerUserId, projectId } },
  callerRepositoryContext: null
});
const projectEventQuery = graphEventsQuerySchema.safeExtend({
  sessionId: z.uuid(),
  personalSelection: z.never().optional(),
  projectId: z.never().optional(),
  teamWorkspaceId: z.never().optional()
});
const projectEventDetailQuery = graphEventDetailQuerySchema.safeExtend({
  sessionId: z.uuid(),
  personalSelection: z.never().optional(),
  projectId: z.never().optional(),
  teamWorkspaceId: z.never().optional()
});

/** Session-cookie/Personal-token authority only; membership never grants Team access. */
export const registerPersonalProjectRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticate },
    rateLimit: { memoryRead: read, memoryWrite: write }
  } = context;
  app.get(
    "/v1/personal/projects/:projectId/sync",
    { preHandler: read },
    async (request) => {
      const user = await authenticate(request),
        { projectId } = projectParams.parse(request.params);
      const query = z
        .object({ afterEntityId: personalIdentifierSchema.optional() })
        .strict()
        .parse(request.query);
      return {
        state: await requireRepository().getPersonalMembershipSyncState(
          { userId: user.id },
          projectId,
          query.afterEntityId
        )
      };
    }
  );
  app.post(
    "/v1/personal/projects/:projectId/sync/reviews",
    { preHandler: write },
    async (request) => {
      const user = await authenticate(request),
        { projectId } = projectParams.parse(request.params);
      return requireRepository().previewPersonalMembershipReview(
        { userId: user.id },
        projectId,
        personalMembershipReviewInputSchema.parse(request.body)
      );
    }
  );
  app.post(
    "/v1/personal/projects/:projectId/sync/reviews/:reviewId/apply",
    { preHandler: write },
    async (request) => {
      const user = await authenticate(request),
        { projectId, reviewId } = projectParams
          .extend({ reviewId: z.uuid() })
          .strict()
          .parse(request.params);
      return requireRepository().applyPersonalMembershipReview(
        { userId: user.id },
        projectId,
        reviewId,
        personalMembershipReviewApplySchema.parse(request.body)
      );
    }
  );
  app.post(
    "/v1/personal/projects/:projectId/memberships/explain",
    { preHandler: read },
    async (request) => {
      const user = await authenticate(request),
        { projectId } = projectParams.parse(request.params);
      return requireRepository().explainPersonalProjectSession(
        { userId: user.id },
        projectId,
        personalProjectAddSessionSchema.parse(request.body)
      );
    }
  );
  app.post(
    "/v1/personal/projects/:projectId/exclusions",
    { preHandler: write },
    async (request) => {
      const user = await authenticate(request),
        { projectId } = projectParams.parse(request.params);
      return requireRepository().excludePersonalProjectSession(
        { userId: user.id },
        projectId,
        personalProjectAddSessionSchema.parse(request.body)
      );
    }
  );
  app.post(
    "/v1/personal/projects/:projectId/exclusions/:exclusionId/restore",
    { preHandler: write },
    async (request) => {
      const user = await authenticate(request),
        { projectId, exclusionId } = projectParams
          .extend({ exclusionId: z.uuid() })
          .strict()
          .parse(request.params);
      const input = personalProjectAddBackSchema
        .omit({ exclusionId: true })
        .parse(request.body);
      return requireRepository().restorePersonalProjectSession(
        { userId: user.id },
        projectId,
        { ...input, exclusionId }
      );
    }
  );
  app.get("/v1/personal/projects", { preHandler: read }, async (request) => {
    const user = await authenticate(request);
    return {
      projects: await requireRepository().listNamedPersonalProjects({
        userId: user.id
      })
    };
  });
  app.get(
    "/v1/personal/projects/:projectId/rules",
    { preHandler: read },
    async (request, reply) => {
      const user = await authenticate(request),
        { projectId } = projectParams.parse(request.params),
        actor = { userId: user.id },
        repo = requireRepository();
      const project = (await repo.listNamedPersonalProjects(actor)).find(
        (row) => row.projectId === projectId
      );
      if (!project)
        return reply.code(404).send({ error: "Personal Project not found" });
      return {
        project,
        rules: await repo.listPersonalProjectRules(actor, projectId)
      };
    }
  );
  app.post(
    "/v1/personal/projects/:projectId/rules/preview",
    { preHandler: read },
    async (request, reply) => {
      const user = await authenticate(request),
        { projectId } = projectParams.parse(request.params),
        input = personalProjectRuleInputSchema.parse(request.body),
        actor = { userId: user.id },
        repo = requireRepository();
      const project = (await repo.listNamedPersonalProjects(actor)).find(
        (row) => row.projectId === projectId
      );
      if (!project)
        return reply.code(404).send({ error: "Personal Project not found" });
      if (project.version !== input.expectedVersion)
        return reply
          .code(409)
          .send({ error: "Project changed. Reload it before saving." });
      const target =
        "repository" in input
          ? { kind: "repository" as const, repository: input.repository }
          : { kind: "folder" as const, folder: input.folder };
      const folderContext =
        target.kind === "folder"
          ? await repo.getPersonalProjectFolderRuleContext(
              actor,
              projectId,
              target.folder
            )
          : undefined;
      if (target.kind === "folder" && !folderContext)
        return reply.code(404).send({
          error:
            "Folder context is unavailable. Capture from the Folder before including it."
        });
      const threads = await listSelectedPersonalThreads(
        repo,
        actor,
        {
          version: 1,
          ownerUserId: user.id,
          target,
          callerRepositoryContext: null
        },
        target.kind === "repository" ? "Git Anchor" : "Folder"
      );
      const conversations = new Map<
        string,
        { logicalSessionId: string; sessionId: string; name: string }
      >();
      for (const thread of threads) {
        const ref = thread.sourceReferences?.find(
          (ref) => ref.sessionId === thread.sessionId
        );
        if (!ref) throw new Error("Conversation source binding is unavailable");
        conversations.set(ref.logicalSessionId, {
          logicalSessionId: ref.logicalSessionId,
          sessionId: ref.sessionId,
          name: thread.name.trim().slice(0, 160) || "Conversation"
        });
      }
      return {
        project,
        preview: {
          target,
          ...(folderContext ? { folderContext } : {}),
          conversations: [...conversations.values()]
        }
      };
    }
  );
  app.post(
    "/v1/personal/projects/:projectId/rules",
    { preHandler: write },
    async (request) => {
      const user = await authenticate(request),
        { projectId } = projectParams.parse(request.params),
        input = personalProjectRuleInputSchema.parse(request.body);
      return "repository" in input
        ? requireRepository().addPersonalProjectRepositoryRule(
            { userId: user.id },
            projectId,
            input
          )
        : requireRepository().addPersonalProjectFolderRule(
            { userId: user.id },
            projectId,
            input
          );
    }
  );
  app.delete(
    "/v1/personal/projects/:projectId/rules/:inclusionId",
    { preHandler: write },
    async (request) => {
      const user = await authenticate(request),
        params = inclusionParams.parse(request.params),
        input = personalProjectVersionSchema.parse(request.body);
      return requireRepository().removePersonalProjectRule(
        { userId: user.id },
        params.projectId,
        params.inclusionId,
        input
      );
    }
  );
  app.get(
    "/v1/personal/projects/inventory",
    { preHandler: read },
    async (request) => {
      const user = await authenticate(request),
        actor = { userId: user.id },
        repo = requireRepository();
      const catalog = await repo.listNamedPersonalProjects(actor);
      const projects = [];
      for (const project of catalog) {
        const personalSelection = selectionFor(user.id, project.projectId);
        const rules = await repo.listPersonalProjectRules(
          actor,
          project.projectId
        );
        const capturedThreads = await listSelectedPersonalThreads(
          repo,
          actor,
          personalSelection,
          "Project"
        );
        const reasonRows = await repo.listPersonalProjectMembershipReasons(
          actor,
          project.projectId,
          capturedThreads.flatMap((thread) =>
            thread.sessionId ? [thread.sessionId] : []
          )
        );
        const reasons = new Map(
          reasonRows.map((row) => [row.sessionId, row.reasons])
        );
        const threads = capturedThreads.filter(
          (thread) => thread.sessionId && reasons.get(thread.sessionId)?.length
        );
        const presentations = new Map(
          (
            await repo.listConversationPresentationStates(
              actor,
              threads.flatMap((thread) =>
                thread.sessionId ? [thread.sessionId] : []
              )
            )
          ).map((row) => [row.sessionId, row])
        );
        const logicalBySession = new Map(
          threads
            .flatMap((thread) => thread.sourceReferences ?? [])
            .map((ref) => [ref.sessionId, ref.logicalSessionId])
        );
        const logicalByProvider = new Map<string, string[]>();
        for (const thread of threads) {
          const logical = thread.sessionId
            ? logicalBySession.get(thread.sessionId)
            : undefined;
          if (logical)
            logicalByProvider.set(thread.id, [
              ...(logicalByProvider.get(thread.id) ?? []),
              logical
            ]);
        }
        const projected = threads.map((thread) => {
          const ref = thread.sourceReferences?.find(
            (ref) => ref.sessionId === thread.sessionId
          );
          if (!ref)
            throw new Error(
              "Project Conversation source binding is unavailable"
            );
          const presentation = thread.sessionId
            ? presentations.get(thread.sessionId)
            : null;
          const parentFromSession = thread.parentSessionId
            ? logicalBySession.get(thread.parentSessionId)
            : undefined;
          const providerParents = thread.parentThreadId
            ? logicalByProvider.get(thread.parentThreadId)
            : undefined;
          const parentThreadId =
            parentFromSession ??
            (providerParents?.length === 1
              ? providerParents[0]!
              : thread.parentThreadId);
          return {
            ...thread,
            id: ref.logicalSessionId,
            sourceThreadId: thread.id,
            parentThreadId,
            namedProjectId: project.projectId,
            sourceProject: {
              id: thread.projectId,
              name: thread.projectName,
              path: thread.projectPath
            },
            projectId: project.projectId,
            projectName: project.name,
            projectPath: null,
            membershipReasons: thread.sessionId
              ? (reasons.get(thread.sessionId) ?? [])
              : [],
            presentation: presentation
              ? {
                  pinnedAt: presentation.pinnedAt,
                  displayMode: presentation.displayMode,
                  snoozedAt: presentation.snoozedAt,
                  snoozedUntil: presentation.snoozedUntil,
                  version: presentation.version,
                  updatedAt: presentation.updatedAt
                }
              : null
          };
        });
        projects.push({
          id: project.projectId,
          name: project.name,
          namedProject: project,
          inclusionRules: rules,
          directInclusions: await repo.listPersonalProjectMemberships(
            actor,
            project.projectId
          ),
          path: null,
          eventCount: projected.reduce(
            (sum, thread) => sum + thread.eventCount,
            0
          ),
          threads: projected
        });
      }
      return graphThreadIndexResponseSchema.parse({ projects });
    }
  );
  app.get(
    "/v1/personal/projects/:projectId/events",
    { preHandler: read },
    async (request) => {
      const user = await authenticate(request),
        params = projectParams.parse(request.params),
        query = projectEventQuery.parse(request.query);
      return {
        events: await requireRepository().listLcmGraphEvents(
          { userId: user.id },
          {
            ...query,
            personalSelection: selectionFor(user.id, params.projectId)
          }
        )
      };
    }
  );
  app.get(
    "/v1/personal/projects/:projectId/events/:eventId",
    { preHandler: read },
    async (request, reply) => {
      const user = await authenticate(request),
        params = projectParams
          .extend({ eventId: z.uuid() })
          .parse(request.params),
        query = projectEventDetailQuery.parse(request.query);
      const event = await requireRepository().getLcmGraphEvent(
        { userId: user.id },
        params.eventId,
        { ...query, personalSelection: selectionFor(user.id, params.projectId) }
      );
      return event
        ? { event }
        : reply
            .status(404)
            .send({ error: "Conversation event not found in this Project" });
    }
  );
  app.post(
    "/v1/personal/projects",
    { preHandler: write },
    async (request, reply) => {
      const user = await authenticate(request),
        input = personalProjectCreateSchema.parse(request.body);
      const project = await requireRepository().createNamedPersonalProject(
        { userId: user.id },
        input
      );
      return reply.status(201).send({ project });
    }
  );
  app.patch(
    "/v1/personal/projects/:projectId",
    { preHandler: write },
    async (request) => {
      const user = await authenticate(request),
        params = projectParams.parse(request.params),
        input = personalProjectUpdateSchema.parse(request.body);
      return {
        project: await requireRepository().updateNamedPersonalProject(
          { userId: user.id },
          params.projectId,
          input
        )
      };
    }
  );
  app.delete(
    "/v1/personal/projects/:projectId",
    { preHandler: write },
    async (request) => {
      const user = await authenticate(request),
        params = projectParams.parse(request.params),
        input = personalProjectVersionSchema.parse(request.body);
      return {
        project: await requireRepository().deleteNamedPersonalProject(
          { userId: user.id },
          params.projectId,
          input
        )
      };
    }
  );
  app.get(
    "/v1/personal/projects/:projectId/memberships",
    { preHandler: read },
    async (request, reply) => {
      const user = await authenticate(request),
        params = projectParams.parse(request.params),
        actor = { userId: user.id };
      const repo = requireRepository();
      const project = (await repo.listNamedPersonalProjects(actor)).find(
        (row) => row.projectId === params.projectId
      );
      if (!project)
        return reply.status(404).send({ error: "Personal Project not found" });
      return {
        project,
        memberships: await repo.listPersonalProjectMemberships(
          actor,
          params.projectId
        )
      };
    }
  );
  app.post(
    "/v1/personal/projects/:projectId/memberships",
    { preHandler: write },
    async (request) => {
      const user = await authenticate(request),
        params = projectParams.parse(request.params),
        input = personalProjectAddSessionSchema.parse(request.body);
      return requireRepository().addPersonalProjectSession(
        { userId: user.id },
        params.projectId,
        input
      );
    }
  );
  app.delete(
    "/v1/personal/projects/:projectId/memberships/:inclusionId",
    { preHandler: write },
    async (request) => {
      const user = await authenticate(request),
        params = inclusionParams.parse(request.params),
        input = personalProjectVersionSchema.parse(request.body);
      return requireRepository().removePersonalProjectInclusion(
        { userId: user.id },
        params.projectId,
        params.inclusionId,
        input
      );
    }
  );
};
