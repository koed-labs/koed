import type {
  ClaudeManagedConversationSession,
  CodexManagedConversationSession,
  PiManagedConversationSession,
  ManagedConversationCommandSession
} from "@koed/mcp-server";

export type ManagedConversationProvider = "codex" | "claude" | "pi";

export const managedConversationPolicySettingsKey = (
  base: string,
  readOnly: boolean
): string => (readOnly ? `${base}:catch_up_read_only` : base);

export const matchesManagedConversationPolicySettingsKey = (
  actual: string | undefined,
  base: string
): boolean =>
  actual === base ||
  actual === managedConversationPolicySettingsKey(base, true);

type ProviderSession = {
  codex: CodexManagedConversationSession & ManagedConversationCommandSession;
  claude: ClaudeManagedConversationSession & ManagedConversationCommandSession;
  pi: PiManagedConversationSession & ManagedConversationCommandSession;
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
      throw new Error("ManagedConversationRuntimeStillActiveError");
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

  deleteIfSession(
    provider: ManagedConversationProvider,
    executionId: string,
    session: ProviderSession[ManagedConversationProvider]
  ): boolean {
    const current = this.#sessions.get(executionId);
    if (current?.provider !== provider || current.session !== session)
      return false;
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

  async clear(closeSessions = true): Promise<void> {
    if (!closeSessions && this.#sessions.size)
      throw new Error("ManagedConversationRuntimeStillActiveError");
    for (const [executionId, entry] of this.#sessions)
      await quiesceManagedConversationRuntimeSession(
        this,
        entry.provider,
        executionId
      );
  }
}

/** Do not evict a possibly live process or start one with a different tool policy. */
export const quiesceManagedConversationRuntimeSession = async (
  registry: ManagedConversationRuntimeRegistry,
  provider: ManagedConversationProvider,
  executionId: string
): Promise<void> => {
  const previous = registry.get(provider, executionId);
  if (!previous) return;
  await previous.session.closeAndWait();
  registry.deleteIfSession(provider, executionId, previous.session);
};

export const runWithManagedConversationLease = async <Session, Result>(input: {
  session: Session;
  heartbeatMs: number;
  renew(): Promise<boolean>;
  close(session: Session): Promise<void>;
  operation(session: Session): Promise<Result>;
  leaseLostError(): Error;
}): Promise<Result> => {
  let leaseLost = false;
  let stoppedHeartbeat = false;
  const heartbeatState: {
    inFlight: Promise<void> | null;
    closeFailure: unknown;
  } = {
    inFlight: null,
    closeFailure: null
  };
  const heartbeat = async (): Promise<void> => {
    if (stoppedHeartbeat || leaseLost || heartbeatState.inFlight) return;
    const work = (async () => {
      try {
        if (await input.renew()) return;
      } catch {
        // Renewal failures fence the provider session just like an explicit loss.
      }
      leaseLost = true;
      try {
        await input.close(input.session);
      } catch (error) {
        heartbeatState.closeFailure = error;
      }
    })();
    heartbeatState.inFlight = work;
    await work;
    if (heartbeatState.inFlight === work) heartbeatState.inFlight = null;
  };
  const heartbeatTimer = setInterval(() => void heartbeat(), input.heartbeatMs);
  heartbeatTimer.unref?.();
  let result: Result | undefined;
  let operationFailure: unknown = null;
  try {
    result = await input.operation(input.session);
  } catch (error) {
    operationFailure = error;
  } finally {
    stoppedHeartbeat = true;
    clearInterval(heartbeatTimer);
    if (heartbeatState.inFlight) await heartbeatState.inFlight;
  }
  if (heartbeatState.closeFailure) throw heartbeatState.closeFailure;
  if (operationFailure) throw operationFailure;
  if (leaseLost) throw input.leaseLostError();
  return result as Result;
};
