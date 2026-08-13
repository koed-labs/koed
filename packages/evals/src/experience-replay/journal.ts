import {
  assertBoundedPath,
  readTextFileNoFollow,
  validateArtifactRelativePath
} from "./artifacts.js";
import type { SafeRunDirectory } from "./output-path.js";

const MAX_JOURNAL_BYTES = 256 * 1024 * 1024;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

export const RUN_PHASES = [
  "preflight",
  "source_attempts",
  "atif_sanitization",
  "placebo_assignment",
  "canonical_koed_ingestion",
  "semantic_readiness",
  "template_creation",
  "replay_schedule",
  "replay_execution",
  "metric_merge",
  "trajectory_judging",
  "report_generation",
  "teardown"
] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

interface JournalBase {
  version: 1;
  sequence: number;
  configurationHash: string;
  recordedAt: string;
}

export type RunJournalEntry =
  | (JournalBase & {
      type: "phase";
      phase: RunPhase;
      status: "started" | "completed" | "blocked" | "skipped";
      detail?: string;
    })
  | (JournalBase & {
      type: "attempt_state";
      attemptId: string;
      executionGeneration: number;
      state: "admitted" | "agent_started";
    })
  | (JournalBase & {
      type: "attempt_result";
      attemptId: string;
      executionGeneration: number;
      resultPath: string;
      /** Digest and embedded identity for every committed result artifact. */
      resultSha256: string;
      resultIdentity: {
        attemptId: string;
        executionGeneration: number;
      };
      reward: number | null;
      failureCategory: string | null;
    });
type AttemptJournalEntry = Exclude<RunJournalEntry, { type: "phase" }>;

const RETRYABLE_PRE_AGENT_FAILURES = new Set(["setup_failed", "setup_timeout"]);

const isRetryablePreAgentResult = (
  result: Extract<AttemptJournalEntry, { type: "attempt_result" }> | undefined,
  agentStarted: boolean
): boolean =>
  !agentStarted &&
  result?.failureCategory != null &&
  RETRYABLE_PRE_AGENT_FAILURES.has(result.failureCategory);

type JournalEntryInput<T> = T extends unknown
  ? Omit<T, keyof JournalBase>
  : never;
export type RunJournalEntryInput = JournalEntryInput<RunJournalEntry>;

const assertEntry = (value: unknown, index: number): RunJournalEntry => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid journal entry at line ${index + 1}`);
  }
  const entry = value as Record<string, unknown>;
  if (
    entry.version !== 1 ||
    !Number.isSafeInteger(entry.sequence) ||
    entry.sequence !== index
  ) {
    throw new Error(`Non-contiguous journal sequence at line ${index + 1}`);
  }
  if (
    typeof entry.configurationHash !== "string" ||
    typeof entry.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(entry.recordedAt)) ||
    typeof entry.type !== "string" ||
    !["phase", "attempt_state", "attempt_result"].includes(entry.type)
  ) {
    throw new Error(`Malformed journal entry at line ${index + 1}`);
  }
  assertBoundedPath(entry.configurationHash, "Journal configuration hash");
  if (entry.type === "phase") {
    if (
      !RUN_PHASES.includes(entry.phase as RunPhase) ||
      typeof entry.status !== "string" ||
      !["started", "completed", "blocked", "skipped"].includes(entry.status) ||
      (entry.detail !== undefined && typeof entry.detail !== "string")
    ) {
      throw new Error(`Malformed phase journal entry at line ${index + 1}`);
    }
  } else {
    if (
      typeof entry.attemptId !== "string" ||
      !Number.isSafeInteger(entry.executionGeneration) ||
      (entry.executionGeneration as number) < 1
    ) {
      throw new Error(`Malformed attempt journal entry at line ${index + 1}`);
    }
    assertBoundedPath(entry.attemptId, "Journal attempt id");
    if (entry.type === "attempt_state") {
      if (
        typeof entry.state !== "string" ||
        !["admitted", "agent_started"].includes(entry.state)
      ) {
        throw new Error(
          `Malformed attempt-state journal entry at line ${index + 1}`
        );
      }
    } else if (
      typeof entry.resultPath !== "string" ||
      (entry.reward !== null &&
        (typeof entry.reward !== "number" || !Number.isFinite(entry.reward))) ||
      (entry.failureCategory !== null &&
        typeof entry.failureCategory !== "string") ||
      typeof entry.resultSha256 !== "string" ||
      !SHA256.test(entry.resultSha256) ||
      !entry.resultIdentity ||
      typeof entry.resultIdentity !== "object" ||
      Array.isArray(entry.resultIdentity)
    ) {
      throw new Error(
        `Malformed attempt-result journal entry at line ${index + 1}`
      );
    } else {
      validateArtifactRelativePath(entry.resultPath);
      const identity = entry.resultIdentity as Record<string, unknown>;
      if (
        Object.keys(identity).length !== 2 ||
        identity.attemptId !== entry.attemptId ||
        identity.executionGeneration !== entry.executionGeneration
      ) {
        throw new Error(
          `Result artifact identity mismatch at line ${index + 1}`
        );
      }
    }
  }
  return entry as unknown as RunJournalEntry;
};

const validateAttemptHistory = (entries: readonly RunJournalEntry[]): void => {
  const byAttempt = new Map<string, AttemptJournalEntry[]>();
  for (const entry of entries) {
    if (entry.type === "phase") continue;
    const values = byAttempt.get(entry.attemptId) ?? [];
    values.push(entry);
    byAttempt.set(entry.attemptId, values);
  }

  for (const [attemptId, values] of byAttempt) {
    const generations = [
      ...new Set(values.map((entry) => entry.executionGeneration))
    ].sort((left, right) => left - right);
    for (const [index, generation] of generations.entries()) {
      if (generation !== index + 1) {
        throw new Error(
          `Attempt ${attemptId} has non-contiguous execution generations`
        );
      }
    }

    let terminalGeneration: number | undefined;
    let priorGenerationReachedAgent = false;
    for (const generation of generations) {
      const generationEntries = values.filter(
        (entry) => entry.executionGeneration === generation
      );
      const admitted = generationEntries.filter(
        (entry) => entry.type === "attempt_state" && entry.state === "admitted"
      );
      const started = generationEntries.filter(
        (entry) =>
          entry.type === "attempt_state" && entry.state === "agent_started"
      );
      const results = generationEntries.filter(
        (entry) => entry.type === "attempt_result"
      );
      if (admitted.length > 1 || started.length > 1 || results.length > 1) {
        throw new Error(
          `Attempt ${attemptId} generation ${generation} has duplicate state`
        );
      }
      if (generation > 1 && admitted.length !== 1) {
        throw new Error(
          `Attempt ${attemptId} generation ${generation} lacks admission`
        );
      }
      if (generation > 1 && priorGenerationReachedAgent) {
        throw new Error(
          `Attempt ${attemptId} continued after an irreversible prior generation`
        );
      }
      const admittedSequence = admitted[0]?.sequence;
      const startedSequence = started[0]?.sequence;
      const resultSequence = results[0]?.sequence;
      if (
        admittedSequence !== undefined &&
        startedSequence !== undefined &&
        admittedSequence >= startedSequence
      ) {
        throw new Error(
          `Attempt ${attemptId} generation ${generation} started before admission`
        );
      }
      if (
        startedSequence !== undefined &&
        resultSequence !== undefined &&
        startedSequence >= resultSequence
      ) {
        throw new Error(
          `Attempt ${attemptId} generation ${generation} completed before agent start`
        );
      }
      if (
        admittedSequence !== undefined &&
        resultSequence !== undefined &&
        admittedSequence >= resultSequence
      ) {
        throw new Error(
          `Attempt ${attemptId} generation ${generation} completed before admission`
        );
      }
      const retryablePreAgentResult = isRetryablePreAgentResult(
        results[0],
        started.length === 1
      );
      if (results.length === 1 && !retryablePreAgentResult) {
        terminalGeneration = generation;
      }
      if (terminalGeneration !== undefined && generation > terminalGeneration) {
        throw new Error(
          `Attempt ${attemptId} continued after a terminal result`
        );
      }
      priorGenerationReachedAgent =
        started.length === 1 ||
        (results.length === 1 && !retryablePreAgentResult);
    }
  }
};

export const readRunJournal = async (
  journalPath: string,
  configurationHash: string
): Promise<RunJournalEntry[]> => {
  let text: string;
  try {
    text = await readTextFileNoFollow(journalPath, MAX_JOURNAL_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (text.length > 0 && !text.endsWith("\n")) {
    throw new Error("Journal has an incomplete final record");
  }
  const entries = text
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`Invalid JSON journal entry at line ${index + 1}`);
      }
      const entry = assertEntry(parsed, index);
      if (entry.configurationHash !== configurationHash) {
        throw new Error(
          `Configuration hash mismatch at journal line ${index + 1}`
        );
      }
      return entry;
    });
  validateAttemptHistory(entries);
  return entries;
};

export class RunJournal {
  private nextSequence: number;
  private appendTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: SafeRunDirectory,
    private readonly configurationHash: string,
    priorEntries: readonly RunJournalEntry[] = [],
    private readonly now: () => Date = () => new Date()
  ) {
    for (const [index, entry] of priorEntries.entries()) {
      if (
        entry.sequence !== index ||
        entry.configurationHash !== configurationHash
      ) {
        throw new Error("Cannot append to an incompatible run journal");
      }
    }
    validateAttemptHistory(priorEntries);
    this.priorAttemptEntries.push(...priorEntries);
    this.nextSequence = priorEntries.length;
  }

  async append(entry: RunJournalEntryInput): Promise<RunJournalEntry> {
    let complete: RunJournalEntry | undefined;
    const operation = this.appendTail.then(async () => {
      complete = {
        ...entry,
        version: 1 as const,
        sequence: this.nextSequence,
        configurationHash: this.configurationHash,
        recordedAt: this.now().toISOString()
      } as RunJournalEntry;
      assertEntry(complete, this.nextSequence);
      validateAttemptHistory([...this.priorAttemptEntries, complete]);
      await this.directory.appendJsonLine("journal.jsonl", complete);
      this.priorAttemptEntries.push(complete);
      this.nextSequence += 1;
    });
    this.appendTail = operation;
    await operation;
    return complete as RunJournalEntry;
  }

  private readonly priorAttemptEntries: RunJournalEntry[] = [];
}

export interface ResumeAttemptDecision {
  attemptId: string;
  action: "skip_completed" | "rerun_before_agent" | "preserve_missing";
  nextExecutionGeneration: number;
}

export const planAttemptResume = (
  expectedAttemptIds: readonly string[],
  entries: readonly RunJournalEntry[]
): ResumeAttemptDecision[] => {
  const expected = new Set(expectedAttemptIds);
  if (expected.size !== expectedAttemptIds.length) {
    throw new Error("Expected attempt identities must be unique");
  }
  const expectedKinds = new Set(
    expectedAttemptIds
      .map((attemptId) => /^(source|replay):/u.exec(attemptId)?.[1])
      .filter((kind): kind is string => kind !== undefined)
  );
  const byAttempt = new Map<string, RunJournalEntry[]>();
  for (const entry of entries) {
    if (entry.type === "phase") continue;
    if (!expected.has(entry.attemptId)) {
      const entryKind = /^(source|replay):/u.exec(entry.attemptId)?.[1];
      if (
        expectedKinds.size === 1 &&
        entryKind !== undefined &&
        !expectedKinds.has(entryKind)
      ) {
        continue;
      }
      throw new Error(`Journal contains unexpected attempt ${entry.attemptId}`);
    }
    const values = byAttempt.get(entry.attemptId) ?? [];
    values.push(entry);
    byAttempt.set(entry.attemptId, values);
  }
  return expectedAttemptIds.map((attemptId) => {
    const values = byAttempt.get(attemptId) ?? [];
    const generation = values.reduce(
      (maximum, entry) =>
        entry.type === "phase"
          ? maximum
          : Math.max(maximum, entry.executionGeneration),
      0
    );
    const latest = values.filter(
      (entry): entry is AttemptJournalEntry =>
        entry.type !== "phase" && entry.executionGeneration === generation
    );
    const terminal = latest.find(
      (
        entry
      ): entry is Extract<AttemptJournalEntry, { type: "attempt_result" }> =>
        entry.type === "attempt_result"
    );
    const agentStarted = latest.some(
      (entry) =>
        entry.type === "attempt_state" && entry.state === "agent_started"
    );
    if (terminal && !isRetryablePreAgentResult(terminal, agentStarted)) {
      return {
        attemptId,
        action: "skip_completed",
        nextExecutionGeneration: terminal.executionGeneration
      };
    }
    if (agentStarted) {
      return {
        attemptId,
        action: "preserve_missing",
        nextExecutionGeneration: generation
      };
    }
    return {
      attemptId,
      action: "rerun_before_agent",
      nextExecutionGeneration: generation + 1
    };
  });
};
