import type { HomeExecution, HomeRecent } from "@/lib/studio-contract";
import type { PersonalMemoryEntry } from "@koed/shared/collaboration";

export type LocalConversationProvider = "codex" | "claude-code" | "pi";

export type LocalConversationMatch =
  | { type: "managed"; executionId: string }
  | { type: "captured"; recent: HomeRecent };

export type ShareablePersonalConversation = Pick<
  PersonalMemoryEntry,
  | "id"
  | "logicalMemoryId"
  | "title"
  | "syncState"
  | "hasSynchronizedRevision"
>;

/**
 * Index only owner-authorized Personal Memory entries. Provider source IDs and
 * managed execution IDs are deliberately not accepted as memory identities.
 */
export function indexShareablePersonalConversations(
  entries: readonly PersonalMemoryEntry[]
): Map<string, ShareablePersonalConversation> {
  const indexed = new Map<string, ShareablePersonalConversation>();
  for (const entry of entries) {
    if (!entry.id || !entry.logicalMemoryId) continue;
    indexed.set(entry.id, {
      id: entry.id,
      logicalMemoryId: entry.logicalMemoryId,
      title: entry.title,
      syncState: entry.syncState,
      hasSynchronizedRevision: entry.hasSynchronizedRevision
    });
  }
  return indexed;
}

export function ownedMemoryForCapturedSession(input: {
  sessionId: string | null | undefined;
  entriesBySessionId: ReadonlyMap<string, ShareablePersonalConversation>;
}): ShareablePersonalConversation | null {
  if (!input.sessionId) return null;
  return input.entriesBySessionId.get(input.sessionId) ?? null;
}

export function indexShareableConversationRows(input: {
  entriesBySessionId: ReadonlyMap<string, ShareablePersonalConversation>;
  recents: readonly HomeRecent[];
  executions: readonly HomeExecution[];
}): {
  byExecutionId: Map<string, ShareablePersonalConversation>;
  byLocalSourceId: Map<string, ShareablePersonalConversation>;
} {
  const byExecutionId = new Map<string, ShareablePersonalConversation>();
  const byLocalSourceId = new Map<string, ShareablePersonalConversation>();

  for (const execution of input.executions) {
    const memory = ownedMemoryForCapturedSession({
      sessionId: execution.sessionId,
      entriesBySessionId: input.entriesBySessionId
    });
    if (memory) byExecutionId.set(execution.id, memory);
  }

  for (const recent of input.recents) {
    const provider = normalizeConversationProvider(recent.provider);
    if (!provider) continue;
    const memory = ownedMemoryForCapturedSession({
      sessionId: recent.sessionId,
      entriesBySessionId: input.entriesBySessionId
    });
    if (!memory) continue;
    byLocalSourceId.set(
      `${provider}:${encodeURIComponent(recent.id)}`,
      memory
    );
  }

  return { byExecutionId, byLocalSourceId };
}

export function ownerMemoryLoadMayApply(input: {
  active: boolean;
  sequence: number;
  currentSequence: number;
  homeScopeKey: string;
  currentHomeScopeKey: string | null | undefined;
}): boolean {
  return (
    input.active &&
    input.sequence === input.currentSequence &&
    input.homeScopeKey === input.currentHomeScopeKey
  );
}

export function normalizeConversationProvider(
  value: string | null | undefined
): LocalConversationProvider | null {
  if (value === "codex" || value === "codex-cli") return "codex";
  if (value === "claude" || value === "claude-code") return "claude-code";
  if (value === "pi") return "pi";
  return null;
}

export function matchManagedExecutionForCapturedSession({
  sessionId,
  provider,
  executions
}: {
  sessionId: string;
  provider: LocalConversationProvider;
  executions: HomeExecution[];
}): string | null {
  const active = executions.filter((execution) => {
    const state = execution.state.toLowerCase();
    return (
      execution.sessionId === sessionId &&
      normalizeConversationProvider(execution.provider) === provider &&
      (state === "running" || state === "ready")
    );
  });
  return active.length === 1 ? active[0].id : null;
}

/** Source IDs that already represent a listed managed execution. */
export function managedConversationSourceIds({
  recents,
  executions
}: {
  recents: HomeRecent[];
  executions: HomeExecution[];
}): Set<string> {
  const ids = new Set<string>();
  for (const recent of recents) {
    const provider = normalizeConversationProvider(recent.provider);
    if (!provider) continue;
    const executionId = matchManagedExecutionForCapturedSession({
      sessionId: recent.sessionId,
      provider,
      executions
    });
    if (executionId) ids.add(`${provider}:${encodeURIComponent(recent.id)}`);
  }
  return ids;
}

export function isSyntheticIndependentProject(
  projectId: string | null | undefined,
  projectName?: string | null
): boolean {
  const isRuntimeUuid = (value: string | null | undefined) =>
    Boolean(
      value &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          value.trim()
        )
    );
  if (/^lp_[0-9a-f]{32}$/iu.test(projectId ?? "")) return false;
  return isRuntimeUuid(projectId) || isRuntimeUuid(projectName);
}

export function matchLocalConversationToHome({
  sourceId,
  provider,
  recents,
  executions
}: {
  sourceId: string;
  provider: LocalConversationProvider;
  recents: HomeRecent[];
  executions: HomeExecution[];
}): LocalConversationMatch | null {
  const prefix = `${provider}:`;
  if (!sourceId.startsWith(prefix)) return null;
  let nativeThreadId: string;
  try {
    nativeThreadId = decodeURIComponent(sourceId.slice(prefix.length));
  } catch {
    return null;
  }
  if (!nativeThreadId) return null;

  const normalizedProvider = normalizeConversationProvider(provider);
  if (!normalizedProvider) return null;
  const matches = recents.filter(
    (recent) =>
      recent.id === nativeThreadId &&
      normalizeConversationProvider(recent.provider) === normalizedProvider
  );
  if (matches.length !== 1) return null;
  const recent = matches[0];
  const executionId = matchManagedExecutionForCapturedSession({
    sessionId: recent.sessionId,
    provider: normalizedProvider,
    executions
  });
  if (executionId) return { type: "managed", executionId };
  return { type: "captured", recent };
}
