import {
  managedConversationDiffSchema,
  managedConversationAppliedEditsSchema
} from "@koed/shared/managed-conversation-diff";
import type { RuntimeSnapshot } from "./managed-agent-chat";
import type {
  BuildActivity,
  BuildActivityEvent
} from "./studio-build-activity";

/** Reuse saved turn checkpoints, never read today's workspace for an older task. */
export function conversationDiffEvent(
  value: unknown,
  runtime: RuntimeSnapshot
): BuildActivityEvent | null {
  const parsed = managedConversationDiffSchema.safeParse(value);
  const applied = managedConversationAppliedEditsSchema.safeParse(value);
  const command = runtime.latestCommand;
  if (!command) return null;
  if (applied.success) {
    const evidence = applied.data;
    if (
      evidence.executionId !== runtime.execution.id ||
      evidence.executionGeneration !== runtime.execution.executionGeneration ||
      evidence.scopeKey !== `turn:${command.id}`
    )
      return null;
    return {
      id: `turn-diff:${command.id}`,
      kind: "workspace-observed",
      state: "completed",
      technical: {
        status: evidence.files.some((file) => file.confirmation === "recorded")
          ? "Patches recorded for this AI Client request; application is not independently verified. A full workspace comparison is unavailable for this folder."
          : "Applied edits recorded by the AI Client. A full workspace comparison is unavailable for this folder.",
        files: boundedAppliedFiles(evidence.files),
        diff: {
          filesChanged: new Set(evidence.files.map((file) => file.path)).size
        }
      }
    };
  }
  if (!parsed.success) return null;
  const diff = parsed.data;
  if (
    diff.executionId !== runtime.execution.id ||
    diff.executionGeneration !== runtime.execution.executionGeneration ||
    diff.scope !== "turn" ||
    diff.scopeKey !== `turn:${command.id}`
  )
    return null;
  let patchBudget = 256 * 1024;
  const files = diff.diff.files.slice(0, 200).map((file) => {
    let additions = 0;
    let deletions = 0;
    let inHunk = false;
    const countsAvailable =
      !file.binary &&
      file.patch !== null &&
      !file.patchTruncated &&
      !file.contentExcluded;
    if (countsAvailable)
      for (const line of file.patch!.split("\n")) {
        if (line.startsWith("@@")) inHunk = true;
        else if (inHunk && line.startsWith("+")) additions++;
        else if (inHunk && line.startsWith("-")) deletions++;
      }
    const change = ["added", "modified", "deleted", "renamed"].includes(
      file.status
    )
      ? (file.status as "added" | "modified" | "deleted" | "renamed")
      : ("unknown" as const);
    const patch =
      !file.binary && !file.contentExcluded && file.patch !== null
        ? file.patch.slice(0, Math.min(32 * 1024, patchBudget))
        : "";
    patchBudget -= patch.length;
    return {
      path: file.path,
      ...(patch
        ? {
            patch,
            patchTruncated:
              file.patchTruncated || patch.length < file.patch!.length
          }
        : {
            patchUnavailable: file.contentExcluded
              ? "Content excluded"
              : file.binary
                ? "Binary file"
                : "Patch unavailable"
          }),
      change,
      ...(countsAvailable ? { additions, deletions } : {})
    };
  });
  const completeCounts =
    diff.complete &&
    !diff.truncated &&
    diff.diff.complete &&
    !diff.diff.truncated &&
    files.length === diff.fileCount &&
    files.every((file) => file.additions !== undefined);
  return {
    id: `turn-diff:${command.id}`,
    kind: "workspace-observed",
    state: "completed",
    technical: {
      status:
        diff.complete && !diff.truncated
          ? "Saved changes for this request"
          : "Partial saved changes for this request; totals may be incomplete",
      files,
      diff: {
        filesChanged: diff.fileCount,
        ...(completeCounts
          ? {
              additions: files.reduce((sum, file) => sum + file.additions!, 0),
              deletions: files.reduce((sum, file) => sum + file.deletions!, 0)
            }
          : {})
      }
    }
  };
}

/** One bounded cache per controller, partitioned by authenticated owner/backend. */
export function createConversationBuildDiffLoader() {
  const cache = new Map<string, BuildActivityEvent | null>();
  return async (
    activity: BuildActivity,
    runtime: RuntimeSnapshot,
    scope: string | null,
    request: () => Promise<unknown>,
    signal?: AbortSignal
  ): Promise<BuildActivity> => {
    const command = runtime.latestCommand;
    if (
      !scope ||
      command?.commandKind !== "prompt" ||
      command.state !== "completed"
    )
      return activity;
    const key = `${scope}:${runtime.execution.id}:${runtime.execution.executionGeneration}:${command.id}`;
    if (!cache.has(key)) {
      let event: BuildActivityEvent | null;
      try {
        event = conversationDiffEvent(await request(), runtime);
      } catch {
        event = null;
      }
      if (signal?.aborted) return activity;
      cache.set(key, event);
      if (cache.size > 5) cache.delete(cache.keys().next().value!);
    }
    const event = cache.get(key);
    if (activity.jobs?.length)
      return { ...activity, ...(event ? { recentTurnChanges: event } : {}) };
    return {
      ...activity,
      availability: event ? "available" : activity.availability,
      events: [
        ...activity.events,
        event ?? {
          id: `turn-diff-unavailable:${command.id}`,
          kind: "message",
          technical: {
            status:
              "No saved file diff is available for this request. File and line counts are unknown."
          }
        }
      ]
    };
  };
}

function boundedAppliedFiles(
  files: {
    path: string;
    change: "added" | "modified" | "deleted";
    patch?: string;
    patchTruncated: boolean;
    confirmation?: "applied" | "recorded";
    contentExcluded?: true;
    additions?: number;
    deletions?: number;
  }[]
) {
  let budget = 256 * 1024;
  return files.map(({ contentExcluded, patch, ...file }) => {
    const shown = contentExcluded
      ? ""
      : (patch ?? "").slice(0, Math.min(32768, budget));
    budget -= shown.length;
    return {
      ...file,
      ...(shown
        ? {
            patch: shown,
            patchTruncated:
              file.patchTruncated || shown.length < (patch?.length ?? 0)
          }
        : {
            patchUnavailable: contentExcluded
              ? "Content excluded"
              : "Patch unavailable"
          })
    };
  });
}
