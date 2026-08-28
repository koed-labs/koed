import type { HistoricalAdmissionDecision } from "@koed/shared";

import type { HistoricalCandidateSelection } from "./historical-ingestion-coordinator.js";
import { MemoryApiClient, MemoryApiError } from "./index.js";

export const AUTOMATIC_HISTORICAL_WINDOW_DAYS = 30;
export const AUTOMATIC_HISTORICAL_CONVERSATION_CAP = 50;

export const resolveAutomaticHistoricalJournalBatchBytes = (
  env: NodeJS.ProcessEnv = process.env
): number => {
  const raw = env.MEMORY_HISTORICAL_IMPORT_JOURNAL_BATCH_BYTES?.trim();
  if (!raw) return 1_048_576;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1_024 || value > 4_194_304) {
    throw new Error(
      "MEMORY_HISTORICAL_IMPORT_JOURNAL_BATCH_BYTES must be an integer from 1024 to 4194304"
    );
  }
  return value;
};

export interface AutomaticHistoricalCandidate {
  sourceSessionId: string;
  latestActivityAt: string;
  frontierOffset: number;
  frontierLine?: number;
}

export const selectRecentHistoricalCandidates = <
  Candidate extends AutomaticHistoricalCandidate
>(input: {
  aiClient: string;
  candidates: readonly Candidate[];
  now: Date;
  adapterState(candidate: Candidate): Record<string, unknown>;
}): HistoricalCandidateSelection[] => {
  const cutoff =
    input.now.getTime() -
    AUTOMATIC_HISTORICAL_WINDOW_DAYS * 24 * 60 * 60 * 1_000;
  const byConversation = new Map<string, Candidate>();
  for (const candidate of input.candidates) {
    const activity = Date.parse(candidate.latestActivityAt);
    if (
      !Number.isFinite(activity) ||
      activity < cutoff ||
      activity > input.now.getTime()
    ) {
      continue;
    }
    const existing = byConversation.get(candidate.sourceSessionId);
    if (!existing || candidate.latestActivityAt > existing.latestActivityAt) {
      byConversation.set(candidate.sourceSessionId, candidate);
    }
  }
  return [...byConversation.values()]
    .sort(
      (left, right) =>
        right.latestActivityAt.localeCompare(left.latestActivityAt) ||
        left.sourceSessionId.localeCompare(right.sourceSessionId)
    )
    .slice(0, AUTOMATIC_HISTORICAL_CONVERSATION_CAP)
    .sort(
      (left, right) =>
        left.latestActivityAt.localeCompare(right.latestActivityAt) ||
        left.sourceSessionId.localeCompare(right.sourceSessionId)
    )
    .map((candidate) => ({
      aiClient: input.aiClient,
      candidateId: candidate.sourceSessionId,
      frontierOffset: candidate.frontierOffset,
      frontierLine: candidate.frontierLine ?? -1,
      latestActivityAt: candidate.latestActivityAt,
      adapterState: input.adapterState(candidate)
    }));
};

const objectValue = <T>(
  response: Record<string, unknown>,
  key: string,
  errorCode: string
): T => {
  const value = response[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(errorCode);
  }
  return value as T;
};

export const historicalObjectValue = objectValue;

export const automaticHistoricalPolicyAdmits = async (
  client: MemoryApiClient,
  selection: HistoricalCandidateSelection
): Promise<boolean> => {
  const response = await client.effectiveCapturePolicy({
    ...(typeof selection.adapterState?.projectId === "string"
      ? { projectId: selection.adapterState.projectId }
      : {}),
    threadId: selection.candidateId
  });
  const policy = objectValue<Record<string, unknown>>(
    response,
    "policy",
    "historical_policy_response_missing"
  );
  return (
    policy.visibility === "personal" &&
    policy.captureState === "enabled" &&
    policy.paused !== true
  );
};

export const automaticHistoricalAdmission = async (
  client: MemoryApiClient
): Promise<HistoricalAdmissionDecision> => {
  const response = await client.historicalImportAdmission();
  if (response.admitted === true) return { admitted: true };
  const reasons = new Set([
    "no_historical_backlog",
    "api_degraded",
    "queue_degraded",
    "embedding_service_degraded",
    "capacity_profile_unavailable",
    "live_projection_pressure",
    "concurrency_cap"
  ]);
  if (
    response.admitted === false &&
    typeof response.reason === "string" &&
    reasons.has(response.reason)
  ) {
    return response as HistoricalAdmissionDecision;
  }
  throw new Error("historical_admission_response_invalid");
};

export const createAutomaticHistoricalRun = async (
  client: MemoryApiClient
): Promise<string> => {
  const run = objectValue<{ id: string }>(
    await client.createHistoricalImportRun(),
    "run",
    "historical_run_response_missing"
  );
  for (const [expectedState, state] of [
    ["discovered", "eligible"],
    ["eligible", "queued"],
    ["queued", "importing"]
  ] as const) {
    await client.transitionHistoricalImportRun(run.id, {
      expectedState,
      state
    });
  }
  return run.id;
};

export const transitionAutomaticHistoricalSource = async <
  Source extends { id: string; state: string }
>(
  client: MemoryApiClient,
  source: Source
): Promise<Source> => {
  const state =
    source.state === "discovered"
      ? "eligible"
      : source.state === "eligible"
        ? "queued"
        : source.state === "queued"
          ? "importing"
          : null;
  if (!state) return source;
  return objectValue<Source>(
    await client.transitionHistoricalImportSource(source.id, {
      expectedState: source.state,
      state
    }),
    "source",
    "historical_source_transition_response_missing"
  );
};

export const completeAutomaticHistoricalSource = async (
  client: MemoryApiClient,
  sourceId: string
): Promise<boolean> => {
  try {
    await client.transitionHistoricalImportSource(sourceId, {
      expectedState: "importing",
      state: "completed"
    });
    return true;
  } catch (error) {
    if (error instanceof MemoryApiError && error.status === 409) return false;
    throw error;
  }
};

export const completeAutomaticHistoricalRun = async (
  client: MemoryApiClient,
  runId: string
): Promise<void> => {
  try {
    await client.transitionHistoricalImportRun(runId, {
      expectedState: "importing",
      state: "completed"
    });
  } catch (error) {
    if (!(error instanceof MemoryApiError) || error.status !== 409) throw error;
  }
};
