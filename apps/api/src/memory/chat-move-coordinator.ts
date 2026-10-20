import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationActionGrantIntentSchema,
  collaborationRendererCommandSchema,
  sharedMemoryFreezeActionGrantBinding
} from "@koed/shared";
import {
  ChatMoveConflictError,
  type ChatMoveOperation,
  type ChatMoveRepository
} from "@koed/db";
import type {
  CollaborationActionGrantControl,
  CollaborationActionGrantControlContext
} from "../local-edge/collaboration-action-grant-control.js";
import type { CollaborationSharedMemoryControl } from "../local-edge/collaboration-shared-memory-control.js";

const ownerGrantSchema = z
  .object({
    shareGrants: z.array(
      z
        .object({
          id: z.uuid(),
          logicalMemoryId: z.uuid(),
          teamId: z.uuid(),
          teamWorkspaceId: z.uuid(),
          grantVersion: z.number().int().positive(),
          lifecycle: z.string(),
          revokedAt: z.string().nullable(),
          frozenAt: z.string().nullable(),
          freezeSourceAccessExpected: z.boolean(),
          source: z
            .object({
              kind: z.literal("captured_session"),
              sessionId: z.uuid()
            })
            .passthrough()
        })
        .passthrough()
    ),
    pagination: z
      .object({ hasMore: z.boolean(), nextOffset: z.number().nullable() })
      .passthrough()
  })
  .passthrough();

/** Freezes only immutable old Project-policy bindings, preserving explicit grants. */
export const createChatMoveCoordinator = (input: {
  repository: ChatMoveRepository;
  sharedMemoryControl: CollaborationSharedMemoryControl;
  actionGrantControl: CollaborationActionGrantControl;
}) => ({
  async advance(operation: ChatMoveOperation): Promise<ChatMoveOperation> {
    for (const binding of operation.bindings) {
      await input.repository.assertPending(
        operation.ownerUserId,
        operation.sessionId,
        operation.batchId
      );
      const authority =
        await input.sharedMemoryControl.resolveProjectSourceAuthority({
          localOwnerUserId: operation.ownerUserId,
          backendId: binding.backendId
        });
      const context: CollaborationActionGrantControlContext = {
        backend: authority.backend,
        localOwnerUserId: operation.ownerUserId,
        principalUserId: authority.principalUserId,
        upstreamDeviceCredentialId: authority.upstreamDeviceCredentialId,
        upstreamDeviceAuthorization: authority.upstreamDeviceAuthorization,
        operationFamilies: new Set(["share_grant_management"])
      };
      const readExact = async () => {
        let offset = 0;
        for (let page = 0; page < 51; page++) {
          const response = ownerGrantSchema.parse(
            await input.sharedMemoryControl.projectSourceRequest({
              backendId: binding.backendId,
              localOwnerUserId: operation.ownerUserId,
              method: "GET",
              path: `/v1/shared-memory/logical-memories/${binding.logicalMemoryId}/share-grants?limit=100&offset=${offset}`
            })
          );
          const found = response.shareGrants.find(
            (grant) => grant.id === binding.shareGrantId
          );
          if (found) return found;
          if (
            !response.pagination.hasMore ||
            response.pagination.nextOffset === null
          )
            break;
          offset = response.pagination.nextOffset;
        }
        throw new Error("Exact policy grant status is unavailable");
      };
      const grant = await readExact();
      if (
        grant.logicalMemoryId !== binding.logicalMemoryId ||
        grant.source.sessionId !== binding.sessionId ||
        grant.teamId !== binding.teamId ||
        grant.teamWorkspaceId !== binding.teamWorkspaceId
      )
        throw new Error("Exact policy grant source identity changed");
      const reservation = await input.repository.reserve(
        operation.ownerUserId,
        operation.sessionId,
        operation.batchId,
        binding.id,
        grant.grantVersion
      );
      if (
        grant.frozenAt ||
        ["revoked", "tombstoned", "purge_pending", "purged"].includes(
          grant.lifecycle
        ) ||
        grant.revokedAt
      ) {
        if (reservation.state !== "frozen" && reservation.state !== "resolved")
          await input.repository.ack(
            operation.ownerUserId,
            operation.sessionId,
            operation.batchId,
            { ...reservation, state: "resolved" }
          );
        continue;
      }
      if (grant.lifecycle !== "active")
        throw new Error(
          "Exact policy grant may advance again; move remains pending"
        );
      if (reservation.state === "dispatched")
        throw new Error(
          "Grant freeze outcome is uncertain; read-only reconciliation is pending"
        );
      if (reservation.state === "frozen" || reservation.state === "resolved")
        throw new Error("A closed grant resumed advancement");
      const intent = collaborationActionGrantIntentSchema.parse({
        intent: "collaboration.freeze_shared_memory_grant",
        commandRequestId: reservation.commandRequestId,
        mutationId: reservation.commandRequestId,
        teamId: binding.teamId,
        workspaceId: binding.teamWorkspaceId,
        shareGrantId: binding.shareGrantId,
        expectedGrantVersion: reservation.reviewedGrantVersion
      });
      const result = await input.actionGrantControl.dispatch(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: randomUUID(),
          command: reservation.actionGrantId
            ? "collaboration.await_action_grant"
            : "collaboration.request_action_grant",
          input: reservation.actionGrantId
            ? { actionGrant: { id: reservation.actionGrantId } }
            : { intent }
        }),
        context
      );
      if (
        reservation.actionGrantId &&
        reservation.state === "review_required" &&
        result?.ok === false &&
        result.error.code === "not_available"
      ) {
        // A definite missing review reference has never dispatched a freeze.
        // Rotate its command so the next user retry requests fresh Native review.
        await input.repository.resetReviewReservation(
          operation.ownerUserId,
          operation.sessionId,
          operation.batchId,
          binding.id,
          reservation.actionGrantId
        );
        throw new Error(
          "Exact grant Native review is no longer available; retry to request fresh review"
        );
      }
      if (!result?.ok || !result.data || !("status" in result.data))
        throw new Error("Exact grant Native review is unresolved");
      const status = result.data.status;
      if (status.approvalTier !== "native_review")
        throw new Error("Native grant review is required");
      if (status.state === "expired") {
        await input.repository.resetReviewReservation(
          operation.ownerUserId,
          operation.sessionId,
          operation.batchId,
          binding.id,
          reservation.actionGrantId
        );
        throw new Error(
          "Exact grant Native review expired; retry to request fresh review"
        );
      }
      if (["denied", "canceled", "revoked"].includes(status.state)) {
        await input.repository.cancel(
          operation.ownerUserId,
          operation.sessionId,
          operation.batchId
        );
        throw new ChatMoveConflictError(
          "Exact grant Native review ended without approval"
        );
      }
      const reviewed = {
        ...reservation,
        actionGrantId: status.actionGrant.id,
        state: "review_required" as const
      };
      if (status.state !== "approved") {
        await input.repository.ack(
          operation.ownerUserId,
          operation.sessionId,
          operation.batchId,
          reviewed
        );
        continue;
      }
      const bindingRequest = sharedMemoryFreezeActionGrantBinding({
        referenceId: status.actionGrant.id,
        mutationId: reservation.commandRequestId,
        teamId: binding.teamId,
        teamWorkspaceId: binding.teamWorkspaceId,
        shareGrantId: binding.shareGrantId,
        expectedGrantVersion: reservation.reviewedGrantVersion
      });
      const secret = await input.actionGrantControl.resolveSecret({
        reference: { id: status.actionGrant.id },
        intent,
        context
      });
      if (!secret) throw new Error("Exact grant approval is unavailable");
      await input.repository.assertPending(
        operation.ownerUserId,
        operation.sessionId,
        operation.batchId
      );
      await input.repository.ack(
        operation.ownerUserId,
        operation.sessionId,
        operation.batchId,
        { ...reviewed, state: "dispatched" }
      );
      await input.sharedMemoryControl.projectSourceRequest({
        backendId: binding.backendId,
        localOwnerUserId: operation.ownerUserId,
        method: "POST",
        path: bindingRequest.path,
        body: bindingRequest.body,
        actionGrant: secret
      });
      if (!(await readExact()).frozenAt)
        throw new Error("Exact grant freeze has not committed");
      await input.repository.ack(
        operation.ownerUserId,
        operation.sessionId,
        operation.batchId,
        { ...reviewed, state: "frozen" }
      );
    }
    const latest = await input.repository.get(
      operation.ownerUserId,
      operation.sessionId,
      operation.batchId
    );
    if (!latest) throw new Error("Conversation move operation changed");
    return latest;
  }
});
