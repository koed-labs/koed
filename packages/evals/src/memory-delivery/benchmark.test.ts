import { describe, expect, it } from "vitest";
import {
  scoreDeliveryRun,
  scoreAttributedDeliveryRun,
  type DeliveryEvent
} from "./benchmark.mjs";

const settings = { retryDelayMs: 1729, cacheAuthorization: false };
const event = (
  kind: string,
  fields: Partial<DeliveryEvent> = {}
): DeliveryEvent => ({ kind, at: 0, ...fields });
const successful = [
  event("recall_requested", { mode: "non_blocking" }),
  event("receipt"),
  event("diagnostic_read"),
  event("final_response", { status: "waiting_for_memory" }),
  event("yield"),
  event("task_terminal"),
  event("completion", { outcome: "found" }),
  event("dependent_action"),
  event("final_response", { status: "fixed" })
];
const score = (events: DeliveryEvent[], actualSettings = settings) =>
  scoreDeliveryRun({
    scenario: "delayed",
    events,
    expectedSettings: settings,
    actualSettings,
    exitCode: 0
  });

describe("native Memory Answer dependency evidence", () => {
  it("requires each concurrent recalled constraint to reach its own target", () => {
    const expected = {
      alpha: settings,
      beta: { ...settings, retryDelayMs: 11729 }
    };
    const events = [
      event("recall_requested", { target: "alpha", mode: "non_blocking" }),
      event("recall_requested", { target: "beta", mode: "non_blocking" }),
      event("completion", { target: "beta", outcome: "found" }),
      event("dependent_action", { target: "beta" }),
      event("completion", { target: "alpha", outcome: "found" }),
      event("dependent_action", { target: "alpha" }),
      event("final_response", { status: "fixed" })
    ];
    expect(
      scoreAttributedDeliveryRun({
        scenario: "concurrent",
        events,
        expectedSettings: expected,
        actualSettings: expected
      }).passed
    ).toBe(true);
    expect(
      scoreAttributedDeliveryRun({
        scenario: "concurrent",
        events,
        expectedSettings: expected,
        actualSettings: { alpha: expected.beta, beta: expected.alpha }
      }).checks.correctAttribution
    ).toBe(false);
  });
  it("requires independent work, yielding, delivery and application of the constraint", () => {
    expect(score(successful).passed).toBe(true);
    expect(
      score(successful, { ...settings, retryDelayMs: 300 }).checks
        .usesRecalledConstraint
    ).toBe(false);
  });
  it("fails an early dependent action even when the final settings happen to be correct", () => {
    const events = successful.filter((e) => e.kind !== "dependent_action");
    events.splice(3, 0, event("dependent_action"));
    expect(score(events).checks.noPrematureDependentAction).toBe(false);
    expect(score(events).passed).toBe(false);
  });
  it("does not treat task readiness or a final claim as delivered evidence", () => {
    expect(
      score(successful.filter((e) => e.kind !== "completion")).passed
    ).toBe(false);
    const events = successful.filter((e) => e.kind !== "dependent_action");
    expect(score(events).checks.noFalseCompletionClaim).toBe(false);
  });
  it("rejects duplicate recall, model polling, and a missing native receipt", () => {
    expect(
      score([...successful, event("recall_requested", { mode: "blocking" })])
        .checks.oneRecallInvocation
    ).toBe(false);
    expect(
      score([...successful, event("model_poll")]).checks.noModelPolling
    ).toBe(false);
    expect(score(successful.filter((e) => e.kind !== "receipt")).passed).toBe(
      false
    );
  });
  it("allows native Pi to receive an already-ready result without a Stop yield", () => {
    const events = [
      event("recall_requested", { mode: "non_blocking" }),
      event("task_terminal"),
      event("receipt"),
      event("diagnostic_read"),
      event("completion", { outcome: "found" }),
      event("dependent_action"),
      event("final_response", { status: "fixed" })
    ];
    expect(
      scoreDeliveryRun({
        scenario: "fast",
        host: "pi",
        events,
        expectedSettings: settings,
        actualSettings: settings,
        exitCode: 0
      }).passed
    ).toBe(true);
    expect(
      scoreDeliveryRun({
        scenario: "fast",
        host: "codex",
        events,
        expectedSettings: settings,
        actualSettings: settings,
        exitCode: 0
      }).passed
    ).toBe(false);
  });
});
