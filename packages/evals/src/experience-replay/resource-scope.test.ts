import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { AsyncResourceScope, ResourceCleanupError } from "./resource-scope.js";

describe("AsyncResourceScope", () => {
  it("runs credential revocation first and otherwise cleans up LIFO", async () => {
    const calls: string[] = [];
    const scope = new AsyncResourceScope({ scopeId: "trial-order" });
    scope.registerCredentialRevocation("revoke-token", () => {
      calls.push("revoke-token");
    });
    scope.register("database", () => {
      calls.push("database");
    });
    scope.register("server", () => {
      calls.push("server");
    });

    const attestation = await scope.close();

    expect(calls).toEqual(["revoke-token", "server", "database"]);
    expect(attestation.cleanups.map((entry) => entry.cleanupName)).toEqual(
      calls
    );
  });

  it("shares one idempotent close across concurrent callers", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cleanup = vi.fn(async () => gate);
    const scope = new AsyncResourceScope({ scopeId: "trial-concurrent" });
    scope.register("shared-resource", cleanup);

    const first = scope.close();
    const second = scope.close();
    expect(second).toBe(first);
    release?.();

    const [left, right] = await Promise.all([first, second]);
    expect(left).toBe(right);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(scope.close()).toBe(first);
  });

  it("bounds each cleanup timeout and aborts its cleanup signal", async () => {
    let observedSignal: AbortSignal | undefined;
    const scope = new AsyncResourceScope({
      scopeId: "trial-timeout",
      defaultTimeoutMs: 20
    });
    scope.register("stuck-process", ({ signal }) => {
      observedSignal = signal;
      return new Promise<void>(() => undefined);
    });

    const started = Date.now();
    const failure = await scope.close().catch((error: unknown) => error);

    expect(Date.now() - started).toBeLessThan(500);
    expect(observedSignal?.aborted).toBe(true);
    expect(failure).toBeInstanceOf(ResourceCleanupError);
    expect(
      (failure as ResourceCleanupError).attestation.cleanups[0]
    ).toMatchObject({
      cleanupName: "stuck-process",
      status: "timed_out",
      error: { kind: "timeout", timeoutMs: 20 }
    });
  });

  it("enforces one global deadline across noncooperative handlers", async () => {
    const calls: string[] = [];
    const observedSignals: AbortSignal[] = [];
    const scope = new AsyncResourceScope({
      scopeId: "trial-global-deadline",
      defaultTimeoutMs: 30,
      cleanupDeadlineMs: 50
    });
    for (const name of ["first", "second", "third"]) {
      scope.register(name, ({ signal }) => {
        calls.push(name);
        observedSignals.push(signal);
        return new Promise<void>(() => undefined);
      });
    }

    const started = Date.now();
    const failure = await scope.close().catch((error: unknown) => error);

    expect(Date.now() - started).toBeLessThan(300);
    expect(calls).toEqual(["third", "second"]);
    expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
    expect(failure).toBeInstanceOf(ResourceCleanupError);
    expect((failure as ResourceCleanupError).attestation).toMatchObject({
      cleanupCount: 3,
      omittedCleanupCount: 1,
      deadlineExceeded: true,
      cleanups: [
        {
          cleanupName: "third",
          status: "timed_out",
          error: { kind: "timeout", timeoutMs: 30 }
        },
        {
          cleanupName: "second",
          status: "deadline_exceeded",
          error: { kind: "global_deadline", timeoutMs: 50 }
        }
      ]
    });
  });

  it("continues after failures and aggregates redacted attestations", async () => {
    const calls: string[] = [];
    const scope = new AsyncResourceScope({ scopeId: "trial-failures" });
    scope.register("runs-last", () => {
      calls.push("runs-last");
    });
    scope.register("contains-sensitive-error", () => {
      calls.push("contains-sensitive-error");
      throw new Error("credential=super-secret-value");
    });

    const failure = await scope.close().catch((error: unknown) => error);

    expect(calls).toEqual(["contains-sensitive-error", "runs-last"]);
    expect(failure).toBeInstanceOf(ResourceCleanupError);
    const cleanupError = failure as ResourceCleanupError;
    expect(cleanupError.errors).toHaveLength(1);
    expect(cleanupError.attestation.errors).toEqual([
      {
        cleanupName: "contains-sensitive-error",
        kind: "handler_failure",
        message: "Cleanup handler failed"
      }
    ]);
    expect(JSON.stringify(cleanupError.attestation)).not.toContain(
      "super-secret-value"
    );
  });

  it("bounds cleanup and error attestation arrays", async () => {
    const scope = new AsyncResourceScope({
      scopeId: "trial-bounded-attestation",
      maxAttestationEntries: 2
    });
    for (let index = 0; index < 5; index += 1) {
      scope.register(`failure-${index}`, () => {
        throw new Error(`secret-${index}`);
      });
    }

    const failure = (await scope
      .close()
      .catch((error: unknown) => error)) as ResourceCleanupError;

    expect(failure.attestation).toMatchObject({
      cleanupCount: 5,
      omittedCleanupCount: 3,
      errorCount: 5,
      omittedErrorCount: 3
    });
    expect(failure.attestation.cleanups).toHaveLength(2);
    expect(failure.attestation.errors).toHaveLength(2);
    expect(JSON.stringify(failure.attestation)).not.toContain("secret-");
  });

  it("cancels scheduling synchronously and removes all signal handlers", async () => {
    const signals = new EventEmitter();
    const scope = new AsyncResourceScope({ scopeId: "trial-signals" });
    const cleanup = vi.fn();
    scope.register("resource", cleanup);
    scope.installSignalHandlers(signals);

    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    expect(signals.listenerCount("SIGHUP")).toBe(1);
    expect(scope.signal.aborted).toBe(false);
    signals.emit("SIGHUP");
    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason).toBe("SIGHUP");
    const attestation = await scope.close();

    expect(attestation.trigger).toBe("signal:SIGHUP");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGHUP")).toBe(0);
  });

  it("keeps signal-triggered cleanup failure observable through close", async () => {
    const signals = new EventEmitter();
    const scope = new AsyncResourceScope({
      scopeId: "trial-signal-failure",
      cleanupDeadlineMs: 20
    });
    scope.register("noncooperative", () => new Promise<void>(() => undefined));
    scope.installSignalHandlers(signals);

    signals.emit("SIGTERM");

    await expect(scope.close()).rejects.toMatchObject({
      attestation: {
        trigger: "signal:SIGTERM",
        deadlineExceeded: true
      }
    });
  });
});
