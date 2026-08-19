import { MemoryApiError, type MemoryApiClient } from "./index.js";
import {
  CURATED_MEMORY_REVIEW_PROMPT_VERSION,
  resolveCuratedMemoryReviewConfig,
  reviewCuratedMemoryProposal,
  type CuratedMemoryReviewBundle,
  type CuratedMemoryReviewConfig
} from "./curated-memory-review-worker.js";
import { aiClientExecutionIdentity } from "./ai-client-runner.js";
import { resolveLocalMemoryAgentConfig } from "./ai-client-assignment.js";

export interface CuratedMemoryReviewServiceHandle {
  stop(): void;
  trigger(reason?: string): Promise<unknown>;
  nudge(reason?: string): void;
  snapshot(): Record<string, unknown>;
}

const intEnv = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number => {
  const value = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const reviewWorkerConfig = async (
  client: MemoryApiClient,
  fallback: CuratedMemoryReviewConfig
): Promise<CuratedMemoryReviewConfig> =>
  resolveLocalMemoryAgentConfig({
    client,
    flowKey: "curated_memory_review",
    fallback: () => fallback,
    fromSetting: (setting) =>
      resolveCuratedMemoryReviewConfig(fallback.env, {
        provider: setting.provider as CuratedMemoryReviewConfig["provider"],
        aiClientInstanceId: setting.aiClientInstanceId,
        model: setting.model,
        reasoningEffort: setting.reasoningEffort,
        timeoutMs: setting.timeoutMs,
        maxAttempts: setting.maxAttempts,
        retryDelayMs: fallback.retryDelayMs,
        maxPromptTokens: fallback.maxPromptTokens
      })
  });

export const startCuratedMemoryReviewService = (
  client: MemoryApiClient,
  options: {
    workerConfig?: CuratedMemoryReviewConfig;
    reviewer?: typeof reviewCuratedMemoryProposal;
  } = {}
): CuratedMemoryReviewServiceHandle => {
  const initialDelayMs = intEnv(
    process.env,
    "MEMORY_CURATED_REVIEW_INITIAL_DELAY_MS",
    5_000
  );
  const intervalMs = intEnv(
    process.env,
    "MEMORY_CURATED_REVIEW_INTERVAL_MS",
    60_000
  );
  const pushDelayMs = intEnv(
    process.env,
    "MEMORY_CURATED_REVIEW_PUSH_DELAY_MS",
    250
  );
  const batchLimit = Math.min(
    20,
    intEnv(process.env, "MEMORY_CURATED_REVIEW_BATCH_LIMIT", 3)
  );
  const fallbackConfig =
    options.workerConfig ?? resolveCuratedMemoryReviewConfig();
  const reviewer = options.reviewer ?? reviewCuratedMemoryProposal;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;
  let lastRunAt: string | null = null;
  let lastSuccessAt: string | null = null;
  let lastError: string | null = null;
  let lastResult: unknown = null;

  const schedule = (delayMs: number) => {
    if (timer) clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => void run("timer"), delayMs);
    timer.unref();
  };

  const run = async (reason = "manual") => {
    if (stopped || running) {
      return {
        ran: false,
        skippedReason: stopped ? "stopped" : "already_running"
      };
    }
    if (timer) clearTimeout(timer);
    timer = undefined;
    running = true;
    lastRunAt = new Date().toISOString();
    try {
      const config = await reviewWorkerConfig(client, fallbackConfig);
      const claimed = await client.claimPendingCuratedMemoryReviews({
        limit: batchLimit,
        lease_seconds: Math.min(3600, Math.ceil(config.timeoutMs / 1000) + 60)
      });
      const reviews = Array.isArray(claimed.reviews)
        ? (claimed.reviews as CuratedMemoryReviewBundle[])
        : [];
      const completed: Array<Record<string, unknown>> = [];
      for (const bundle of reviews) {
        const proposalId = bundle.proposal.id;
        const attemptCount = bundle.proposal.attemptCount;
        const revisions = bundle.evidence.map((item) => ({
          source_type: item.sourceType,
          source_id: item.sourceId,
          source_hash: item.sourceHash
        }));
        const candidateIds = bundle.currentAssertions.map(
          (item) => item.assertionId
        );
        try {
          const result = await reviewer(bundle, config);
          const identity = aiClientExecutionIdentity(
            config.provider,
            config.aiClientInstanceId
          );
          const telemetry = {
            reviewer:
              identity.provider === "codex"
                ? "local_codex_app_server"
                : "local_claude_agent_sdk",
            provider: identity.provider,
            aiClientInstanceId: identity.aiClientInstanceId,
            transport: identity.transport,
            promptVersion: CURATED_MEMORY_REVIEW_PROMPT_VERSION,
            model: result.model,
            promptTokens: result.promptTokens,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            latencyMs: result.latencyMs,
            attemptIndex: result.attemptIndex,
            reasonCategory: result.decision.reason_category
          };
          const submitted = await client.submitCuratedMemoryReview(proposalId, {
            outcome: result.decision.outcome,
            attempt_count: attemptCount,
            evidence_revisions: revisions,
            selected_evidence_ids:
              result.decision.outcome === "accepted"
                ? result.decision.selected_evidence_ids
                : [],
            candidate_assertion_ids: candidateIds,
            decision_reason: result.decision.decision_reason,
            worker_result: telemetry,
            ...(result.decision.outcome === "accepted"
              ? {
                  operation: result.decision.operation,
                  target_assertion_id: result.decision.target_assertion_id,
                  assertion_text: result.decision.assertion_text,
                  topic_title: result.decision.topic_title,
                  tags: result.decision.tags,
                  sensitivity: result.decision.sensitivity,
                  confidence: result.decision.confidence,
                  expires_at: result.decision.expires_at,
                  reviewer_model: result.model,
                  reviewer_prompt_version: CURATED_MEMORY_REVIEW_PROMPT_VERSION
                }
              : {})
          });
          completed.push({
            proposalId,
            outcome: result.decision.outcome,
            submitted
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          const staleReview =
            error instanceof MemoryApiError && error.status === 409;
          const terminal =
            !staleReview &&
            (Boolean(
              error && typeof error === "object" && "terminal" in error
            ) ||
              attemptCount >= config.maxAttempts);
          if (terminal) {
            const identity = aiClientExecutionIdentity(
              config.provider,
              config.aiClientInstanceId
            );
            await client.submitCuratedMemoryReview(proposalId, {
              outcome: "rejected",
              attempt_count: attemptCount,
              evidence_revisions: revisions,
              candidate_assertion_ids: candidateIds,
              decision_reason: message,
              worker_result: {
                reviewer:
                  identity.provider === "codex"
                    ? "local_codex_app_server"
                    : "local_claude_agent_sdk",
                provider: identity.provider,
                aiClientInstanceId: identity.aiClientInstanceId,
                transport: identity.transport,
                promptVersion: CURATED_MEMORY_REVIEW_PROMPT_VERSION,
                terminalFailure: true
              }
            });
            completed.push({ proposalId, outcome: "rejected", error: message });
          } else {
            await client.submitCuratedMemoryReview(proposalId, {
              outcome: "retry",
              attempt_count: attemptCount,
              error_message: message
            });
            completed.push({ proposalId, outcome: "retry", error: message });
          }
        }
      }
      lastResult = { reason, claimed: reviews.length, completed };
      lastSuccessAt = new Date().toISOString();
      lastError = null;
      return { ran: true, result: lastResult };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      return { ran: true, error: lastError };
    } finally {
      running = false;
      schedule(intervalMs);
    }
  };

  schedule(initialDelayMs);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    trigger: run,
    nudge(reason = "proposal_created") {
      if (!stopped && !running) schedule(pushDelayMs);
      void reason;
    },
    snapshot() {
      return {
        running,
        stopped,
        lastRunAt,
        lastSuccessAt,
        lastError,
        lastResult,
        model: fallbackConfig.model,
        reasoningEffort: fallbackConfig.reasoningEffort
      };
    }
  };
};
