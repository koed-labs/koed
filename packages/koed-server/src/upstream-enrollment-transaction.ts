export type UpstreamEnrollmentTransactionKind = "initial" | "replacement";

export type UpstreamEnrollmentTransactionPhase =
  | "prepared"
  | "awaiting_remote"
  | "awaiting_exchange"
  | "committing"
  | "committed"
  | "aborting"
  | "aborted"
  | "recovery_required";

export type UpstreamEnrollmentTransactionState =
  | "pending"
  | "approved"
  | "exchanged"
  | "denied"
  | "expired"
  | "canceled"
  | "revoked"
  | "failed";

export type UpstreamEnrollmentTransactionEffect =
  | "none"
  | "stage_pending_custody"
  | "compensate_pending_custody"
  | "record_challenge"
  | "commit_successor"
  | "abort_pending"
  | "revoke_active";

export interface UpstreamEnrollmentTransactionSnapshot {
  id: string;
  generation: number;
  kind: UpstreamEnrollmentTransactionKind;
  phase: UpstreamEnrollmentTransactionPhase;
  state: UpstreamEnrollmentTransactionState;
  pendingEffect: Exclude<UpstreamEnrollmentTransactionEffect, "none"> | null;
}

export type UpstreamEnrollmentTransactionEvent =
  | { type: "prepare" }
  | { type: "challenge_created" }
  | {
      type: "challenge_observed";
      status: "pending" | "approved" | "denied" | "expired" | "unknown";
    }
  | {
      type: "credential_observed";
      status: "active" | "rejected" | "unknown";
    }
  | { type: "cancel" }
  | { type: "revoke" }
  | { type: "effect_succeeded" }
  | { type: "effect_failed" }
  | { type: "recover" };

export interface UpstreamEnrollmentTransactionDecision {
  next: UpstreamEnrollmentTransactionSnapshot;
  effect: UpstreamEnrollmentTransactionEffect;
  temporary: boolean;
}

type ActiveUpstreamEnrollmentTransactionEffect = Exclude<
  UpstreamEnrollmentTransactionEffect,
  "none"
>;

export const executeUpstreamEnrollmentTransactionEffect = <T>(
  decision: UpstreamEnrollmentTransactionDecision,
  handlers: Partial<Record<ActiveUpstreamEnrollmentTransactionEffect, () => T>>
): T | null => {
  if (decision.effect === "none") return null;
  const handler = handlers[decision.effect];
  if (!handler) {
    throw new Error(
      `Enrollment transaction effect ${decision.effect} has no handler.`
    );
  }
  return handler();
};

const decision = (
  current: UpstreamEnrollmentTransactionSnapshot,
  update: Partial<UpstreamEnrollmentTransactionSnapshot>,
  effect: UpstreamEnrollmentTransactionEffect = "none",
  temporary = false
): UpstreamEnrollmentTransactionDecision => ({
  next: { ...current, ...update },
  effect,
  temporary
});

const beginEffect = (
  current: UpstreamEnrollmentTransactionSnapshot,
  phase: "committing" | "aborting",
  state: UpstreamEnrollmentTransactionState,
  effect: Exclude<UpstreamEnrollmentTransactionEffect, "none">
): UpstreamEnrollmentTransactionDecision =>
  decision(current, { phase, state, pendingEffect: effect }, effect);

export const createUpstreamEnrollmentTransaction = (input: {
  id: string;
  generation: number;
  kind: UpstreamEnrollmentTransactionKind;
}): UpstreamEnrollmentTransactionSnapshot => {
  if (!input.id.trim())
    throw new Error("Enrollment transaction id is required.");
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error("Enrollment transaction generation must be positive.");
  }
  return {
    id: input.id,
    generation: input.generation,
    kind: input.kind,
    phase: "prepared",
    state: "pending",
    pendingEffect: "stage_pending_custody"
  };
};

export const upstreamEnrollmentObservationApplies = (
  current: Pick<UpstreamEnrollmentTransactionSnapshot, "id" | "generation">,
  observation: { transactionId: string; generation: number }
): boolean =>
  current.id === observation.transactionId &&
  current.generation === observation.generation;

export const decideUpstreamEnrollmentTransaction = (
  current: UpstreamEnrollmentTransactionSnapshot,
  event: UpstreamEnrollmentTransactionEvent
): UpstreamEnrollmentTransactionDecision => {
  if (event.type === "prepare") {
    return current.phase === "prepared"
      ? decision(current, {}, "stage_pending_custody")
      : decision(current, {});
  }

  if (event.type === "effect_failed") {
    return current.pendingEffect
      ? decision(current, { phase: "recovery_required" })
      : decision(current, {});
  }

  if (event.type === "recover") {
    if (!current.pendingEffect) {
      return decision(current, {});
    }
    if (current.phase !== "recovery_required") {
      return current.phase === "prepared" ||
        current.phase === "awaiting_remote" ||
        current.phase === "committing" ||
        current.phase === "aborting"
        ? decision(current, {}, current.pendingEffect)
        : decision(current, {});
    }
    if (current.pendingEffect === "stage_pending_custody") {
      return beginEffect(
        current,
        "aborting",
        "failed",
        "compensate_pending_custody"
      );
    }
    const phase =
      current.pendingEffect === "commit_successor"
        ? "committing"
        : current.pendingEffect === "abort_pending" ||
            current.pendingEffect === "revoke_active"
          ? "aborting"
          : "awaiting_remote";
    return decision(current, { phase }, current.pendingEffect);
  }

  if (event.type === "effect_succeeded") {
    if (current.phase === "committing") {
      return decision(current, {
        phase: "committed",
        state: "exchanged",
        pendingEffect: null
      });
    }
    if (current.phase === "aborting") {
      return decision(current, { phase: "aborted", pendingEffect: null });
    }
    if (
      current.phase === "prepared" &&
      current.pendingEffect === "stage_pending_custody"
    ) {
      return decision(current, {
        phase: "awaiting_remote",
        pendingEffect: null
      });
    }
    if (
      current.phase === "awaiting_remote" &&
      current.pendingEffect === "record_challenge"
    ) {
      return decision(current, { pendingEffect: null });
    }
    return decision(current, {});
  }

  if (event.type === "challenge_created") {
    return current.phase === "prepared" || current.phase === "awaiting_remote"
      ? decision(
          current,
          {
            phase: "awaiting_remote",
            state: "pending",
            pendingEffect: "record_challenge"
          },
          "record_challenge"
        )
      : decision(current, {});
  }

  if (event.type === "challenge_observed") {
    if (event.status === "unknown") return decision(current, {}, "none", true);
    if (event.status === "pending") {
      return decision(current, {
        phase: "awaiting_remote",
        state: "pending",
        pendingEffect: null
      });
    }
    if (event.status === "approved") {
      return decision(current, {
        phase: "awaiting_exchange",
        state: "approved",
        pendingEffect: null
      });
    }
    return beginEffect(current, "aborting", event.status, "abort_pending");
  }

  if (event.type === "credential_observed") {
    if (event.status === "unknown") return decision(current, {}, "none", true);
    if (event.status === "active") {
      return beginEffect(
        current,
        "committing",
        "exchanged",
        "commit_successor"
      );
    }
    return current.phase === "committed" || current.state === "exchanged"
      ? beginEffect(current, "aborting", "failed", "revoke_active")
      : decision(current, {});
  }

  if (event.type === "cancel") {
    return current.phase === "committed" || current.phase === "aborted"
      ? decision(current, {})
      : beginEffect(current, "aborting", "canceled", "abort_pending");
  }

  return current.phase === "aborted"
    ? decision(current, {})
    : beginEffect(current, "aborting", "revoked", "revoke_active");
};
