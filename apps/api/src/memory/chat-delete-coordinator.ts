import type { ChatDeleteOperation, ChatDeleteRepository } from "@koed/db";
import type { CollaborationActionGrantControl } from "../local-edge/collaboration-action-grant-control.js";
import type { CollaborationSharedMemoryControl } from "../local-edge/collaboration-shared-memory-control.js";
import { createSourceLifecycleCoordinator } from "../projects/delete-coordinator.js";

/** Exact-source grant closure for a single owner-owned Conversation. */
export const createChatDeleteCoordinator = (input: {
  repository: ChatDeleteRepository;
  sharedMemoryControl: CollaborationSharedMemoryControl;
  actionGrantControl: CollaborationActionGrantControl;
  resolveSourceIdentity: (ownerUserId: string) => {
    sourceDeploymentProtocolId: string;
    sourceOwnerPrincipalId: string;
  } | null;
}) => {
  const lifecycle = createSourceLifecycleCoordinator({
    ...input,
    storeForOperation(operation) {
      if (!("chatRemoval" in operation))
        throw new Error("Chat deletion requires its own source manifest");
      const repository = input.repository;
      return {
        recordBackendAck: repository.recordChatBackendAck.bind(repository),
        reserveGrantFreezeReview:
          repository.reserveChatGrantFreezeReview.bind(repository),
        recordGrantFreezeAck:
          repository.recordChatGrantFreezeAck.bind(repository),
        getOperation: repository.getChatDeleteOperation.bind(repository)
      };
    }
  });
  return {
    advance: (operation: ChatDeleteOperation) =>
      lifecycle.advance({
        ownerUserId: operation.ownerUserId,
        resourceId: operation.sessionId,
        batchId: operation.batchId,
        operation
      }),
    cancel: (operation: ChatDeleteOperation) =>
      lifecycle.cancel({
        ownerUserId: operation.ownerUserId,
        resourceId: operation.sessionId,
        batchId: operation.batchId,
        operation
      })
  };
};
