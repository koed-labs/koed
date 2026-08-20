export interface CostCrossingAttempt {
  attemptId: string;
  admittedMaximumCostUsd: number;
  observedCostUsd: number | null;
}

export interface CostStopCrossing {
  triggeringAttemptId: string;
  observedCostAtCrossingUsd: number;
  inFlightAttempts: readonly CostCrossingAttempt[];
}

export interface CostAdmissionSnapshot {
  observedCostUsd: number;
  reservedMaximumCostUsd: number;
  activeAttempts: number;
  stopped: boolean;
  crossing: CostStopCrossing | null;
}

const assertCost = (value: number, label: string, positive = false): void => {
  if (!Number.isFinite(value) || value < 0 || (positive && value === 0)) {
    throw new Error(
      `${label} must be a finite ${positive ? "positive" : "non-negative"} number`
    );
  }
};

interface Reservation {
  maximumCostUsd: number;
  observedCostUsd: number;
}

export class CostAdmissionController {
  private observedCostUsd = 0;
  private readonly reservations = new Map<string, Reservation>();
  private stopped = false;
  private crossing: {
    triggeringAttemptId: string;
    observedCostAtCrossingUsd: number;
    attempts: Map<string, CostCrossingAttempt>;
  } | null = null;

  constructor(
    private readonly stopUsd: number,
    private readonly providerLimitUsd: number,
    private readonly concurrency: number
  ) {
    assertCost(stopUsd, "Cost stop", true);
    assertCost(providerLimitUsd, "Provider limit", true);
    if (providerLimitUsd < stopUsd)
      throw new Error("Provider limit must not be below the cost stop");
    if (!Number.isSafeInteger(concurrency) || concurrency < 1)
      throw new Error("Concurrency must be a positive integer");
  }

  admit(attemptId: string, maximumCostUsd: number): void {
    if (
      !attemptId ||
      attemptId.trim() !== attemptId ||
      this.reservations.has(attemptId)
    ) {
      throw new Error("Attempt identity must be unique, exact and non-empty");
    }
    assertCost(maximumCostUsd, "Maximum attempt cost", true);
    if (this.stopped || this.observedCostUsd >= this.stopUsd) {
      this.stopped = true;
      throw new Error("Paid cost stop reached; no new attempt may start");
    }
    if (this.reservations.size >= this.concurrency)
      throw new Error("Benchmark concurrency is exhausted");
    const reserved = this.reservedMaximum();
    if (
      this.observedCostUsd + reserved + maximumCostUsd >
      this.providerLimitUsd + Number.EPSILON
    ) {
      throw new Error("Provider spending limit cannot cover this attempt");
    }
    this.reservations.set(attemptId, {
      maximumCostUsd,
      observedCostUsd: 0
    });
  }

  /** Account one observable coding-agent or nested-worker call immediately. */
  observe(attemptId: string, incrementalCostUsd: number): void {
    assertCost(incrementalCostUsd, "Observed incremental cost");
    const reservation = this.reservations.get(attemptId);
    if (!reservation) throw new Error(`Attempt is not active: ${attemptId}`);
    reservation.observedCostUsd += incrementalCostUsd;
    this.observedCostUsd += incrementalCostUsd;
    this.stopAtCrossing(attemptId);
    if (
      reservation.observedCostUsd >
      reservation.maximumCostUsd + Number.EPSILON
    ) {
      this.stopped = true;
      throw new Error("Observed attempt cost exceeded its admitted maximum");
    }
    if (this.observedCostUsd > this.providerLimitUsd + Number.EPSILON) {
      this.stopped = true;
      throw new Error("Observed cost exceeded the external provider limit");
    }
  }

  settle(attemptId: string, attemptCostUsd: number): void {
    assertCost(attemptCostUsd, "Observed attempt cost");
    const reservation = this.reservations.get(attemptId);
    if (!reservation) throw new Error(`Attempt is not active: ${attemptId}`);
    if (attemptCostUsd + Number.EPSILON < reservation.observedCostUsd) {
      throw new Error(
        "Final attempt cost cannot be below already observed cost"
      );
    }
    const incremental = attemptCostUsd - reservation.observedCostUsd;
    reservation.observedCostUsd = attemptCostUsd;
    this.observedCostUsd += incremental;
    this.stopAtCrossing(attemptId);

    // Account first so an estimate violation cannot hide real provider usage.
    this.reservations.delete(attemptId);
    if (this.crossing?.attempts.has(attemptId)) {
      this.crossing.attempts.set(attemptId, {
        ...this.crossing.attempts.get(attemptId)!,
        observedCostUsd: attemptCostUsd
      });
    }
    this.stopAtCrossing(attemptId, {
      maximumCostUsd: reservation.maximumCostUsd,
      observedCostUsd: attemptCostUsd
    });
    if (attemptCostUsd > reservation.maximumCostUsd + Number.EPSILON) {
      this.stopped = true;
      throw new Error("Observed attempt cost exceeded its admitted maximum");
    }
    if (this.observedCostUsd > this.providerLimitUsd + Number.EPSILON) {
      this.stopped = true;
      throw new Error("Observed cost exceeded the external provider limit");
    }
  }

  private stopAtCrossing(
    triggeringAttemptId: string,
    completed?: Reservation
  ): void {
    if (!this.crossing && this.observedCostUsd >= this.stopUsd) {
      const cohort = new Map<string, CostCrossingAttempt>();
      for (const [id, active] of this.reservations) {
        cohort.set(id, {
          attemptId: id,
          admittedMaximumCostUsd: active.maximumCostUsd,
          observedCostUsd: null
        });
      }
      if (completed) {
        cohort.set(triggeringAttemptId, {
          attemptId: triggeringAttemptId,
          admittedMaximumCostUsd: completed.maximumCostUsd,
          observedCostUsd: completed.observedCostUsd
        });
      }
      this.crossing = {
        triggeringAttemptId,
        observedCostAtCrossingUsd: this.observedCostUsd,
        attempts: cohort
      };
      this.stopped = true;
    }
  }

  private reservedMaximum(): number {
    return [...this.reservations.values()].reduce(
      (total, value) =>
        total + Math.max(0, value.maximumCostUsd - value.observedCostUsd),
      0
    );
  }

  snapshot(): CostAdmissionSnapshot {
    return {
      observedCostUsd: this.observedCostUsd,
      reservedMaximumCostUsd: this.reservedMaximum(),
      activeAttempts: this.reservations.size,
      stopped: this.stopped,
      crossing: this.crossing
        ? {
            triggeringAttemptId: this.crossing.triggeringAttemptId,
            observedCostAtCrossingUsd: this.crossing.observedCostAtCrossingUsd,
            inFlightAttempts: Object.freeze(
              [...this.crossing.attempts.values()].map((attempt) =>
                Object.freeze({ ...attempt })
              )
            )
          }
        : null
    };
  }
}
