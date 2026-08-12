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
      stopped: true
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
    expect(() => gate.settle("attempt-a", Number.NaN)).toThrow("finite");
  });
});
