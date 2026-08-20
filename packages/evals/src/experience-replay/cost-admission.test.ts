import { describe, expect, it } from "vitest";
import { CostAdmissionController } from "./cost-admission.js";

describe("experience replay paid-cost admission", () => {
  it("allows admitted in-flight work to finish but stops new work at the cost boundary", () => {
    const gate = new CostAdmissionController(10, 14, 2);
    gate.admit("attempt-a", 5);
    gate.admit("attempt-b", 5);
    expect(() => gate.admit("attempt-c", 1)).toThrow("concurrency");
    gate.settle("attempt-a", 5);
    gate.admit("attempt-c", 4);
    gate.settle("attempt-b", 5);
    gate.settle("attempt-c", 4);
    expect(gate.snapshot()).toEqual({
      observedCostUsd: 14,
      reservedMaximumCostUsd: 0,
      activeAttempts: 0,
      stopped: true,
      crossing: {
        triggeringAttemptId: "attempt-b",
        observedCostAtCrossingUsd: 10,
        inFlightAttempts: [
          {
            attemptId: "attempt-b",
            admittedMaximumCostUsd: 5,
            observedCostUsd: 5
          },
          {
            attemptId: "attempt-c",
            admittedMaximumCostUsd: 4,
            observedCostUsd: 4
          }
        ]
      }
    });
    expect(() => gate.admit("attempt-d", 1)).toThrow("cost stop");
  });

  it("never reserves beyond the external provider cap", () => {
    const gate = new CostAdmissionController(10, 11, 2);
    gate.admit("attempt-a", 6);
    expect(() => gate.admit("attempt-b", 6)).toThrow("Provider spending");
    gate.settle("attempt-a", 6);
    gate.admit("attempt-b", 5);
    expect(gate.snapshot().reservedMaximumCostUsd).toBe(5);
  });

  it("rejects duplicate, unknown, invalid and under-reserved accounting", () => {
    const gate = new CostAdmissionController(10, 12, 1);
    gate.admit("attempt-a", 2);
    expect(() => gate.admit("attempt-a", 2)).toThrow("unique");
    expect(() => gate.settle("missing", 1)).toThrow("not active");
    expect(() => gate.settle("attempt-a", 3)).toThrow("exceeded");
    expect(gate.snapshot()).toMatchObject({
      observedCostUsd: 3,
      activeAttempts: 0,
      stopped: true
    });
    expect(() => gate.settle("attempt-a", Number.NaN)).toThrow("finite");
  });

  it("rejects zero budgets, zero reservations, whitespace identities and invalid concurrency", () => {
    expect(() => new CostAdmissionController(0, 1, 1)).toThrow("positive");
    expect(() => new CostAdmissionController(1, 1, 0)).toThrow("Concurrency");
    const gate = new CostAdmissionController(1, 2, 1);
    expect(() => gate.admit(" attempt", 1)).toThrow("exact");
    expect(() => gate.admit("attempt", 0)).toThrow("positive");
  });

  it("records every attempt in flight at the crossing and fills costs as they settle", () => {
    const gate = new CostAdmissionController(5, 9, 2);
    gate.admit("first", 4);
    gate.admit("second", 4);
    expect(() => gate.settle("first", 5)).toThrow("exceeded");
    expect(gate.snapshot().crossing?.inFlightAttempts).toEqual([
      { attemptId: "first", admittedMaximumCostUsd: 4, observedCostUsd: 5 },
      { attemptId: "second", admittedMaximumCostUsd: 4, observedCostUsd: null }
    ]);
    // Estimate violations fail closed but real cost remains accounted.
    expect(gate.snapshot().observedCostUsd).toBe(5);
    gate.settle("second", 3);
    expect(gate.snapshot().crossing?.inFlightAttempts[1]).toEqual({
      attemptId: "second",
      admittedMaximumCostUsd: 4,
      observedCostUsd: 3
    });
  });

  it("stops admission immediately when a nested call crosses the stop", () => {
    const gate = new CostAdmissionController(5, 8, 2);
    gate.admit("top-a", 4);
    gate.admit("top-b", 4);
    gate.observe("top-a", 3);
    gate.observe("top-b", 2);
    expect(() => gate.admit("top-c", 1)).toThrow("cost stop");
    expect(gate.snapshot()).toMatchObject({
      observedCostUsd: 5,
      activeAttempts: 2,
      stopped: true,
      crossing: {
        triggeringAttemptId: "top-b",
        observedCostAtCrossingUsd: 5,
        inFlightAttempts: [
          { attemptId: "top-a", observedCostUsd: null },
          { attemptId: "top-b", observedCostUsd: null }
        ]
      }
    });
    gate.settle("top-a", 4);
    gate.settle("top-b", 3);
    expect(gate.snapshot().observedCostUsd).toBe(7);
    expect(gate.snapshot().crossing?.inFlightAttempts).toMatchObject([
      { attemptId: "top-a", observedCostUsd: 4 },
      { attemptId: "top-b", observedCostUsd: 3 }
    ]);
  });

  it("rejects decreasing final totals after incremental observations", () => {
    const gate = new CostAdmissionController(5, 6, 1);
    gate.admit("top", 5);
    gate.observe("top", 2);
    expect(() => gate.settle("top", 1)).toThrow("below already observed");
    expect(gate.snapshot()).toMatchObject({
      observedCostUsd: 2,
      activeAttempts: 1
    });
  });
});
