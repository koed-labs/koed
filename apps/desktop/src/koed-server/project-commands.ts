import { z } from "zod";
import {
  acknowledgeRepositoryChange,
  listPendingRepositoryChanges,
  listProjectMetadata,
  discoverProjectMetadata,
  hintsForConversation,
  createClientWorktreeLookup,
  setProjectRepositoryAnchor,
  type KoedServerPaths
} from "@koed-labs/server";
import {
  repositoryChangeSchema,
  inspectDeviceIdentityAtKoedHome,
  type PersonalSourceCorrectionInput,
  personalNamedProjectSchema,
  personalProjectCommandSchema,
  personalMembershipSyncCommandSchema,
  personalMembershipSyncCommandResultSchema,
  personalSourceContextCommandSchema,
  personalSourceContextCommandResultSchema,
  personalFolderHintConfirmDataSchema,
  personalFolderHintConfirmRequestSchema,
  personalFolderHintEvidenceSchema,
  personalFolderScopeId,
  type PersonalFolderHint,
  type PersonalFolderHintEvidence,
  type PersonalFolderReference,
  personalFolderHintRequestSchema,
  personalFolderHintsDataSchema,
  personalProjectCommandResultSchema,
  repositoryReviewCommandSchema,
  repositoryReviewCommandResultSchema,
  repositoryReviewSchema,
  repositoryIdentityMatches,
  personalDesktopProjectsDataSchema,
  personalDesktopProjectMetadataDataSchema
} from "@koed-labs/shared";
import {
  createProjectSelectionCommand,
  createProjectSelectionLookup,
  type ProjectSelectionLookup
} from "./project-selection-command.js";
import { PersonalMemoryBoundaryError } from "./personal-memory-boundary.js";
import { projectSelectionLookupResponseSchema } from "@koed-labs/shared/project-selection";

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

  const createPersonalProject = async (input: {
    name: string;
    requestId?: string;
  }) => {
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
  const fetchHintEvidence = async (
    sessionIds: string[],
    proposedFolders?: PersonalFolderReference[]
  ) =>
    personalFolderHintEvidenceSchema.parse(
      await deps.personalRequest("/v1/personal/sessions/folder-hint-evidence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionIds, proposedFolders })
      })
    );
  type HintEvidence = PersonalFolderHintEvidence["evidence"][number];
  type InferenceCorrection = Extract<
    PersonalSourceCorrectionInput,
    { axis: "git"; action: "set" }
  >;
  type InferenceEvidence = {
    directory: string;
    directoryIncarnation: string;
    startedAt: string;
  };
  const sourceContextReviews = new Map<
    string,
    {
      sessionId: string;
      expectedVersion: number;
      inference?: {
        correction: InferenceCorrection;
        evidence: InferenceEvidence;
      };
    }
  >();
  const lookupHintAssociation: NonNullable<
    NonNullable<
      Parameters<typeof hintsForConversation>[2]
    >["lookupAssociatedSelection"]
  > = async (checkout, signal) => {
    const result = projectSelectionLookupResponseSchema.parse(
      await deps.personalRequest(
        `/v1/memory/repository-selection?${new URLSearchParams(checkout)}`,
        { signal }
      )
    );
    return result.association?.selection
      ? {
          associationId: result.association.associationId,
          selection: result.association.selection
        }
      : undefined;
  };
  const recordingDeviceProvenance = (
    ownerUserId: string,
    row: HintEvidence
  ) => {
    const provenance = row.recordingDeviceProvenance;
    if (!provenance || provenance === "known-copy") return provenance;
    const original = row.folderAssignment.original;
    if (original.state !== "known")
      return provenance === "unknown" ? provenance : undefined;
    if (original.value.reference.ownerUserId !== ownerUserId) return undefined;
    const device = inspectDeviceIdentityAtKoedHome({
      koedHome: deps.paths.koedHome
    });
    if (!device.remoteOperationsAllowed) return undefined;
    return original.value.reference.originatingDeviceId ===
      device.deviceInstanceId &&
      original.value.reference.originatingDeploymentId === device.deploymentId
      ? provenance === "recording-device"
        ? provenance
        : undefined
      : "known-copy";
  };
  const inferenceEligible = (row: HintEvidence) =>
    row.gitInferenceEligibility === true &&
    row.gitRevision === 1 &&
    row.firstConversationAt !== null &&
    Number.isFinite(Date.parse(row.firstConversationAt));
  const hintConversation = (
    ownerUserId: string,
    row: HintEvidence,
    provenance: ReturnType<typeof recordingDeviceProvenance>
  ) => ({
    allowUnknownRepositoryCandidate:
      provenance === "unknown" && inferenceEligible(row),
    ownerUserId,
    folderAssignment: row.folderAssignment,
    recordedCwd: row.recordedCwd,
    originDeviceId:
      provenance === "recording-device" &&
      row.folderAssignment.original.state === "known"
        ? row.folderAssignment.original.value.reference.originatingDeviceId
        : null,
    ...(row.gitAnchorKnown !== undefined
      ? { gitAnchorKnown: row.gitAnchorKnown }
      : {}),
    sourceRuntime: row.sourceRuntime ?? null,
    externalSessionId: row.externalSessionId ?? null,
    firstConversationAt: row.firstConversationAt,
    recordedRemoteFingerprint: row.recordedRemoteFingerprint,
    recordedMetadataState: row.recordedCwd
      ? ("resolved" as const)
      : ("absent" as const)
  });
  const scoreHintEvidence = (
    ownerUserId: string,
    row: HintEvidence,
    provenance: ReturnType<typeof recordingDeviceProvenance>,
    lookupClientWorktree = createClientWorktreeLookup()
  ) =>
    hintsForConversation(
      deps.paths,
      hintConversation(ownerUserId, row, provenance),
      {
        lookupClientWorktree,
        lookupAssociatedSelection: lookupHintAssociation
      }
    );
  /** Advisory Folder hints. Recorded facts come from the API; the filesystem and
   * registry evidence is read here, on the device that owns them. Read-only. */
  const folderHints = async (raw: unknown) => {
    const input = personalFolderHintRequestSchema.parse(raw);
    const payload = await fetchHintEvidence(input.sessionIds);
    const requested = new Set(input.sessionIds);
    const proposed = new Map<string, PersonalFolderReference>();
    const lookupClientWorktree = createClientWorktreeLookup();
    const hints: PersonalFolderHint[] = [];
    for (const row of payload.evidence) {
      if (!requested.has(row.sessionId)) continue;
      const provenance = recordingDeviceProvenance(payload.ownerUserId, row);
      const results = await scoreHintEvidence(
        payload.ownerUserId,
        row,
        provenance,
        lookupClientWorktree
      );
      // No ready local identity: no Folder can be a candidate on this device.
      if (!results) continue;
      for (const result of results) {
        if (
          result.tier !== "none" &&
          (result.kind === "registered" || result.kind === "worktree-parent")
        )
          proposed.set(personalFolderScopeId(result.folder), result.folder);
        hints.push({
          sessionId: row.sessionId,
          tier: result.tier,
          score: result.score,
          ...(result.tier === "none"
            ? {}
            : result.kind === "create"
              ? { kind: result.kind, directory: result.directory }
              : result.kind === "repository"
                ? {
                    kind: result.kind,
                    repositoryKey: result.repositoryKey,
                    ...(provenance === undefined
                      ? {}
                      : { recordingDeviceProvenance: provenance }),
                    ...(row.gitInferenceEligibility === undefined
                      ? {}
                      : { gitInferenceEligibility: inferenceEligible(row) }),
                    ...(row.gitRevision === undefined
                      ? {}
                      : { gitRevision: row.gitRevision }),
                    ...(result.directory ? { directory: result.directory } : {})
                  }
                : {
                    kind: result.kind,
                    folder: result.folder,
                    ...(result.directory ? { directory: result.directory } : {})
                  }),
          reasons: result.reasons.map(({ code, outcome }) => ({
            code,
            outcome
          }))
        });
      }
    }
    if (!proposed.size) return personalFolderHintsDataSchema.parse({ hints });
    const checked = await fetchHintEvidence(input.sessionIds, [
      ...proposed.values()
    ]);
    const knownFolders = new Set(
      checked.knownFolders?.map(personalFolderScopeId)
    );
    return personalFolderHintsDataSchema.parse({
      hints: hints.filter(
        (hint) =>
          !hint.folder || knownFolders.has(personalFolderScopeId(hint.folder))
      )
    });
  };
  /** Recheck the exact candidate against recorded and local evidence.
   * Correction preview still validates the versioned change. */
  const confirmFolderHint = async (raw: unknown) => {
    const { sessionId, kind, folder } =
      personalFolderHintConfirmRequestSchema.parse(raw);
    const payload = await fetchHintEvidence([sessionId], [folder]);
    const row = payload.evidence.find((item) => item.sessionId === sessionId);
    if (!row) throw new Error("Conversation not found.");
    const reviewed = personalFolderScopeId(folder);
    if (
      !payload.knownFolders?.some(
        (known) => personalFolderScopeId(known) === reviewed
      )
    )
      throw new Error("This Folder suggestion is not recorded on the server.");
    const candidates = await scoreHintEvidence(
      payload.ownerUserId,
      row,
      recordingDeviceProvenance(payload.ownerUserId, row)
    );
    if (
      !candidates?.some(
        (candidate) =>
          candidate.tier !== "none" &&
          candidate.kind === kind &&
          personalFolderScopeId(candidate.folder) === reviewed
      )
    )
      throw new Error(
        "This Folder suggestion no longer matches what you reviewed."
      );
    return personalFolderHintConfirmDataSchema.parse({ folder });
  };
  const staleGitInference = () =>
    new Error("This Git Anchor suggestion no longer matches current evidence.");
  const confirmGitInference = async (
    sessionId: string,
    correction: InferenceCorrection
  ): Promise<InferenceEvidence> => {
    const payload = await fetchHintEvidence([sessionId]);
    const row = payload.evidence.find((item) => item.sessionId === sessionId);
    if (
      !row ||
      !inferenceEligible(row) ||
      !row.firstConversationAt ||
      row.gitRevision !== correction.expectedVersion
    )
      throw staleGitInference();
    const provenance = recordingDeviceProvenance(payload.ownerUserId, row);
    const automatic = correction.inferenceIntent === "recording-device";
    if (
      provenance !== (automatic ? "recording-device" : "unknown") ||
      correction.repository.kind !== "portable_repository"
    )
      throw staleGitInference();
    const candidates = (
      await scoreHintEvidence(payload.ownerUserId, row, provenance)
    )?.filter(
      (candidate) =>
        candidate.tier !== "none" && candidate.kind === "repository"
    );
    const candidate = candidates?.[0];
    if (
      candidates?.length !== 1 ||
      !candidate ||
      candidate.kind !== "repository" ||
      !candidate.directory ||
      !candidate.directoryIncarnation ||
      candidate.repositoryKey !== correction.repository.key ||
      candidate.reasons.some(({ outcome }) => outcome === "rejects") ||
      !candidate.reasons.some(
        ({ code, outcome }) =>
          code === "origin-device" &&
          outcome === (automatic ? "agrees" : "unavailable")
      ) ||
      ![
        "recorded-cwd",
        "local-directory",
        "directory-birthtime",
        "directory-remote"
      ].every((code) =>
        candidate.reasons.some(
          (reason) => reason.code === code && reason.outcome === "agrees"
        )
      )
    )
      throw staleGitInference();
    return {
      directory: candidate.directory,
      directoryIncarnation: candidate.directoryIncarnation,
      startedAt: row.firstConversationAt
    };
  };
  const manageSourceContext = async (raw: unknown) => {
    const input = personalSourceContextCommandSchema.parse(raw);
    const guardedPreview =
      input.action === "preview" &&
      input.correction.axis === "git" &&
      input.correction.action === "set" &&
      input.correction.inferenceIntent
        ? input.correction
        : undefined;
    const freshEvidence = guardedPreview
      ? await confirmGitInference(input.sessionId, guardedPreview)
      : undefined;
    if (
      input.action === "preview" &&
      input.reviewedDirectory !== undefined &&
      input.reviewedDirectory !== freshEvidence?.directory
    )
      throw staleGitInference();
    if (input.action === "apply") {
      const review = sourceContextReviews.get(input.reviewId);
      if (
        review?.sessionId !== input.sessionId ||
        review.expectedVersion !== input.expectedVersion
      )
        throw new Error(
          "This source context review is unavailable. Review the change again."
        );
      if (review.inference) {
        const { correction, evidence } = review.inference;
        const current = await confirmGitInference(input.sessionId, correction);
        if (
          current.directory !== evidence.directory ||
          current.directoryIncarnation !== evidence.directoryIncarnation ||
          current.startedAt !== evidence.startedAt
        )
          throw staleGitInference();
      }
    }
    const base = `/v1/personal/sessions/${encodeURIComponent(input.sessionId)}/source-context`;
    const payload =
      input.action === "organize"
        ? await deps.personalRequest(
            `/v1/personal/sessions/${encodeURIComponent(input.sessionId)}/organization`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(input.edit)
            }
          )
        : input.action === "get"
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
                  body: JSON.stringify({
                    expectedVersion: input.expectedVersion
                  })
                }
              );
    const result = personalSourceContextCommandResultSchema.parse(payload);
    if (
      result.context.sessionId !== input.sessionId ||
      (result.preview &&
        (result.preview.before.sessionId !== input.sessionId ||
          result.preview.after.sessionId !== input.sessionId)) ||
      (input.action === "apply" &&
        result.preview?.reviewId !== input.reviewId) ||
      (input.action === "organize" &&
        (!result.organization ||
          result.organization.before.context.sessionId !== input.sessionId ||
          result.organization.after.context.sessionId !== input.sessionId ||
          JSON.stringify(result.organization.before.context) !==
            JSON.stringify(input.edit.expectedContext) ||
          result.organization.before.projects.length !==
            input.edit.reviewedProjects.length ||
          result.organization.before.projects.some(
            ({ project }) =>
              !input.edit.reviewedProjects.some(
                (reviewed) =>
                  reviewed.projectId === project.projectId &&
                  reviewed.expectedVersion === project.version
              )
          ) ||
          JSON.stringify(result.organization.after.context) !==
            JSON.stringify(result.context)))
    )
      throw new Error(
        "Source context response belongs to another Conversation or review."
      );
    if (guardedPreview) {
      const preview = result.preview;
      if (
        preview?.axis !== "git" ||
        preview.inferenceIntent !== guardedPreview.inferenceIntent ||
        preview.expectedVersion !== guardedPreview.expectedVersion ||
        preview.after.git.correction.state !== "corrected" ||
        preview.after.git.correction.value.state !== "known" ||
        !repositoryIdentityMatches(
          preview.after.git.correction.value.value,
          guardedPreview.repository
        )
      )
        throw staleGitInference();
    }
    if (input.action === "preview" && result.preview) {
      // A missing receipt must not let a persisted inference review bypass the
      // fresh local check, even when Apply has no intent field of its own.
      if (sourceContextReviews.size >= 256) {
        const oldest = sourceContextReviews.keys().next().value;
        if (oldest !== undefined) sourceContextReviews.delete(oldest);
      }
      sourceContextReviews.set(result.preview.reviewId, {
        sessionId: input.sessionId,
        expectedVersion: result.preview.expectedVersion,
        ...(guardedPreview && freshEvidence
          ? {
              inference: { correction: guardedPreview, evidence: freshEvidence }
            }
          : {})
      });
    }
    if (input.action === "apply") sourceContextReviews.delete(input.reviewId);
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
      case "explain_sessions":
        method = "POST";
        path = `${base}/memberships/explain-batch`;
        body.sessionIds = input.sessionIds;
        break;
      case "list_exclusions":
        method = "POST";
        path = `${base}/exclusions/list`;
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
    folderHints,
    confirmFolderHint,
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
