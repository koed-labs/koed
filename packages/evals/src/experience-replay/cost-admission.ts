export interface CostAdmissionSnapshot {
  observedCostUsd: number;
  reservedMaximumCostUsd: number;
  activeAttempts: number;
  stopped: boolean;
}

const assertCost = (value: number, label: string): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
};

export class CostAdmissionController {
  private observedCostUsd = 0;
  private readonly reservations = new Map<string, number>();
  private stopped = false;

  constructor(
    private readonly stopUsd: number,
    private readonly providerLimitUsd: number,
    private readonly concurrency: number
  ) {
    assertCost(stopUsd, "Cost stop");
    assertCost(providerLimitUsd, "Provider limit");
    if (providerLimitUsd < stopUsd) {
      throw new Error("Provider limit must not be below the cost stop");
    }
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error("Concurrency must be a positive integer");
    }
  }

  admit(attemptId: string, maximumCostUsd: number): void {
    if (!attemptId || this.reservations.has(attemptId)) {
      throw new Error("Attempt identity must be unique and non-empty");
    }
    assertCost(maximumCostUsd, "Maximum attempt cost");
    if (this.stopped || this.observedCostUsd >= this.stopUsd) {
      this.stopped = true;
      throw new Error("Paid cost stop reached; no new attempt may start");
    }
    if (this.reservations.size >= this.concurrency) {
      throw new Error("Benchmark concurrency is exhausted");
    }
    const reserved = [...this.reservations.values()].reduce(
      (total, value) => total + value,
      0
    );
    if (
      this.observedCostUsd + reserved + maximumCostUsd >
      this.providerLimitUsd + Number.EPSILON
    ) {
      throw new Error("Provider spending limit cannot cover this attempt");
    }
    this.reservations.set(attemptId, maximumCostUsd);
  }

  settle(attemptId: string, observedCostUsd: number): void {
    assertCost(observedCostUsd, "Observed attempt cost");
    const reservation = this.reservations.get(attemptId);
    if (reservation === undefined) {
      throw new Error(`Attempt is not active: ${attemptId}`);
    }
    if (observedCostUsd > reservation + Number.EPSILON) {
      throw new Error("Observed attempt cost exceeded its admitted maximum");
    }
    this.reservations.delete(attemptId);
    this.observedCostUsd += observedCostUsd;
    if (this.observedCostUsd >= this.stopUsd) this.stopped = true;
  }

  snapshot(): CostAdmissionSnapshot {
    return {
      observedCostUsd: this.observedCostUsd,
      reservedMaximumCostUsd: [...this.reservations.values()].reduce(
        (total, value) => total + value,
        0
      ),
      activeAttempts: this.reservations.size,
      stopped: this.stopped
    };
  }
}
