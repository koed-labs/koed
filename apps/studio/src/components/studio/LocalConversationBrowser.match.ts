import type { HomeExecution, HomeRecent } from "@/lib/studio-contract";
// Node 24's native TypeScript runner requires the source extension here.
// @ts-expect-error -- Next's app compiler does not enable TS extension imports.
export { isSyntheticIndependentProject } from "../../lib/project-identity.ts";
import type { PersonalMemoryEntry } from "@koed/shared/collaboration";

export type LocalConversationProvider = "codex" | "claude-code" | "pi";

export type LocalConversationMatch =
  | { type: "managed"; executionId: string }
  | { type: "captured"; recent: HomeRecent };

export function managedConversationActivityLabel(
  activity: HomeExecution["activity"],
  state?: string | null
): string {
  switch (state?.toLowerCase()) {
    case "stopped":
      return "Stopped";
    case "failed":
      return "Failed";
    case "fenced":
      return "Disconnected";
  }
  switch (activity) {
    case "running":
      return "Working";
    case "pending":
      return "Queued";
    case "uncertain":
      return "Status uncertain";
    case "idle":
      return "Idle";
    case "operation":
      return "Operation active";
    case "operation-pending":
      return "Operation queued";
    default:
      return "Activity unverified";
  }
}

export type ShareablePersonalConversation = Pick<
  PersonalMemoryEntry,
  "id" | "logicalMemoryId" | "title" | "syncState" | "hasSynchronizedRevision"
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
    byLocalSourceId.set(`${provider}:${encodeURIComponent(recent.id)}`, memory);
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

export function shareDialogSourceMayRemainOpen(input: {
  sourceHomeScopeKey: string;
  currentHomeScopeKey: string | null;
  sourceAuthorityKey: string;
  currentAuthorityKey: string | null;
  sourceLogicalMemoryId: string | null;
  currentLogicalMemoryId: string | null;
}): boolean {
  return (
    input.sourceHomeScopeKey === input.currentHomeScopeKey &&
    input.sourceAuthorityKey === input.currentAuthorityKey &&
    input.sourceLogicalMemoryId === input.currentLogicalMemoryId
  );
}

export function ownerSnapshotMaySurviveRefresh(input: {
  sameHomeScope: boolean;
  authorizationDenied: boolean;
}): boolean {
  return input.sameHomeScope && !input.authorizationDenied;
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
  const matching = executions.filter((execution) => {
    const state = execution.state.toLowerCase();
    return (
      execution.sessionId === sessionId &&
      normalizeConversationProvider(execution.provider) === provider &&
      ["running", "ready", "starting", "stopped", "failed", "fenced"].includes(
        state
      )
    );
  });
  const active = matching.filter((execution) =>
    ["running", "ready", "starting"].includes(execution.state.toLowerCase())
  );
  if (active.length > 0) return active.length === 1 ? active[0].id : null;

  const history = matching.filter((execution) =>
    ["stopped", "failed", "fenced"].includes(execution.state.toLowerCase())
  );
  return history.length === 1 ? history[0].id : null;
}

/** Source IDs that already represent a listed managed execution or history row. */
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

/** Provider source IDs associated with each uniquely resolved managed row. */
export function managedProviderSourceIdsByExecution({
  recents,
  executions
}: {
  recents: HomeRecent[];
  executions: HomeExecution[];
}): Record<string, string[]> {
  const byExecution = new Map<string, Set<string>>();
  for (const recent of recents) {
    const provider = normalizeConversationProvider(recent.provider);
    if (!provider) continue;
    const executionId = matchManagedExecutionForCapturedSession({
      sessionId: recent.sessionId,
      provider,
      executions
    });
    if (!executionId) continue;
    const sources = byExecution.get(executionId) ?? new Set<string>();
    sources.add(`${provider}:${encodeURIComponent(recent.id)}`);
    byExecution.set(executionId, sources);
  }
  return Object.fromEntries(
    Array.from(byExecution, ([executionId, sources]) => [
      executionId,
      Array.from(sources)
    ])
  );
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
