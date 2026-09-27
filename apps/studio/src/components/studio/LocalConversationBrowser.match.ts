import type { HomeExecution, HomeRecent } from "@/lib/studio-contract";

export type LocalConversationProvider = "codex" | "claude-code" | "pi";

export type LocalConversationMatch =
  | { type: "managed"; executionId: string }
  | { type: "captured"; recent: HomeRecent };

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
