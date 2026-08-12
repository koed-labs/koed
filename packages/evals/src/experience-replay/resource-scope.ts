export type CleanupPriority = "normal" | "credential-revocation";
export type CleanupTrigger = "explicit" | `signal:${"SIGINT" | "SIGTERM"}`;

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
  kind: "handler_failure" | "timeout";
  message: "Cleanup handler failed" | "Cleanup handler timed out";
  timeoutMs?: number;
}

export interface CleanupAttestationEntry {
  cleanupName: string;
  priority: CleanupPriority;
  registrationIndex: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: "completed" | "failed" | "timed_out";
  error?: CleanupErrorAttestation;
}

export interface CleanupAttestation {
  scopeId: string;
  trigger: CleanupTrigger;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  cleanups: CleanupAttestationEntry[];
  errors: CleanupErrorAttestation[];
}

export interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface ResourceScopeOptions {
  scopeId: string;
  defaultTimeoutMs?: number;
  now?: () => number;
}

interface RegisteredCleanup {
  name: string;
  handler: CleanupHandler;
  timeoutMs: number;
  priority: CleanupPriority;
  registrationIndex: number;
}

const SIGNALS = ["SIGINT", "SIGTERM"] as const;
const DEFAULT_TIMEOUT_MS = 10_000;

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

const assertTimeout = (timeoutMs: number): void => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      "Cleanup timeout must be a positive integer number of milliseconds"
    );
  }
};

const iso = (milliseconds: number): string =>
  new Date(milliseconds).toISOString();

export class ResourceCleanupError extends AggregateError {
  override readonly name = "ResourceCleanupError";

  constructor(readonly attestation: CleanupAttestation) {
    super(
      attestation.errors.map((failure) => new Error(failure.message)),
      `${attestation.errors.length} resource cleanup operation(s) failed`
    );
  }
}

/**
 * Owns async resources for one benchmark run or trial.
 *
 * Cleanup is LIFO within each priority. Credential revocations always run
 * before normal cleanup, so revocation can be registered as soon as a
 * credential is issued without depending on later registration order.
 */
export class AsyncResourceScope {
  private readonly cleanups: RegisteredCleanup[] = [];
  private readonly cleanupNames = new Set<string>();
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;
  private readonly signalDetachments = new Set<() => void>();
  private closePromise: Promise<CleanupAttestation> | undefined;

  constructor(private readonly options: ResourceScopeOptions) {
    assertIdentifier(options.scopeId, "Resource scope ID");
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    assertTimeout(this.defaultTimeoutMs);
    this.now = options.now ?? Date.now;
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
    assertTimeout(timeoutMs);
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
    const listeners = new Map<(typeof SIGNALS)[number], () => void>();
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
        void this.close(`signal:${signal}`).catch(() => {
          // The caller can observe the same aggregate through close(). Signals
          // must not create an unhandled rejection while cleanup continues.
        });
      };
      listeners.set(signal, listener);
      source.on(signal, listener);
    }
    this.signalDetachments.add(detach);
    return detach;
  }

  close(trigger: CleanupTrigger = "explicit"): Promise<CleanupAttestation> {
    if (!this.closePromise) {
      this.closePromise = this.runClose(trigger);
    }
    return this.closePromise;
  }

  private detachSignalHandlers(): void {
    for (const detach of [...this.signalDetachments]) detach();
  }

  private async runClose(trigger: CleanupTrigger): Promise<CleanupAttestation> {
    this.detachSignalHandlers();
    const started = this.now();
    const ordered = [...this.cleanups].sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority === "credential-revocation" ? -1 : 1;
      }
      return right.registrationIndex - left.registrationIndex;
    });
    const entries: CleanupAttestationEntry[] = [];
    const errors: CleanupErrorAttestation[] = [];

    for (const cleanup of ordered) {
      const entry = await this.runCleanup(cleanup);
      entries.push(entry);
      if (entry.error) errors.push(entry.error);
    }

    const completed = this.now();
    const attestation: CleanupAttestation = {
      scopeId: this.options.scopeId,
      trigger,
      startedAt: iso(started),
      completedAt: iso(completed),
      durationMs: Math.max(0, completed - started),
      cleanups: entries,
      errors
    };
    if (errors.length > 0) throw new ResourceCleanupError(attestation);
    return attestation;
  }

  private async runCleanup(
    cleanup: RegisteredCleanup
  ): Promise<CleanupAttestationEntry> {
    const started = this.now();
    const abort = new AbortController();
    const timeoutMarker = Symbol("cleanup-timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof timeoutMarker>((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve(timeoutMarker);
      }, cleanup.timeoutMs);
    });
    const operation = Promise.resolve().then(() =>
      cleanup.handler({ signal: abort.signal })
    );

    let status: CleanupAttestationEntry["status"] = "completed";
    let error: CleanupErrorAttestation | undefined;
    try {
      const result = await Promise.race([operation, timeout]);
      if (result === timeoutMarker) {
        status = "timed_out";
        error = {
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
