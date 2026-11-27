import { describe, expect, it } from "vitest";
import { EnrollmentFence } from "./enrollment-fence.js";

const unknownId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function expectCode(action: () => unknown, code: string) {
  expect(action).toThrowError(expect.objectContaining({ code }));
}

function setup() {
  let now = 0;
  const fence = new EnrollmentFence({
    now: () => now,
    epochLifetimeMs: 10,
    maxEpochs: 2,
    maxEpochsPerOwner: 1,
    maxOperations: 2,
    maxOperationsPerOwner: 1
  });
  const base = {
    instanceId: fence.instanceId,
    epochId: fence.createEpoch("alice"),
    owner: "alice"
  };
  return {
    fence,
    base,
    advance: () => {
      now = 10;
    }
  };
}

function register(
  fence: EnrollmentFence,
  base: { instanceId: string; epochId: string; owner: string }
) {
  return { ...base, operationId: fence.register(base) };
}

describe("EnrollmentFence", () => {
  it("reclaims drained operations under pressure without reusing identifiers", () => {
    const fence = new EnrollmentFence();
    const base = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("alice"),
      owner: "alice"
    };
    const ids = new Set<string>();
    let first!: ReturnType<typeof register>;
    for (let i = 0; i < 150; i++) {
      const request = register(fence, base);
      if (i === 0) first = request;
      expect(ids.has(request.operationId)).toBe(false);
      ids.add(request.operationId);
      expect(fence.fenceAndDrain(request)).toBe("drained");
    }
    expectCode(() => fence.enter(first), "unknown_operation");
    expectCode(() => fence.fenceAndDrain(first), "unknown_operation");
    expect(fence.fenceEpochAndDrain(base)).toBe("drained");
  });
  it("reclaims drained epochs under pressure and leaves lost acknowledgments uncertain", () => {
    const fence = new EnrollmentFence();
    let first!: { instanceId: string; epochId: string; owner: string };
    for (let i = 0; i < 150; i++) {
      const base = {
        instanceId: fence.instanceId,
        epochId: fence.createEpoch("alice"),
        owner: "alice"
      };
      if (i === 0) first = base;
      register(fence, base);
      expect(fence.fenceEpochAndDrain(base)).toBe("drained");
    }
    expectCode(() => fence.fenceEpochAndDrain(first), "unknown_epoch");
    expectCode(() => fence.register(first), "unknown_epoch");
  });

  it("reclaims a drained epoch with operations under owner capacity pressure", () => {
    const fence = new EnrollmentFence({ maxOperationsPerOwner: 1 });
    const old = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("alice"),
      owner: "alice"
    };
    const operation = register(fence, old);
    expect(fence.fenceEpochAndDrain(old)).toBe("drained");
    const next = { ...old, epochId: fence.createEpoch("alice") };
    register(fence, next);
    expectCode(() => fence.fenceEpochAndDrain(old), "unknown_epoch");
    expectCode(() => fence.enter(operation), "unknown_epoch");
    expectCode(() => fence.register(next), "capacity_exceeded");
  });

  it("reclaims a nonempty drained epoch across owners but not active epochs", () => {
    const fence = new EnrollmentFence({ maxOperations: 2 });
    const empty = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("alice"),
      owner: "alice"
    };
    expect(fence.fenceEpochAndDrain(empty)).toBe("drained");
    const old = { ...empty, epochId: fence.createEpoch("alice") };
    register(fence, old);
    expect(fence.fenceEpochAndDrain(old)).toBe("drained");
    const active = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("bob"),
      owner: "bob"
    };
    const request = register(fence, active);
    const release = fence.enter(request);
    expect(fence.fenceEpochAndDrain(active)).toBe("pending");
    const next = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("charlie"),
      owner: "charlie"
    };
    register(fence, next);
    expectCode(() => fence.fenceEpochAndDrain(old), "unknown_epoch");
    expect(fence.fenceEpochAndDrain(empty)).toBe("drained");
    expect(fence.fenceEpochAndDrain(active)).toBe("pending");
    expectCode(() => fence.register(next), "capacity_exceeded");
    release();
    register(fence, next);
    expectCode(() => fence.fenceEpochAndDrain(active), "unknown_epoch");
  });

  it("does not reclaim another owner's epoch when owner quota remains full", () => {
    const fence = new EnrollmentFence({
      maxOperations: 2,
      maxOperationsPerOwner: 1
    });
    const alice = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("alice"),
      owner: "alice"
    };
    const bob = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("bob"),
      owner: "bob"
    };
    register(fence, alice);
    register(fence, bob);
    expect(fence.fenceEpochAndDrain(bob)).toBe("drained");
    expectCode(() => fence.register(alice), "capacity_exceeded");
    expect(fence.fenceEpochAndDrain(bob)).toBe("drained");
  });

  it("removes emptied epochs from operation-capacity indexes", () => {
    const fence = new EnrollmentFence({ maxOperations: 1 });
    const first = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("alice"),
      owner: "alice"
    };
    const entry = register(fence, first);
    expect(fence.fenceAndDrain(entry)).toBe("drained");
    expect(fence.fenceEpochAndDrain(first)).toBe("drained");
    const second = { ...first, epochId: fence.createEpoch("alice") };
    register(fence, second);
    expect(fence.fenceEpochAndDrain(second)).toBe("drained");
    const third = { ...first, epochId: fence.createEpoch("alice") };
    register(fence, third);
    expect(fence.fenceEpochAndDrain(first)).toBe("drained");
    expectCode(() => fence.fenceEpochAndDrain(second), "unknown_epoch");
  });

  it("preserves active and unfenced operations and an epoch barrier under pressure", () => {
    const fence = new EnrollmentFence({
      maxOperations: 2,
      maxOperationsPerOwner: 2,
      maxEpochsPerOwner: 1
    });
    const base = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("alice"),
      owner: "alice"
    };
    const active = register(fence, base);
    const idle = register(fence, base);
    const release = fence.enter(active);
    expect(fence.fenceAndDrain(active)).toBe("pending");
    expectCode(() => fence.register(base), "capacity_exceeded");
    expect(fence.fenceEpochAndDrain(base)).toBe("pending");
    expectCode(() => fence.createEpoch("alice"), "capacity_exceeded");
    expectCode(() => fence.enter(idle), "fenced");
    release();
    release();
    expect(fence.fenceEpochAndDrain(base)).toBe("drained");
    fence.createEpoch("alice");
    expectCode(() => fence.fenceEpochAndDrain(base), "unknown_epoch");
  });

  it("reclaims correct owners under global and per-owner pressure", () => {
    const fence = new EnrollmentFence({
      maxOperations: 2,
      maxOperationsPerOwner: 1
    });
    const alice = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("alice"),
      owner: "alice"
    };
    const bob = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("bob"),
      owner: "bob"
    };
    const a = register(fence, alice);
    const b = register(fence, bob);
    expect(fence.fenceAndDrain(a)).toBe("drained");
    const next = register(fence, alice);
    expectCode(() => fence.fenceAndDrain(a), "unknown_operation");
    expect(fence.fenceAndDrain(next)).toBe("drained");
    expectCode(() => fence.register(bob), "capacity_exceeded");
    expect(fence.fenceAndDrain(next)).toBe("drained");
    expect(fence.fenceAndDrain(b)).toBe("drained");
    expect(fence.fenceAndDrain(next)).toBe("drained");
    const charlie = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("charlie"),
      owner: "charlie"
    };
    register(fence, charlie);
    expectCode(
      () => fence.fenceAndDrain({ ...next, owner: "bob" }),
      "owner_mismatch"
    );
  });

  it("uses a retained epoch barrier after a lost operation acknowledgment", () => {
    const fence = new EnrollmentFence({ maxOperations: 2 });
    const base = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("alice"),
      owner: "alice"
    };
    const lost = register(fence, base);
    const active = register(fence, base);
    const release = fence.enter(active);
    expect(fence.fenceAndDrain(lost)).toBe("drained");
    register(fence, base);
    expectCode(() => fence.fenceAndDrain(lost), "unknown_operation");
    expect(fence.fenceEpochAndDrain(base)).toBe("pending");
    release();
    expect(fence.fenceEpochAndDrain(base)).toBe("drained");
  });

  it("fails closed when the operation counter is exhausted", () => {
    const fence = new EnrollmentFence();
    const base = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("alice"),
      owner: "alice"
    };
    const state = fence as unknown as { operationSequence: bigint };
    state.operationSequence = (1n << 122n) - 2n;
    const last = register(fence, base);
    expect(fence.fenceAndDrain(last)).toBe("drained");
    expectCode(() => fence.register(base), "capacity_exceeded");
    const epochState = fence as unknown as { sequence: bigint };
    epochState.sequence = 0xffffffffffffffffn;
    expectCode(() => fence.createEpoch("alice"), "capacity_exceeded");
    expect(fence.fenceAndDrain(last)).toBe("drained");
  });

  it("bounds candidate indexes and clears them when epochs are removed", () => {
    const fence = new EnrollmentFence({
      maxOperationsPerOwner: 2,
      maxEpochsPerOwner: 1
    });
    const state = fence as unknown as {
      operationCandidates: Set<unknown>;
      epochCandidates: Set<unknown>;
      operationEpochCandidates: Set<unknown>;
    };
    for (let i = 0; i < 150; i++) {
      const base = {
        instanceId: fence.instanceId,
        epochId: fence.createEpoch("alice"),
        owner: "alice"
      };
      for (let j = 0; j < 5; j++) {
        const request = register(fence, base);
        expect(fence.fenceAndDrain(request)).toBe("drained");
        expect(fence.fenceAndDrain(request)).toBe("drained");
        expect(state.operationCandidates.size).toBeLessThanOrEqual(2);
      }
      expect(fence.fenceEpochAndDrain(base)).toBe("drained");
      expect(state.epochCandidates.size).toBe(1);
      expect(state.operationEpochCandidates.size).toBe(1);
    }
    expect(state.operationCandidates.size).toBe(2);
  });

  it("closes an epoch before delayed registration and drains all admitted work", async () => {
    const fence = new EnrollmentFence();
    const base = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("alice"),
      owner: "alice"
    };
    const first = register(fence, base);
    const second = register(fence, base);
    const releaseFirst = fence.enter(first);
    const releaseSecond = fence.enter(second);
    let resume!: () => void;
    const delayed = new Promise<void>((resolve) => {
      resume = resolve;
    }).then(() => fence.register(base));
    expect(fence.fenceEpochAndDrain(base)).toBe("pending");
    expectCode(() => fence.enter(first), "fenced");
    expectCode(() => fence.enter(second), "fenced");
    expectCode(
      () => fence.fenceEpochAndDrain({ ...base, owner: "bob" }),
      "owner_mismatch"
    );
    resume();
    await expect(delayed).rejects.toMatchObject({ code: "fenced" });
    releaseFirst();
    expect(fence.fenceEpochAndDrain(base)).toBe("pending");
    releaseSecond();
    expect(fence.fenceEpochAndDrain(base)).toBe("drained");
    expectCode(() => fence.register(base), "fenced");
    expectCode(() => fence.enter(first), "fenced");
  });

  it("reclaims expired idle capacity on registration but retains active epochs", () => {
    let now = 0;
    const fence = new EnrollmentFence({
      now: () => now,
      epochLifetimeMs: 10,
      maxOperations: 2
    });
    const alice = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("alice"),
      owner: "alice"
    };
    const idle = register(fence, alice);
    const active = register(fence, alice);
    const release = fence.enter(active);
    now = 5;
    const bob = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("bob"),
      owner: "bob"
    };
    now = 10;
    expectCode(() => fence.register(bob), "capacity_exceeded");
    expect(fence.fenceEpochAndDrain(alice)).toBe("pending");
    release();
    expect(fence.register(bob)).toBeTruthy();
    expectCode(() => fence.fenceEpochAndDrain(alice), "unknown_epoch");
    expectCode(() => fence.fenceAndDrain(idle), "unknown_epoch");
  });

  it("reclaims only expired quiescent operations across owners", () => {
    let now = 0;
    const fence = new EnrollmentFence({
      now: () => now,
      epochLifetimeMs: 10,
      maxOperations: 4,
      maxOperationsPerOwner: 3
    });
    const alice = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("alice"),
      owner: "alice"
    };
    register(fence, alice);
    register(fence, alice);
    const bob = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("bob"),
      owner: "bob"
    };
    const active = register(fence, bob);
    const release = fence.enter(active);
    now = 5;
    const nextAlice = { ...alice, epochId: fence.createEpoch("alice") };
    register(fence, nextAlice);
    now = 10;
    register(fence, nextAlice);
    register(fence, nextAlice);
    expectCode(() => fence.register(nextAlice), "capacity_exceeded");
    expect(fence.fenceEpochAndDrain(bob)).toBe("pending");
    release();
    release();
    const nextBob = { ...bob, epochId: fence.createEpoch("bob") };
    register(fence, nextBob);
    expectCode(() => fence.register(nextBob), "capacity_exceeded");
  });

  it("accounts for repeated admissions and idempotent releases independently by owner", () => {
    const fence = new EnrollmentFence({ maxActive: 3, maxActivePerOwner: 2 });
    const alice = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("alice"),
      owner: "alice"
    };
    const bob = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("bob"),
      owner: "bob"
    };
    const a = register(fence, alice);
    const b = register(fence, bob);
    const first = fence.enter(a);
    const second = fence.enter(a);
    const third = fence.enter(b);
    expectCode(() => fence.enter(b), "capacity_exceeded");
    first();
    first();
    const fourth = fence.enter(b);
    expectCode(() => fence.enter(b), "capacity_exceeded");
    expect(fence.fenceAndDrain(a)).toBe("pending");
    second();
    expect(fence.fenceAndDrain(a)).toBe("drained");
    third();
    fourth();
  });

  it("does not iterate retained operations for admission or registration", () => {
    const fence = new EnrollmentFence();
    const base = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("alice"),
      owner: "alice"
    };
    const request = register(fence, base);
    const epochs = (
      fence as unknown as {
        epochs: Map<string, { operations: Map<string, unknown> }>;
      }
    ).epochs;
    const operations = epochs.get(base.epochId)!.operations;
    const rejectIteration = () => {
      throw new Error("operations scanned");
    };
    operations.values = rejectIteration;
    operations.entries = rejectIteration;
    operations.keys = rejectIteration;
    operations.forEach = rejectIteration;
    operations[Symbol.iterator] = rejectIteration;
    const release = fence.enter(request);
    register(fence, base);
    release();
  });

  it("rejects delayed registrations and writes after expiry and eviction", () => {
    const { fence, base, advance } = setup();
    const request = register(fence, base);
    advance();
    expectCode(() => fence.enter(request), "fenced");
    expectCode(() => fence.register(base), "fenced");
    expect(fence.createEpoch("alice")).not.toBe(base.epochId);
    expectCode(() => fence.register(base), "unknown_epoch");
    expectCode(() => fence.fenceEpochAndDrain(base), "unknown_epoch");
    expectCode(() => fence.fenceAndDrain(request), "unknown_epoch");
  });

  it("retains active work across expiry, fencing synchronously until release", () => {
    const { fence, base, advance } = setup();
    const request = register(fence, base);
    const release = fence.enter(request);
    advance();
    expect(fence.fenceAndDrain(request)).toBe("pending");
    expectCode(() => fence.enter(request), "fenced");
    expectCode(() => fence.createEpoch("alice"), "capacity_exceeded");
    release();
    release();
    expect(fence.fenceAndDrain(request)).toBe("drained");
    fence.createEpoch("alice");
    expectCode(() => fence.fenceAndDrain(request), "unknown_epoch");
  });

  it("treats lost registration responses as uncertain and retries as distinct operations", () => {
    const fence = new EnrollmentFence();
    const base = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("alice"),
      owner: "alice"
    };
    const lost = register(fence, base);
    const release = fence.enter(lost);
    const retry = register(fence, base);
    expect(retry.operationId).not.toBe(lost.operationId);
    expectCode(
      () => fence.fenceAndDrain({ ...base, operationId: unknownId }),
      "unknown_operation"
    );
    expect(fence.fenceAndDrain(retry)).toBe("drained");
    expect(fence.fenceAndDrain(lost)).toBe("pending");
    release();
    expect(fence.fenceAndDrain(lost)).toBe("drained");
    expect(fence.fenceAndDrain(lost)).toBe("drained");
    expectCode(() => fence.enter(lost), "fenced");
  });

  it("bounds owner and global operation capacity while retaining control calls", () => {
    const { fence, base } = setup();
    const request = register(fence, base);
    expectCode(() => fence.register(base), "capacity_exceeded");
    const bob = register(fence, {
      ...base,
      owner: "bob",
      epochId: fence.createEpoch("bob")
    });
    expectCode(() => fence.createEpoch("charlie"), "capacity_exceeded");
    expectCode(
      () => fence.register({ ...base, owner: "bob", epochId: bob.epochId }),
      "capacity_exceeded"
    );
    expect(fence.fenceAndDrain(request)).toBe("drained");
    expect(fence.fenceAndDrain(bob)).toBe("drained");
  });

  it("limits multiple active admissions per owner and globally", () => {
    const fence = new EnrollmentFence({ maxActive: 2, maxActivePerOwner: 1 });
    const alice = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("alice"),
      owner: "alice"
    };
    const bob = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("bob"),
      owner: "bob"
    };
    const charlie = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("charlie"),
      owner: "charlie"
    };
    const first = register(fence, alice);
    const second = register(fence, alice);
    const third = register(fence, bob);
    const fourth = register(fence, charlie);
    const releaseFirst = fence.enter(first);
    expectCode(() => fence.enter(second), "capacity_exceeded");
    const releaseThird = fence.enter(third);
    expectCode(() => fence.enter(fourth), "capacity_exceeded");
    expect(fence.fenceAndDrain(first)).toBe("pending");
    releaseFirst();
    fence.enter(fourth)();
    releaseThird();
    expect(fence.fenceAndDrain(first)).toBe("drained");
    fence.enter(second)();
  });

  it("rejects registration when expiry occurs during capacity counting", () => {
    let calls = 0;
    const fence = new EnrollmentFence({
      now: () => (++calls >= 3 ? 10 : 0),
      epochLifetimeMs: 10
    });
    const base = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("alice"),
      owner: "alice"
    };
    expectCode(() => fence.register(base), "fenced");
  });

  it("rejects admission when expiry occurs during capacity counting", () => {
    let now = 0;
    let expireOnNextCheck = false;
    const fence = new EnrollmentFence({
      now: () => {
        if (expireOnNextCheck) {
          expireOnNextCheck = false;
          return 0;
        }
        return now;
      },
      epochLifetimeMs: 10
    });
    const base = {
      instanceId: fence.instanceId,
      epochId: fence.createEpoch("alice"),
      owner: "alice"
    };
    const request = register(fence, base);
    now = 10;
    expireOnNextCheck = true;
    expectCode(() => fence.enter(request), "fenced");
    expect(fence.fenceAndDrain(request)).toBe("drained");
  });

  it("enforces ownership, instance binding, input validation and restart uncertainty", () => {
    const { fence, base } = setup();
    const request = register(fence, base);
    expectCode(
      () => fence.enter({ ...request, owner: "bob" }),
      "owner_mismatch"
    );
    expectCode(
      () => fence.fenceAndDrain({ ...request, instanceId: unknownId }),
      "instance_mismatch"
    );
    expectCode(() => fence.createEpoch("x".repeat(1025)), "invalid_input");
    expectCode(
      () => fence.enter({ ...request, operationId: "bad" }),
      "invalid_input"
    );
    const restarted = new EnrollmentFence();
    expect(restarted.instanceId).not.toBe(fence.instanceId);
    expectCode(() => restarted.fenceAndDrain(request), "instance_mismatch");
    expectCode(
      () =>
        restarted.fenceAndDrain({
          ...request,
          instanceId: restarted.instanceId
        }),
      "unknown_epoch"
    );
  });
});
