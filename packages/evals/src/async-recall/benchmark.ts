export type Phase = "primary" | "followup";
export type Mode = "blocking" | "non_blocking";
export interface RecallCase {
  id: string;
  prompt: string;
  independentWork: boolean;
  phases: {
    phase: Phase;
    preferredMode: Mode;
    memory: string | null;
    expected: Record<string, unknown>;
  }[];
}

export interface RecallEvent {
  kind:
    | "submitted"
    | "receipt"
    | "completed"
    | "collected"
    | "result_requested"
    | "pending_poll"
    | "cancelled"
    | "independent_action"
    | "dependent_action";
  atMs: number;
  phase?: Phase;
  taskId?: string;
  mode?: Mode;
  query?: string;
  waitSeconds?: number;
  outcome?: "found" | "not_found";
  decision?: Record<string, unknown>;
}

export interface RecallScore {
  caseId: string;
  passed: boolean;
  violations: string[];
  advisory: {
    preferredModes: boolean;
    usefulWorkDuringRecall: boolean | null;
    excessivePolling: boolean;
    pendingPollCount: number;
    tightPollCount: number;
    extraRecallCount: number;
    score: number;
    maxScore: number;
  };
}

// Mode selection and polling budgets are benchmark preferences, not protocol errors.
export function scoreRecallTrace(
  fixture: RecallCase,
  events: RecallEvent[]
): RecallScore {
  const violations: string[] = [];
  let preferredModes = true;
  let usefulWorkDuringRecall = !fixture.independentWork;
  let pendingPollCount = 0;
  let tightPollCount = 0;
  let extraRecallCount = 0;
  const knownTasks = new Map<string, { phase: Phase; submitted: number }>();
  let previousTime = -1;
  for (const [index, event] of events.entries()) {
    if (!Number.isFinite(event.atMs) || event.atMs < previousTime)
      violations.push(`invalid_time:${index}`);
    previousTime = event.atMs;
    if (
      event.phase &&
      !fixture.phases.some((phase) => phase.phase === event.phase)
    )
      violations.push(`unexpected_phase:${index}`);
    if (event.kind === "submitted" && event.taskId && event.phase) {
      if (knownTasks.has(event.taskId))
        violations.push(`reused_task:${event.taskId}`);
      knownTasks.set(event.taskId, { phase: event.phase, submitted: index });
    } else if (
      [
        "receipt",
        "completed",
        "collected",
        "pending_poll",
        "result_requested",
        "cancelled"
      ].includes(event.kind)
    ) {
      const task = event.taskId ? knownTasks.get(event.taskId) : undefined;
      if (!task || task.phase !== event.phase)
        violations.push(`unknown_or_misattributed_task:${index}`);
    }
  }
  if (fixture.phases.length > 1) {
    const primaryDecision = events.findIndex(
      (event) => event.kind === "dependent_action" && event.phase === "primary"
    );
    const followupSubmission = events.findIndex(
      (event) => event.kind === "submitted" && event.phase === "followup"
    );
    if (primaryDecision < 0 || followupSubmission <= primaryDecision)
      violations.push("followup_before_primary_decision");
  }
  for (const phase of fixture.phases) {
    const indexed = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.phase === phase.phase);
    const submissions = indexed.filter(
      ({ event }) => event.kind === "submitted"
    );
    if (submissions.length === 0) {
      violations.push(`recall_count:${phase.phase}:${submissions.length}`);
      preferredModes = false;
      continue;
    }
    extraRecallCount += Math.max(0, submissions.length - 1);
    for (const current of submissions) {
      const normalized = current.event.query
        ?.toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
      if (!normalized) continue;
      const previous = submissions.find(
        (entry) =>
          entry.index < current.index &&
          entry.event.query?.toLowerCase().replace(/\s+/g, " ").trim() ===
            normalized
      );
      if (
        previous &&
        !events.some(
          (event, index) =>
            index < current.index &&
            event.kind === "collected" &&
            event.taskId === previous.event.taskId
        )
      )
        violations.push(`resubmitted_uncollected_query:${phase.phase}`);
    }
    const submission = submissions[0]!;
    const mode = submission.event.mode;
    preferredModes &&= mode === phase.preferredMode;
    const taskEvents = indexed.filter(
      ({ event }) => event.taskId === submission.event.taskId
    );
    const completion = taskEvents.find(
      ({ event }) => event.kind === "completed"
    );
    const collection = taskEvents.find(
      ({ event }) => event.kind === "collected"
    );
    const receipt = taskEvents.find(({ event }) => event.kind === "receipt");
    if (!completion || !collection || collection.index < completion.index)
      violations.push(`result_not_collected:${phase.phase}`);
    if (
      mode === "non_blocking" &&
      (!receipt || receipt.index < submission.index)
    )
      violations.push(`missing_receipt:${phase.phase}`);
    if (
      mode === "non_blocking" &&
      receipt &&
      completion &&
      receipt.index > completion.index
    )
      violations.push(`late_receipt:${phase.phase}`);
    const actions = indexed.filter(
      ({ event }) => event.kind === "dependent_action"
    );
    if (actions.length !== 1)
      violations.push(`decision_count:${phase.phase}:${actions.length}`);
    for (const action of actions) {
      if (!collection || action.index < collection.index)
        violations.push(`premature_decision:${phase.phase}`);
      if (
        !Object.entries(phase.expected).every(
          ([key, value]) => action.event.decision?.[key] === value
        )
      )
        violations.push(`incorrect_decision:${phase.phase}`);
      if (
        phase.memory === null &&
        Object.keys(action.event.decision ?? {}).some(
          (key) => key !== "outcome"
        )
      )
        violations.push(`invented_constraint:${phase.phase}`);
    }
    if (collection?.event.outcome !== (phase.memory ? "found" : "not_found"))
      violations.push(`incorrect_memory_outcome:${phase.phase}`);
    if (fixture.independentWork && phase.phase === "primary") {
      usefulWorkDuringRecall =
        !!receipt &&
        events.some(
          (event, index) =>
            event.kind === "independent_action" &&
            index > receipt.index &&
            (!completion || index < completion.index)
        );
    }
    const polls = indexed.filter(({ event, index }) => {
      if (event.kind === "pending_poll") return true;
      if (event.kind !== "result_requested") return false;
      const nextRequest = indexed.find(
        (entry) =>
          entry.index > index &&
          entry.event.kind === "result_requested" &&
          entry.event.taskId === event.taskId
      );
      return !indexed.some(
        (entry) =>
          entry.event.kind === "collected" &&
          entry.event.taskId === event.taskId &&
          entry.index > index &&
          (!nextRequest || entry.index < nextRequest.index)
      );
    });
    pendingPollCount += polls.length;
    let lastPollAt = receipt?.event.atMs;
    for (const { event } of polls) {
      if (lastPollAt !== undefined && event.atMs - lastPollAt < 1_000)
        tightPollCount += 1;
      lastPollAt = event.atMs;
    }
  }
  const excessivePolling = pendingPollCount > 2 || tightPollCount > 1;
  const maxScore = fixture.independentWork ? 4 : 3;
  return {
    caseId: fixture.id,
    passed: violations.length === 0,
    violations,
    advisory: {
      preferredModes,
      usefulWorkDuringRecall: fixture.independentWork
        ? usefulWorkDuringRecall
        : null,
      excessivePolling,
      pendingPollCount,
      tightPollCount,
      extraRecallCount,
      score:
        Number(preferredModes) +
        Number(!excessivePolling) +
        Number(extraRecallCount === 0) +
        (fixture.independentWork ? Number(usefulWorkDuringRecall) : 0),
      maxScore
    }
  };
}
