import { randomUUID } from "node:crypto";
import type { MemorySourceRepository } from "@koed/db";
import type { Logger } from "pino";

/**
 * Secure runtime adapter owns private-key/group-secret operations and relay wire
 * bytes. Worker receives only opaque work identity and verified materialization
 * metadata. No credential, API Token, PDS secret, manifest, or plaintext enters
 * worker config/logging/queue state.
 */
export interface PdsWorkerSecureRuntime {
  publish(input: {
    outboxId: string;
    closureId: string;
    packageId: string;
    sourceManifestHash: string;
  }): Promise<{ state: "committed" | "acked"; transportId?: string }>;
  poll(): Promise<
    Array<{
      userId: string;
      groupId: string;
      packageId: string;
      sourceManifestHash: string;
    }>
  >;
  materialize(input: {
    inboxId: string;
    groupId: string;
    packageId: string;
    sourceManifestHash: string;
  }): Promise<{
    userId: string;
    retainedPackageId: string;
    localSessionId: string;
    sourceFingerprint: string | null;
    closureHash: string;
    originDeploymentId: string;
    originDeviceId: string;
    sourceSequence: string;
    sourceClosedAt: Date;
    observedAt: Date;
    sourceItemIds: string[];
  }>;
}

let installedSecureRuntime: PdsWorkerSecureRuntime | null = null;

/** Bootstrap-only injection point for platform secret runtime; never environment/config. */
export const installPdsWorkerSecureRuntime = (
  runtime: PdsWorkerSecureRuntime
): void => {
  installedSecureRuntime = runtime;
};

export const getInstalledPdsWorkerSecureRuntime =
  (): PdsWorkerSecureRuntime | null => installedSecureRuntime;

export interface PdsLocalSyncService {
  run(): Promise<void>;
  start(): void;
  stop(): void;
}

export const createPdsLocalSyncService = (input: {
  repository: MemorySourceRepository;
  secureRuntime: PdsWorkerSecureRuntime;
  intervalMs: number;
  logger: Logger;
  workerId?: string;
}): PdsLocalSyncService => {
  const workerId = input.workerId ?? randomUUID();
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const retryAt = () => new Date(Date.now() + 5_000);
  const errorClass = (error: unknown): string =>
    error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(error.name)
      ? error.name
      : "pds_worker_failure";

  const run = async () => {
    if (running) return;
    running = true;
    try {
      for (const incoming of await input.secureRuntime.poll()) {
        await input.repository.receivePdsInbox(incoming);
      }
      const outbox = await input.repository.claimPdsOutbox({ workerId });
      for (const entry of outbox) {
        try {
          const result = await input.secureRuntime.publish({
            outboxId: entry.id,
            closureId: entry.closureId,
            packageId: entry.packageId,
            sourceManifestHash: entry.sourceManifestHash
          });
          await input.repository.completePdsOutbox({
            workerId,
            outboxId: entry.id,
            state: result.state,
            transportId: result.transportId
          });
        } catch (error) {
          await input.repository.retryPdsOutbox({
            workerId,
            outboxId: entry.id,
            errorClass: errorClass(error),
            retryAt: retryAt()
          });
        }
      }
      const inbox = await input.repository.claimPdsInbox({ workerId });
      for (const entry of inbox) {
        try {
          const materialized = await input.secureRuntime.materialize({
            inboxId: entry.id,
            groupId: entry.groupId,
            packageId: entry.packageId,
            sourceManifestHash: entry.sourceManifestHash
          });
          const result = await input.repository.materializePdsReplica({
            ...materialized,
            groupId: entry.groupId
          });
          await input.repository.heartbeatPdsWorker({
            groupId: entry.groupId,
            workerId,
            capability: "receiver_materialization"
          });
          if (result.conflict) {
            input.logger.warn(
              {
                event: {
                  name: "worker.pds.conflict_quarantined",
                  category: "pds"
                }
              },
              "PDS synchronized representation quarantined"
            );
          }
        } catch (error) {
          await input.repository.markPdsInboxFailure({
            workerId,
            inboxId: entry.id,
            errorClass: errorClass(error),
            retryAt: retryAt()
          });
        }
      }
    } catch (error) {
      input.logger.warn(
        {
          event: { name: "worker.pds.reconciliation.failed", category: "pds" },
          err: error
        },
        "PDS local reconciliation failed"
      );
    } finally {
      running = false;
    }
  };

  return {
    run,
    start() {
      if (timer) return;
      timer = setInterval(() => void run(), input.intervalMs);
      void run();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    }
  };
};
