import {
  crossIdentitySyncDeterministicUuid,
  curatedWithdrawalManifestHash,
  curatedWithdrawalReceiptSchema,
  type CuratedWithdrawalBody
} from "@koed/shared";
import type {
  CuratedClassificationOperation,
  MemorySourceRepository
} from "@koed/db";
import type { CollaborationSharedMemoryControl } from "../local-edge/collaboration-shared-memory-control.js";

export interface CuratedClassificationCoordinator {
  advance(
    operation: CuratedClassificationOperation
  ): Promise<CuratedClassificationOperation>;
  runPending(): Promise<void>;
}

export const createCuratedClassificationCoordinator = (input: {
  repository: MemorySourceRepository;
  sharedMemoryControl: CollaborationSharedMemoryControl;
  resolveSourceIdentity(ownerUserId: string): {
    sourceDeploymentProtocolId: string;
    sourceOwnerPrincipalId: string;
  } | null;
}): CuratedClassificationCoordinator => {
  const advance = async (operation: CuratedClassificationOperation) => {
    const actor = { userId: operation.ownerUserId };
    let current = operation;
    let requests = 0;
    for (const group of operation.manifest) {
      if (
        current.backendAcks.some(
          (ack) =>
            ack.backendId === group.backendId &&
            ack.logicalMemoryId === group.source.logicalMemoryId
        )
      )
        continue;
      if (requests >= 10) return current;
      requests += 1;
      const identity = input.resolveSourceIdentity(operation.ownerUserId);
      if (!identity)
        throw new Error("Verified local source identity is unavailable");
      const mutationId = crossIdentitySyncDeterministicUuid({
        protocol: "koed.curated-withdrawal-group/v1",
        operationId: operation.id,
        backendId: group.backendId,
        sourceLogicalMemoryId: group.source.logicalMemoryId
      });
      const unsigned: Omit<CuratedWithdrawalBody, "manifestHash"> = {
        source: group.source,
        ...identity,
        mutationId,
        assertionId: operation.assertionId,
        classificationVersion: operation.expectedVersion,
        items: group.items
      };
      const manifestHash = curatedWithdrawalManifestHash(unsigned);
      const raw = await input.sharedMemoryControl.projectSourceRequest({
        backendId: group.backendId,
        localOwnerUserId: operation.ownerUserId,
        method: "POST",
        path: "/v1/shared-memory/curated-withdrawals",
        body: { ...unsigned, manifestHash }
      });
      const receipt = curatedWithdrawalReceiptSchema.parse(raw.receipt);
      if (
        receipt.mutationId !== mutationId ||
        receipt.manifestHash !== manifestHash ||
        receipt.appliedVersion !== operation.expectedVersion
      ) {
        throw new Error(
          "Team withdrawal ACK did not match its immutable manifest"
        );
      }
      current = await input.repository.recordCuratedClassificationAck(
        actor,
        operation.id,
        group.backendId,
        group.source.logicalMemoryId,
        receipt,
        manifestHash
      );
    }
    return input.repository.commitCuratedClassification(actor, operation.id);
  };
  return {
    advance,
    async runPending() {
      await input.repository.prepareLegacyCuratedActivationBatch(2);
      const operations =
        await input.repository.listPendingCuratedClassificationWork();
      for (const operation of operations) {
        try {
          await advance(operation);
        } catch {
          // Put the failed row behind other pending work before a later retry.
          await input.repository.deferCuratedClassificationRetry(
            { userId: operation.ownerUserId },
            operation.id
          );
        }
      }
    }
  };
};
