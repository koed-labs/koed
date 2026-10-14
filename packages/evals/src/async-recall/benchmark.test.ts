import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryAnswerTaskSchema } from "@koed/shared";
import { scoreRecallTrace, type RecallEvent } from "./benchmark.js";
import { asyncRecallCases } from "./cases.js";
import { RecallFixture } from "./fixture.js";
import { referenceTrace } from "./index.js";

const independent = asyncRecallCases[0]!;
afterEach(() => vi.useRealTimers());

describe("submit/collect recall traces", () => {
  it.each(asyncRecallCases)(
    "scores the intended reference behavior for $id",
    (fixture) => {
      const score = scoreRecallTrace(fixture, referenceTrace(fixture.id));
      expect(score.passed).toBe(true);
      expect(score.advisory.score).toBe(score.advisory.maxScore);
    }
  );

  it("requires collection, not merely background completion, before a decision", () => {
    const events = referenceTrace(independent.id).filter(
      (event) => event.kind !== "collected"
    );
    const score = scoreRecallTrace(independent, events);
    expect(score.violations).toContain("result_not_collected:primary");
    expect(score.violations).toContain("premature_decision:primary");
  });

  it("rejects early decisions even when their eventual values are correct", () => {
    const events = referenceTrace(independent.id);
    const decision = events.pop()!;
    events.splice(3, 0, { ...decision, atMs: 3 });
    expect(scoreRecallTrace(independent, events).violations).toContain(
      "premature_decision:primary"
    );
  });

  it("keeps mode preference distinct from safe blocking behavior", () => {
    const events = referenceTrace(independent.id)
      .filter(
        (event) => !["receipt", "independent_action"].includes(event.kind)
      )
      .map((event) =>
        event.kind === "submitted"
          ? { ...event, mode: "blocking" as const }
          : event
      );
    const score = scoreRecallTrace(independent, events);
    expect(score.passed).toBe(true);
    expect(score.advisory.preferredModes).toBe(false);
    expect(score.advisory.usefulWorkDuringRecall).toBe(false);
  });

  it("treats a distinct narrower query as additional retrieval, not a duplicate", () => {
    const events = referenceTrace(independent.id);
    const submission = events[0]!;
    const extraId = "00000000-0000-4000-8000-000000000009";
    events.splice(5, 0, {
      ...submission,
      taskId: extraId,
      query: "retry delay",
      atMs: 5003
    });
    const score = scoreRecallTrace(independent, events);
    expect(score.passed).toBe(true);
    expect(score.advisory.extraRecallCount).toBe(1);
  });

  it("rejects an identical unresolved request instead of collecting its task", () => {
    const events = referenceTrace(independent.id);
    events.splice(3, 0, {
      ...events[0]!,
      taskId: "00000000-0000-4000-8000-000000000009",
      query: " PRIMARY  ",
      atMs: 3
    });
    expect(scoreRecallTrace(independent, events).violations).toContain(
      "resubmitted_uncollected_query:primary"
    );
  });

  it("distinguishes result collection from excessive tight pending polls", () => {
    const events = referenceTrace(independent.id);
    const base = events[1]!;
    events.splice(
      3,
      0,
      ...[100, 200, 300].map(
        (atMs): RecallEvent => ({
          ...base,
          kind: "pending_poll",
          atMs
        })
      )
    );
    const score = scoreRecallTrace(independent, events);
    expect(score.passed).toBe(true);
    expect(score.advisory.excessivePolling).toBe(true);
    expect(score.advisory.pendingPollCount).toBe(3);
  });

  it("attributes result collection to the exact submitted task", () => {
    const events = referenceTrace(independent.id).map((event) =>
      event.kind === "collected"
        ? { ...event, taskId: "different-task" }
        : event
    );
    const score = scoreRecallTrace(independent, events);
    expect(score.passed).toBe(false);
    expect(
      score.violations.some((value) =>
        value.startsWith("unknown_or_misattributed_task")
      )
    ).toBe(true);
  });

  it("counts model result requests, not internal reads while waiting until ready", () => {
    const events = referenceTrace(independent.id);
    const receipt = events[1]!;
    events.splice(3, 0, {
      ...receipt,
      kind: "result_requested",
      wait: true,
      atMs: 100
    });
    expect(
      scoreRecallTrace(independent, events).advisory.pendingPollCount
    ).toBe(0);
    events.splice(4, 0, { ...receipt, kind: "result_requested", atMs: 1500 });
    expect(
      scoreRecallTrace(independent, events).advisory.pendingPollCount
    ).toBe(1);
  });

  it("does not count a rejected result argument as pending polling", () => {
    const events = referenceTrace(independent.id);
    events.splice(3, 0, {
      ...events[1]!,
      kind: "result_requested",
      atMs: 100,
      invalidArgumentKeys: ["unsupported_setting"]
    });
    expect(
      scoreRecallTrace(independent, events).advisory.pendingPollCount
    ).toBe(0);
  });

  it("requires an honest unknown decision after no relevant memory", () => {
    const fixture = asyncRecallCases[2]!;
    const events = referenceTrace(fixture.id).map((event) =>
      event.kind === "dependent_action"
        ? { ...event, decision: { outcome: "unknown", retry_count: 1 } }
        : event
    );
    expect(scoreRecallTrace(fixture, events).violations).toContain(
      "invented_constraint:primary"
    );
  });

  it("does not count independent work done after completion as overlap", () => {
    const events = referenceTrace(independent.id).filter(
      (event) => event.kind !== "independent_action"
    );
    events.push({ kind: "independent_action", atMs: 6000 });
    expect(
      scoreRecallTrace(independent, events).advisory.usefulWorkDuringRecall
    ).toBe(false);
  });
});

describe("delayed synthetic recall fixture", () => {
  it("records immediate collection and waiting collection as distinct request modes", async () => {
    vi.useFakeTimers();
    const events: RecallEvent[] = [];
    const host = new RecallFixture(independent, (event) => events.push(event));
    const receipt = await host.submit("primary", "non_blocking");
    const id = String(receipt.task_id);
    host.resultRequested(id);
    host.resultRequested(id, true);
    expect(
      events
        .filter((event) => event.kind === "result_requested")
        .map((event) => event.wait)
    ).toEqual([false, true]);
    host.close();
  });

  it("returns an immediate receipt, permits diagnostics, and collects only when ready", async () => {
    vi.useFakeTimers();
    const events: RecallEvent[] = [];
    const host = new RecallFixture(
      independent,
      (event) => events.push(event),
      5000
    );
    const receipt = await host.submit("primary", "non_blocking");
    const id = String(receipt.task_id);
    expect(memoryAnswerTaskSchema.parse(host.snapshot(id)).status).toBe(
      "running"
    );
    expect(receipt.status).toBe("pending");
    expect(events.map((event) => event.kind)).toEqual(["submitted", "receipt"]);
    host.diagnostics();
    expect(host.collect(id).status).toBe("pending");
    await vi.advanceTimersByTimeAsync(5000);
    expect(memoryAnswerTaskSchema.parse(host.snapshot(id)).status).toBe(
      "completed"
    );
    expect(host.collect(id).markdown).toBe(independent.phases[0]!.memory);
    host.decide("primary", independent.phases[0]!.expected);
    expect(scoreRecallTrace(independent, events).passed).toBe(true);
    expect(
      scoreRecallTrace(independent, events).advisory.usefulWorkDuringRecall
    ).toBe(true);
    host.close();
  });

  it("blocking waits and delivers the same final result without result polling", async () => {
    vi.useFakeTimers();
    const events: RecallEvent[] = [];
    const host = new RecallFixture(
      asyncRecallCases[1]!,
      (event) => events.push(event),
      5000
    );
    const answer = host.submit("primary", "blocking");
    expect(events.map((event) => event.kind)).toEqual(["submitted"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await answer).markdown).toBe(independent.phases[0]!.memory);
    expect(events.map((event) => event.kind)).toEqual([
      "submitted",
      "completed",
      "collected"
    ]);
    host.close();
  });

  it("cancels without publishing a completion and rejects unknown task IDs", async () => {
    vi.useFakeTimers();
    const events: RecallEvent[] = [];
    const host = new RecallFixture(independent, (event) => events.push(event));
    const receipt = await host.submit("primary", "non_blocking");
    const id = String(receipt.task_id);
    expect(host.cancel(id).status).toBe("cancelled");
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.collect(id).status).toBe("cancelled");
    expect(events.some((event) => event.kind === "completed")).toBe(false);
    expect(() => host.collect("unknown")).toThrow("Unknown task_id");
    host.close();
  });
});
