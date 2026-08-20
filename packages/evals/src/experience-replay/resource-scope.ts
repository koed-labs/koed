import { performance } from "node:perf_hooks";

export type CleanupPriority = "normal" | "credential-revocation";
export type RunSignal = "SIGINT" | "SIGTERM" | "SIGHUP";
export type CleanupTrigger = "explicit" | `signal:${RunSignal}`;

export interface CleanupContext {
  signal: AbortSignal;
}

export type CleanupHandler = (context: CleanupContext) => void | Promise<void>;

export interface RegisterCleanupOptions {
  timeoutMs?: number;
  priority?: CleanupPriority;
}

export interface CleanupErrorAttestation {
  cleanupName: string;
  kind: "handler_failure" | "timeout" | "global_deadline";
  message:
    | "Cleanup handler failed"
    | "Cleanup handler timed out"
    | "Global cleanup deadline exceeded";
  timeoutMs?: number;
}

export interface CleanupAttestationEntry {
  cleanupName: string;
  priority: CleanupPriority;
  registrationIndex: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: "completed" | "failed" | "timed_out" | "deadline_exceeded";
  error?: CleanupErrorAttestation;
}

export interface CleanupAttestation {
  scopeId: string;
  trigger: CleanupTrigger;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  cleanupCount: number;
  omittedCleanupCount: number;
  errorCount: number;
  omittedErrorCount: number;
  deadlineExceeded: boolean;
  cleanups: CleanupAttestationEntry[];
  errors: CleanupErrorAttestation[];
}

export interface SignalSource {
  on(signal: RunSignal, listener: () => void): unknown;
  removeListener(signal: RunSignal, listener: () => void): unknown;
}

export interface ResourceScopeOptions {
  scopeId: string;
  defaultTimeoutMs?: number;
  cleanupDeadlineMs?: number;
  maxAttestationEntries?: number;
  now?: () => number;
  monotonicNow?: () => number;
}

interface RegisteredCleanup {
  name: string;
  handler: CleanupHandler;
  timeoutMs: number;
  priority: CleanupPriority;
  registrationIndex: number;
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CLEANUP_DEADLINE_MS = 30_000;
const DEFAULT_MAX_ATTESTATION_ENTRIES = 256;

const assertIdentifier = (value: string, label: string): void => {
  const containsControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
  });
  if (value.length === 0 || value.length > 200 || containsControlCharacter) {
    throw new Error(
      `${label} must be a non-empty, bounded printable identifier`
    );
  }
};

const assertPositiveInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
};

const iso = (milliseconds: number): string =>
  new Date(milliseconds).toISOString();

export class ResourceCleanupError extends AggregateError {
  override readonly name = "ResourceCleanupError";

  constructor(readonly attestation: CleanupAttestation) {
    super(
      attestation.errors.map((failure) => new Error(failure.message)),
      `${attestation.errorCount} resource cleanup operation(s) failed`
    );
  }
}

/** Owns async resources for one benchmark run or trial. */
export class AsyncResourceScope {
  private readonly cleanups: RegisteredCleanup[] = [];
  private readonly cleanupNames = new Set<string>();
  private readonly defaultTimeoutMs: number;
  private readonly cleanupDeadlineMs: number;
  private readonly maxAttestationEntries: number;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly signalDetachments = new Set<() => void>();
  private readonly runAbort = new AbortController();
  private closePromise: Promise<CleanupAttestation> | undefined;

  constructor(private readonly options: ResourceScopeOptions) {
    assertIdentifier(options.scopeId, "Resource scope ID");
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cleanupDeadlineMs =
      options.cleanupDeadlineMs ?? DEFAULT_CLEANUP_DEADLINE_MS;
    this.maxAttestationEntries =
      options.maxAttestationEntries ?? DEFAULT_MAX_ATTESTATION_ENTRIES;
    assertPositiveInteger(this.defaultTimeoutMs, "Cleanup timeout");
    assertPositiveInteger(this.cleanupDeadlineMs, "Cleanup deadline");
    assertPositiveInteger(
      this.maxAttestationEntries,
      "Maximum attestation entries"
    );
    this.now = options.now ?? Date.now;
    this.monotonicNow =
      options.monotonicNow ?? performance.now.bind(performance);
  }

  /** Aborts synchronously when an installed process signal is observed. */
  get signal(): AbortSignal {
    return this.runAbort.signal;
  }

  register(
    name: string,
    handler: CleanupHandler,
    options: RegisterCleanupOptions = {}
  ): void {
    if (this.closePromise) {
      throw new Error(
        "Cannot register cleanup after resource scope close began"
      );
    }
    assertIdentifier(name, "Cleanup name");
    if (this.cleanupNames.has(name)) {
      throw new Error(`Cleanup name is already registered: ${name}`);
    }
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    assertPositiveInteger(timeoutMs, "Cleanup timeout");
    const priority = options.priority ?? "normal";
    this.cleanupNames.add(name);
    this.cleanups.push({
      name,
      handler,
      timeoutMs,
      priority,
      registrationIndex: this.cleanups.length
    });
  }

  registerCredentialRevocation(
    name: string,
    handler: CleanupHandler,
    options: Omit<RegisterCleanupOptions, "priority"> = {}
  ): void {
    this.register(name, handler, {
      ...options,
      priority: "credential-revocation"
    });
  }

  installSignalHandlers(source: SignalSource = process): () => void {
    if (this.closePromise) {
      throw new Error(
        "Cannot install signal handlers after resource scope close began"
      );
    }
    let attached = true;
    const listeners = new Map<RunSignal, () => void>();
    const detach = (): void => {
      if (!attached) return;
      attached = false;
      for (const [signal, listener] of listeners) {
        source.removeListener(signal, listener);
      }
      this.signalDetachments.delete(detach);
    };
    for (const signal of SIGNALS) {
      const listener = (): void => {
        // Cancellation is synchronous: a coordinator checking this signal cannot
        // schedule another trial after process termination was requested.
        if (!this.runAbort.signal.aborted) this.runAbort.abort(signal);
        const cleanup = this.close(`signal:${signal}`);
        if (source === process) {
          // Installing a signal listener suppresses Node's default termination.
          // Re-deliver it after bounded cleanup so the process cannot resume its
          // normal scheduling loop merely because cleanup settled.
          void cleanup.then(
            () => process.kill(process.pid, signal),
            () => process.kill(process.pid, signal)
          );
        } else {
          void cleanup.catch(() => undefined);
        }
      };
      listeners.set(signal, listener);
      source.on(signal, listener);
    }
    this.signalDetachments.add(detach);
    return detach;
  }

  close(trigger: CleanupTrigger = "explicit"): Promise<CleanupAttestation> {
    if (!this.closePromise) this.closePromise = this.runClose(trigger);
    return this.closePromise;
  }

  private detachSignalHandlers(): void {
    for (const detach of [...this.signalDetachments]) detach();
  }

  private async runClose(trigger: CleanupTrigger): Promise<CleanupAttestation> {
    this.detachSignalHandlers();
    const started = this.now();
    const deadline = this.monotonicNow() + this.cleanupDeadlineMs;
    const ordered = [...this.cleanups].sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority === "credential-revocation" ? -1 : 1;
      }
      return right.registrationIndex - left.registrationIndex;
    });
    const allEntries: CleanupAttestationEntry[] = [];
    const allErrors: CleanupErrorAttestation[] = [];
    let deadlineExceeded = false;

    for (const cleanup of ordered) {
      const remainingMs = deadline - this.monotonicNow();
      if (remainingMs <= 0) {
        deadlineExceeded = true;
        allErrors.push({
          cleanupName: cleanup.name,
          kind: "global_deadline",
          message: "Global cleanup deadline exceeded",
          timeoutMs: this.cleanupDeadlineMs
        });
        break;
      }
      const entry = await this.runCleanup(cleanup, remainingMs);
      allEntries.push(entry);
      if (entry.error) allErrors.push(entry.error);
      if (entry.status === "deadline_exceeded") {
        deadlineExceeded = true;
        break;
      }
    }

    const completed = this.now();
    const cleanups = allEntries.slice(0, this.maxAttestationEntries);
    const errors = allErrors.slice(0, this.maxAttestationEntries);
    const attestation: CleanupAttestation = {
      scopeId: this.options.scopeId,
      trigger,
      startedAt: iso(started),
      completedAt: iso(completed),
      durationMs: Math.max(0, completed - started),
      cleanupCount: ordered.length,
      omittedCleanupCount: ordered.length - cleanups.length,
      errorCount: allErrors.length,
      omittedErrorCount: allErrors.length - errors.length,
      deadlineExceeded,
      cleanups,
      errors
    };
    if (allErrors.length > 0 || deadlineExceeded) {
      throw new ResourceCleanupError(attestation);
    }
    return attestation;
  }

  private async runCleanup(
    cleanup: RegisteredCleanup,
    remainingMs: number
  ): Promise<CleanupAttestationEntry> {
    const started = this.now();
    const abort = new AbortController();
    const boundedTimeoutMs = Math.min(cleanup.timeoutMs, remainingMs);
    const hitGlobalDeadline = remainingMs <= cleanup.timeoutMs;
    const timeoutMarker = Symbol("cleanup-timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof timeoutMarker>((resolve) => {
      timer = setTimeout(() => {
        abort.abort(hitGlobalDeadline ? "global-deadline" : "handler-timeout");
        resolve(timeoutMarker);
      }, boundedTimeoutMs);
    });
    const operation = Promise.resolve().then(() =>
      cleanup.handler({ signal: abort.signal })
    );

    let status: CleanupAttestationEntry["status"] = "completed";
    let error: CleanupErrorAttestation | undefined;
    try {
      const result = await Promise.race([operation, timeout]);
      if (result === timeoutMarker) {
        status = hitGlobalDeadline ? "deadline_exceeded" : "timed_out";
        error = hitGlobalDeadline
          ? {
              cleanupName: cleanup.name,
              kind: "global_deadline",
              message: "Global cleanup deadline exceeded",
              timeoutMs: this.cleanupDeadlineMs
            }
          : {
              cleanupName: cleanup.name,
              kind: "timeout",
              message: "Cleanup handler timed out",
              timeoutMs: cleanup.timeoutMs
            };
      }
    } catch {
      status = "failed";
      error = {
        cleanupName: cleanup.name,
        kind: "handler_failure",
        message: "Cleanup handler failed"
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
    const completed = this.now();
    return {
      cleanupName: cleanup.name,
      priority: cleanup.priority,
      registrationIndex: cleanup.registrationIndex,
      startedAt: iso(started),
      completedAt: iso(completed),
      durationMs: Math.max(0, completed - started),
      status,
      ...(error ? { error } : {})
    };
  }
}
