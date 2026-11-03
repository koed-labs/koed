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
}

export type HistoricalIngestionLifecycle =
  | "unknown"
  | "idle"
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
  /** Conversations explicitly skipped; reported apart from completions. */
  skipped: number;
  updatedAt: string | null;
  lastErrorCode: string | null;
}

const unknownProgress: HistoricalIngestionProgress = {
  lifecycle: "unknown",
  selected: null,
  completed: 0,
  skipped: 0,
  updatedAt: null,
  lastErrorCode: null
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
    ...text("lastErrorAt")
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
    lastErrorCode: progress?.lastErrorCode ?? null
  };
  if (value.runCompleted === true || selections.length === 0)
    return { ...base, lifecycle: "completed" };
  // State written before progress records existed cannot say what is running.
  if (!progress) return { ...base, lifecycle: "unknown" };
  const updatedAt = timestamp(progress.updatedAt)!;
  if (now - updatedAt > HISTORICAL_INGESTION_STALE_MS)
    return { ...base, lifecycle: "idle" };
  const errorAt = timestamp(progress.lastErrorAt);
  const progressAt = timestamp(progress.lastProgressAt);
  if (errorAt !== null && (progressAt === null || errorAt > progressAt))
    return { ...base, lifecycle: "failed" };
  if (progress.lastBatchState === "waiting")
    return { ...base, lifecycle: "idle" };
  return { ...base, lifecycle: "running" };
}
