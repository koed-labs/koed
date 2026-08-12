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

  it("removes SIGINT and SIGTERM handlers when cleanup begins", async () => {
    const signals = new EventEmitter();
    const scope = new AsyncResourceScope({ scopeId: "trial-signals" });
    const cleanup = vi.fn();
    scope.register("resource", cleanup);
    scope.installSignalHandlers(signals);

    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    signals.emit("SIGINT");
    await scope.close();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
});
