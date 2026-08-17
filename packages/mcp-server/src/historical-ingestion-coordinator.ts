import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const STATE_VERSION = 1;

export interface HistoricalCandidateSelection {
  aiClient: string;
  candidateId: string;
  frontierOffset: number;
  frontierLine: number;
  latestActivityAt: string;
  artifactId?: string;
  adapterState?: Record<string, unknown>;
  terminalState?: "completed" | "skipped";
}

export interface HistoricalProviderBatchResult {
  state: "progress" | "source_exhausted" | "waiting" | "completed" | "skipped";
  selection: HistoricalCandidateSelection;
  runId?: string;
}

export interface HistoricalProviderAdapter<Candidate> {
  readonly aiClient: string;
  candidateId(candidate: Candidate): string;
  selectCandidates(
    candidates: readonly Candidate[],
    now: Date
  ): HistoricalCandidateSelection[];
  processNextBatch(input: {
    candidate?: Candidate;
    selection: HistoricalCandidateSelection;
    runId?: string;
  }): Promise<HistoricalProviderBatchResult>;
  completeRun?(runId: string): Promise<void>;
}

export interface HistoricalIngestionCoordinatorState {
  version: number;
  selectionFrozen: boolean;
  runCompleted: boolean;
  runId?: string;
  selections: HistoricalCandidateSelection[];
}

export interface HistoricalIngestionCoordinatorHandle<Candidate> {
  offerCandidates(candidates: readonly Candidate[]): void;
  selectionFor(candidateId: string): HistoricalCandidateSelection | undefined;
  snapshot(): HistoricalIngestionCoordinatorState;
  stop(): Promise<void>;
}

const emptyState = (): HistoricalIngestionCoordinatorState => ({
  version: STATE_VERSION,
  selectionFrozen: false,
  runCompleted: false,
  selections: []
});

const validSelection = (
  value: unknown
): value is HistoricalCandidateSelection => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const selection = value as Record<string, unknown>;
  return (
    typeof selection.aiClient === "string" &&
    typeof selection.candidateId === "string" &&
    Number.isSafeInteger(selection.frontierOffset) &&
    Number(selection.frontierOffset) >= 0 &&
    Number.isSafeInteger(selection.frontierLine) &&
    Number(selection.frontierLine) >= -1 &&
    typeof selection.latestActivityAt === "string" &&
    Number.isFinite(Date.parse(selection.latestActivityAt)) &&
    (selection.artifactId === undefined ||
      typeof selection.artifactId === "string") &&
    (selection.adapterState === undefined ||
      (typeof selection.adapterState === "object" &&
        selection.adapterState !== null &&
        !Array.isArray(selection.adapterState))) &&
    (selection.terminalState === undefined ||
      selection.terminalState === "completed" ||
      selection.terminalState === "skipped")
  );
};

const loadState = (statePath: string): HistoricalIngestionCoordinatorState => {
  try {
    const value = JSON.parse(readFileSync(statePath, "utf8")) as Record<
      string,
      unknown
    >;
    if (
      value.version !== STATE_VERSION ||
      typeof value.selectionFrozen !== "boolean" ||
      (value.runCompleted !== undefined &&
        typeof value.runCompleted !== "boolean") ||
      !Array.isArray(value.selections) ||
      !value.selections.every(validSelection) ||
      (value.runId !== undefined && typeof value.runId !== "string")
    ) {
      return emptyState();
    }
    return {
      version: STATE_VERSION,
      selectionFrozen: value.selectionFrozen,
      runCompleted: value.runCompleted === true,
      ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
      selections: value.selections
    };
  } catch {
    return emptyState();
  }
};

const persistState = (
  statePath: string,
  state: HistoricalIngestionCoordinatorState
): void => {
  mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporary, statePath);
};

export const startHistoricalIngestionCoordinator = <Candidate>(input: {
  adapter: HistoricalProviderAdapter<Candidate>;
  koedHome: string;
  retryMs: number;
  now?: () => Date;
  onError?: (code: string) => void;
}): HistoricalIngestionCoordinatorHandle<Candidate> => {
  const statePath = path.join(
    input.koedHome,
    "state",
    `${input.adapter.aiClient}-historical-ingestion.json`
  );
  let state = loadState(statePath);
  const candidates = new Map<string, Candidate>();
  let running: Promise<void> | null = null;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let requested = false;

  const save = (): void => persistState(statePath, state);
  const schedule = (delayMs = 0): void => {
    if (stopped) return;
    requested = true;
    if (running || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, delayMs);
    timer.unref();
  };
  const pass = async (): Promise<boolean> => {
    if (state.runCompleted || state.selections.length === 0) return false;
    let progressed = false;
    let allTerminal = true;
    for (const current of state.selections) {
      if (stopped) break;
      if (current.terminalState) continue;
      const candidate = candidates.get(current.candidateId);
      const result = await input.adapter.processNextBatch({
        ...(candidate ? { candidate } : {}),
        selection: current,
        ...(state.runId ? { runId: state.runId } : {})
      });
      const index = state.selections.findIndex(
        (selection) => selection.candidateId === current.candidateId
      );
      if (index >= 0) {
        state.selections[index] =
          result.state === "completed" || result.state === "skipped"
            ? { ...result.selection, terminalState: result.state }
            : result.selection;
      }
      if (result.runId) state.runId = result.runId;
      if (result.state === "progress") progressed = true;
      if (result.state !== "completed" && result.state !== "skipped") {
        allTerminal = false;
      }
      save();
      // Selection order is chronological. Exhaust (or explicitly skip) the
      // oldest raw range before admitting bytes from the next one. Semantic
      // finalization may finish later and remains a downstream concern.
      if (result.state === "progress" || result.state === "waiting") break;
    }
    if (allTerminal && state.runId && input.adapter.completeRun) {
      await input.adapter.completeRun(state.runId);
      state = { ...state, runCompleted: true };
      save();
    }
    return progressed;
  };
  const run = async (): Promise<void> => {
    if (running || stopped) return running ?? Promise.resolve();
    requested = false;
    running = (async () => {
      try {
        const progressed = await pass();
        if (progressed) requested = true;
      } catch (error) {
        input.onError?.(
          error instanceof Error && /^[a-z0-9_.:-]+$/.test(error.message)
            ? error.message
            : "historical_ingestion_pass_failed"
        );
      }
    })().finally(() => {
      running = null;
      if (requested) schedule();
      else if (!stopped && !state.runCompleted && state.selections.length > 0) {
        schedule(input.retryMs);
      }
    });
    return running;
  };

  return {
    offerCandidates(offered) {
      for (const candidate of offered) {
        candidates.set(input.adapter.candidateId(candidate), candidate);
      }
      if (!state.selectionFrozen) {
        state = {
          version: STATE_VERSION,
          selectionFrozen: true,
          runCompleted: false,
          selections: input.adapter.selectCandidates(
            [...candidates.values()],
            input.now?.() ?? new Date()
          )
        };
        save();
      }
      schedule();
    },
    selectionFor(candidateId) {
      const selection = state.selections.find(
        (candidate) => candidate.candidateId === candidateId
      );
      return selection ? structuredClone(selection) : undefined;
    },
    snapshot: () => structuredClone(state),
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    }
  };
};
