import { z } from "zod";
import {
  acknowledgeRepositoryChange,
  listPendingRepositoryChanges,
  listProjectMetadata,
  discoverProjectMetadata,
  setProjectRepositoryAnchor,
  type KoedServerPaths
} from "@koed-labs/server";
import {
  repositoryChangeSchema,
  personalNamedProjectSchema,
  personalProjectCommandSchema,
  personalMembershipSyncCommandSchema,
  personalMembershipSyncCommandResultSchema,
  personalSourceContextCommandSchema,
  personalSourceContextCommandResultSchema,
  personalProjectCommandResultSchema,
  repositoryReviewCommandSchema,
  repositoryReviewCommandResultSchema,
  repositoryReviewSchema,
  repositoryIdentityMatches,
  personalDesktopProjectsDataSchema,
  personalDesktopProjectMetadataDataSchema
} from "@koed/shared";
import {
  createProjectSelectionCommand,
  createProjectSelectionLookup,
  type ProjectSelectionLookup
} from "./project-selection-command.js";
import { PersonalMemoryBoundaryError } from "./personal-memory-boundary.js";

export type ProjectCommandsDeps = {
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
              expectedRevision: input.expectedRevision
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

  const createPersonalProject = async (input: { name: string }) => {
    await deps.requireAccess();
    const payload = await deps.personalRequest("/v1/personal/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    return {
      projectId: personalNamedProjectSchema.parse(payload.project).projectId
    };
  };
  const manageMembershipSync = async (raw: unknown) => {
    const input = personalMembershipSyncCommandSchema.parse(raw);
    const base = `/v1/personal/projects/${encodeURIComponent(input.projectId)}/sync`;
    const payload =
      input.action === "list"
        ? await deps.personalRequest(
            input.afterEntityId
              ? `${base}?afterEntityId=${encodeURIComponent(input.afterEntityId)}`
              : base
          )
        : input.action === "preview"
          ? await deps.personalRequest(`${base}/reviews`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(input.review)
            })
          : await deps.personalRequest(
              `${base}/reviews/${encodeURIComponent(input.reviewId)}/apply`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ expectedVersion: input.expectedVersion })
              }
            );
    const result = personalMembershipSyncCommandResultSchema.parse(payload);
    if (
      result.state.project.projectId !== input.projectId ||
      (result.preview &&
        result.preview.projectIdentity !== result.state.projectIdentity) ||
      (input.action === "preview" &&
        (!result.preview ||
          result.preview.entityId !== input.review.entityId ||
          result.preview.expectedVersion !== input.review.expectedVersion)) ||
      (input.action === "apply" && result.preview?.reviewId !== input.reviewId)
    )
      throw new Error(
        "Project sync response does not match the reviewed Project."
      );
    return result;
  };
  const manageSourceContext = async (raw: unknown) => {
    const input = personalSourceContextCommandSchema.parse(raw);
    const base = `/v1/personal/sessions/${encodeURIComponent(input.sessionId)}/source-context`;
    const payload =
      input.action === "get"
        ? await deps.personalRequest(base)
        : input.action === "preview"
          ? await deps.personalRequest(`${base}/reviews`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(input.correction)
            })
          : await deps.personalRequest(
              `${base}/reviews/${encodeURIComponent(input.reviewId)}/apply`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ expectedVersion: input.expectedVersion })
              }
            );
    const result = personalSourceContextCommandResultSchema.parse(payload);
    if (
      result.context.sessionId !== input.sessionId ||
      (result.preview &&
        (result.preview.before.sessionId !== input.sessionId ||
          result.preview.after.sessionId !== input.sessionId)) ||
      (input.action === "apply" && result.preview?.reviewId !== input.reviewId)
    )
      throw new Error(
        "Source context response belongs to another Conversation or review."
      );
    return result;
  };
  const managePersonalProject = async (raw: unknown) => {
    const input = personalProjectCommandSchema.parse(raw);
    const { projectId, expectedVersion } = input;
    const base = `/v1/personal/projects/${encodeURIComponent(projectId)}`;
    let path = base;
    let method: "PATCH" | "POST" | "DELETE";
    const body: Record<string, unknown> = { expectedVersion };
    switch (input.action) {
      case "apply_sources":
        method = "POST";
        path = `${base}/sources`;
        body.changes = input.changes;
        break;
      case "explain_session":
        method = "POST";
        path = `${base}/memberships/explain`;
        body.sessionId = input.sessionId;
        break;
      case "exclude_session":
        method = "POST";
        path = `${base}/exclusions`;
        body.sessionId = input.sessionId;
        break;
      case "add_back":
        method = "POST";
        path = `${base}/exclusions/${encodeURIComponent(input.exclusionId)}/restore`;
        body.sessionId = input.sessionId;
        body.expectedExclusionRevisionId = input.expectedExclusionRevisionId;
        break;
      case "rename":
        method = "PATCH";
        body.name = input.name;
        break;
      case "delete":
        method = "DELETE";
        break;
      case "add_session":
        method = "POST";
        path = `${base}/memberships`;
        body.sessionId = input.sessionId;
        break;
      case "remove_inclusion":
        method = "DELETE";
        path = `${base}/memberships/${encodeURIComponent(input.inclusionId)}`;
        break;
      case "preview_folder":
        method = "POST";
        path = `${base}/rules/preview`;
        body.folder = input.folder;
        break;
      case "add_folder":
        method = "POST";
        path = `${base}/rules`;
        body.folder = input.folder;
        break;
      case "preview_repository":
        method = "POST";
        path = `${base}/rules/preview`;
        body.repository = input.repository;
        break;
      case "add_repository":
        method = "POST";
        path = `${base}/rules`;
        body.repository = input.repository;
        break;
      case "remove_rule":
        method = "DELETE";
        path = `${base}/rules/${encodeURIComponent(input.inclusionId)}`;
        break;
      default: {
        const unsupported: never = input;
        throw new Error(
          `Unsupported Project operation: ${String(unsupported)}`
        );
      }
    }
    const payload = await deps.personalRequest(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return personalProjectCommandResultSchema.parse(payload);
  };

  return {
    review: repositoryReviewCommand,
    create: createPersonalProject,
    manage: managePersonalProject,
    manageSourceContext,
    manageMembershipSync,
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
