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
  heartbeatGroups?(): Promise<string[]>;
  waitForWake?(signal?: AbortSignal): Promise<void>;
  reconcileArtifacts?(): Promise<number>;
  publish(input: {
    workerId: string;
    outboxId: string;
    closureId: string;
    packageId: string;
    sourceManifestHash: string;
  }): Promise<{ state: "committed" | "acked"; transportId?: string }>;
  publishArtifact?(input: {
    workerId: string;
    outboxId: string;
    artifactId: string;
    packageId: string;
    manifestHash: string;
  }): Promise<{ state: "committed" | "acked"; transportId: string }>;
  outboundState(input: {
    groupId: string;
    transportId: string;
  }): Promise<"committed" | "acked">;
  /** Durable lifecycle controls run before mailbox, publication, or Recall work. */
  pollLifecycle?(): Promise<void>;
  poll(): Promise<
    Array<{
      userId: string;
      groupId: string;
      packageId: string;
      sourceManifestHash: string;
      transportId?: string;
    }>
  >;
  acknowledge?(input: {
    inboxId: string;
    groupId: string;
    packageId: string;
    sourceManifestHash: string;
    originDeviceId: string;
    sourceSequence?: string;
  }): Promise<void>;
  materialize(input: {
    workerId: string;
    inboxId: string;
    groupId: string;
    packageId: string;
    sourceManifestHash: string;
  }): Promise<
    | {
        kind?: "source";
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
      }
    | {
        kind: "artifact";
        userId: string;
        originDeviceId: string;
        artifactState: "ready" | "incompatible";
      }
  >;
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
  stop(): Promise<void>;
}

type PdsWakeClient = {
  query(sql: string): Promise<unknown>;
  on(
    event: "notification",
    listener: (message: { channel: string; payload?: string }) => void
  ): void;
  on(event: "error", listener: (error: unknown) => void): void;
  removeAllListeners(event?: "notification" | "error"): void;
  release(): void;
};

export const createPdsLocalSyncService = (input: {
  repository: MemorySourceRepository;
  secureRuntime: PdsWorkerSecureRuntime;
  wakePool: { connect(): Promise<PdsWakeClient> };
  logger: Logger;
  workerId?: string;
}): PdsLocalSyncService => {
  const workerId = input.workerId ?? randomUUID();
  let running = false;
  let runAgain = false;
  let stopped = true;
  let wakeClient: PdsWakeClient | null = null;
  let wakeReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeReconnectAttempt = 0;
  let dueTimer: ReturnType<typeof setTimeout> | null = null;
  let remoteWakeAbort: AbortController | null = null;
  let remoteWakeReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let remoteWakeReconnectAttempt = 0;
  let reconciliationRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let reconciliationFailureAttempt = 0;
  let runtimeAvailable = false;

  const retryAt = (attempt: number) =>
    new Date(
      Date.now() + Math.min(5 * 60_000, 1_000 * 2 ** Math.min(attempt, 8))
    );
  const errorClass = (error: unknown): string =>
    error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(error.name)
      ? error.name
      : "pds_worker_failure";
  const permanentFailure = (error: unknown): boolean =>
    error instanceof Error &&
    /(?:crypto|signature|authority|certificate|policy|floor|tamper|quarantine)/i.test(
      `${error.name} ${error.message}`
    );

  const processOnce = async (): Promise<{
    failed: boolean;
    needsDrain: boolean;
  }> => {
    let needsDrain = false;
    try {
      const groups = (await input.secureRuntime.heartbeatGroups?.()) ?? [];
      runtimeAvailable = groups.length > 0;
      if (!runtimeAvailable) {
        remoteWakeAbort?.abort();
        remoteWakeAbort = null;
        return { failed: false, needsDrain: false };
      }
      for (const groupId of groups) {
        await Promise.all([
          input.repository.heartbeatPdsWorker({
            groupId,
            workerId,
            capability: "source_publication"
          }),
          input.repository.heartbeatPdsWorker({
            groupId,
            workerId,
            capability: "receiver_materialization"
          })
        ]);
      }
      await input.secureRuntime.pollLifecycle?.();
      const stagedArtifacts =
        (await input.secureRuntime.reconcileArtifacts?.()) ?? 0;
      needsDrain ||= stagedArtifacts >= 50;
      const incomingPackages = await input.secureRuntime.poll();
      needsDrain ||= incomingPackages.length >= 50;
      for (const incoming of incomingPackages) {
        await input.repository.receivePdsInbox(incoming);
      }
      const outbox = await input.repository.claimPdsOutbox({ workerId });
      needsDrain ||= outbox.length >= 10;
      for (const entry of outbox) {
        try {
          // Pause may change after claim. Check durable policy before relay I/O.
          if (
            !(await input.repository.beginPdsOutboxNetworkAction({
              workerId,
              outboxId: entry.id
            }))
          ) {
            continue;
          }
          const result = await input.secureRuntime.publish({
            workerId,
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
          await input.repository.heartbeatPdsWorker({
            groupId: entry.groupId,
            workerId,
            capability: "source_publication"
          });
        } catch (error) {
          input.logger.warn(
            {
              err: error,
              event: {
                name: "worker.pds.outbox.failed",
                category: "pds"
              },
              pds: {
                outboxId: entry.id,
                attemptCount: entry.attemptCount
              }
            },
            "PDS outbound package processing failed"
          );
          await input.repository.retryPdsOutbox({
            workerId,
            outboxId: entry.id,
            errorClass: errorClass(error),
            retryAt: retryAt(entry.attemptCount)
          });
        }
      }
      const artifactOutbox = await input.repository.claimPdsArtifactOutbox({
        workerId
      });
      needsDrain ||= artifactOutbox.length >= 10;
      for (const entry of artifactOutbox) {
        try {
          if (!input.secureRuntime.publishArtifact) {
            throw new Error("PdsArtifactRuntimeUnavailableError");
          }
          if (
            !(await input.repository.beginPdsArtifactOutboxNetworkAction({
              workerId,
              outboxId: entry.id
            }))
          ) {
            continue;
          }
          const result = await input.secureRuntime.publishArtifact({
            workerId,
            outboxId: entry.id,
            artifactId: entry.artifactId,
            packageId: entry.packageId,
            manifestHash: entry.manifestHash
          });
          await input.repository.completePdsArtifactOutbox({
            workerId,
            outboxId: entry.id,
            state: result.state,
            transportId: result.transportId
          });
        } catch (error) {
          input.logger.warn(
            {
              err: error,
              event: {
                name: "worker.pds.artifact_outbox.failed",
                category: "pds"
              },
              pds: {
                artifactId: entry.artifactId,
                attemptCount: entry.attemptCount
              }
            },
            "PDS outbound artifact processing failed"
          );
          await input.repository.retryPdsArtifactOutbox({
            workerId,
            outboxId: entry.id,
            errorClass: errorClass(error),
            retryAt: retryAt(entry.attemptCount)
          });
        }
      }
      const committedOutbox = await input.repository.claimPdsCommittedOutbox({
        workerId
      });
      needsDrain ||= committedOutbox.length >= 10;
      for (const entry of committedOutbox) {
        try {
          const state = await input.secureRuntime.outboundState({
            groupId: entry.groupId,
            transportId: entry.transportId
          });
          if (state === "acked") {
            await input.repository.completePdsOutbox({
              workerId,
              outboxId: entry.id,
              state: "acked",
              transportId: entry.transportId
            });
          } else {
            await input.repository.releasePdsCommittedOutbox({
              workerId,
              outboxId: entry.id
            });
          }
        } catch (error) {
          input.logger.warn(
            {
              err: error,
              event: {
                name: "worker.pds.outbox_ack_reconciliation.failed",
                category: "pds"
              },
              pds: { outboxId: entry.id }
            },
            "PDS outbound acknowledgement reconciliation failed"
          );
          await input.repository.releasePdsCommittedOutbox({
            workerId,
            outboxId: entry.id
          });
        }
      }
      const committedArtifactOutbox =
        await input.repository.claimPdsArtifactOutbox({
          workerId,
          state: "committed"
        });
      needsDrain ||= committedArtifactOutbox.length >= 10;
      for (const entry of committedArtifactOutbox) {
        try {
          if (!entry.transportId) {
            throw new Error("PdsArtifactTransportIdentityError");
          }
          const state = await input.secureRuntime.outboundState({
            groupId: entry.groupId,
            transportId: entry.transportId
          });
          if (state === "acked") {
            await input.repository.completePdsArtifactOutbox({
              workerId,
              outboxId: entry.id,
              state: "acked",
              transportId: entry.transportId
            });
          } else {
            await input.repository.releasePdsCommittedArtifactOutbox({
              workerId,
              outboxId: entry.id
            });
          }
        } catch (error) {
          input.logger.warn(
            {
              err: error,
              event: {
                name: "worker.pds.artifact_outbox_ack.failed",
                category: "pds"
              },
              pds: { artifactId: entry.artifactId }
            },
            "PDS artifact acknowledgement reconciliation failed"
          );
          await input.repository.releasePdsCommittedArtifactOutbox({
            workerId,
            outboxId: entry.id
          });
        }
      }
      const inbox = await input.repository.claimPdsInbox({ workerId });
      needsDrain ||= inbox.length >= 10;
      for (const entry of inbox) {
        try {
          const materialized = await input.secureRuntime.materialize({
            workerId,
            inboxId: entry.id,
            groupId: entry.groupId,
            packageId: entry.packageId,
            sourceManifestHash: entry.sourceManifestHash
          });
          if (materialized.kind === "artifact") {
            await input.secureRuntime.acknowledge?.({
              inboxId: entry.id,
              groupId: entry.groupId,
              packageId: entry.packageId,
              sourceManifestHash: entry.sourceManifestHash,
              originDeviceId: materialized.originDeviceId
            });
            if (
              !(await input.repository.completePdsInbox({
                workerId,
                inboxId: entry.id,
                state: "ready"
              }))
            ) {
              throw new Error("PdsInboxLeaseUnavailableError");
            }
            continue;
          }
          const result = await input.repository.materializePdsReplica({
            ...materialized,
            groupId: entry.groupId,
            workerId,
            inboxId: entry.id
          });
          // ACK only after durable verification, local materialization, and handoff.
          await input.secureRuntime.acknowledge?.({
            inboxId: entry.id,
            groupId: entry.groupId,
            packageId: entry.packageId,
            sourceManifestHash: entry.sourceManifestHash,
            originDeviceId: materialized.originDeviceId,
            sourceSequence: materialized.sourceSequence
          });
          if (
            !(await input.repository.completePdsInbox({
              workerId,
              inboxId: entry.id,
              retainedPackageId: materialized.retainedPackageId,
              state: result.state === "quarantined" ? "quarantined" : "ready"
            }))
          ) {
            throw new Error("PdsInboxLeaseUnavailableError");
          }
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
          input.logger.warn(
            {
              err: error,
              event: {
                name: "worker.pds.inbox.failed",
                category: "pds"
              },
              pds: {
                inboxId: entry.id,
                attemptCount: entry.attemptCount
              }
            },
            "PDS inbound package processing failed"
          );
          await input.repository.markPdsInboxFailure({
            workerId,
            inboxId: entry.id,
            errorClass: errorClass(error),
            retryAt: retryAt(entry.attemptCount),
            permanent: permanentFailure(error)
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
      return { failed: true, needsDrain: false };
    }
    return { failed: false, needsDrain };
  };

  const scheduleDueWake = async (): Promise<void> => {
    if (stopped) return;
    const wakeAt = await input.repository.getPdsLocalSyncWakeAt();
    if (dueTimer) clearTimeout(dueTimer);
    dueTimer = null;
    if (!wakeAt) return;
    const delayMs = Math.max(0, Date.parse(wakeAt) - Date.now());
    dueTimer = setTimeout(
      () => {
        dueTimer = null;
        requestProcessing();
      },
      Math.min(delayMs, 2_147_000_000)
    );
    dueTimer.unref?.();
  };

  const scheduleRemoteWake = (): void => {
    if (
      stopped ||
      remoteWakeAbort ||
      remoteWakeReconnectTimer ||
      !runtimeAvailable ||
      !input.secureRuntime.waitForWake
    )
      return;
    const controller = new AbortController();
    remoteWakeAbort = controller;
    void input.secureRuntime
      .waitForWake(controller.signal)
      .then(() => {
        remoteWakeReconnectAttempt = 0;
        if (!stopped) requestProcessing();
      })
      .catch(() => {
        if (stopped || controller.signal.aborted) return;
        const delayMs = Math.min(250 * 2 ** remoteWakeReconnectAttempt, 10_000);
        remoteWakeReconnectAttempt += 1;
        remoteWakeReconnectTimer = setTimeout(() => {
          remoteWakeReconnectTimer = null;
          scheduleRemoteWake();
        }, delayMs);
        remoteWakeReconnectTimer.unref?.();
      })
      .finally(() => {
        if (remoteWakeAbort === controller) remoteWakeAbort = null;
        if (!stopped && !remoteWakeReconnectTimer) scheduleRemoteWake();
      });
  };

  const requestProcessing = (): void => {
    if (stopped || reconciliationRetryTimer) return;
    if (running) {
      runAgain = true;
      return;
    }
    running = true;
    void (async () => {
      do {
        runAgain = false;
        const outcome = await processOnce();
        if (outcome.failed) {
          const delayMs = Math.min(
            1_000 * 2 ** reconciliationFailureAttempt,
            30_000
          );
          reconciliationFailureAttempt += 1;
          reconciliationRetryTimer = setTimeout(() => {
            reconciliationRetryTimer = null;
            requestProcessing();
          }, delayMs);
          reconciliationRetryTimer.unref?.();
          break;
        }
        reconciliationFailureAttempt = 0;
        if (outcome.needsDrain) runAgain = true;
      } while (!stopped && runAgain);
      if (!reconciliationRetryTimer) await scheduleDueWake();
      scheduleRemoteWake();
    })().finally(() => {
      running = false;
      if (!stopped && runAgain) requestProcessing();
    });
  };

  const run = async (): Promise<void> => {
    await processOnce();
  };

  const scheduleWakeReconnect = (): void => {
    if (stopped || wakeReconnectTimer) return;
    const delayMs = Math.min(250 * 2 ** wakeReconnectAttempt, 10_000);
    wakeReconnectAttempt += 1;
    wakeReconnectTimer = setTimeout(() => {
      wakeReconnectTimer = null;
      void connectWakeClient();
    }, delayMs);
    wakeReconnectTimer.unref?.();
  };

  const connectWakeClient = async (): Promise<void> => {
    if (stopped || wakeClient) return;
    try {
      const client = await input.wakePool.connect();
      if (stopped) {
        client.release();
        return;
      }
      wakeClient = client;
      await client.query("listen koed_pds_local_sync");
      wakeReconnectAttempt = 0;
      client.on("notification", (message) => {
        if (message.channel === "koed_pds_local_sync") requestProcessing();
      });
      client.on("error", () => {
        if (wakeClient === client) wakeClient = null;
        client.removeAllListeners();
        client.release();
        scheduleWakeReconnect();
      });
      requestProcessing();
    } catch {
      scheduleWakeReconnect();
    }
  };

  return {
    run,
    start() {
      if (!stopped) return;
      stopped = false;
      void connectWakeClient();
    },
    async stop() {
      stopped = true;
      runAgain = false;
      if (dueTimer) clearTimeout(dueTimer);
      dueTimer = null;
      if (wakeReconnectTimer) clearTimeout(wakeReconnectTimer);
      wakeReconnectTimer = null;
      if (remoteWakeReconnectTimer) clearTimeout(remoteWakeReconnectTimer);
      remoteWakeReconnectTimer = null;
      if (reconciliationRetryTimer) clearTimeout(reconciliationRetryTimer);
      reconciliationRetryTimer = null;
      remoteWakeAbort?.abort();
      remoteWakeAbort = null;
      if (wakeClient) {
        const client = wakeClient;
        wakeClient = null;
        client.removeAllListeners();
        await client
          .query("unlisten koed_pds_local_sync")
          .catch(() => undefined);
        client.release();
      }
    }
  };
};
