import type {
  ClaudeManagedConversationSession,
  CodexManagedConversationSession
} from "@koed/mcp-server";

export type ManagedConversationProvider = "codex" | "claude";

type ProviderSession = {
  codex: CodexManagedConversationSession;
  claude: ClaudeManagedConversationSession;
};

export type RuntimeSessionEntry<P extends ManagedConversationProvider> = {
  provider: P;
  executionGeneration: number;
  aiClientInstanceId: string;
  configIdentityHash: string;
  session: ProviderSession[P];
};

type AnyRuntimeSessionEntry =
  | RuntimeSessionEntry<"codex">
  | RuntimeSessionEntry<"claude">;

export class ManagedConversationRuntimeRegistry {
  readonly #sessions = new Map<string, AnyRuntimeSessionEntry>();

  get<P extends ManagedConversationProvider>(
    provider: P,
    executionId: string,
    expected?: {
      executionGeneration?: number;
      aiClientInstanceId?: string;
      configIdentityHash?: string;
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
  const heartbeat = async (): Promise<void> => {
    if (stoppedHeartbeat || leaseLost) return;
    try {
      if (await input.renew()) return;
    } catch {
      // Renewal failures fence the provider session just like an explicit loss.
    }
    leaseLost = true;
    await input.close(input.session).catch(() => undefined);
  };
  const heartbeatTimer = setInterval(() => void heartbeat(), input.heartbeatMs);
  heartbeatTimer.unref?.();
  try {
    const result = await input.operation(input.session);
    if (leaseLost) throw input.leaseLostError();
    return result;
  } finally {
    stoppedHeartbeat = true;
    clearInterval(heartbeatTimer);
  }
};
