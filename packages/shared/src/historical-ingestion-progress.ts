// Automatic historical ingestion processes selected recent history only.
export const AUTOMATIC_HISTORICAL_WINDOW_DAYS = 30;
export const AUTOMATIC_HISTORICAL_CONVERSATION_CAP = 50;

// After this long without a coordinator write, an unfinished run is reported
// as idle rather than running: the process may have stopped.
export const HISTORICAL_INGESTION_STALE_MS = 15 * 60 * 1_000;

/**
 * Written by the coordinator next to its selections. It records what happened,
 * not a forecast, so readers never infer that an interrupted run resumed.
 */
export interface HistoricalIngestionProgressRecord {
  updatedAt: string;
  lastBatchState?:
    | "progress"
    | "source_exhausted"
    | "waiting"
    | "completed"
    | "skipped";
  lastProgressAt?: string;
  lastErrorCode?: string;
  lastErrorAt?: string;
  /** First failure since the last progress; cleared when progress resumes. */
  failingSince?: string;
  /** When a pass last ran without failing after a failure. */
  recoveredAt?: string;
}

export type HistoricalIngestionLifecycle =
  | "unknown"
  | "idle"
  | "waiting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface HistoricalIngestionProgress {
  lifecycle: HistoricalIngestionLifecycle;
  /** Selected Conversations; null until the selection is known. */
  selected: number | null;
  /** Conversations whose processing reached the completed outcome. */
  completed: number;
  /** Aggregate records and memory items for selected sources, when available. */
  activity?: { recordsRead: number; embedded: number; eligible: number };
  /** Conversations explicitly skipped; reported apart from completions. */
  skipped: number;
  updatedAt: string | null;
  lastProgressAt?: string | null;
  lastErrorCode: string | null;
  /** Set while failing: when the current run of failures began. */
  failingSince: string | null;
}

const unknownProgress: HistoricalIngestionProgress = {
  lifecycle: "unknown",
  selected: null,
  completed: 0,
  skipped: 0,
  updatedAt: null,
  lastErrorCode: null,
  failingSince: null
};

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const timestamp = (value: unknown): number | null => {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

export const readHistoricalIngestionProgressRecord = (
  value: unknown
): HistoricalIngestionProgressRecord | undefined => {
  if (!record(value) || timestamp(value.updatedAt) === null) return undefined;
  const text = (key: string) =>
    typeof value[key] === "string" ? { [key]: value[key] } : {};
  return {
    updatedAt: value.updatedAt as string,
    ...text("lastBatchState"),
    ...text("lastProgressAt"),
    ...text("lastErrorCode"),
    ...text("lastErrorAt"),
    ...text("failingSince"),
    ...text("recoveredAt")
  } as HistoricalIngestionProgressRecord;
};

/** Summarises one AI Client's coordinator state file for presentation. */
export function summarizeHistoricalIngestionState(
  value: unknown,
  now: number
): HistoricalIngestionProgress {
  if (
    !record(value) ||
    value.version !== 1 ||
    value.selectionFrozen !== true ||
    !Array.isArray(value.selections)
  )
    return unknownProgress;
  const selections = value.selections.filter(record);
  const completed = selections.filter(
    ({ terminalState }) => terminalState === "completed"
  ).length;
  const skipped = selections.filter(
    ({ terminalState }) => terminalState === "skipped"
  ).length;
  const progress = readHistoricalIngestionProgressRecord(value.progress);
  const base = {
    selected: selections.length,
    completed,
    skipped,
    updatedAt: progress?.updatedAt ?? null,
    lastProgressAt: progress?.lastProgressAt ?? null,
    lastErrorCode: progress?.lastErrorCode ?? null,
    failingSince: null
  };
  if (value.runCompleted === true || selections.length === 0)
    return { ...base, lifecycle: "completed" };
  // State written before progress records existed cannot say what is running.
  if (!progress) return { ...base, lifecycle: "unknown" };
  const updatedAt = timestamp(progress.updatedAt)!;
  if (now - updatedAt > HISTORICAL_INGESTION_STALE_MS)
    return { ...base, lifecycle: "idle" };
  const errorAt = timestamp(progress.lastErrorAt);
  // A later clean pass ends a failure even when it made no progress, such as
  // while selected sources finish downstream.
  const settledAt = Math.max(
    timestamp(progress.lastProgressAt) ?? Number.NEGATIVE_INFINITY,
    timestamp(progress.recoveredAt) ?? Number.NEGATIVE_INFINITY
  );
  if (errorAt !== null && errorAt > settledAt)
    return {
      ...base,
      lifecycle: "failed",
      failingSince: progress.failingSince ?? progress.lastErrorAt ?? null
    };
  if (progress.lastBatchState === "waiting")
    return { ...base, lifecycle: "waiting" };
  return { ...base, lifecycle: "running" };
}
