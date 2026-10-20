import { randomUUID } from "node:crypto";
import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationActionGrantIntentSchema,
  collaborationRendererCommandSchema,
  sharedMemoryFreezeActionGrantBinding,
  sourceAdmissionActionGrantBinding,
  type CollaborationActionGrantIntent
} from "@koed/shared";
import type { ProjectApiRepository } from "@koed/db";
import { z } from "zod";
import type {
  CollaborationActionGrantControl,
  CollaborationActionGrantControlContext
} from "../local-edge/collaboration-action-grant-control.js";
import type { CollaborationSharedMemoryControl } from "../local-edge/collaboration-shared-memory-control.js";

const admissionSchema = z
  .object({
    admission: z
      .object({
        generation: z.number().int().nonnegative(),
        holdVersion: z.number().int().nonnegative(),
        heldBatchId: z.uuid().nullable(),
        sealed: z.boolean(),
        activeUnfrozenGrants: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();
const grantListSchema = z
  .object({
    grants: z
      .array(
        z
          .object({
            id: z.uuid(),
            teamId: z.uuid(),
            teamWorkspaceId: z.uuid(),
            grantVersion: z.number().int().positive()
          })
          .strict()
      )
      .max(10000)
  })
  .strict();
export class ProjectNativeReviewDeclined extends Error {}

export interface ProjectSourceCoordinator {
  advance(input: {
    ownerUserId: string;
    projectId: string;
    batchId: string;
    operation: NonNullable<
      Awaited<ReturnType<ProjectApiRepository["getDeleteOperation"]>>
    >;
  }): Promise<void>;
  cancel(input: {
    ownerUserId: string;
    projectId: string;
    batchId: string;
    operation: NonNullable<
      Awaited<ReturnType<ProjectApiRepository["getDeleteOperation"]>>
    >;
  }): Promise<boolean>;
}

export const createProjectSourceCoordinator = (input: {
  repository: ProjectApiRepository;
  sharedMemoryControl: CollaborationSharedMemoryControl;
  actionGrantControl: CollaborationActionGrantControl;
  resolveSourceIdentity: (ownerUserId: string) => {
    sourceDeploymentProtocolId: string;
    sourceOwnerPrincipalId: string;
  } | null;
}): ProjectSourceCoordinator => {
  const context = async (
    ownerUserId: string,
    backendId: string
  ): Promise<CollaborationActionGrantControlContext> => {
    const authority =
      await input.sharedMemoryControl.resolveProjectSourceAuthority({
        localOwnerUserId: ownerUserId,
        backendId
      });
    return {
      backend: authority.backend,
      localOwnerUserId: ownerUserId,
      principalUserId: authority.principalUserId,
      upstreamDeviceCredentialId: authority.upstreamDeviceCredentialId,
      upstreamDeviceAuthorization: authority.upstreamDeviceAuthorization,
      operationFamilies: new Set(["share_grant_management"])
    };
  };
  const actionStatus = async (
    intent: CollaborationActionGrantIntent,
    authority: CollaborationActionGrantControlContext,
    referenceId?: string
  ) => {
    const command = collaborationRendererCommandSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: referenceId
        ? "collaboration.await_action_grant"
        : "collaboration.request_action_grant",
      input: referenceId ? { actionGrant: { id: referenceId } } : { intent }
    });
    const result = await input.actionGrantControl.dispatch(command, authority);
    if (!result || !result.ok || !result.data || !("status" in result.data))
      throw new Error("Project source action review is unresolved");
    return result.data.status;
  };
  const actionSecret = async (
    intent: CollaborationActionGrantIntent,
    authority: CollaborationActionGrantControlContext,
    actionGrantId: string
  ) => {
    const secret = await input.actionGrantControl.resolveSecret({
      reference: { id: actionGrantId },
      intent,
      context: authority
    });
    if (!secret) throw new Error("Project source action grant is unavailable");
    return secret;
  };
  return {
    async cancel({ ownerUserId, projectId, batchId, operation }) {
      const identity = input.resolveSourceIdentity(ownerUserId);
      if (!identity) return false;
      let allClosed = true;
      for (const source of operation.sources) {
        if (!source.logicalMemoryId) continue;
        for (const backend of source.backends) {
          const backendId = backend.backendId;
          const sourceRef = {
            kind: "captured_session" as const,
            sessionId: source.sessionId,
            logicalMemoryId: source.logicalMemoryId
          };
          const path = `/v1/shared-memory/sources/${source.logicalMemoryId}/admission`;
          try {
            const authority = await context(ownerUserId, backendId);
            let admission = admissionSchema.parse(
              await input.sharedMemoryControl.projectSourceRequest({
                backendId,
                localOwnerUserId: ownerUserId,
                method: "GET",
                path
              })
            ).admission;
            if (admission.heldBatchId === batchId) {
              const commandRequestId = randomUUID();
              const intent = collaborationActionGrantIntentSchema.parse({
                intent: "collaboration.source_admission",
                commandRequestId,
                source: sourceRef,
                ...identity,
                logicalMemoryId: source.logicalMemoryId,
                batchId,
                expectedGeneration: admission.generation,
                expectedHoldVersion: admission.holdVersion,
                operation: "cancel"
              });
              const status = await actionStatus(intent, authority);
              if (
                status.approvalTier !== "direct" ||
                status.state !== "approved"
              )
                throw new Error("Project source cancellation is unresolved");
              const binding = sourceAdmissionActionGrantBinding({
                referenceId: status.actionGrant.id,
                source: sourceRef,
                ...identity,
                logicalMemoryId: source.logicalMemoryId,
                batchId,
                expectedGeneration: admission.generation,
                expectedHoldVersion: admission.holdVersion,
                operation: "cancel"
              });
              await input.sharedMemoryControl.projectSourceRequest({
                backendId,
                localOwnerUserId: ownerUserId,
                method: "POST",
                path,
                body: binding.body,
                actionGrant: await actionSecret(
                  intent,
                  authority,
                  status.actionGrant.id
                )
              });
              admission = admissionSchema.parse(
                await input.sharedMemoryControl.projectSourceRequest({
                  backendId,
                  localOwnerUserId: ownerUserId,
                  method: "GET",
                  path
                })
              ).admission;
            }
            if (admission.heldBatchId !== null) {
              allClosed = false;
              continue;
            }
            await input.repository.recordBackendAck(
              ownerUserId,
              projectId,
              batchId,
              {
                logicalMemoryId: source.logicalMemoryId,
                backendId,
                generation: admission.generation,
                holdVersion: admission.holdVersion,
                sealed: false,
                cancelled: true
              }
            );
          } catch {
            allClosed = false;
          }
        }
      }
      return allClosed;
    },
    async advance({ ownerUserId, projectId, batchId, operation }) {
      const identity = input.resolveSourceIdentity(ownerUserId);
      if (!identity)
        throw new Error("Verified Project source identity is unavailable");
      for (const source of operation.sources) {
        if (!source.logicalMemoryId) continue;
        for (const backend of source.backends) {
          const backendId = backend.backendId;
          const sourceRef = {
            kind: "captured_session" as const,
            sessionId: source.sessionId,
            logicalMemoryId: source.logicalMemoryId
          };
          const authority = await context(ownerUserId, backendId);
          const admissionPath = `/v1/shared-memory/sources/${source.logicalMemoryId}/admission`;
          const readAdmission = async () =>
            admissionSchema.parse(
              await input.sharedMemoryControl.projectSourceRequest({
                backendId,
                localOwnerUserId: ownerUserId,
                method: "GET",
                path: admissionPath
              })
            ).admission;
          let admission:
            | ReturnType<typeof admissionSchema.parse>["admission"]
            | null = null;
          try {
            admission = await readAdmission();
          } catch {
            // A never-materialized source can be reserved only by the exact
            // provenance-bound prepare action. No generic 403/404 proves zero.
          }
          if (!admission || admission.heldBatchId !== batchId) {
            if (admission?.heldBatchId)
              throw new Error("Source admission belongs to another batch");
            const commandRequestId = randomUUID();
            const intent = collaborationActionGrantIntentSchema.parse({
              intent: "collaboration.source_admission",
              commandRequestId,
              source: sourceRef,
              ...identity,
              logicalMemoryId: source.logicalMemoryId,
              batchId,
              expectedGeneration: admission?.generation ?? 0,
              expectedHoldVersion: admission?.holdVersion ?? 0,
              operation: "prepare"
            });
            const status = await actionStatus(intent, authority);
            if (status.approvalTier !== "direct" || status.state !== "approved")
              throw new Error("Project source preparation is unresolved");
            const binding = sourceAdmissionActionGrantBinding({
              referenceId: status.actionGrant.id,
              source: sourceRef,
              ...identity,
              logicalMemoryId: source.logicalMemoryId,
              batchId,
              expectedGeneration: admission?.generation ?? 0,
              expectedHoldVersion: admission?.holdVersion ?? 0,
              operation: "prepare"
            });
            await input.sharedMemoryControl.projectSourceRequest({
              backendId,
              localOwnerUserId: ownerUserId,
              method: "POST",
              path: admissionPath,
              body: binding.body,
              actionGrant: await actionSecret(
                intent,
                authority,
                status.actionGrant.id
              )
            });
            admission = await readAdmission();
          }
          if (admission.heldBatchId !== batchId)
            throw new Error("Project source hold did not bind batch");
          await input.repository.recordBackendAck(
            ownerUserId,
            projectId,
            batchId,
            {
              logicalMemoryId: source.logicalMemoryId,
              backendId,
              generation: admission.generation,
              holdVersion: admission.holdVersion,
              sealed: admission.sealed
            }
          );
          const grants = grantListSchema.parse(
            await input.sharedMemoryControl.projectSourceRequest({
              backendId,
              localOwnerUserId: ownerUserId,
              method: "GET",
              path: `${admissionPath}/grants`
            })
          ).grants;
          for (const grant of grants) {
            // Persist the immutable review identity before remote dispatch.
            // A concurrent retry receives the same command and action grant.
            const reservation = await input.repository.reserveGrantFreezeReview(
              ownerUserId,
              projectId,
              batchId,
              {
                logicalMemoryId: source.logicalMemoryId,
                backendId,
                shareGrantId: grant.id,
                reviewedGrantVersion: grant.grantVersion
              }
            );
            if (
              reservation.state === "frozen" ||
              reservation.state === "resolved"
            )
              throw new Error("Previously closed Share Grant is active again");
            const commandRequestId = reservation.commandRequestId;
            const mutationId = commandRequestId;
            const intent = collaborationActionGrantIntentSchema.parse({
              intent: "collaboration.freeze_shared_memory_grant",
              commandRequestId,
              mutationId,
              teamId: grant.teamId,
              workspaceId: grant.teamWorkspaceId,
              shareGrantId: grant.id,
              expectedGrantVersion: grant.grantVersion
            });
            const status = await actionStatus(
              intent,
              authority,
              reservation.actionGrantId ?? undefined
            );
            if (status.approvalTier !== "native_review")
              throw new Error(
                "Independent Native Share Grant review is required"
              );
            if (
              ["denied", "canceled", "expired", "revoked"].includes(
                status.state
              )
            )
              throw new ProjectNativeReviewDeclined(
                "Project Share Grant freeze review ended"
              );
            if (status.state !== "approved") {
              await input.repository.recordGrantFreezeAck(
                ownerUserId,
                projectId,
                batchId,
                {
                  logicalMemoryId: source.logicalMemoryId,
                  backendId,
                  shareGrantId: grant.id,
                  reviewedGrantVersion: grant.grantVersion,
                  grantVersion: grant.grantVersion,
                  state: "review_required",
                  actionGrantId: status.actionGrant.id,
                  commandRequestId
                }
              );
              continue;
            }
            const binding = sharedMemoryFreezeActionGrantBinding({
              referenceId: status.actionGrant.id,
              mutationId,
              teamId: grant.teamId,
              teamWorkspaceId: grant.teamWorkspaceId,
              shareGrantId: grant.id,
              expectedGrantVersion: grant.grantVersion
            });
            await input.sharedMemoryControl.projectSourceRequest({
              backendId,
              localOwnerUserId: ownerUserId,
              method: "POST",
              path: binding.path,
              body: binding.body,
              actionGrant: await actionSecret(
                intent,
                authority,
                status.actionGrant.id
              )
            });
            await input.repository.recordGrantFreezeAck(
              ownerUserId,
              projectId,
              batchId,
              {
                logicalMemoryId: source.logicalMemoryId,
                backendId,
                shareGrantId: grant.id,
                reviewedGrantVersion: grant.grantVersion,
                grantVersion: grant.grantVersion + 1,
                state: "frozen",
                actionGrantId: status.actionGrant.id,
                commandRequestId
              }
            );
          }
          const after = grantListSchema.parse(
            await input.sharedMemoryControl.projectSourceRequest({
              backendId,
              localOwnerUserId: ownerUserId,
              method: "GET",
              path: `${admissionPath}/grants`
            })
          ).grants;
          if (after.length > 0) continue;
          admission = await readAdmission();
          if (!admission.sealed) {
            const commandRequestId = randomUUID();
            const intent = collaborationActionGrantIntentSchema.parse({
              intent: "collaboration.source_admission",
              commandRequestId,
              source: sourceRef,
              ...identity,
              logicalMemoryId: source.logicalMemoryId,
              batchId,
              expectedGeneration: admission.generation,
              expectedHoldVersion: admission.holdVersion,
              operation: "seal"
            });
            const status = await actionStatus(intent, authority);
            if (status.approvalTier !== "direct" || status.state !== "approved")
              throw new Error("Project source seal is unresolved");
            const binding = sourceAdmissionActionGrantBinding({
              referenceId: status.actionGrant.id,
              source: sourceRef,
              ...identity,
              logicalMemoryId: source.logicalMemoryId,
              batchId,
              expectedGeneration: admission.generation,
              expectedHoldVersion: admission.holdVersion,
              operation: "seal"
            });
            await input.sharedMemoryControl.projectSourceRequest({
              backendId,
              localOwnerUserId: ownerUserId,
              method: "POST",
              path: admissionPath,
              body: binding.body,
              actionGrant: await actionSecret(
                intent,
                authority,
                status.actionGrant.id
              )
            });
            admission = await readAdmission();
          }
          if (
            admission.heldBatchId !== batchId ||
            !admission.sealed ||
            admission.activeUnfrozenGrants !== 0
          )
            throw new Error("Project source seal is incomplete");
          const latest = await input.repository.getDeleteOperationByBatch(
            ownerUserId,
            projectId,
            batchId
          );
          if (!latest) throw new Error("Project source operation changed");
          for (const prior of latest.grantFreezeAcks.filter(
            (ack) =>
              ack.backendId === backendId &&
              ack.logicalMemoryId === source.logicalMemoryId &&
              (ack.state === "reserved" || ack.state === "review_required")
          )) {
            await input.repository.recordGrantFreezeAck(
              ownerUserId,
              projectId,
              batchId,
              {
                ...prior,
                state: "resolved"
              }
            );
          }
          await input.repository.recordBackendAck(
            ownerUserId,
            projectId,
            batchId,
            {
              logicalMemoryId: source.logicalMemoryId,
              backendId,
              generation: admission.generation,
              holdVersion: admission.holdVersion,
              sealed: true
            }
          );
        }
      }
    }
  };
};
