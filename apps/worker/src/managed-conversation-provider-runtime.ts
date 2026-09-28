import type {
  ClaudeManagedConversationSession,
  CodexManagedConversationSession,
  PiManagedConversationSession
} from "@koed/mcp-server";

export type ManagedConversationProvider = "codex" | "claude" | "pi";

type ProviderSession = {
  codex: CodexManagedConversationSession;
  claude: ClaudeManagedConversationSession;
  pi: PiManagedConversationSession;
};

export type RuntimeSessionEntry<P extends ManagedConversationProvider> = {
  provider: P;
  executionGeneration: number;
  aiClientInstanceId: string;
  configIdentityHash: string;
  settingsKey?: string;
  session: ProviderSession[P];
};

type AnyRuntimeSessionEntry =
  | RuntimeSessionEntry<"codex">
  | RuntimeSessionEntry<"claude">
  | RuntimeSessionEntry<"pi">;

export class ManagedConversationRuntimeRegistry {
  readonly #sessions = new Map<string, AnyRuntimeSessionEntry>();

  get<P extends ManagedConversationProvider>(
    provider: P,
    executionId: string,
    expected?: {
      executionGeneration?: number;
      aiClientInstanceId?: string;
      configIdentityHash?: string;
      settingsKey?: string;
    }
  ): RuntimeSessionEntry<P> | undefined {
    const entry = this.#sessions.get(executionId);
    if (entry?.provider !== provider) return undefined;
    if (
      expected?.executionGeneration !== undefined &&
      entry.executionGeneration !== expected.executionGeneration
    ) {
      return undefined;
    }
    if (
      expected?.aiClientInstanceId !== undefined &&
      entry.aiClientInstanceId !== expected.aiClientInstanceId
    ) {
      return undefined;
    }
    if (
      expected?.configIdentityHash !== undefined &&
      entry.configIdentityHash !== expected.configIdentityHash
    ) {
      return undefined;
    }
    if (
      expected?.settingsKey !== undefined &&
      entry.settingsKey !== expected.settingsKey
    ) {
      return undefined;
    }
    return entry as RuntimeSessionEntry<P>;
  }

  set<P extends ManagedConversationProvider>(
    provider: P,
    executionId: string,
    entry: Omit<RuntimeSessionEntry<P>, "provider">
  ): void {
    const previous = this.#sessions.get(executionId);
    if (previous && previous.session !== entry.session) {
      void previous.session.closeAndWait().catch(() => undefined);
    }
    this.#sessions.set(executionId, {
      provider,
      ...entry
    } as AnyRuntimeSessionEntry);
  }

  delete(provider: ManagedConversationProvider, executionId: string): boolean {
    if (this.#sessions.get(executionId)?.provider !== provider) return false;
    return this.#sessions.delete(executionId);
  }

  deleteAny(executionId: string): boolean {
    return this.#sessions.delete(executionId);
  }

  has(executionId: string): boolean {
    return this.#sessions.has(executionId);
  }

  entries(): IterableIterator<[string, AnyRuntimeSessionEntry]> {
    return this.#sessions.entries();
  }

  clear(closeSessions = true): void {
    if (closeSessions) {
      for (const entry of this.#sessions.values()) {
        void entry.session.closeAndWait().catch(() => undefined);
      }
    }
    this.#sessions.clear();
  }
}

export const isTransientManagedConversationLeaseRenewalError = (
  error: unknown
): boolean => {
  if (!error || typeof error !== "object") return true;
  const candidate = error as {
    statusCode?: unknown;
    transient?: unknown;
    name?: unknown;
  };
  if (typeof candidate.statusCode === "number") {
    return (
      candidate.statusCode === 408 ||
      candidate.statusCode === 429 ||
      candidate.statusCode >= 500
    );
  }
  if (candidate.transient === false) return false;
  if (candidate.transient === true) return true;
  if (
    candidate.name === "AbortError" ||
    candidate.name === "TimeoutError" ||
    candidate.name === "TypeError"
  ) {
    return true;
  }
  // Fetch/socket failures commonly arrive without an HTTP status. Retrying is
  // bounded by the last confirmed lease deadline below.
  return true;
};

export type ManagedConversationLeaseHeartbeat = {
  start(): void;
  stop(): void;
  assertCurrent(): void;
  watchSession<Session extends { closeAndWait(): Promise<void> }>(
    session: Session,
    close?: () => Promise<void>
  ): () => void;
  withSession<Session extends { closeAndWait(): Promise<void> }, Result>(
    session: Session,
    operation: (session: Session) => Promise<Result>
  ): Promise<Result>;
};

export const createManagedConversationLeaseHeartbeat = (input: {
  heartbeatMs: number;
  leaseMs: number;
  initialLeaseExpiresAt?: number;
  retryMs?: number;
  initialSafetyMarginMs?: number;
  renewalSafetyMarginMs?: number;
  renew(): Promise<boolean>;
  leaseLostError(): Error;
}): ManagedConversationLeaseHeartbeat => {
  const retryMs = input.retryMs ?? 5_000;
  const initialSafetyMarginMs = input.initialSafetyMarginMs ?? 30_000;
  const renewalSafetyMarginMs = input.renewalSafetyMarginMs ?? 15_000;
  const initialMarginMs = Math.max(
    initialSafetyMarginMs,
    renewalSafetyMarginMs
  );
  let leaseLost = false;
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let closeSessions = Promise.resolve();
  let safeLeaseDeadline =
    typeof input.initialLeaseExpiresAt === "number" &&
      Number.isFinite(input.initialLeaseExpiresAt)
      ? input.initialLeaseExpiresAt - initialMarginMs
      : Date.now() + input.leaseMs - initialMarginMs;
  const watchedSessions = new Map<
    { closeAndWait(): Promise<void> },
    { close: () => Promise<void>; references: number }
  >();

  const loseLease = (): void => {
    if (leaseLost) return;
    leaseLost = true;
    if (timer) clearTimeout(timer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    timer = undefined;
    deadlineTimer = undefined;
    closeSessions = Promise.all(
      [...watchedSessions.values()].map(({ close }) =>
        close().catch(() => undefined)
      )
    ).then(() => undefined);
  };

  const schedule = (delayMs: number): void => {
    if (stopped || leaseLost) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void renew(), Math.max(1, delayMs));
    timer.unref?.();
  };

  const armDeadline = (): void => {
    if (stopped || leaseLost) return;
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = setTimeout(
      loseLease,
      Math.max(1, safeLeaseDeadline - Date.now())
    );
    deadlineTimer.unref?.();
  };

  const renew = async (): Promise<void> => {
    if (stopped || leaseLost || inFlight) return;
    if (Date.now() >= safeLeaseDeadline) {
      loseLease();
      return;
    }
    inFlight = true;
    const requestStartedAt = Date.now();
    try {
      const renewed = await input.renew();
      if (stopped || leaseLost) return;
      if (!renewed) {
        loseLease();
        return;
      }
      safeLeaseDeadline = requestStartedAt + input.leaseMs - renewalSafetyMarginMs;
      armDeadline();
      schedule(input.heartbeatMs);
    } catch (error) {
      if (stopped || leaseLost) return;
      if (
        !isTransientManagedConversationLeaseRenewalError(error) ||
        Date.now() >= safeLeaseDeadline
      ) {
        loseLease();
        return;
      }
      schedule(
        Math.min(
          retryMs,
          safeLeaseDeadline - Date.now()
        )
      );
    } finally {
      inFlight = false;
    }
  };

  return {
    start() {
      armDeadline();
      const remainingSafeLeaseMs = safeLeaseDeadline - Date.now();
      schedule(
        Math.min(
          input.heartbeatMs,
          Math.max(1, Math.floor(remainingSafeLeaseMs / 2))
        )
      );
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      timer = undefined;
      deadlineTimer = undefined;
    },
    assertCurrent() {
      if (
        !leaseLost &&
        Date.now() >= safeLeaseDeadline
      ) {
        loseLease();
      }
      if (leaseLost) throw input.leaseLostError();
    },
    watchSession(session, closeSession) {
      const close = closeSession ?? (() => session.closeAndWait());
      const existing = watchedSessions.get(session);
      if (existing) existing.references += 1;
      else watchedSessions.set(session, { close, references: 1 });
      if (leaseLost) void close().catch(() => undefined);
      return () => {
        const current = watchedSessions.get(session);
        if (!current) return;
        current.references -= 1;
        if (current.references <= 0) watchedSessions.delete(session);
      };
    },
    async withSession(session, operation) {
      const unwatch = this.watchSession(session);
      try {
        this.assertCurrent();
        const result = await operation(session);
        this.assertCurrent();
        return result;
      } finally {
        unwatch();
        await closeSessions;
      }
    }
  };
};

export const runWithManagedConversationLease = async <Session extends {
  closeAndWait(): Promise<void>;
}, Result>(input: {
  session: Session;
  heartbeatMs: number;
  leaseMs?: number;
  renew(): Promise<boolean>;
  close(session: Session): Promise<void>;
  operation(session: Session): Promise<Result>;
  leaseLostError(): Error;
}): Promise<Result> => {
  const heartbeat = createManagedConversationLeaseHeartbeat({
    heartbeatMs: input.heartbeatMs,
    leaseMs: input.leaseMs ?? 180_000,
    renew: input.renew,
    leaseLostError: input.leaseLostError
  });
  const unwatch = heartbeat.watchSession(input.session, () =>
    input.close(input.session)
  );
  heartbeat.start();
  try {
    heartbeat.assertCurrent();
    const result = await input.operation(input.session);
    heartbeat.assertCurrent();
    return result;
  } finally {
    heartbeat.stop();
    unwatch();
  }
};
