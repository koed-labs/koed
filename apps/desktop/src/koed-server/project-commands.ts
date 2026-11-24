import { createHash } from "node:crypto";
import { z } from "zod";
import {
  acknowledgeRepositoryChange,
  listPendingRepositoryChanges,
  listProjectMetadata,
  discoverProjectMetadata,
  hintsForConversation,
  createClientWorktreeLookup,
  setProjectRepositoryAnchor,
  type KoedServerPaths,
  type FolderHintCandidate
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
    init?: RequestInit,
    expectedScopeKey?: string,
    options?: { retry?: boolean }
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
    proposedFolders?: PersonalFolderReference[],
    expectedScopeKey?: string
  ) =>
    personalFolderHintEvidenceSchema.parse(
      await deps.personalRequest(
        "/v1/personal/sessions/folder-hint-evidence",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionIds, proposedFolders })
        },
        expectedScopeKey
      )
    );
  type HintEvidence = PersonalFolderHintEvidence["evidence"][number];
  type InferenceCorrection = Extract<
    PersonalSourceCorrectionInput,
    { axis: "git"; action: "set" }
  >;
  type InferenceEvidence = {
    directory: string;
    directoryIncarnation: string;
    gitCheckoutIncarnation: string;
    startedAt: string;
    ownerUserId: string;
    importAuthority?: HintEvidence["importAuthority"];
  };
  const sourceContextReviews = new Map<
    string,
    {
      sessionId: string;
      expectedVersion: number;
      expectedScopeKey?: string;
      inference?: {
        correction: InferenceCorrection;
        evidence: InferenceEvidence;
        manual: boolean;
      };
    }
  >();
  const lookupHintAssociation =
    (
      expectedScopeKey?: string
    ): NonNullable<
      NonNullable<
        Parameters<typeof hintsForConversation>[2]
      >["lookupAssociatedSelection"]
    > =>
    async (checkout, signal) => {
      const result = projectSelectionLookupResponseSchema.parse(
        await deps.personalRequest(
          `/v1/memory/repository-selection?${new URLSearchParams(checkout)}`,
          { signal },
          expectedScopeKey
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
    const reference =
      original.state === "known" ? original.value.reference : null;
    if (!reference && provenance !== "assumed-local-import")
      return provenance === "unknown" ? provenance : undefined;
    if (reference && reference.ownerUserId !== ownerUserId) return undefined;
    const device = inspectDeviceIdentityAtKoedHome({
      koedHome: deps.paths.koedHome
    });
    if (!device.remoteOperationsAllowed) return undefined;
    if (
      reference &&
      (reference.originatingDeviceId !== device.deviceInstanceId ||
        reference.originatingDeploymentId !== device.deploymentId)
    )
      return "known-copy";
    if (provenance === "assumed-local-import") {
      const authority = row.importAuthority;
      return authority &&
        authority.deviceId === device.deviceInstanceId &&
        authority.deploymentId === device.deploymentId
        ? provenance
        : "unknown";
    }
    return provenance === "recording-device" ? provenance : undefined;
  };
  const inferenceEligible = (row: HintEvidence) =>
    row.gitInferenceEligibility === true &&
    row.gitRevision === 1 &&
    row.firstConversationAt !== null &&
    Number.isFinite(Date.parse(row.firstConversationAt));
  const manualGitIntent = (
    row: HintEvidence,
    provenance: ReturnType<typeof recordingDeviceProvenance>
  ):
    | NonNullable<PersonalFolderHint["manualGitReview"]>["intent"]
    | undefined => {
    if (
      !inferenceEligible(row) ||
      (provenance !== "unknown" && provenance !== "assumed-local-import")
    )
      return undefined;
    if (row.gitUnknownReviewEligible === true) return "user-confirmed-unknown";
    if (provenance === "assumed-local-import") return provenance;
  };
  const inferenceCheckout = (
    candidate: Extract<FolderHintCandidate, { kind: "repository" }>,
    manual = false
  ) => {
    const { directory, directoryIncarnation } = candidate;
    const gitCheckoutIncarnation =
      candidate.gitCheckoutIncarnation ??
      (manual ? candidate.manualGitCheckoutIncarnation : undefined);
    if (
      !directory ||
      !directoryIncarnation ||
      !gitCheckoutIncarnation ||
      (!manual &&
        !candidate.reasons.some(
          ({ code, outcome }) =>
            code === "git-directory-birthtime" && outcome === "agrees"
        ))
    )
      return undefined;
    return { directory, directoryIncarnation, gitCheckoutIncarnation };
  };
  const checkoutIncarnation = (
    checkout: NonNullable<ReturnType<typeof inferenceCheckout>>
  ) =>
    createHash("sha256")
      .update(
        JSON.stringify([
          checkout.directoryIncarnation,
          checkout.gitCheckoutIncarnation
        ])
      )
      .digest("hex");
  const manualGitHintFields = (
    row: HintEvidence,
    provenance: ReturnType<typeof recordingDeviceProvenance>,
    candidate: Extract<FolderHintCandidate, { kind: "repository" }>
  ) => {
    const intent = manualGitIntent(row, provenance);
    const checkout = inferenceCheckout(candidate, true);
    return intent && checkout
      ? {
          manualGitReview: {
            intent,
            incarnation: checkoutIncarnation(checkout)
          }
        }
      : {};
  };
  const hintConversation = (
    ownerUserId: string,
    row: HintEvidence,
    provenance: ReturnType<typeof recordingDeviceProvenance>
  ) => ({
    allowUnknownRepositoryCandidate:
      (provenance === "unknown" || provenance === "assumed-local-import") &&
      inferenceEligible(row),
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
    lookupClientWorktree = createClientWorktreeLookup(),
    expectedScopeKey?: string
  ) =>
    hintsForConversation(
      deps.paths,
      hintConversation(ownerUserId, row, provenance),
      {
        lookupClientWorktree,
        lookupAssociatedSelection: lookupHintAssociation(expectedScopeKey)
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
                      : {
                          gitInferenceEligibility:
                            inferenceEligible(row) &&
                            !!inferenceCheckout(result)
                        }),
                    ...manualGitHintFields(row, provenance, result),
                    ...(row.gitRevision === undefined
                      ? {}
                      : { gitRevision: row.gitRevision }),
                    ...(result.directory ? { directory: result.directory } : {})
                  }
                : {
                    kind: result.kind,
                    folder: result.folder,
                    folderRevision: row.folderAssignment.revision,
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
    correction: InferenceCorrection,
    manual: boolean,
    expectedScopeKey?: string
  ): Promise<InferenceEvidence> => {
    const payload = await fetchHintEvidence(
      [sessionId],
      undefined,
      expectedScopeKey
    );
    const row = payload.evidence.find((item) => item.sessionId === sessionId);
    if (
      !row ||
      !inferenceEligible(row) ||
      !row.firstConversationAt ||
      row.gitRevision !== correction.expectedVersion
    )
      throw staleGitInference();
    const provenance = recordingDeviceProvenance(payload.ownerUserId, row);
    const recordingDevice = correction.inferenceIntent === "recording-device";
    const intent = manual ? manualGitIntent(row, provenance) : provenance;
    const matchesIntent = intent === correction.inferenceIntent;
    const importAuthority =
      correction.inferenceIntent === "assumed-local-import"
        ? row.importAuthority
        : undefined;
    if (
      !matchesIntent ||
      correction.repository.kind !== "portable_repository" ||
      (correction.inferenceIntent === "assumed-local-import" &&
        (!importAuthority ||
          Date.parse(importAuthority.startedAt) !==
            Date.parse(row.firstConversationAt)))
    )
      throw staleGitInference();
    const candidates = (
      await scoreHintEvidence(
        payload.ownerUserId,
        row,
        provenance,
        undefined,
        expectedScopeKey
      )
    )?.filter(
      (candidate) =>
        candidate.tier !== "none" && candidate.kind === "repository"
    );
    const candidate = candidates?.[0];
    const checkout =
      candidate?.kind === "repository" && inferenceCheckout(candidate, manual);
    if (
      candidates?.length !== 1 ||
      !candidate ||
      candidate.kind !== "repository" ||
      !checkout ||
      candidate.repositoryKey !== correction.repository.key ||
      candidate.reasons.some(({ outcome }) => outcome === "rejects") ||
      !candidate.reasons.some(
        ({ code, outcome }) =>
          code === "origin-device" &&
          outcome === (recordingDevice ? "agrees" : "unavailable")
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
      ...checkout,
      startedAt: row.firstConversationAt,
      ownerUserId: payload.ownerUserId,
      ...(importAuthority ? { importAuthority } : {})
    };
  };
  const manageSourceContext = async (raw: unknown) => {
    const input = personalSourceContextCommandSchema.parse(raw);
    const { expectedScopeKey } = input;
    const guardedPreview =
      input.action === "preview" &&
      input.correction.axis === "git" &&
      input.correction.action === "set" &&
      input.correction.inferenceIntent
        ? input.correction
        : undefined;
    const reviewedCheckout =
      input.action === "preview" ? input.reviewedCheckout : undefined;
    const freshEvidence = guardedPreview
      ? await confirmGitInference(
          input.sessionId,
          guardedPreview,
          !!reviewedCheckout,
          expectedScopeKey
        )
      : undefined;
    if (
      reviewedCheckout &&
      (!freshEvidence ||
        reviewedCheckout.directory !== freshEvidence.directory ||
        reviewedCheckout.incarnation !== checkoutIncarnation(freshEvidence))
    )
      throw staleGitInference();
    let guardedApply = false;
    if (input.action === "apply") {
      const review = sourceContextReviews.get(input.reviewId);
      if (
        review?.sessionId !== input.sessionId ||
        review.expectedVersion !== input.expectedVersion
      )
        throw new Error(
          "This source context review is unavailable. Review the change again."
        );
      if (
        review.expectedScopeKey !== expectedScopeKey ||
        (review.inference?.manual && !expectedScopeKey)
      )
        throw staleGitInference();
      if (review.inference) {
        guardedApply = true;
        const { correction, evidence, manual } = review.inference;
        const current = await confirmGitInference(
          input.sessionId,
          correction,
          manual,
          expectedScopeKey
        );
        if (
          current.directory !== evidence.directory ||
          current.directoryIncarnation !== evidence.directoryIncarnation ||
          current.gitCheckoutIncarnation !== evidence.gitCheckoutIncarnation ||
          current.startedAt !== evidence.startedAt ||
          current.ownerUserId !== evidence.ownerUserId ||
          current.importAuthority?.artifactId !==
            evidence.importAuthority?.artifactId ||
          current.importAuthority?.importSourceId !==
            evidence.importAuthority?.importSourceId ||
          current.importAuthority?.startedAt !==
            evidence.importAuthority?.startedAt ||
          current.importAuthority?.deviceId !==
            evidence.importAuthority?.deviceId ||
          current.importAuthority?.deploymentId !==
            evidence.importAuthority?.deploymentId
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
            },
            ...(expectedScopeKey ? [expectedScopeKey] : [])
          )
        : input.action === "get"
          ? await deps.personalRequest(base, undefined, expectedScopeKey)
          : input.action === "preview"
            ? await deps.personalRequest(
                `${base}/reviews`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    ...input.correction,
                    ...(freshEvidence?.importAuthority
                      ? { localImportBasis: freshEvidence.importAuthority }
                      : {})
                  })
                },
                expectedScopeKey
              )
            : await deps.personalRequest(
                `${base}/reviews/${encodeURIComponent(input.reviewId)}/apply`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    expectedVersion: input.expectedVersion
                  })
                },
                expectedScopeKey,
                // An explicit retry must go through the checkout guard again.
                guardedApply ? { retry: false } : undefined
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
        ...(expectedScopeKey ? { expectedScopeKey } : {}),
        ...(guardedPreview && freshEvidence
          ? {
              inference: {
                correction: guardedPreview,
                evidence: freshEvidence,
                manual: !!reviewedCheckout
              }
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
    const request = {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    };
    const scope =
      input.action === "apply_sources" ? input.expectedScopeKey : undefined;
    const payload = scope
      ? await deps.personalRequest(path, request, scope)
      : await deps.personalRequest(path, request);
    const result = personalProjectCommandResultSchema.parse(payload);
    if (scope && result.project.projectId !== projectId)
      throw new PersonalMemoryBoundaryError("invalid_response", false);
    return result;
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
