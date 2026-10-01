/* global AbortController, clearTimeout, setTimeout */
// Generic delivery lifecycle. This directory is also the standalone distribution
// boundary: installed adapters and package consumers execute this same source.
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
const statuses = new Set([
  "accepted",
  "running",
  "cancel_requested",
  ...terminalStatuses
]);

const abortError = (signal) =>
  signal.reason ?? new Error("Memory Answer observation detached");

// Bound observation even when a port cannot interrupt an in-flight read. The
// late snapshot is discarded; the port still receives the abort signal.
const untilAbort = (operation, signal) =>
  new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
    if (signal.aborted) onAbort();
  });

const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

const validateTask = (task, taskId) => {
  if (
    !task ||
    typeof task.id !== "string" ||
    !task.id ||
    (taskId !== undefined && task.id !== taskId)
  ) {
    throw new Error("Memory Answer task identity mismatch");
  }
  if (
    !statuses.has(task.status) ||
    !Number.isSafeInteger(task.version) ||
    task.version < 1
  ) {
    throw new Error("Invalid Memory Answer task state");
  }
  if (
    typeof task.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(task.expiresAt))
  ) {
    throw new Error("Invalid Memory Answer task expiry");
  }
  if (task.invocationKey !== null && typeof task.invocationKey !== "string") {
    throw new Error("Invalid Memory Answer invocation identity");
  }
  return task;
};

export class MemoryAnswerDelivery {
  constructor(
    port,
    { pollMs = 250, maxObservationMs = 86_400_000, now = Date.now } = {}
  ) {
    if (!Number.isFinite(pollMs) || pollMs < 25 || pollMs > 60_000) {
      throw new Error(
        "Memory Answer polling interval must be 25–60000 milliseconds"
      );
    }
    if (
      !Number.isFinite(maxObservationMs) ||
      maxObservationMs <= 0 ||
      maxObservationMs > 86_400_000
    ) {
      throw new Error("Memory Answer observation must be bounded to one day");
    }
    this.port = port;
    this.pollMs = pollMs;
    this.maxObservationMs = maxObservationMs;
    this.now = now;
  }

  async accept(input, caller, invocationKey, signal) {
    const task = validateTask(
      await this.port.start(input, caller, invocationKey, signal)
    );
    if (invocationKey !== undefined && task.invocationKey !== invocationKey) {
      throw new Error("Memory Answer invocation identity mismatch");
    }
    return task;
  }

  async get(taskId, signal) {
    return validateTask(await this.port.get(taskId, signal), taskId);
  }

  async cancel(taskId, signal) {
    return validateTask(await this.port.cancel(taskId, signal), taskId);
  }

  async observe(
    taskId,
    { signal, isCurrent = () => true, present = () => {} } = {}
  ) {
    const controller = new AbortController();
    const deadline = this.now() + this.maxObservationMs;
    const detach = (reason) => ({ kind: "detached", taskId, reason });
    let timedOut = false;
    let expired = false;
    let expiryTimer;
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Memory Answer observation timed out"));
    }, this.maxObservationMs);
    let previous;
    const detached = (task) => {
      if (signal?.aborted) return detach("observer-aborted");
      if (timedOut || this.now() >= deadline)
        return detach("observation-timeout");
      if (expired) return detach("expired");
      const current = isCurrent(task);
      if (typeof current !== "boolean") {
        throw new Error("Memory Answer freshness checks must be synchronous");
      }
      if (!current) return detach("stale-origin");
      if (task && Date.parse(task.expiresAt) <= this.now())
        return detach("expired");
      return undefined;
    };
    const read = async () => {
      const task = await untilAbort(
        this.get(taskId, controller.signal),
        controller.signal
      );
      if (
        previous &&
        (task.invocationKey !== previous.invocationKey ||
          task.version < previous.version)
      ) {
        throw new Error("Memory Answer task identity or version changed");
      }
      previous = task;
      clearTimeout(expiryTimer);
      const remaining = Date.parse(task.expiresAt) - this.now();
      if (remaining > 0 && remaining < deadline - this.now()) {
        expiryTimer = setTimeout(() => {
          expired = true;
          controller.abort(new Error("Memory Answer task expired"));
        }, remaining);
      }
      return task;
    };
    try {
      while (true) {
        const before = detached(previous);
        if (before) return before;
        const task = await read();
        const after = detached(task);
        if (after) return after;
        if (terminalStatuses.has(task.status)) {
          // A terminal snapshot never supplies delivery authority: re-read from
          // the port so revocation and expiry cannot leak a cached result.
          const fresh = await read();
          const suppressed = detached(fresh);
          if (suppressed) return suppressed;
          if (fresh.status !== task.status) {
            throw new Error("Memory Answer terminal state changed");
          }
          // The adapter enqueues synchronously at this freshness fence. It owns
          // continuation/recovery and must never await before that enqueue.
          present(fresh);
          return { kind: "terminal", task: fresh };
        }
        await pause(
          Math.min(
            this.pollMs,
            deadline - this.now(),
            Date.parse(task.expiresAt) - this.now()
          ),
          controller.signal
        );
      }
    } catch (error) {
      if (signal?.aborted) return detach("observer-aborted");
      if (timedOut) return detach("observation-timeout");
      if (expired) return detach("expired");
      throw error;
    } finally {
      clearTimeout(timer);
      clearTimeout(expiryTimer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
