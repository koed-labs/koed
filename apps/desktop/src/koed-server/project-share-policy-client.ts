import { z } from "zod";
import {
  prepareProjectShareManifestSchema,
  projectShareManifestEntrySchema,
  projectShareManifestReceiptSchema,
  projectSharePolicyEnableSchema,
  projectSharePolicyRevokeSchema,
  projectSharePolicyReviewSchema,
  projectSharePolicyManifestHash
} from "@koed/shared";
import type { WorkspaceProjectShareContext } from "@koed/shared/workspace-project-contract";

const localManifestSchema = z
  .object({
    personalProjectBindingHash: z.string().regex(/^[a-f0-9]{64}$/),
    deviceCredentialId: z.uuid(),
    signingPublicKey: z.base64().min(40).max(128),
    entries: z.array(projectShareManifestEntrySchema).max(100)
  })
  .strict();
export type ProjectPolicyLink = {
  ownerUserId: string;
  teamBackendId: string;
  workspaceProjectId: string;
};
export type ProjectPolicyReview = z.infer<
  typeof projectSharePolicyReviewSchema
>;
export type ProjectPolicyLocalManifest = z.infer<typeof localManifestSchema>;
export type ProjectPolicyLocalState = {
  policyVersion: number | null;
  deviceCredentialId: string | null;
  currentDeviceCredentialId: string;
  signingPublicKey: string | null;
  currentBindingHash: string;
};
export type ProjectPolicyPrepared = {
  link: ProjectPolicyLink;
  context: WorkspaceProjectShareContext;
  policy: ProjectPolicyReview;
  manifest: ProjectPolicyLocalManifest;
  receipt: z.infer<typeof projectShareManifestReceiptSchema>;
  review: ProjectPolicyReview;
};

const canonicalEntries = (entries: ProjectPolicyLocalManifest["entries"]) =>
  entries
    .map((entry) => ({
      sessionId: entry.sessionId.toLowerCase(),
      logicalMemoryId: entry.logicalMemoryId.toLowerCase(),
      sourceRevision: entry.sourceRevision,
      mappingRevision: entry.mappingRevision,
      reviewLabel: entry.reviewLabel.trim()
    }))
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
export type ProjectPolicyGrantIntent =
  | {
      intent: "collaboration.project_share_policy_enable";
      commandRequestId: string;
      teamId: string;
      projectId: string;
      expectedPolicyVersion: number;
      manifestId: string;
      manifestHash: string;
    }
  | {
      intent: "collaboration.project_share_policy_revoke";
      commandRequestId: string;
      teamId: string;
      projectId: string;
      expectedPolicyVersion: number;
    };
export type ProjectPolicyInitialStage = {
  stagedCount: number;
  skippedCount: number;
  pendingCount: number;
  needsReviewCount: number;
  items: Array<{
    label: string;
    state: "pending" | "skipped" | "needs_review";
    reason?:
      | "occupied"
      | "already_issued"
      | "ineligible"
      | "source_changed"
      | "result_unknown";
  }>;
};

export const assertProjectPolicyAuthority = (
  context: WorkspaceProjectShareContext,
  link: ProjectPolicyLink,
  policy: ProjectPolicyReview,
  requireWrite: boolean
): void => {
  const team = context.teams.find((item) => item.id === policy.teamId);
  const workspace = team?.workspaces.find(
    (item) => item.id === policy.workspaceId
  );
  if (
    context.state !== "ready" ||
    !context.principalId ||
    context.backendId !== link.teamBackendId ||
    policy.projectId !== link.workspaceProjectId ||
    !team ||
    !workspace ||
    (requireWrite && workspace.access !== "write")
  )
    throw new Error("Current Team Project policy authority is unavailable");
};

/** The renderer passes only an owner Personal Project ID. The link, manifest,
 * Team identity, and Action Grant stay in the trusted Desktop/main boundary. */
export const createProjectSharePolicyClient = (input: {
  loadContext(): Promise<WorkspaceProjectShareContext>;
  loadLink(personalProjectId: string): Promise<ProjectPolicyLink>;
  loadManifest(
    personalProjectId: string,
    teamBackendId: string,
    workspaceProjectId: string
  ): Promise<ProjectPolicyLocalManifest>;
  loadLocalState(
    personalProjectId: string,
    teamBackendId: string,
    workspaceProjectId: string
  ): Promise<ProjectPolicyLocalState>;
  startAttempt(
    personalProjectId: string,
    teamBackendId: string,
    workspaceProjectId: string,
    grantId: string,
    intent: ProjectPolicyGrantIntent,
    payload: unknown
  ): Promise<{ attemptId: string; state: "pending" }>;
  pendingAttempts(personalProjectId: string): Promise<{
    attempts: Array<{
      attemptId: string;
      action: "enable" | "revoke";
      clientRequestId: string;
      actionGrantId: string;
      teamBackendId: string;
      workspaceProjectId: string;
      teamId: string;
      teamPrincipalUserId: string;
      deviceCredentialId: string;
      expectedPolicyVersion: number;
      manifestId?: string;
      manifestHash?: string;
      payloadHash: string;
    }>;
  }>;
  finalizeAttempt(
    personalProjectId: string,
    teamBackendId: string,
    attemptId: string
  ): Promise<
    | { state: "unknown" }
    | { state: "terminal"; reason: "denied" | "revoked" | "expired" }
    | { state: "finalized"; action: "enable" | "revoke"; version: number }
  >;
  sendPolicy(
    teamBackendId: string,
    path: string,
    init?: RequestInit
  ): Promise<unknown>;
  consumeLocal(
    personalProjectId: string,
    teamBackendId: string,
    workspaceProjectId: string,
    actionGrantId: string,
    intent: ProjectPolicyGrantIntent,
    payload: unknown
  ): Promise<unknown>;
  prepareInitialSource(
    ownerUserId: string,
    teamBackendId: string,
    sessionId: string
  ): Promise<void>;
  stageLocal(
    personalProjectId: string,
    teamBackendId: string,
    workspaceProjectId: string,
    sessionId: string,
    expectedPolicyVersion: number
  ): Promise<
    | { state: "staged"; pendingShareId: string }
    | { state: "skipped"; reason: "occupied" | "already_issued" }
  >;
}) => {
  const path = (projectId: string, suffix: string) =>
    `/v1/workspace-projects/${encodeURIComponent(projectId)}/share-policy/${suffix}`;
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const resolve = async (personalProjectId: string, write: boolean) => {
    const link = await input.loadLink(personalProjectId);
    const context = await input.loadContext();
    if (
      context.state !== "ready" ||
      context.backendId !== link.teamBackendId ||
      !context.principalId
    )
      throw new Error("Current Team Project policy authority is unavailable");
    const policy = projectSharePolicyReviewSchema.parse(
      await input.sendPolicy(
        link.teamBackendId,
        path(link.workspaceProjectId, "status")
      )
    );
    assertProjectPolicyAuthority(context, link, policy, write);
    const local = await input.loadLocalState(
      personalProjectId,
      link.teamBackendId,
      link.workspaceProjectId
    );
    const reviewRequired =
      policy.status === "active" &&
      (policy.policyVersion !== local.policyVersion ||
        policy.deviceCredentialId !== local.deviceCredentialId ||
        policy.deviceCredentialId !== local.currentDeviceCredentialId ||
        policy.signingPublicKey !== local.signingPublicKey ||
        policy.personalProjectBindingHash !== local.currentBindingHash);
    return { link, context, policy, reviewRequired };
  };
  const pendingForCurrent = async (
    personalProjectId: string,
    pending?: Awaited<ReturnType<typeof input.pendingAttempts>>["attempts"]
  ) => {
    const current = await resolve(personalProjectId, false);
    const attempts =
      pending ?? (await input.pendingAttempts(personalProjectId)).attempts;
    // The owner-local endpoint also scopes these to the currently enrolled
    // device. Keep a Desktop check for a former link or Team principal so an
    // obsolete sealed attempt cannot be adopted into the current Project.
    return {
      current,
      attempts: attempts.filter(
        (attempt) =>
          attempt.teamBackendId === current.link.teamBackendId &&
          attempt.workspaceProjectId === current.link.workspaceProjectId &&
          attempt.teamId === current.policy.teamId &&
          attempt.teamPrincipalUserId === current.context.principalId
      )
    };
  };
  const reconcilePending = async (personalProjectId: string) => {
    const { attempts } = await pendingForCurrent(personalProjectId);
    for (const attempt of attempts) {
      // Finalization only reads the original consumed receipt. It never repeats
      // the Team mutation, and the local edge rechecks device and link custody.
      await input
        .finalizeAttempt(
          personalProjectId,
          attempt.teamBackendId,
          attempt.attemptId
        )
        .catch(() => ({ state: "unknown" as const }));
    }
    const remaining = (await pendingForCurrent(personalProjectId)).attempts;
    const latest = await resolve(personalProjectId, false);
    return {
      policy: latest.policy,
      pendingAction: remaining[0]?.action ?? null,
      reviewRequired: latest.reviewRequired
    };
  };
  const requireNoPending = async (personalProjectId: string) => {
    const pending = (await input.pendingAttempts(personalProjectId)).attempts;
    if (pending.length === 0) return;
    const { attempts } = await pendingForCurrent(personalProjectId, pending);
    if (attempts.length === 0) return;
    const result = await reconcilePending(personalProjectId);
    if (result.pendingAction)
      throw new Error(
        "Project summary sharing has an unresolved exact action; retry status later"
      );
    throw new Error(
      "Prior Project summary sharing result was reconciled; prepare a fresh review"
    );
  };
  const reviewedManifest = async (
    link: ProjectPolicyLink,
    policy: ProjectPolicyReview,
    manifest: ProjectPolicyLocalManifest,
    receipt: z.infer<typeof projectShareManifestReceiptSchema>
  ) => {
    const entries = canonicalEntries(manifest.entries);
    if (
      receipt.projectId !== link.workspaceProjectId ||
      receipt.ownerTeamMemberId !== policy.ownerTeamMemberId ||
      receipt.deviceCredentialId !== manifest.deviceCredentialId ||
      receipt.upstreamBackendId !== link.teamBackendId ||
      receipt.expectedPolicyVersion !== policy.policyVersion ||
      receipt.personalProjectBindingHash !==
        manifest.personalProjectBindingHash ||
      receipt.signingPublicKey !== manifest.signingPublicKey ||
      receipt.manifestHash !==
        projectSharePolicyManifestHash(
          manifest.entries,
          manifest.signingPublicKey
        ) ||
      JSON.stringify(receipt.entries) !== JSON.stringify(entries)
    )
      throw new Error(
        "Team Project manifest differs from trusted Personal sources"
      );
    const query = new URLSearchParams({
      expectedPolicyVersion: String(policy.policyVersion),
      manifestHash: receipt.manifestHash
    });
    const review = projectSharePolicyReviewSchema.parse(
      await input.sendPolicy(
        link.teamBackendId,
        path(
          link.workspaceProjectId,
          `manifests/${encodeURIComponent(receipt.manifestId)}/review?${query}`
        )
      )
    );
    if (
      review.projectId !== link.workspaceProjectId ||
      review.teamId !== policy.teamId ||
      review.workspaceId !== policy.workspaceId ||
      review.ownerTeamMemberId !== policy.ownerTeamMemberId ||
      review.policyId !== policy.policyId ||
      review.policyVersion !== policy.policyVersion ||
      review.status !== policy.status ||
      review.manifestId !== receipt.manifestId ||
      review.manifestHash !== receipt.manifestHash ||
      review.signingPublicKey !== manifest.signingPublicKey ||
      review.reviewSources.length !== entries.length ||
      review.reviewSources.some(
        (source, index) =>
          source.sessionId !== entries[index]?.sessionId ||
          source.reviewLabel !== entries[index]?.reviewLabel
      )
    )
      throw new Error(
        "Team Project Native review differs from trusted Personal sources"
      );
    return review;
  };
  return {
    status: reconcilePending,
    currentForRead: async (personalProjectId: string) =>
      resolve(personalProjectId, false),
    currentForWrite: async (personalProjectId: string) =>
      resolve(personalProjectId, true),
    currentForIssue: async (personalProjectId: string) => {
      const current = await resolve(personalProjectId, true);
      if (current.reviewRequired)
        throw new Error(
          "Project summary sharing requires a fresh Native review"
        );
      return current;
    },
    async stageInitial(personalProjectId: string): Promise<{
      policy: ProjectPolicyReview;
      initialStage: ProjectPolicyInitialStage;
    }> {
      await requireNoPending(personalProjectId);
      const first = await resolve(personalProjectId, true);
      if (first.policy.status !== "active" || first.reviewRequired)
        throw new Error("Project summary sharing is not active");
      const samePolicy = (current: typeof first) =>
        current.link.ownerUserId === first.link.ownerUserId &&
        current.link.teamBackendId === first.link.teamBackendId &&
        current.link.workspaceProjectId === first.link.workspaceProjectId &&
        current.context.principalId === first.context.principalId &&
        current.policy.status === "active" &&
        current.policy.policyVersion === first.policy.policyVersion &&
        current.policy.policyId === first.policy.policyId &&
        current.policy.ownerTeamMemberId === first.policy.ownerTeamMemberId &&
        current.policy.manifestHash === first.policy.manifestHash &&
        !current.reviewRequired;
      const items: ProjectPolicyInitialStage["items"] = [];
      for (const source of first.policy.reviewSources) {
        const current = await resolve(personalProjectId, true);
        if (
          !samePolicy(current) ||
          !current.policy.reviewSources.some(
            (entry) =>
              entry.sessionId === source.sessionId &&
              entry.reviewLabel === source.reviewLabel
          )
        )
          throw new Error("Project summary sharing policy changed");
        if (
          !current.policy.reviewSources.find(
            (entry) => entry.sessionId === source.sessionId
          )?.eligible
        ) {
          items.push({
            label: source.reviewLabel,
            state: "skipped",
            reason: "ineligible"
          });
          continue;
        }
        await input.prepareInitialSource(
          first.link.ownerUserId,
          first.link.teamBackendId,
          source.sessionId
        );
        const prepared = await resolve(personalProjectId, true);
        if (
          !samePolicy(prepared) ||
          !prepared.policy.reviewSources.some(
            (entry) =>
              entry.sessionId === source.sessionId &&
              entry.reviewLabel === source.reviewLabel &&
              entry.eligible
          )
        )
          throw new Error("Project summary sharing policy changed");
        try {
          const outcome = await input.stageLocal(
            personalProjectId,
            first.link.teamBackendId,
            first.link.workspaceProjectId,
            source.sessionId,
            first.policy.policyVersion
          );
          items.push(
            outcome.state === "staged"
              ? { label: source.reviewLabel, state: "pending" }
              : {
                  label: source.reviewLabel,
                  state: "skipped",
                  reason: outcome.reason
                }
          );
        } catch (error) {
          const statusCode = (error as { statusCode?: unknown }).statusCode;
          if (
            statusCode === 409 &&
            !samePolicy(await resolve(personalProjectId, true))
          )
            throw new Error("Project summary sharing policy changed", {
              cause: error
            });
          items.push(
            statusCode === 409
              ? {
                  label: source.reviewLabel,
                  state: "needs_review",
                  reason: "source_changed"
                }
              : {
                  label: source.reviewLabel,
                  state: "pending",
                  reason: "result_unknown"
                }
          );
        }
      }
      const latest = await resolve(personalProjectId, false);
      if (!samePolicy(latest))
        throw new Error("Project summary sharing policy changed");
      const stagedCount = items.filter(
        (item) => item.state === "pending" && !item.reason
      ).length;
      return {
        policy: latest.policy,
        initialStage: {
          stagedCount,
          skippedCount: items.filter((item) => item.state === "skipped").length,
          pendingCount: items.filter((item) => item.state === "pending").length,
          needsReviewCount: items.filter(
            (item) => item.state === "needs_review"
          ).length,
          items
        }
      };
    },
    async prepareEnable(personalProjectId: string) {
      await requireNoPending(personalProjectId);
      const current = await resolve(personalProjectId, true);
      if (current.policy.status === "active")
        throw new Error("Project summary sharing is already active");
      const manifest = localManifestSchema.parse(
        await input.loadManifest(
          personalProjectId,
          current.link.teamBackendId,
          current.link.workspaceProjectId
        )
      );
      const receipt = projectShareManifestReceiptSchema.parse(
        await input.sendPolicy(
          current.link.teamBackendId,
          path(current.link.workspaceProjectId, "manifests"),
          json(
            prepareProjectShareManifestSchema.parse({
              expectedPolicyVersion: current.policy.policyVersion,
              personalProjectBindingHash: manifest.personalProjectBindingHash,
              signingPublicKey: manifest.signingPublicKey,
              entries: manifest.entries
            })
          )
        )
      );
      const review = await reviewedManifest(
        current.link,
        current.policy,
        manifest,
        receipt
      );
      const fresh = await resolve(personalProjectId, true);
      if (
        fresh.link.teamBackendId !== current.link.teamBackendId ||
        fresh.link.workspaceProjectId !== current.link.workspaceProjectId ||
        fresh.context.principalId !== current.context.principalId ||
        fresh.policy.teamId !== current.policy.teamId ||
        fresh.policy.workspaceId !== current.policy.workspaceId ||
        fresh.policy.policyVersion !== current.policy.policyVersion ||
        fresh.policy.status !== current.policy.status
      )
        throw new Error(
          "Project summary sharing authority changed during preparation"
        );
      return { ...current, manifest, receipt, review };
    },
    reviewedManifest,
    async currentManifest(
      personalProjectId: string,
      expected: ProjectPolicyLink
    ) {
      const current = await resolve(personalProjectId, true);
      if (
        current.link.teamBackendId !== expected.teamBackendId ||
        current.link.workspaceProjectId !== expected.workspaceProjectId ||
        current.link.ownerUserId !== expected.ownerUserId
      )
        throw new Error("Project summary sharing link changed");
      const manifest = localManifestSchema.parse(
        await input.loadManifest(
          personalProjectId,
          expected.teamBackendId,
          expected.workspaceProjectId
        )
      );
      return { ...current, manifest };
    },
    async enable(
      personalProjectId: string,
      prepared: ProjectPolicyPrepared,
      intent: Extract<
        ProjectPolicyGrantIntent,
        { intent: "collaboration.project_share_policy_enable" }
      >,
      grantId: string
    ) {
      if (
        intent.teamId !== prepared.policy.teamId ||
        intent.projectId !== prepared.link.workspaceProjectId ||
        intent.expectedPolicyVersion !== prepared.policy.policyVersion ||
        intent.manifestId !== prepared.receipt.manifestId ||
        intent.manifestHash !== prepared.receipt.manifestHash
      )
        throw new Error("Project summary sharing grant intent changed");
      const current = await this.currentManifest(
        personalProjectId,
        prepared.link
      );
      if (
        current.policy.policyVersion !== prepared.policy.policyVersion ||
        current.policy.status !== prepared.policy.status ||
        current.context.principalId !== prepared.context.principalId ||
        current.manifest.personalProjectBindingHash !==
          prepared.manifest.personalProjectBindingHash ||
        current.manifest.deviceCredentialId !==
          prepared.manifest.deviceCredentialId ||
        current.manifest.signingPublicKey !==
          prepared.manifest.signingPublicKey ||
        JSON.stringify(current.manifest.entries) !==
          JSON.stringify(prepared.manifest.entries) ||
        Date.parse(prepared.receipt.expiresAt) <= Date.now()
      )
        throw new Error("Project summary sharing review expired or changed");
      const currentReview = await reviewedManifest(
        prepared.link,
        current.policy,
        current.manifest,
        prepared.receipt
      );
      if (JSON.stringify(currentReview) !== JSON.stringify(prepared.review))
        throw new Error("Project summary sharing Native review changed");
      const body = projectSharePolicyEnableSchema.parse({
        expectedPolicyVersion: prepared.policy.policyVersion,
        manifestId: prepared.receipt.manifestId,
        manifestHash: prepared.receipt.manifestHash,
        signingPublicKey: current.manifest.signingPublicKey,
        authority: {
          action: "workspace.memory.share_owned",
          source: "device_action_grant",
          referenceId: grantId
        },
        currentEntries: current.manifest.entries
      });
      await requireNoPending(personalProjectId);
      const attempt = await input.startAttempt(
        personalProjectId,
        prepared.link.teamBackendId,
        prepared.link.workspaceProjectId,
        grantId,
        intent,
        body
      );
      try {
        await input.consumeLocal(
          personalProjectId,
          prepared.link.teamBackendId,
          prepared.link.workspaceProjectId,
          grantId,
          intent,
          body
        );
      } catch {
        /* Exact read-only finalization handles lost responses. */
      }
      const finalized = await input
        .finalizeAttempt(
          personalProjectId,
          prepared.link.teamBackendId,
          attempt.attemptId
        )
        .catch(() => ({ state: "unknown" as const }));
      if (finalized.state === "terminal")
        throw new Error(
          "Project summary sharing action did not execute; prepare a fresh Native review"
        );
      if (
        finalized.state !== "finalized" ||
        finalized.action !== "enable" ||
        finalized.version !== prepared.policy.policyVersion + 1
      )
        throw new Error(
          "Project summary sharing result is pending exact receipt recovery"
        );
      return this.stageInitial(personalProjectId);
    },
    async revoke(
      personalProjectId: string,
      reviewed: {
        link: ProjectPolicyLink;
        policy: ProjectPolicyReview;
        principalId: string;
      },
      intent: Extract<
        ProjectPolicyGrantIntent,
        { intent: "collaboration.project_share_policy_revoke" }
      >,
      grantId: string
    ) {
      if (
        intent.teamId !== reviewed.policy.teamId ||
        intent.projectId !== reviewed.link.workspaceProjectId ||
        intent.expectedPolicyVersion !== reviewed.policy.policyVersion
      )
        throw new Error("Project summary sharing grant intent changed");
      const current = await resolve(personalProjectId, true);
      if (
        current.link.teamBackendId !== reviewed.link.teamBackendId ||
        current.link.workspaceProjectId !== reviewed.link.workspaceProjectId ||
        current.link.ownerUserId !== reviewed.link.ownerUserId ||
        current.context.principalId !== reviewed.principalId ||
        current.policy.policyVersion !== reviewed.policy.policyVersion ||
        current.policy.status !== "active"
      )
        throw new Error("Project summary sharing authority changed");
      await requireNoPending(personalProjectId);
      const body = projectSharePolicyRevokeSchema.parse({
        expectedPolicyVersion: reviewed.policy.policyVersion,
        authority: {
          action: "workspace.memory.share_owned",
          source: "device_action_grant",
          referenceId: grantId
        }
      });
      const attempt = await input.startAttempt(
        personalProjectId,
        reviewed.link.teamBackendId,
        reviewed.link.workspaceProjectId,
        grantId,
        intent,
        body
      );
      try {
        await input.consumeLocal(
          personalProjectId,
          reviewed.link.teamBackendId,
          reviewed.link.workspaceProjectId,
          grantId,
          intent,
          body
        );
      } catch {
        /* Exact read-only finalization handles lost responses. */
      }
      const finalized = await input
        .finalizeAttempt(
          personalProjectId,
          reviewed.link.teamBackendId,
          attempt.attemptId
        )
        .catch(() => ({ state: "unknown" as const }));
      if (finalized.state === "terminal")
        throw new Error(
          "Project summary sharing action did not execute; prepare a fresh Native review"
        );
      if (
        finalized.state !== "finalized" ||
        finalized.action !== "revoke" ||
        finalized.version !== reviewed.policy.policyVersion + 1
      )
        throw new Error(
          "Project summary sharing result is pending exact receipt recovery"
        );
      return (await resolve(personalProjectId, true)).policy;
    },
    async prepareRevoke(personalProjectId: string) {
      await requireNoPending(personalProjectId);
      const current = await resolve(personalProjectId, true);
      if (current.policy.status !== "active")
        throw new Error("Project summary sharing is not active");
      return {
        link: current.link,
        policy: current.policy,
        principalId: current.context.principalId!
      };
    }
  };
};
