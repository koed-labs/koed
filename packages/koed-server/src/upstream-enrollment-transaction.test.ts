import { describe, expect, it } from "vitest";

import {
  createUpstreamEnrollmentTransaction,
  decideUpstreamEnrollmentTransaction,
  upstreamEnrollmentObservationApplies,
  type UpstreamEnrollmentTransactionEvent,
  type UpstreamEnrollmentTransactionSnapshot
} from "./upstream-enrollment-transaction.js";

const initial = (): UpstreamEnrollmentTransactionSnapshot =>
  createUpstreamEnrollmentTransaction({
    id: "enrollment-1",
    generation: 1,
    kind: "initial"
  });

const transition = (
  snapshot: UpstreamEnrollmentTransactionSnapshot,
  event: UpstreamEnrollmentTransactionEvent
) => decideUpstreamEnrollmentTransaction(snapshot, event).next;

describe("upstream enrollment transaction", () => {
  it("orders durable pending custody before remote challenge creation", () => {
    const prepared = initial();
    const stage = decideUpstreamEnrollmentTransaction(prepared, {
      type: "prepare"
    });

    expect(stage.effect).toBe("stage_pending_custody");
    const awaitingRemote = transition(prepared, { type: "effect_succeeded" });
    expect(awaitingRemote).toMatchObject({
      phase: "awaiting_remote",
      state: "pending",
      pendingEffect: null
    });
    expect(
      decideUpstreamEnrollmentTransaction(awaitingRemote, {
        type: "challenge_created"
      })
    ).toMatchObject({
      effect: "record_challenge",
      next: { pendingEffect: "record_challenge" }
    });
  });

  it.each([
    ["pending", "awaiting_remote", "pending", "none"],
    ["approved", "awaiting_exchange", "approved", "none"],
    ["denied", "aborting", "denied", "abort_pending"],
    ["expired", "aborting", "expired", "abort_pending"],
    ["unknown", "awaiting_remote", "pending", "none"]
  ] as const)(
    "maps challenge %s deterministically",
    (status, phase, state, effect) => {
      const awaiting = transition(initial(), { type: "effect_succeeded" });
      expect(
        decideUpstreamEnrollmentTransaction(awaiting, {
          type: "challenge_observed",
          status
        })
      ).toMatchObject({ next: { phase, state }, effect });
    }
  );

  it.each(["initial", "replacement"] as const)(
    "commits an active %s credential through one successor effect",
    (kind) => {
      const transaction = createUpstreamEnrollmentTransaction({
        id: `${kind}-1`,
        generation: 2,
        kind
      });
      const awaiting = transition(transaction, { type: "effect_succeeded" });
      const committing = decideUpstreamEnrollmentTransaction(awaiting, {
        type: "credential_observed",
        status: "active"
      });
      expect(committing).toMatchObject({
        effect: "commit_successor",
        next: { phase: "committing", state: "exchanged" }
      });
      expect(
        transition(committing.next, { type: "effect_succeeded" })
      ).toMatchObject({
        phase: "committed",
        state: "exchanged",
        pendingEffect: null
      });
    }
  );

  it.each(["denied", "expired", "canceled", "revoked"] as const)(
    "uses an explicit abort or revoke effect for %s",
    (outcome) => {
      const awaiting = transition(initial(), { type: "effect_succeeded" });
      const decision =
        outcome === "canceled"
          ? decideUpstreamEnrollmentTransaction(awaiting, { type: "cancel" })
          : outcome === "revoked"
            ? decideUpstreamEnrollmentTransaction(awaiting, { type: "revoke" })
            : decideUpstreamEnrollmentTransaction(awaiting, {
                type: "challenge_observed",
                status: outcome
              });
      expect(decision.next).toMatchObject({
        phase: "aborting",
        state: outcome
      });
      expect(decision.effect).toBe(
        outcome === "revoked" ? "revoke_active" : "abort_pending"
      );
    }
  );

  it("persists failed effects for idempotent recovery", () => {
    const awaiting = transition(initial(), { type: "effect_succeeded" });
    const aborting = decideUpstreamEnrollmentTransaction(awaiting, {
      type: "cancel"
    }).next;
    const failed = transition(aborting, { type: "effect_failed" });

    expect(failed).toMatchObject({
      phase: "recovery_required",
      pendingEffect: "abort_pending"
    });
    expect(
      decideUpstreamEnrollmentTransaction(failed, { type: "recover" })
    ).toMatchObject({
      effect: "abort_pending",
      next: { phase: "aborting", pendingEffect: "abort_pending" }
    });
  });

  it("retains authority on temporary challenge and credential uncertainty", () => {
    const awaiting = transition(initial(), { type: "effect_succeeded" });
    expect(
      decideUpstreamEnrollmentTransaction(awaiting, {
        type: "challenge_observed",
        status: "unknown"
      })
    ).toMatchObject({ temporary: true, effect: "none", next: awaiting });
    expect(
      decideUpstreamEnrollmentTransaction(awaiting, {
        type: "credential_observed",
        status: "unknown"
      })
    ).toMatchObject({ temporary: true, effect: "none", next: awaiting });
  });

  it("rejects stale observations from superseded transaction generations", () => {
    const current = createUpstreamEnrollmentTransaction({
      id: "replacement-2",
      generation: 2,
      kind: "replacement"
    });

    expect(
      upstreamEnrollmentObservationApplies(current, {
        transactionId: "replacement-2",
        generation: 2
      })
    ).toBe(true);
    expect(
      upstreamEnrollmentObservationApplies(current, {
        transactionId: "replacement-1",
        generation: 1
      })
    ).toBe(false);
  });
});
