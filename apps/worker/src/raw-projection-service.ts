import type { Visibility } from "@koed/core";
import type { EmbeddableSourceType, MemorySourceRepository } from "@koed/db";
import {
  lcmCompactQueueName,
  memoryEmbedQueueName,
  type KoedWorkClass
} from "@koed/shared";
import type { Logger } from "pino";
import {
  decideHistoricalAdmission,
  type HistoricalAdmissionDecision,
  type HistoricalImportBatchConfig
} from "./historical-admission.js";

interface ProjectionReport {
  actors: number;
  noProgressActors: number;
  projected: number;
  scanned: number;
  waitingForAgentSeal: number;
}

interface HistoricalAdmissionHealth {
  apiHealthy: boolean;
  embeddingServiceHealthy: boolean;
  capacityProfileHealthy: boolean;
  queueHealthy: boolean;
}

interface HistoricalBatchResult {
  decision: HistoricalAdmissionDecision;
  report: ProjectionReport;
}

interface ProjectionWakeClient {
  query(sql: string): Promise<unknown>;
  on(
    event: "notification",
    listener: (message: { channel: string; payload?: string }) => void
  ): void;
  on(event: "error", listener: (error: Error) => void): void;
  removeAllListeners(): void;
  release(): void;
}

export interface RawProjectionServiceConfig {
  actorLimit: number;
  batchLimit: number;
  embeddingDispatchKey: string;
  enqueueLcmCompaction(
    requesterContext: { userId: string },
    visibility: Visibility,
    dispatchKey: string,
    workClass?: KoedWorkClass,
    jobId?: string,
    sessionId?: string,
    finalize?: boolean
  ): Promise<unknown>;
  enqueueProjectedMemoryEventProcessing(
    actor: { userId: string },
    scopes: Awaited<
      ReturnType<MemorySourceRepository["projectPendingConversationItems"]>
    >["memoryEventScopes"]
  ): Promise<unknown>;
  enqueueSourceEmbedding(
    sourceType: EmbeddableSourceType,
    sourceId: string,
    dispatchKey: string,
    workClass?: KoedWorkClass,
    jobId?: string
  ): Promise<unknown>;
  getHistoricalAdmissionHealth(): Promise<HistoricalAdmissionHealth>;
  recoverProjectedMemoryEventProcessing(): Promise<number>;
  historicalImport: HistoricalImportBatchConfig;
  logger: Logger;
  repository: MemorySourceRepository;
  wakePool?: { connect(): Promise<ProjectionWakeClient> };
}

export interface RawProjectionService {
  run(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

const emptyProjectionReport = (): ProjectionReport => ({
  actors: 0,
  noProgressActors: 0,
  projected: 0,
  scanned: 0,
  waitingForAgentSeal: 0
});

const addProjectionResult = (
  report: ProjectionReport,
  result: Awaited<
    ReturnType<MemorySourceRepository["projectPendingConversationItems"]>
  >
): void => {
  report.actors += 1;
  report.projected += result.rawItemsProjected;
  report.scanned += result.rawItemsScanned;
  report.waitingForAgentSeal += result.rawItemsWaitingForAgentSeal;
  if (result.rawItemsScanned > 0 && result.rawItemsProjected === 0) {
    report.noProgressActors += 1;
  }
};

const projectActors = async (
  config: RawProjectionServiceConfig,
  workClass: "live_capture_projection" | "historical_import_backfill",
  input: { limit: number; maxBytes?: number; maxRuntimeMs?: number },
  actorLimit: number
): Promise<ProjectionReport> => {
  const report = emptyProjectionReport();
  const actors = await config.repository.listConversationProjectionActors({
    limit: actorLimit,
    workClass
  });
  for (const actor of actors) {
    const result = await config.repository.projectPendingConversationItems(
      actor,
      { ...input, workClass }
    );
    await config.enqueueProjectedMemoryEventProcessing(
      actor,
      result.memoryEventScopes
    );
    addProjectionResult(report, result);
  }
  return report;
};

const processRebuildActors = async (
  config: RawProjectionServiceConfig
): Promise<{ jobs: number; events: number }> => {
  const actors = await config.repository.listSemanticMemoryRebuildActors({
    limit: config.actorLimit
  });
  let events = 0;
  let jobs = 0;
  for (const actor of actors) {
    const result = await config.repository.processDueSemanticMemoryRebuilds(
      actor,
      { limit: config.batchLimit }
    );
    await config.enqueueProjectedMemoryEventProcessing(
      actor,
      result.memoryEventScopes
    );
    events += result.memoryEventsCreated;
    jobs += result.jobsCompleted;
  }
  return { events, jobs };
};

const logHistoricalDecision = (
  logger: Logger,
  decision: HistoricalAdmissionDecision,
  backlog: Awaited<
    ReturnType<MemorySourceRepository["getConversationProjectionBacklog"]>
  >,
  report: ProjectionReport
): void => {
  logger.info(
    {
      event: {
        name: "worker.historical_import.admission",
        category: "projection"
      },
      historicalImport: {
        admitted: decision.admitted,
        reason: decision.admitted ? null : decision.reason,
        pendingRows: backlog.historicalImportRows,
        pendingBytes: backlog.historicalImportBytes,
        projectedRows: report.projected,
        scannedRows: report.scanned
      }
    },
    "historical import admission evaluated"
  );
};

const reconcileTerminalHistoricalLcmJobs = async (
  config: RawProjectionServiceConfig
): Promise<void> => {
  if (
    !("listHistoricalImportSourcesNeedingLcmFinalization" in config.repository)
  ) {
    return;
  }
  const sources =
    await config.repository.listHistoricalImportSourcesNeedingLcmFinalization();
  await Promise.all(
    sources.map((source) =>
      config.enqueueLcmCompaction(
        { userId: source.ownerUserId },
        "personal",
        `historical-import-finalize-${source.sourceId}`,
        "historical_import_backfill",
        `historical-import-finalize-${source.sourceId}`,
        source.sessionId,
        true
      )
    )
  );
};

const reconcileLcmCompactionJobs = async (
  config: RawProjectionServiceConfig
): Promise<boolean> => {
  const scopes = await config.repository.listPendingLcmDispatchScopes({
    limit: config.actorLimit
  });
  const results = await Promise.allSettled(
    scopes.map((scope) =>
      config.enqueueLcmCompaction(
        { userId: scope.ownerUserId },
        scope.visibility,
        scope.dispatchKey,
        scope.workClass,
        scope.jobId
      )
    )
  );
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      continue;
    }
    const scope = scopes[index];
    config.logger.warn(
      {
        event: {
          name: "worker.lcm_reconciliation.job_enqueue.failed",
          category: "queue"
        },
        queue: { name: lcmCompactQueueName },
        job: { name: "compact-scope" },
        actor: { user_id: scope?.ownerUserId },
        resource: {
          type: "compaction_scope",
          visibility: scope?.visibility,
          pendingMemoryEventIds: scope?.pendingMemoryEventIds
        },
        err: result.reason
      },
      "could not enqueue pending LCM compaction scope"
    );
  }
  return results.some((result) => result.status === "rejected");
};

const reconcileEmbeddingJobs = async (
  config: RawProjectionServiceConfig
): Promise<boolean> => {
  const sources = await config.repository.listSourcesNeedingEmbeddings(
    config.batchLimit
  );
  const results = await Promise.allSettled(
    sources.map((source) =>
      config.enqueueSourceEmbedding(
        source.sourceType,
        source.sourceId,
        config.embeddingDispatchKey,
        source.workClass ?? "normal_embedding_lcm",
        source.reconciliationJobId
      )
    )
  );
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      continue;
    }
    const source = sources[index];
    config.logger.warn(
      {
        event: {
          name: "worker.embedding_reconciliation.job_enqueue.failed",
          category: "queue"
        },
        queue: { name: memoryEmbedQueueName },
        job: { name: "embed-source" },
        resource: { type: source?.sourceType, id: source?.sourceId },
        err: result.reason
      },
      "could not enqueue pending embedding source"
    );
  }
  return results.some((result) => result.status === "rejected");
};

const runHistoricalBatch = async (
  config: RawProjectionServiceConfig,
  decision: HistoricalAdmissionDecision,
  start: () => void,
  finish: () => void
): Promise<HistoricalBatchResult> => {
  if (!decision.admitted) {
    return { decision, report: emptyProjectionReport() };
  }
  const lease = await config.repository.tryAcquireHistoricalProjectionLease();
  if (!lease) {
    return {
      decision: { admitted: false, reason: "concurrency_cap" },
      report: emptyProjectionReport()
    };
  }
  start();
  try {
    const report = await projectActors(
      config,
      "historical_import_backfill",
      {
        limit: config.historicalImport.maxRows,
        maxBytes: config.historicalImport.maxBytes,
        maxRuntimeMs: config.historicalImport.maxRuntimeMs
      },
      config.historicalImport.maxConcurrency
    );
    return { decision, report };
  } finally {
    finish();
    await lease.release();
  }
};

const logProjectionReport = (
  logger: Logger,
  live: ProjectionReport,
  historical: ProjectionReport
): void => {
  if (live.scanned + historical.scanned === 0) {
    return;
  }
  logger.info(
    {
      event: {
        name: "worker.raw_projection.catchup.completed",
        category: "projection"
      },
      projection: { live, historical }
    },
    "raw conversation projection catch-up completed"
  );
};

const logRebuildReport = (
  logger: Logger,
  rebuild: { jobs: number; events: number }
): void => {
  if (rebuild.jobs === 0) {
    return;
  }
  logger.info(
    {
      event: {
        name: "worker.raw_projection.semantic_rebuild.completed",
        category: "projection"
      },
      projection: {
        rebuildJobs: rebuild.jobs,
        rebuiltEvents: rebuild.events
      }
    },
    "semantic memory rebuild completed"
  );
};

export const createRawProjectionService = (
  config: RawProjectionServiceConfig
): RawProjectionService => {
  let currentRun: Promise<void> | null = null;
  let activeHistoricalBatches = 0;
  let processingRequested = false;
  let runAgain = false;
  let stopped = false;
  let wakeClient: ProjectionWakeClient | null = null;
  let wakeReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeReconnectAttempt = 0;
  let dueTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryAttempt = 0;

  const runOnce = async () => {
    try {
      const live = await projectActors(
        config,
        "live_capture_projection",
        { limit: config.batchLimit },
        config.actorLimit
      );
      await config.recoverProjectedMemoryEventProcessing();
      const backlog =
        await config.repository.getConversationProjectionBacklog();
      const health = await config.getHistoricalAdmissionHealth();
      const decision = decideHistoricalAdmission(
        { ...backlog, ...health, activeHistoricalBatches },
        config.historicalImport
      );
      const historical = await runHistoricalBatch(
        config,
        decision,
        () => {
          activeHistoricalBatches += 1;
        },
        () => {
          activeHistoricalBatches -= 1;
        }
      );
      const rebuild = await processRebuildActors(config);
      const embeddingAdmissionFailed = await reconcileEmbeddingJobs(config);
      await reconcileTerminalHistoricalLcmJobs(config);
      const lcmAdmissionFailed = await reconcileLcmCompactionJobs(config);
      logHistoricalDecision(
        config.logger,
        historical.decision,
        backlog,
        historical.report
      );
      logProjectionReport(config.logger, live, historical.report);
      logRebuildReport(config.logger, rebuild);
      const nextRebuildDueAt =
        await config.repository.getNextSemanticMemoryRebuildDueAt();
      return {
        continueImmediately:
          live.projected > 0 ||
          historical.report.projected > 0 ||
          rebuild.jobs > 0,
        nextRebuildDueAt,
        recoveryNeeded:
          embeddingAdmissionFailed ||
          lcmAdmissionFailed ||
          (backlog.historicalImportRows > 0 && !historical.decision.admitted)
      };
    } catch (error) {
      config.logger.warn(
        {
          event: {
            name: "worker.raw_projection.catchup.failed",
            category: "projection"
          },
          err: error
        },
        "raw conversation projection catch-up failed"
      );
      throw error;
    }
  };

  const run = (): Promise<void> => {
    if (!currentRun) {
      currentRun = runOnce()
        .then(() => undefined)
        .finally(() => {
          currentRun = null;
        });
    }
    return currentRun;
  };

  const requestProcessing = (): void => {
    if (stopped) return;
    if (currentRun) {
      runAgain = true;
      return;
    }
    if (processingRequested) return;
    processingRequested = true;
    queueMicrotask(() => {
      processingRequested = false;
      if (stopped || currentRun) {
        if (currentRun) runAgain = true;
        return;
      }
      currentRun = runOnce()
        .then((result) => {
          recoveryAttempt = 0;
          if (!result.recoveryNeeded && recoveryTimer) {
            clearTimeout(recoveryTimer);
            recoveryTimer = null;
          }
          if (dueTimer) clearTimeout(dueTimer);
          dueTimer = null;
          if (result.nextRebuildDueAt) {
            const delayMs = Math.min(
              Math.max(result.nextRebuildDueAt.getTime() - Date.now(), 0),
              2_147_483_647
            );
            dueTimer = setTimeout(requestProcessing, delayMs);
            dueTimer.unref?.();
          }
          if (result.recoveryNeeded && !recoveryTimer) {
            recoveryTimer = setTimeout(() => {
              recoveryTimer = null;
              requestProcessing();
            }, 1_000);
            recoveryTimer.unref?.();
          }
          if (result.continueImmediately) runAgain = true;
        })
        .catch(() => {
          if (stopped || recoveryTimer) return;
          const delayMs = Math.min(250 * 2 ** recoveryAttempt, 10_000);
          recoveryAttempt += 1;
          recoveryTimer = setTimeout(() => {
            recoveryTimer = null;
            requestProcessing();
          }, delayMs);
          recoveryTimer.unref?.();
        })
        .finally(() => {
          currentRun = null;
          if (runAgain) {
            runAgain = false;
            requestProcessing();
          }
        });
    });
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
    if (stopped || wakeClient || !config.wakePool) return;
    try {
      const client = await config.wakePool.connect();
      if (stopped) {
        client.release();
        return;
      }
      wakeClient = client;
      await client.query("listen koed_projection_work");
      wakeReconnectAttempt = 0;
      client.on("notification", (message) => {
        if (message.channel === "koed_projection_work") requestProcessing();
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
      stopped = false;
      void connectWakeClient();
      requestProcessing();
    },
    async stop() {
      stopped = true;
      processingRequested = false;
      runAgain = false;
      if (wakeReconnectTimer) clearTimeout(wakeReconnectTimer);
      wakeReconnectTimer = null;
      if (dueTimer) clearTimeout(dueTimer);
      dueTimer = null;
      if (recoveryTimer) clearTimeout(recoveryTimer);
      recoveryTimer = null;
      if (wakeClient) {
        const client = wakeClient;
        wakeClient = null;
        client.removeAllListeners();
        await client
          .query("unlisten koed_projection_work")
          .catch(() => undefined);
        client.release();
      }
      await currentRun;
    }
  };
};
