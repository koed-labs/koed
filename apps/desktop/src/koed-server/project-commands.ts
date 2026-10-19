import { z } from "zod";
import {
  acknowledgeRepositoryChange,
  listPendingRepositoryChanges,
  listProjectMetadata,
  discoverProjectMetadata,
  listNamedProjects,
  createNamedProject,
  setProjectRepositoryAnchor,
  type KoedServerPaths
} from "@koed-labs/server";
import {
  repositoryChangeSchema,
  repositoryReviewCommandSchema,
  repositoryReviewCommandResultSchema,
  repositoryReviewSchema,
  repositoryIdentityMatches,
  repositoryScopeId,
  repositoryAssignmentSchema,
  personalDesktopProjectMoveDataSchema,
  personalDesktopSessionProjectDataSchema,
  personalDesktopProjectsDataSchema,
  personalDesktopProjectMetadataDataSchema,
  type PersonalDesktopRequest
} from "@koed/shared";
import {
  createProjectSelectionCommand,
  createProjectSelectionLookup,
  type ProjectSelectionLookup
} from "./project-selection-command.js";
import { PersonalMemoryBoundaryError } from "./personal-memory-boundary.js";

type ProjectCommandsDeps = {
  paths: KoedServerPaths;
  personalRequest(
    path: string,
    init?: RequestInit
  ): Promise<Record<string, unknown>>;
  governanceRequest(
    path: string,
    init?: RequestInit
  ): Promise<Record<string, unknown>>;
  lookup: ProjectSelectionLookup;
  status(): Promise<Record<string, unknown>>;
  listProjects(): Promise<z.infer<typeof personalDesktopProjectsDataSchema>>;
  localProjects(): z.infer<
    typeof personalDesktopProjectMetadataDataSchema
  >["projects"];
  requireAccess(): Promise<unknown>;
};
const anchorInput = z
  .object({
    localProjectId: z.string().regex(/^lp_[0-9a-f]{32}$/),
    expectedCheckoutId: z.string().startsWith("checkout_"),
    remoteName: z.string().nullable()
  })
  .strict();

export const createProjectCommands = (deps: ProjectCommandsDeps) => {
  const lookupAssociatedSelection = createProjectSelectionLookup(deps.lookup);
  const publishRepositoryChanges = async () => {
    const paths = deps.paths;
    for (const event of listPendingRepositoryChanges(paths)) {
      const response = await deps.personalRequest(
        "/v1/memory/repository-changes",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event)
        }
      );
      repositoryChangeSchema.parse(response.event);
      acknowledgeRepositoryChange(paths, event.id);
    }
  };
  const repositoryReviewCommand = async (raw: unknown) => {
    const input = repositoryReviewCommandSchema.parse(raw);
    const paths = deps.paths;
    const local = (listProjectMetadata(paths).projects ?? []).find(
      (project) => project.localProjectId === input.localProjectId
    );
    if (!local)
      throw new Error(
        "Local Project is unavailable. Inspect the checkout again."
      );
    const discovery = await discoverProjectMetadata(
      paths,
      {
        cwd: local.path.projectRoot ?? local.path.cwd
      },
      {
        lookupAssociatedSelection: lookupAssociatedSelection
      }
    );
    const repository = discovery.project?.repository;
    if (!repository?.checkoutId)
      throw new Error(
        "Checkout provenance is unavailable. Nothing was reassigned."
      );
    await publishRepositoryChanges();
    if (input.operation === "list")
      return repositoryReviewCommandResultSchema.parse(
        await deps.personalRequest(
          `/v1/memory/repository-changes?checkoutId=${encodeURIComponent(repository.checkoutId)}`
        )
      );
    if (input.operation === "preview") {
      const events = await deps.personalRequest(
        `/v1/memory/repository-changes?checkoutId=${encodeURIComponent(repository.checkoutId)}`
      );
      const pending = repositoryReviewCommandResultSchema
        .parse(events)
        .events?.find(
          (event) =>
            event.id === input.eventId &&
            event.originatingDeviceId === repository.originatingDeviceId
        );
      if (!pending)
        throw new Error(
          "Repository change is stale. Inspect the current change again."
        );
      return repositoryReviewCommandResultSchema.parse(
        await deps.personalRequest(
          `/v1/memory/repository-changes/${input.eventId}/reviews`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input.options)
          }
        )
      );
    }
    const retained = await deps.personalRequest(
      `/v1/memory/repository-reviews/${input.reviewId}`
    );
    const review = repositoryReviewSchema.parse(retained.review);
    const event = review.event;
    if (
      event.checkoutId !== repository.checkoutId ||
      event.originatingDeviceId !== repository.originatingDeviceId ||
      !(
        repositoryIdentityMatches(event.targetIdentity, repository) ||
        (event.targetIdentity.kind === "unresolved" &&
          repository.kind === "unresolved" &&
          event.targetIdentity.reason === repository.reason)
      )
    )
      throw new Error(
        "The checkout or selected anchor changed. Nothing was reassigned. Inspect it again."
      );
    try {
      return repositoryReviewCommandResultSchema.parse(
        await deps.personalRequest(
          `/v1/memory/repository-reviews/${input.reviewId}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: input.operation,
              expectedRevision: input.expectedRevision,
              ...(input.operation === "apply"
                ? { sessionIds: input.sessionIds }
                : {})
            })
          }
        )
      );
    } catch (error) {
      if (
        error instanceof PersonalMemoryBoundaryError &&
        error.code === "conflict"
      )
        throw new Error(
          "The review or a session changed. Nothing was reassigned. Inspect the current change again.",
          { cause: error }
        );
      throw error;
    }
  };

  const resolvePersonalProjectTarget = async (targetProjectId: string) => {
    const named = listNamedProjects(deps.paths).find(
      (project) => repositoryScopeId(project.repository) === targetProjectId
    );
    if (named)
      return {
        id: targetProjectId,
        name: named.name,
        path: null,
        repositoryIdentity: named.repository
      };
    const graphProjects = (await deps.listProjects()).projects;
    const local = deps
      .localProjects()
      .find(
        (project) =>
          project.localProjectId === targetProjectId ||
          (project.repository &&
            project.repository.kind !== "unresolved" &&
            repositoryScopeId(project.repository) === targetProjectId)
      );
    const graph = graphProjects.find(
      (project) => project.id === targetProjectId
    );
    const repositoryIdentity =
      local?.repository ??
      graph?.threads.find((thread) => thread.repositoryAssignment?.effective)
        ?.repositoryAssignment?.effective;
    if (
      targetProjectId === "unassigned" ||
      !repositoryIdentity ||
      repositoryIdentity.kind === "unresolved" ||
      (!local && !graph)
    )
      throw new PersonalMemoryBoundaryError("not_found", false);
    return {
      id: targetProjectId,
      name: local?.displayName ?? graph!.name,
      path: local ? (local.path.projectRoot ?? local.path.cwd) : graph!.path,
      repositoryIdentity
    };
  };

  const createPersonalProject = async (input: { name: string }) => {
    await deps.requireAccess();
    const project = createNamedProject(deps.paths, input.name);
    return { projectId: repositoryScopeId(project.repository) };
  };

  const movePersonalProject = async (input: {
    sourceProjectId: string;
    targetProjectId: string;
  }) => {
    const project = await resolvePersonalProjectTarget(input.targetProjectId);
    const result = await deps.personalRequest(
      "/v1/memory/graph/projects/move",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceProjectId: input.sourceProjectId,
          project
        })
      }
    );
    return personalDesktopProjectMoveDataSchema.parse({
      projectId: result.projectId,
      movedCount: result.movedCount
    });
  };

  const assignPersonalSessionProject = async (
    input: Extract<
      PersonalDesktopRequest,
      { operation: "personal.sessions.assign_project" }
    >["input"]
  ) => {
    const target =
      input.action === "move"
        ? await resolvePersonalProjectTarget(input.targetProjectId)
        : null;
    const payload = await deps.personalRequest(
      `/v1/memory/graph/sessions/${encodeURIComponent(input.sessionId)}/project`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          input.action === "reset"
            ? { action: "reset", expectedVersion: input.expectedVersion }
            : {
                action: "move",
                expectedVersion: input.expectedVersion,
                project: target
              }
        )
      }
    );
    const session = z.record(z.string(), z.unknown()).parse(payload.session);
    const assignment = repositoryAssignmentSchema.parse(
      session.repositoryAssignment
    );
    return personalDesktopSessionProjectDataSchema.parse({
      projectId:
        assignment.effective && assignment.effective.kind !== "unresolved"
          ? repositoryScopeId(assignment.effective)
          : null
    });
  };

  return {
    review: repositoryReviewCommand,
    create: createPersonalProject,
    move: movePersonalProject,
    assign: assignPersonalSessionProject,
    lookupAssociatedSelection,
    selection: createProjectSelectionCommand({
      paths: deps.paths,
      request: deps.governanceRequest,
      lookup: deps.lookup,
      status: deps.status
    }),
    setAnchor: (raw: unknown) =>
      setProjectRepositoryAnchor(deps.paths, anchorInput.parse(raw), {
        lookupAssociatedSelection
      })
  };
};
