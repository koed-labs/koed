import { z } from "zod";
import {
  workspaceProjectCopySchema,
  projectSourceSchema,
  projectSourceUploadSchema,
  projectSourceReadSchema
} from "@koed/shared";
import { sharedMemorySourceCapabilitiesSchema } from "@koed/shared";
import { projectShareManifestEntrySchema } from "@koed/shared";
import { projectSharePolicyReceiptReadSchema } from "@koed/shared";

const localPolicyManifestSchema = z
  .object({
    personalProjectBindingHash: z.string().regex(/^[a-f0-9]{64}$/),
    deviceCredentialId: z.uuid(),
    signingPublicKey: z.base64().min(40).max(128),
    entries: z.array(projectShareManifestEntrySchema).max(100)
  })
  .strict();
const localPolicyStateSchema = z
  .object({
    policyVersion: z.number().int().nonnegative().nullable(),
    deviceCredentialId: z.uuid().nullable(),
    currentDeviceCredentialId: z.uuid(),
    signingPublicKey: z.base64().min(40).max(128).nullable(),
    currentBindingHash: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
const explicitProjectShareOfferShape = {
  offerId: z.uuid(),
  mutationId: z.uuid(),
  expiresAt: z.iso.datetime({ offset: true }),
  reason: z.enum(["moved_in", "share_again"]),
  workspaceProjectId: z.uuid(),
  sessionId: z.uuid(),
  mappingRevision: z.number().int().positive(),
  sourceRevision: z.number().int().positive(),
  source: z
    .object({
      kind: z.literal("captured_session"),
      sessionId: z.uuid(),
      logicalMemoryId: z.uuid()
    })
    .strict(),
  logicalMemoryId: z.uuid(),
  sourceCapabilities: sharedMemorySourceCapabilitiesSchema,
  itemCount: z.number().int().positive().max(100),
  excludedItemCount: z.number().int().nonnegative(),
  manifest: z
    .array(
      z
        .object({
          sourceId: z.uuid(),
          revisionHash: z.string().regex(/^[a-f0-9]{64}$/)
        })
        .strict()
    )
    .min(1)
    .max(100),
  byteCount: z
    .number()
    .int()
    .positive()
    .max(256 * 1024),
  candidateExpiresAt: z.iso.datetime({ offset: true }).nullable(),
  activationRepresentation: z.literal("lcm_leaves"),
  maximumFidelity: z.literal("lcm_leaves"),
  mode: z.literal("continuous"),
  includeCuratedMemory: z.literal(false),
  candidateHash: z.string().regex(/^[a-f0-9]{64}$/)
} as const;
const checkExplicitOfferSource = (
  offer: z.infer<z.ZodObject<typeof explicitProjectShareOfferShape>>,
  context: z.RefinementCtx
) => {
  if (
    offer.source.sessionId !== offer.sessionId ||
    offer.source.logicalMemoryId !== offer.logicalMemoryId
  )
    context.addIssue({
      code: "custom",
      path: ["source"],
      message: "Offer source differs from the reviewed chat"
    });
  if (offer.manifest.length !== offer.itemCount)
    context.addIssue({
      code: "custom",
      path: ["manifest"],
      message: "Offer candidate item count changed"
    });
};
const explicitProjectShareOfferSchema = z
  .object(explicitProjectShareOfferShape)
  .strict()
  .superRefine(checkExplicitOfferSource);
const explicitProjectShareOfferReadSchema = z
  .object({
    ...explicitProjectShareOfferShape,
    state: z.literal("prepared"),
    teamPrincipalUserId: z.uuid(),
    deviceCredentialId: z.uuid(),
    remotePendingShareId: z.uuid().nullable(),
    remoteShareGrantId: z.uuid().nullable(),
    remoteGrantVersion: z.number().int().positive().nullable()
  })
  .strict()
  .superRefine(checkExplicitOfferSource);
const explicitProjectShareOfferStatusSchema = z
  .object({
    offerId: z.uuid(),
    mutationId: z.uuid(),
    state: z.enum(["absent", "pending", "activated", "blocked"]),
    pendingShareId: z.uuid().nullable(),
    shareGrantId: z.uuid().nullable(),
    grantVersion: z.number().int().positive().nullable()
  })
  .strict();
const explicitProjectShareOfferSettleSchema = z.union([
  z.object({ state: z.literal("pending") }).strict(),
  z
    .object({
      state: z.enum(["pending", "activated"]),
      pendingShareId: z.uuid(),
      shareGrantId: z.uuid(),
      grantVersion: z.number().int().positive()
    })
    .strict()
]);
const explicitProjectShareOfferFenceSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("fenced") }).strict(),
  z
    .object({
      state: z.literal("activation_race"),
      shareGrantId: z.uuid(),
      grantVersion: z.number().int().positive()
    })
    .strict()
]);
const policyCursor = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const activePolicyProjectsSchema = z
  .object({
    projects: z
      .array(
        z
          .object({
            projectId: z.uuid(),
            teamBackendId: z.string().min(1).max(160),
            workspaceProjectId: z.uuid(),
            policyVersion: z.number().int().positive()
          })
          .strict()
      )
      .max(50),
    nextCursor: policyCursor.nullable(),
    hasMore: z.boolean()
  })
  .strict();
const futurePolicyPageSchema = z
  .object({
    processed: z.number().int().nonnegative().max(20),
    staged: z.number().int().nonnegative().max(20),
    skipped: z.number().int().nonnegative().max(20),
    failed: z.number().int().nonnegative().max(20),
    hasMore: z.boolean(),
    nextCursor: policyCursor.nullable()
  })
  .strict()
  .superRefine((page, context) => {
    if (
      page.processed !== page.staged + page.skipped + page.failed ||
      page.hasMore !== (page.nextCursor !== null)
    )
      context.addIssue({
        code: "custom",
        message: "Invalid future Project policy page"
      });
  });

const snapshotSchema = z
  .object(workspaceProjectCopySchema.shape)
  .omit({
    expectedVersion: true
  })
  .extend({
    personalProjectVersion: z.number().int().positive()
  })
  .strict()
  .superRefine((snapshot, context) => {
    // The local snapshot has no Team target version yet. Validate its complete
    // copy content with the original cross-field rules before adding that
    // separately reviewed version at the Team write boundary.
    const checked = workspaceProjectCopySchema.safeParse({
      ...snapshot,
      expectedVersion: 1
    });
    if (!checked.success)
      for (const issue of checked.error.issues)
        context.addIssue({
          code: "custom",
          message: issue.message,
          path: issue.path
        });
  });

export const createWorkspaceProjectPersonalClient = (
  sendPersonal: (path: string, init?: RequestInit) => Promise<unknown>,
  teamClientAuthorization: (
    teamBackendId: string,
    family?:
      | "team_workspace_read"
      | "team_workspace_write"
      | "share_grant_management"
  ) => string
) => ({
  async activeProjectSharePolicies(cursor?: string, signal?: AbortSignal) {
    return activePolicyProjectsSchema.parse(
      await sendPersonal(
        `/v1/local-edge/project-share-policy/active-projects${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        { method: "GET", signal }
      )
    );
  },
  async reconcileFutureProjectSharePolicy(
    projectId: string,
    teamBackendId: string,
    workspaceProjectId: string,
    expectedPolicyVersion: number,
    cursor?: string,
    signal?: AbortSignal
  ) {
    return futurePolicyPageSchema.parse(
      await sendPersonal(
        `/v1/local-edge/projects/${encodeURIComponent(projectId)}/project-share-policy/reconcile-future`,
        {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            "x-koed-team-client-credential": teamClientAuthorization(
              teamBackendId,
              "share_grant_management"
            )
          },
          body: JSON.stringify({
            teamBackendId,
            workspaceProjectId,
            expectedPolicyVersion,
            ...(cursor ? { cursor } : {})
          })
        }
      )
    );
  },
  async readProjectSharePolicyExecutionReceipt(
    projectId: string,
    teamBackendId: string,
    workspaceProjectId: string,
    receipt: z.infer<typeof projectSharePolicyReceiptReadSchema>
  ) {
    return z
      .object({
        executed: z.boolean(),
        receipt: z
          .object({
            statusCode: z.number().int(),
            body: z.unknown()
          })
          .strict()
          .nullable(),
        terminalState: z.enum(["denied", "revoked", "expired"]).nullable(),
        serverTime: z.iso.datetime({ offset: true })
      })
      .strict()
      .parse(
        await sendPersonal(
          `/v1/local-edge/projects/${encodeURIComponent(projectId)}/project-share-policy/execution-receipts/read`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-koed-team-client-credential": teamClientAuthorization(
                teamBackendId,
                "share_grant_management"
              )
            },
            body: JSON.stringify({
              teamBackendId,
              workspaceProjectId,
              receipt: projectSharePolicyReceiptReadSchema.parse(receipt)
            })
          }
        )
      );
  },
  async projectSharePolicyManifest(
    projectId: string,
    teamBackendId: string,
    workspaceProjectId: string
  ) {
    return localPolicyManifestSchema.parse(
      await sendPersonal(
        `/v1/local-edge/projects/${encodeURIComponent(projectId)}/project-share-policy/manifest`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-koed-team-client-credential": teamClientAuthorization(
              teamBackendId,
              "team_workspace_write"
            )
          },
          body: JSON.stringify({ teamBackendId, workspaceProjectId })
        }
      )
    );
  },
  async projectSharePolicyLocalState(
    projectId: string,
    teamBackendId: string,
    workspaceProjectId: string
  ) {
    return localPolicyStateSchema.parse(
      await sendPersonal(
        `/v1/local-edge/projects/${encodeURIComponent(projectId)}/project-share-policy/local-state`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-koed-team-client-credential": teamClientAuthorization(
              teamBackendId,
              "share_grant_management"
            )
          },
          body: JSON.stringify({ teamBackendId, workspaceProjectId })
        }
      )
    );
  },
  async createExplicitProjectShareOffer(
    projectId: string,
    teamBackendId: string,
    workspaceProjectId: string,
    sessionId: string,
    reason: "moved_in" | "share_again"
  ) {
    return explicitProjectShareOfferSchema.parse(
      await sendPersonal(
        `/v1/local-edge/projects/${encodeURIComponent(projectId)}/project-share-policy/explicit-offers`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-koed-team-client-credential": teamClientAuthorization(
              teamBackendId,
              "share_grant_management"
            )
          },
          body: JSON.stringify({
            teamBackendId,
            workspaceProjectId,
            sessionId,
            reason
          })
        }
      )
    );
  },
  async readExplicitProjectShareOffer(
    projectId: string,
    teamBackendId: string,
    offerId: string
  ) {
    return explicitProjectShareOfferReadSchema.parse(
      await sendPersonal(
        `/v1/local-edge/projects/${encodeURIComponent(projectId)}/project-share-policy/explicit-offers/${encodeURIComponent(offerId)}?teamBackendId=${encodeURIComponent(teamBackendId)}`,
        {
          method: "GET",
          headers: {
            "x-koed-team-client-credential": teamClientAuthorization(
              teamBackendId,
              "share_grant_management"
            )
          }
        }
      )
    );
  },
  async explicitProjectShareOfferStatus(
    projectId: string,
    teamBackendId: string,
    offerId: string
  ) {
    return explicitProjectShareOfferStatusSchema.parse(
      await sendPersonal(
        `/v1/local-edge/projects/${encodeURIComponent(projectId)}/project-share-policy/explicit-offers/${encodeURIComponent(offerId)}/status?teamBackendId=${encodeURIComponent(teamBackendId)}`,
        {
          method: "GET",
          headers: {
            "x-koed-team-client-credential": teamClientAuthorization(
              teamBackendId,
              "share_grant_management"
            )
          }
        }
      )
    );
  },
  async settleExplicitProjectShareOffer(
    projectId: string,
    teamBackendId: string,
    offerId: string
  ) {
    return explicitProjectShareOfferSettleSchema.parse(
      await sendPersonal(
        `/v1/local-edge/projects/${encodeURIComponent(projectId)}/project-share-policy/explicit-offers/${encodeURIComponent(offerId)}/settle`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-koed-team-client-credential": teamClientAuthorization(
              teamBackendId,
              "share_grant_management"
            )
          },
          body: JSON.stringify({ teamBackendId })
        }
      )
    );
  },
  async fenceExplicitProjectShareOffer(
    projectId: string,
    teamBackendId: string,
    offerId: string
  ) {
    return explicitProjectShareOfferFenceSchema.parse(
      await sendPersonal(
        `/v1/local-edge/projects/${encodeURIComponent(projectId)}/project-share-policy/explicit-offers/${encodeURIComponent(offerId)}/fence`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-koed-team-client-credential": teamClientAuthorization(
              teamBackendId,
              "share_grant_management"
            )
          },
          body: JSON.stringify({ teamBackendId })
        }
      )
    );
  },
  async startProjectSharePolicyAttempt(
    projectId: string,
    teamBackendId: string,
    workspaceProjectId: string,
    actionGrantId: string,
    intent: { commandRequestId: string },
    payload: unknown
  ) {
    return z
      .object({ attemptId: z.uuid(), state: z.literal("pending") })
      .strict()
      .parse(
        await sendPersonal(
          `/v1/local-edge/projects/${encodeURIComponent(projectId)}/project-share-policy/attempts/start`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-koed-team-client-credential": teamClientAuthorization(
                teamBackendId,
                "share_grant_management"
              )
            },
            body: JSON.stringify({
              teamBackendId,
              workspaceProjectId,
              actionGrant: { id: actionGrantId },
              intent,
              payload,
              clientRequestId: intent.commandRequestId
            })
          }
        )
      );
  },
  async pendingProjectSharePolicyAttempts(projectId: string) {
    return z
      .object({
        attempts: z
          .array(
            z
              .object({
                attemptId: z.uuid(),
                action: z.enum(["enable", "revoke"]),
                clientRequestId: z.uuid(),
                actionGrantId: z.uuid(),
                teamBackendId: z.string().min(1),
                workspaceProjectId: z.uuid(),
                teamId: z.uuid(),
                teamPrincipalUserId: z.uuid(),
                deviceCredentialId: z.uuid(),
                expectedPolicyVersion: z.number().int().nonnegative(),
                manifestId: z.uuid().optional(),
                manifestHash: z
                  .string()
                  .regex(/^[a-f0-9]{64}$/)
                  .optional(),
                payloadHash: z.string().regex(/^[a-f0-9]{64}$/)
              })
              .strict()
          )
          .max(10)
      })
      .strict()
      .parse(
        await sendPersonal(
          `/v1/local-edge/projects/${encodeURIComponent(projectId)}/project-share-policy/attempts/pending`
        )
      );
  },
  async finalizeProjectSharePolicyAttempt(
    projectId: string,
    teamBackendId: string,
    attemptId: string
  ) {
    return z
      .discriminatedUnion("state", [
        z.object({ state: z.literal("unknown") }).strict(),
        z
          .object({
            state: z.literal("terminal"),
            reason: z.enum(["denied", "revoked", "expired"])
          })
          .strict(),
        z
          .object({
            state: z.literal("finalized"),
            action: z.enum(["enable", "revoke"]),
            version: z.number().int().positive()
          })
          .strict()
      ])
      .parse(
        await sendPersonal(
          `/v1/local-edge/projects/${encodeURIComponent(projectId)}/project-share-policy/attempts/finalize`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-koed-team-client-credential": teamClientAuthorization(
                teamBackendId,
                "share_grant_management"
              )
            },
            body: JSON.stringify({ attemptId })
          }
        )
      );
  },
  async makeProjectSharePolicySessionPrivate(
    projectId: string,
    teamBackendId: string,
    workspaceProjectId: string,
    sessionId: string
  ) {
    return z
      .discriminatedUnion("state", [
        z.object({ state: z.literal("private") }).strict(),
        z
          .object({
            state: z.literal("withdrawal_required"),
            withdrawalTarget: z
              .object({
                shareGrantId: z.uuid(),
                grantVersion: z.number().int().positive()
              })
              .strict()
          })
          .strict()
      ])
      .parse(
        await sendPersonal(
          `/v1/local-edge/projects/${encodeURIComponent(projectId)}/project-share-policy/make-private`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-koed-team-client-credential": teamClientAuthorization(
                teamBackendId,
                "share_grant_management"
              )
            },
            body: JSON.stringify({
              teamBackendId,
              workspaceProjectId,
              sessionId
            })
          }
        )
      );
  },
  async projectSharePolicySessionStatus(
    projectId: string,
    teamBackendId: string,
    workspaceProjectId: string,
    sessionId: string
  ) {
    return z
      .object({
        state: z.enum([
          "private",
          "pending",
          "shared",
          "unshared",
          "ineligible"
        ]),
        mappingRevision: z.number().int().positive()
      })
      .strict()
      .parse(
        await sendPersonal(
          `/v1/local-edge/projects/${encodeURIComponent(projectId)}/project-share-policy/session-status`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-koed-team-client-credential": teamClientAuthorization(
                teamBackendId,
                "share_grant_management"
              )
            },
            body: JSON.stringify({
              teamBackendId,
              workspaceProjectId,
              sessionId
            })
          }
        )
      );
  },
  async reconcileProjectSharePolicyIssues(
    projectId: string,
    teamBackendId: string,
    workspaceProjectId: string,
    cursor?: string,
    sessionId?: string,
    signal?: AbortSignal
  ) {
    return z
      .object({
        processed: z.number().int().nonnegative().max(20),
        activated: z.number().int().nonnegative().max(20),
        pending: z.number().int().nonnegative().max(20),
        hasMore: z.boolean(),
        nextCursor: policyCursor.nullable()
      })
      .strict()
      .parse(
        await sendPersonal(
          `/v1/local-edge/projects/${encodeURIComponent(projectId)}/project-share-policy/reconcile-issues`,
          {
            method: "POST",
            signal,
            headers: {
              "content-type": "application/json",
              "x-koed-team-client-credential": teamClientAuthorization(
                teamBackendId,
                "share_grant_management"
              )
            },
            body: JSON.stringify({
              teamBackendId,
              workspaceProjectId,
              ...(cursor ? { cursor } : {}),
              ...(sessionId ? { sessionId } : {})
            })
          }
        )
      );
  },
  async fenceUnpublishedProjectSharePolicyIssue(
    projectId: string,
    teamBackendId: string,
    workspaceProjectId: string,
    sessionId: string
  ) {
    return z
      .union([
        z
          .object({
            state: z.enum(["settled", "frozen"]),
            fenceId: z.uuid()
          })
          .strict(),
        z.object({ state: z.literal("activation_race") }).strict()
      ])
      .parse(
        await sendPersonal(
          `/v1/local-edge/projects/${encodeURIComponent(projectId)}/project-share-policy/fence-unpublished`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-koed-team-client-credential": teamClientAuthorization(
                teamBackendId,
                "share_grant_management"
              )
            },
            body: JSON.stringify({
              teamBackendId,
              workspaceProjectId,
              sessionId
            })
          }
        )
      );
  },
  async currentUnpublishedProjectSharePolicyFence(
    projectId: string,
    teamBackendId: string,
    workspaceProjectId: string,
    sessionId: string
  ) {
    const query = new URLSearchParams({
      teamBackendId,
      workspaceProjectId,
      sessionId
    });
    return z
      .union([
        z.object({ state: z.literal("none") }).strict(),
        z
          .object({
            state: z.enum(["preparing", "acknowledged"]),
            fenceId: z.uuid(),
            mappingRevision: z.number().int().positive()
          })
          .strict()
      ])
      .parse(
        await sendPersonal(
          `/v1/local-edge/projects/${encodeURIComponent(projectId)}/project-share-policy/fence-unpublished/current?${query}`,
          {
            method: "GET",
            headers: {
              "x-koed-team-client-credential": teamClientAuthorization(
                teamBackendId,
                "share_grant_management"
              )
            }
          }
        )
      );
  },
  async releaseUnpublishedProjectSharePolicyFence(
    projectId: string,
    teamBackendId: string,
    workspaceProjectId: string,
    sessionId: string,
    fenceId: string
  ) {
    return z
      .object({ state: z.literal("released") })
      .strict()
      .parse(
        await sendPersonal(
          `/v1/local-edge/projects/${encodeURIComponent(projectId)}/project-share-policy/fence-unpublished/release`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-koed-team-client-credential": teamClientAuthorization(
                teamBackendId,
                "share_grant_management"
              )
            },
            body: JSON.stringify({
              teamBackendId,
              workspaceProjectId,
              sessionId,
              fenceId
            })
          }
        )
      );
  },
  async loadPersonalCopy(
    projectId: string,
    teamBackendId: string,
    shareAttemptKey: string,
    targetTeamId: string,
    targetWorkspaceId: string
  ) {
    const prepared = z
      .object({
        snapshot: snapshotSchema,
        manifestHash: z.string().regex(/^[a-f0-9]{64}$/)
      })
      .strict()
      .parse(
        await sendPersonal(
          `/v1/local-edge/projects/${encodeURIComponent(projectId)}/workspace-project-prepare`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-koed-team-client-credential":
                teamClientAuthorization(teamBackendId)
            },
            body: JSON.stringify({
              teamBackendId,
              shareAttemptKey,
              targetTeamId,
              targetWorkspaceId
            })
          }
        )
      );
    return prepared.snapshot;
  },
  async pendingShare(projectId: string, teamBackendId: string) {
    return z
      .object({
        attempt: z
          .object({
            teamBackendId: z.string().min(1),
            shareAttemptKey: z.string().min(8),
            targetTeamId: z.uuid(),
            targetWorkspaceId: z.uuid(),
            state: z.literal("pending")
          })
          .strict()
          .nullable()
      })
      .strict()
      .parse(
        await sendPersonal(
          `/v1/local-edge/projects/${encodeURIComponent(projectId)}/workspace-project-share-attempt`,
          {
            headers: {
              "x-koed-team-client-credential":
                teamClientAuthorization(teamBackendId)
            }
          }
        )
      ).attempt;
  },
  async cancelPendingShare(projectId: string, teamBackendId: string) {
    return z
      .object({ canceled: z.literal(true), shareAttemptKey: z.string().min(8) })
      .strict()
      .parse(
        await sendPersonal(
          `/v1/local-edge/projects/${encodeURIComponent(projectId)}/workspace-project-share-cancel`,
          {
            method: "POST",
            headers: {
              "x-koed-team-client-credential": teamClientAuthorization(
                teamBackendId,
                "team_workspace_write"
              )
            }
          }
        )
      );
  },
  async markPersonalMoved(
    projectId: string,
    workspaceProjectId: string,
    teamBackendId: string,
    _workspaceId: string,
    expectedPersonalProjectVersion: number
  ) {
    await sendPersonal(
      `/v1/local-edge/projects/${encodeURIComponent(projectId)}/workspace-project-confirm`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-koed-team-client-credential":
            teamClientAuthorization(teamBackendId)
        },
        body: JSON.stringify({
          expectedPersonalProjectVersion,
          teamBackendId,
          workspaceProjectId
        })
      }
    );
  },
  async consumeProjectSharePolicy(
    projectId: string,
    teamBackendId: string,
    workspaceProjectId: string,
    actionGrantId: string,
    intent: Record<string, unknown>,
    payload: unknown
  ) {
    return sendPersonal(
      `/v1/local-edge/projects/${encodeURIComponent(projectId)}/project-share-policy/consume`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-koed-team-client-credential": teamClientAuthorization(
            teamBackendId,
            "team_workspace_write"
          )
        },
        body: JSON.stringify({
          teamBackendId,
          workspaceProjectId,
          actionGrant: { id: actionGrantId },
          intent,
          payload
        })
      }
    );
  },
  async stageInitialProjectSharePolicy(
    projectId: string,
    teamBackendId: string,
    workspaceProjectId: string,
    sessionId: string,
    expectedPolicyVersion: number
  ) {
    return z
      .discriminatedUnion("state", [
        z
          .object({ state: z.literal("staged"), pendingShareId: z.uuid() })
          .strict(),
        z
          .object({
            state: z.literal("skipped"),
            reason: z.enum(["occupied", "already_issued"])
          })
          .strict()
      ])
      .parse(
        await sendPersonal(
          `/v1/local-edge/projects/${encodeURIComponent(projectId)}/project-share-policy/stage-initial`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-koed-team-client-credential": teamClientAuthorization(
                teamBackendId,
                "share_grant_management"
              )
            },
            body: JSON.stringify({
              teamBackendId,
              workspaceProjectId,
              sessionId,
              expectedPolicyVersion
            })
          }
        )
      );
  },
  async reconcileInvalidation(projectId: string, teamBackendId: string) {
    await sendPersonal(
      `/v1/local-edge/projects/${encodeURIComponent(projectId)}/workspace-project-reconcile`,
      {
        method: "POST",
        headers: {
          "x-koed-team-client-credential":
            teamClientAuthorization(teamBackendId)
        }
      }
    );
  },
  async reconcileWorkspaceInvalidation(
    workspaceProjectId: string,
    teamBackendId: string
  ) {
    await sendPersonal(
      `/v1/local-edge/workspace-projects/${encodeURIComponent(workspaceProjectId)}/reconcile`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-koed-team-client-credential":
            teamClientAuthorization(teamBackendId)
        },
        body: JSON.stringify({ teamBackendId })
      }
    );
  },
  async stageTeamLeave(teamBackendId: string, teamId: string) {
    return sendPersonal("/v1/local-edge/workspace-project-team-leave-stage", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-koed-team-client-credential": teamClientAuthorization(teamBackendId)
      },
      body: JSON.stringify({ teamBackendId, teamId })
    });
  },
  async sourceMetadata(
    projectId: string,
    sourceId: string,
    teamBackendId: string,
    workspaceProjectId: string
  ) {
    const query = new URLSearchParams({ teamBackendId, workspaceProjectId });
    return z
      .object({
        id: z.uuid(),
        name: z.string(),
        kind: z.string(),
        status: z.string(),
        personalNoteId: z.uuid().nullable(),
        personalNoteRevisionId: z.uuid().nullable()
      })
      .strict()
      .parse(
        await sendPersonal(
          `/v1/projects/${encodeURIComponent(projectId)}/workspace-project-source-metadata/${encodeURIComponent(sourceId)}?${query}`
        )
      );
  },
  async uploadLinkedSource(
    projectId: string,
    workspaceProjectId: string,
    teamBackendId: string,
    upload: z.infer<typeof projectSourceUploadSchema>
  ) {
    return projectSourceSchema.parse(
      await sendPersonal(
        `/v1/local-edge/projects/${encodeURIComponent(projectId)}/workspace-project-sources/upload`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-koed-team-client-credential": teamClientAuthorization(
              teamBackendId,
              "team_workspace_write"
            )
          },
          body: JSON.stringify({ teamBackendId, workspaceProjectId, upload })
        }
      )
    );
  },
  async linkedSourceMetadata(
    workspaceProjectId: string,
    teamBackendId: string,
    sourceId: string
  ) {
    const query = new URLSearchParams({ teamBackendId });
    return z
      .object({
        id: z.uuid(),
        name: z.string(),
        kind: z.string(),
        status: z.string(),
        personalNoteId: z.uuid().nullable(),
        personalNoteRevisionId: z.uuid().nullable()
      })
      .strict()
      .parse(
        await sendPersonal(
          `/v1/local-edge/workspace-projects/${encodeURIComponent(workspaceProjectId)}/source-metadata/${encodeURIComponent(sourceId)}?${query}`
        )
      );
  },
  async linkedSourcesMetadata(
    workspaceProjectId: string,
    teamBackendId: string
  ) {
    const query = new URLSearchParams({ teamBackendId });
    return z
      .array(
        z
          .object({
            id: z.uuid(),
            name: z.string(),
            kind: z.string(),
            status: z.string(),
            personalNoteId: z.uuid().nullable(),
            personalNoteRevisionId: z.uuid().nullable()
          })
          .strict()
      )
      .parse(
        await sendPersonal(
          `/v1/local-edge/workspace-projects/${encodeURIComponent(workspaceProjectId)}/source-metadata?${query}`
        )
      );
  },
  async readLinkedSource(
    projectId: string,
    workspaceProjectId: string,
    teamBackendId: string,
    teamSourceId: string
  ) {
    const query = new URLSearchParams({ teamBackendId, workspaceProjectId });
    return projectSourceReadSchema.parse(
      await sendPersonal(
        `/v1/local-edge/projects/${encodeURIComponent(projectId)}/workspace-project-sources/${encodeURIComponent(teamSourceId)}/content?${query}`,
        {
          method: "GET",
          headers: {
            "x-koed-team-client-credential":
              teamClientAuthorization(teamBackendId)
          }
        }
      )
    );
  },
  async dispatchSharedWorkItem(
    projectId: string,
    itemId: string,
    value: {
      agentId: string;
      expectedProjectVersion: number;
      expectedMemberVersion: number;
      expectedWorkItemVersion: number;
      textActionId?: string;
    },
    teamBackendId: string
  ) {
    return sendPersonal(
      `/v1/projects/${encodeURIComponent(projectId)}/shared-work-items/${encodeURIComponent(itemId)}/dispatch`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-koed-team-client-credential": teamClientAuthorization(
            teamBackendId,
            "team_workspace_write"
          )
        },
        body: JSON.stringify(value)
      }
    );
  },
  async listSharedDispatches(projectId: string) {
    return z
      .object({
        items: z
          .array(
            z
              .object({
                teamWorkItemId: z.uuid(),
                executionId: z.uuid(),
                agentId: z.uuid()
              })
              .strict()
          )
          .max(500)
      })
      .strict()
      .parse(
        await sendPersonal(
          `/v1/projects/${encodeURIComponent(projectId)}/shared-work-items/dispatches`
        )
      ).items;
  },
  async linkedProject(projectId: string) {
    return z
      .object({
        ownerUserId: z.uuid(),
        teamBackendId: z.string().min(1),
        workspaceProjectId: z.uuid()
      })
      .strict()
      .parse(
        await sendPersonal(
          `/v1/projects/${encodeURIComponent(projectId)}/workspace-project-link`
        )
      );
  },
  async finishTeamLeave(teamBackendId: string, stageIds: string[]) {
    return sendPersonal("/v1/local-edge/workspace-project-team-leave-finish", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-koed-team-client-credential": teamClientAuthorization(teamBackendId)
      },
      body: JSON.stringify({ teamBackendId, stageIds })
    });
  }
});
