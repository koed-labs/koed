import { readFile } from "node:fs/promises";
import pg from "pg";
import type { HarborExecutionAdapterOptions } from "./harbor-execution-adapter.js";
import type {
  AttemptTelemetryIdentity,
  TelemetryEnvelope
} from "./telemetry.js";
import type { BridgeCallTelemetry } from "./bridge-telemetry.js";

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
    providerBilledUsd: null,
    apiEquivalentUsd: null,
    subscriptionUsd: null
  }
};

const databaseObservers = async (
  identity: AttemptTelemetryIdentity,
  observation: RecordedAttemptObservation
): Promise<
  Pick<Observers, "modelWorkflows"> & { workerBytes: number | null }
> => {
  if (!observation.databaseUrl || !observation.ownerUserId) {
    if (identity.condition !== "cold")
      throw new Error("Recorded Koed attempt lacks its database observation");
    return {
      modelWorkflows: available(identity, {
        memoryAnswer: zeroWorker,
        lcmSummary: zeroWorker,
        sessionTitle: zeroWorker
      }),
      workerBytes: null
    };
  }
  const pool = new pg.Pool({
    connectionString: observation.databaseUrl,
    max: 1
  });
  try {
    const usage = await pool.query<{
      workflow_type: string;
      calls: string;
      input_tokens: string;
      cached_input_tokens: string;
      output_tokens: string;
      reasoning_tokens: string;
    }>(
      `select workflow_type, count(distinct coalesce(workflow_id, id::text))::text calls,
      coalesce(sum(input_tokens),0)::text input_tokens,
      coalesce(sum(cached_input_tokens),0)::text cached_input_tokens,
      coalesce(sum(output_tokens),0)::text output_tokens,
      coalesce(sum(reasoning_output_tokens),0)::text reasoning_tokens
      from workflow_token_usage where owner_user_id=$1
      and usage_accuracy='provider_reported' and usage_kind='turn_delta'
      group by workflow_type`,
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
    const byType = new Map(usage.rows.map((row) => [row.workflow_type, row]));
    const worker = (workflow: string, callsOverride?: number, failures = 0) => {
      const row = byType.get(workflow);
      const input = Number(row?.input_tokens ?? 0);
      const cached = Number(row?.cached_input_tokens ?? 0);
      return {
        calls: callsOverride ?? Number(row?.calls ?? 0),
        failures,
        durationMs: null,
        tokens: {
          uncachedInput: Math.max(0, input - cached),
          cachedInput: cached,
          output: Number(row?.output_tokens ?? 0),
          reasoning: Number(row?.reasoning_tokens ?? 0)
        },
        costs: {
          providerBilledUsd: null,
          apiEquivalentUsd: null,
          subscriptionUsd: null
        }
      };
    };
    const question = questions.rows[0];
    return {
      modelWorkflows: available(identity, {
        memoryAnswer: worker(
          "mcp_memory_answer",
          Number(question?.calls ?? 0),
          Number(question?.failures ?? 0)
        ),
        lcmSummary: worker("lcm_summary"),
        sessionTitle: worker("session_title")
      }),
      workerBytes:
        question?.worker_rss == null ? null : Number(question.worker_rss)
    };
  } finally {
    await pool.end();
  }
};

export const createRecordedReplayTelemetryCollector = (
  environment: Readonly<NodeJS.ProcessEnv> = {}
): Collector => {
  void environment;
  return async ({ identity, captured }) => {
    const observation = observations.get(key(identity));
    if (!observation) {
      if (identity.condition !== "cold")
        throw new Error("Mandatory recorded attempt observation is absent");
    } else if (key(observation.identity) !== key(identity)) {
      throw new Error("Recorded attempt observation identity does not match");
    }
    const active = observation ?? { identity };
    if (identity.condition !== "cold" && (!active.bridge || !active.embeddings))
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
      workerPeakRssBytes: null
    };
    const database = await databaseObservers(identity, active);
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
          providerBilledUsd: captured.trial.usage.costUsd,
          apiEquivalentUsd: null,
          subscriptionUsd: null
        },
        turns: captured.trial.interactions.turns,
        toolCalls: captured.trial.interactions.toolCalls,
        toolFailures: null,
        mcpCalls: bridge.mcpCalls,
        mcpFailures: bridge.mcpFailures,
        memoryAnswerCalls: bridge.memoryAnswerCalls,
        memoryAnswerFailures: bridge.memoryAnswerFailures
      }),
      koedRecall: available(identity, {
        searches: bridge.searches,
        expansions: bridge.expansions,
        stages: bridge.stages,
        evidenceCount: bridge.evidenceCount,
        projectionMs: null,
        lcmMs: null,
        queueMs: null
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
