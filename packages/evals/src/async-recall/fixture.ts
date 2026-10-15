import { randomUUID } from "node:crypto";
import type { MemoryAnswerTask } from "@koed/shared";
import type { Mode, Phase, RecallCase, RecallEvent } from "./benchmark.js";

interface Task {
  id: string;
  phase: Phase;
  memory: string | null;
  result: Record<string, unknown>;
  state: "pending" | "completed" | "cancelled";
  timer: ReturnType<typeof setTimeout>;
  ready: Promise<void>;
  resolve: () => void;
}

/** Synthetic delayed recall only; this is not the production task manager. */
export class RecallFixture {
  private readonly tasks = new Map<string, Task>();
  private readonly decidedPhases = new Set<Phase>();
  private readonly started = Date.now();
  constructor(
    private readonly fixture: RecallCase,
    private readonly observe: (event: RecallEvent) => void,
    private readonly delayMs = 5_000
  ) {}

  recallPhase(): Phase {
    return (
      this.fixture.phases.find(({ phase }) => !this.decidedPhases.has(phase)) ??
      this.fixture.phases[this.fixture.phases.length - 1]!
    ).phase;
  }

  private emit(event: Omit<RecallEvent, "atMs">): void {
    this.observe({ ...event, atMs: Date.now() - this.started });
  }

  recallRequested(args: Record<string, unknown>): void {
    this.emit({ kind: "recall_requested", arguments: structuredClone(args) });
  }

  async submit(
    phase: Phase,
    mode: Mode,
    query?: string,
    detail: { response_detail?: unknown; include_evidence?: unknown } = {}
  ): Promise<Record<string, unknown>> {
    const spec = this.fixture.phases.find((entry) => entry.phase === phase);
    if (!spec) throw new Error(`Unsupported phase: ${phase}`);
    const id = randomUUID();
    let resolve!: () => void;
    const ready = new Promise<void>((done) => {
      resolve = done;
    });
    const withEvidence =
      detail.include_evidence === true ||
      detail.response_detail === "with_evidence";
    const withCitations =
      withEvidence || detail.response_detail === "with_citations";
    const task: Task = {
      id,
      phase,
      memory: spec.memory,
      result: {
        markdown: spec.memory ?? "No relevant memory found.",
        ...(withCitations
          ? {
              citations:
                spec.memory === null ? [] : [{ sourceId: `fixture-${phase}` }]
            }
          : {}),
        ...(withEvidence
          ? {
              evidence:
                spec.memory === null
                  ? []
                  : [{ sourceId: `fixture-${phase}`, summaryText: spec.memory }]
            }
          : {})
      },
      state: "pending",
      ready,
      resolve,
      timer: setTimeout(() => {
        task.state = "completed";
        this.emit({ kind: "completed", phase, taskId: id });
        resolve();
      }, this.delayMs)
    };
    this.tasks.set(id, task);
    this.emit({ kind: "submitted", phase, taskId: id, mode, query });
    if (mode === "blocking") {
      await ready;
      return this.collect(id);
    }
    this.emit({ kind: "receipt", phase, taskId: id });
    return {
      status: "pending",
      task_id: id,
      guidance:
        "Continue independent work; collect with memory_answer_result before a dependent action. Avoid tight polling."
    };
  }

  resultRequested(
    id: string,
    wait = false,
    invalidArgumentKeys: string[] = []
  ): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error("Unknown task_id");
    this.emit({
      kind: "result_requested",
      phase: task.phase,
      taskId: id,
      wait,
      invalidArgumentKeys
    });
  }

  collect(id: string, observePending = true): Record<string, unknown> {
    const task = this.tasks.get(id);
    if (!task) throw new Error("Unknown task_id");
    if (task.state === "pending") {
      if (observePending)
        this.emit({ kind: "pending_poll", phase: task.phase, taskId: id });
      return { status: "pending", task_id: id };
    }
    if (task.state === "cancelled") return { status: "cancelled", task_id: id };
    this.emit({
      kind: "collected",
      phase: task.phase,
      taskId: id,
      outcome: task.memory === null ? "not_found" : "found"
    });
    return structuredClone(task.result);
  }

  cancel(id: string): Record<string, unknown> {
    const task = this.tasks.get(id);
    if (!task) throw new Error("Unknown task_id");
    if (task.state === "pending") {
      clearTimeout(task.timer);
      task.state = "cancelled";
      task.resolve();
      this.emit({ kind: "cancelled", phase: task.phase, taskId: id });
    }
    return { status: task.state, task_id: id };
  }

  snapshot(id: string): MemoryAnswerTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error("Unknown task_id");
    const now = new Date().toISOString();
    return {
      id,
      origin: "mcp",
      invocationKey: null,
      questionId: null,
      status: task.state === "pending" ? "running" : task.state,
      statusMessage: null,
      attemptCount: 1,
      maxAttempts: 1,
      fenceGeneration: 1,
      cancelRequestedAt: null,
      startedAt: now,
      lastProgressAt: now,
      completedAt: task.state === "completed" ? now : null,
      failedAt: null,
      cancelledAt: task.state === "cancelled" ? now : null,
      lastErrorCode: null,
      lastErrorMessage: null,
      result: task.state === "completed" ? structuredClone(task.result) : null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
  }

  diagnostics(): Record<string, unknown> {
    this.emit({ kind: "independent_action" });
    return {
      error: "Import timed out after a transient connection failure.",
      current_retry_count: 0
    };
  }

  decide(phase: Phase, decision: Record<string, unknown>): void {
    this.decidedPhases.add(phase);
    this.emit({ kind: "dependent_action", phase, decision });
  }

  close(): void {
    for (const task of this.tasks.values()) {
      clearTimeout(task.timer);
      task.resolve();
    }
  }
}
