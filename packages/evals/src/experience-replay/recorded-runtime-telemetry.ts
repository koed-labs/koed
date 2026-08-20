import { readFile } from "node:fs/promises";
import pg from "pg";
import type { HarborExecutionAdapterOptions } from "./harbor-execution-adapter.js";
import type {
  AttemptTelemetryIdentity,
  TelemetryEnvelope
} from "./telemetry.js";
import type { BridgeCallTelemetry } from "./bridge-telemetry.js";
import type { ExperienceReplayCodexAuthMode } from "./core/index.js";
import { conditionUsesKoed } from "./core/index.js";

type Collector = NonNullable<
  HarborExecutionAdapterOptions["collectReplayTelemetry"]
>;
type Observers = Awaited<ReturnType<Collector>>;

export interface RecordedAttemptObservation {
  identity: AttemptTelemetryIdentity;
  databaseUrl?: string;
  ownerUserId?: string;
  apiPid?: number;
  runtimePid?: number;
  bridge?: () => BridgeCallTelemetry;
  embeddings?: () => {
    calls: number;
    tokens: number | null;
    durationMs: number;
  };
}

export interface RecordedReplayTelemetryOptions {
  authMode: ExperienceReplayCodexAuthMode;
  workflowModels: Readonly<
    Record<"mcp_memory_answer" | "lcm_summary" | "session_title", string>
  >;
  prices: Readonly<
    Record<
      string,
      {
        uncached_input_usd_per_million: number;
        cached_input_usd_per_million: number;
        output_usd_per_million: number;
      }
    >
  >;
}

export const recordedApiEquivalentCost = (
  tokens: { input: number; cachedInput: number; output: number },
  price: RecordedReplayTelemetryOptions["prices"][string]
): number =>
  (Math.max(0, tokens.input - tokens.cachedInput) *
    price.uncached_input_usd_per_million +
    tokens.cachedInput * price.cached_input_usd_per_million +
    tokens.output * price.output_usd_per_million) /
  1_000_000;

export const reconcileMemoryAnswerInteractionCounts = (
  bridge: Pick<
    BridgeCallTelemetry,
    "mcpCalls" | "mcpFailures" | "memoryAnswerCalls" | "memoryAnswerFailures"
  >,
  persisted: { calls: number; failures: number }
) => {
  for (const [label, value] of Object.entries(persisted)) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`Persisted Memory Answer ${label} count is invalid`);
  }
  if (persisted.failures > persisted.calls)
    throw new Error("Persisted Memory Answer failures exceed calls");
  return {
    mcpCalls: Math.max(bridge.mcpCalls, persisted.calls),
    mcpFailures: Math.max(bridge.mcpFailures, persisted.failures),
    memoryAnswerCalls: Math.max(bridge.memoryAnswerCalls, persisted.calls),
    memoryAnswerFailures: Math.max(
      bridge.memoryAnswerFailures,
      persisted.failures
    )
  };
};

const key = (identity: AttemptTelemetryIdentity): string =>
  JSON.stringify([identity.taskDigest, identity.condition, identity.repeat]);
const observations = new Map<string, RecordedAttemptObservation>();

export const registerRecordedAttemptObservation = (
  observation: RecordedAttemptObservation
): (() => void) => {
  const identityKey = key(observation.identity);
  if (observations.has(identityKey))
    throw new Error("Recorded attempt observation is already registered");
  observations.set(identityKey, observation);
  return () => {
    if (observations.get(identityKey) === observation)
      observations.delete(identityKey);
  };
};

const available = (
  identity: AttemptTelemetryIdentity,
  metrics: Record<string, unknown>
): TelemetryEnvelope => ({ identity, status: "available", metrics });

const rss = async (pid: number | undefined): Promise<number | null> => {
  if (pid === undefined) return null;
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("Observed process PID is invalid");
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
    if (!match) throw new Error("RSS field is absent");
    return Number(match[1]) * 1024;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return null;
    throw new Error(`Live RSS observation failed for pid ${pid}`, {
      cause: error
    });
  }
};

const zeroWorker = {
  calls: 0,
  failures: 0,
  durationMs: null,
  tokens: { uncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 },
  costs: {
    providerBilledUsd: 0,
    apiEquivalentUsd: 0,
    subscriptionUsd: 0
  }
};

const databaseObservers = async (
  identity: AttemptTelemetryIdentity,
  observation: RecordedAttemptObservation,
  options: RecordedReplayTelemetryOptions
): Promise<
  Pick<Observers, "modelWorkflows"> & {
    workerBytes: number | null;
    memoryQuestions: { calls: number; failures: number };
  }
> => {
  if (!observation.databaseUrl || !observation.ownerUserId) {
    if (conditionUsesKoed(identity.condition))
      throw new Error("Recorded Koed attempt lacks its database observation");
    return {
      modelWorkflows: available(identity, {
        memoryAnswer: zeroWorker,
        lcmSummary: zeroWorker,
        sessionTitle: zeroWorker
      }),
      workerBytes: null,
      memoryQuestions: { calls: 0, failures: 0 }
    };
  }
  const pool = new pg.Pool({
    connectionString: observation.databaseUrl,
    max: 1
  });
  try {
    type UsageRow = {
      workflow_type: string;
      calls: string;
      input_tokens: string;
      cached_input_tokens: string;
      output_tokens: string;
      reasoning_tokens: string;
      model: string | null;
    };
    const usage = await pool.query<UsageRow>(
      `select workflow_type, model,
      count(distinct coalesce(workflow_id, id::text))::text calls,
      coalesce(sum(input_tokens),0)::text input_tokens,
      coalesce(sum(cached_input_tokens),0)::text cached_input_tokens,
      coalesce(sum(output_tokens),0)::text output_tokens,
      coalesce(sum(reasoning_output_tokens),0)::text reasoning_tokens
      from workflow_token_usage where owner_user_id=$1
      and usage_accuracy='provider_reported' and usage_kind='turn_delta'
      group by workflow_type, model`,
      [observation.ownerUserId]
    );
    const questions = await pool.query<{
      calls: string;
      failures: string;
      worker_rss: string | null;
    }>(
      `select count(*)::text calls, count(*) filter (where status='error')::text failures,
       max(nullif(local_memory_worker #>> '{appServerExecutions,0,processMetrics,peakRssBytes}','')::bigint)::text worker_rss
       from memory_questions where owner_user_id=$1 and origin='mcp_memory_answer'`,
      [observation.ownerUserId]
    );
    const byType = new Map<string, UsageRow[]>();
    for (const row of usage.rows) {
      byType.set(row.workflow_type, [
        ...(byType.get(row.workflow_type) ?? []),
        row
      ]);
    }
    const worker = (workflow: string, callsOverride?: number, failures = 0) => {
      const rows = byType.get(workflow) ?? [];
      const expectedModel =
        options.workflowModels[
          workflow as keyof RecordedReplayTelemetryOptions["workflowModels"]
        ];
      if (
        rows.some(
          (row) =>
            row.model !== null &&
            row.model !== expectedModel &&
            !row.model.includes(expectedModel)
        )
      ) {
        throw new Error(`Recorded ${workflow} usage has an unexpected model`);
      }
      const price = options.prices[expectedModel];
      if (!price && rows.length > 0) {
        throw new Error(`Recorded ${workflow} model has no price entry`);
      }
      const sum = (field: keyof (typeof rows)[number]) =>
        rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);
      const input = sum("input_tokens");
      const cached = sum("cached_input_tokens");
      const output = sum("output_tokens");
      const apiEquivalentUsd = price
        ? recordedApiEquivalentCost(
            { input, cachedInput: cached, output },
            price
          )
        : 0;
      return {
        calls: callsOverride ?? sum("calls"),
        failures,
        durationMs: null,
        tokens: {
          uncachedInput: Math.max(0, input - cached),
          cachedInput: cached,
          output,
          reasoning: sum("reasoning_tokens")
        },
        costs: {
          providerBilledUsd:
            options.authMode === "api_key" ? apiEquivalentUsd : 0,
          apiEquivalentUsd,
          subscriptionUsd: 0
        }
      };
    };
    const question = questions.rows[0];
    const memoryQuestions = {
      calls: Number(question?.calls ?? 0),
      failures: Number(question?.failures ?? 0)
    };
    reconcileMemoryAnswerInteractionCounts(
      {
        mcpCalls: 0,
        mcpFailures: 0,
        memoryAnswerCalls: 0,
        memoryAnswerFailures: 0
      },
      memoryQuestions
    );
    return {
      modelWorkflows: available(identity, {
        memoryAnswer: worker(
          "mcp_memory_answer",
          memoryQuestions.calls,
          memoryQuestions.failures
        ),
        lcmSummary: worker("lcm_summary"),
        sessionTitle: worker("session_title")
      }),
      workerBytes:
        question?.worker_rss == null ? null : Number(question.worker_rss),
      memoryQuestions
    };
  } finally {
    await pool.end();
  }
};

export const createRecordedReplayTelemetryCollector = (
  options: RecordedReplayTelemetryOptions
): Collector => {
  return async ({ identity, captured }) => {
    const observation = observations.get(key(identity));
    if (!observation) {
      if (conditionUsesKoed(identity.condition))
        throw new Error("Mandatory recorded attempt observation is absent");
    } else if (key(observation.identity) !== key(identity)) {
      throw new Error("Recorded attempt observation identity does not match");
    }
    const active = observation ?? { identity };
    if (
      conditionUsesKoed(identity.condition) &&
      (!active.bridge || !active.embeddings)
    )
      throw new Error("Recorded Koed attempt lacks mandatory live observers");
    const bridge = active.bridge?.() ?? {
      mcpCalls: 0,
      mcpFailures: 0,
      memoryAnswerCalls: 0,
      memoryAnswerFailures: 0,
      searches: 0,
      expansions: 0,
      stages: 0,
      evidenceCount: 0,
      workerPeakRssBytes: null,
      memoryAnswerRequests: []
    };
    const database = await databaseObservers(identity, active, options);
    const interactions = reconcileMemoryAnswerInteractionCounts(
      bridge,
      database.memoryQuestions
    );
    const embedding = active.embeddings?.() ?? {
      calls: 0,
      tokens: 0,
      durationMs: 0
    };
    return {
      codex: available(identity, {
        tokens: {
          uncachedInput: Math.max(
            0,
            captured.trial.usage.inputTokens -
              captured.trial.usage.cachedInputTokens
          ),
          cachedInput: captured.trial.usage.cachedInputTokens,
          output: captured.trial.usage.outputTokens,
          reasoning: null
        },
        costs: {
          providerBilledUsd:
            options.authMode === "api_key" ? captured.trial.usage.costUsd : 0,
          apiEquivalentUsd: captured.trial.usage.costUsd,
          subscriptionUsd: 0
        },
        turns: captured.trial.interactions.turns,
        toolCalls: captured.trial.interactions.toolCalls,
        toolFailures: null,
        mcpCalls: interactions.mcpCalls,
        mcpFailures: interactions.mcpFailures,
        memoryAnswerCalls: interactions.memoryAnswerCalls,
        memoryAnswerFailures: interactions.memoryAnswerFailures
      }),
      koedRecall: available(identity, {
        searches: bridge.searches,
        expansions: bridge.expansions,
        stages: bridge.stages,
        evidenceCount: bridge.evidenceCount,
        projectionMs: null,
        lcmMs: null,
        queueMs: null,
        memoryAnswerRequests: bridge.memoryAnswerRequests
      }),
      modelWorkflows: database.modelWorkflows,
      embeddings: available(identity, embedding),
      processRss: available(identity, {
        apiBytes: await rss(active.apiPid),
        runtimeBytes: await rss(active.runtimePid),
        workerBytes: bridge.workerPeakRssBytes ?? database.workerBytes
      })
    } as Observers;
  };
};
