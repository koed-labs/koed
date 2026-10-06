import { pendingChatRequests } from "./managed-chat-requests";
import type { RuntimeSnapshot } from "./managed-agent-chat";
import { stripPersonalMemoryAttributionFooter } from "@koed/shared/personal-memory-attribution";
import { record } from "./managed-agent-chat";
import type {
  BuildActivity,
  BuildActivityEvent,
  BuildActivityState
} from "./studio-build-activity";

export function managedAgentActivity(
  payload: Record<string, unknown>
): BuildActivity {
  const jobs = (Array.isArray(payload.jobs) ? payload.jobs : [])
    .filter(record)
    .slice(0, 20);
  const events: BuildActivityEvent[] = jobs.flatMap((job) => {
    if (typeof job.id !== "string") return [];
    const observed = job.freshness === "stale" ? "unknown" : job.observedState;
    const state: BuildActivityState =
      observed === "succeeded"
        ? "completed"
        : observed === "running"
          ? "running"
          : observed === "failed"
            ? "failed"
            : observed === "queued"
              ? "idle"
              : observed === "canceled"
                ? "idle"
                : "unknown";
    const title =
      observed === "succeeded"
        ? "Task completed"
        : observed === "running"
          ? "Working on your request"
          : observed === "queued"
            ? "Task queued"
            : observed === "canceled"
              ? "Task canceled"
              : observed === "failed"
                ? "Task failed"
                : "Task status needs verification";
    const at =
      typeof job.updatedAt === "string" ? Date.parse(job.updatedAt) : NaN;
    return [
      {
        id: job.id,
        ...(Number.isFinite(at) ? { at } : {}),
        kind:
          state === "completed"
            ? "completed"
            : state === "failed"
              ? "failed"
              : "progress",
        state,
        story: {
          title,
          detail:
            observed === "succeeded"
              ? "The runtime reported a successful completion."
              : observed === "running"
                ? "The runtime is processing your request."
                : observed === "queued"
                  ? "Your request is waiting for the runtime."
                  : "Status reported by the execution service."
        },
        technical: {
          status: typeof observed === "string" ? observed : "unknown"
        }
      }
    ];
  });
  const timestamp =
    typeof payload.snapshotAt === "string"
      ? Date.parse(payload.snapshotAt)
      : NaN;
  return {
    source: "live",
    state: events[0]?.state ?? "idle",
    // The API returns newest first; the panel renders chronological events.
    events: events.reverse(),
    ...(Number.isFinite(timestamp) ? { updatedAt: timestamp } : {})
  };
}

/** Direct AI Client chats have prompt commands but do not require a named Agent Job. */
export function managedConversationActivity(
  payload: Record<string, unknown>,
  runtime: RuntimeSnapshot
): BuildActivity {
  if (payload.executionGeneration !== runtime.execution.executionGeneration)
    return { source: "live", state: "unknown", events: [] };
  const activity = managedAgentActivity(payload);
  const command = runtime.latestCommand;
  if (!command) return activity;
  const state: BuildActivityState =
    command.state === "completed" && command.commandKind === "prompt"
      ? "completed"
      : command.state === "failed" || runtime.execution.state === "failed"
        ? "failed"
        : command.state === "indeterminate" || runtime.hasIndeterminatePrompt
          ? "unknown"
          : pendingChatRequests(runtime).length
            ? "blocked"
            : ["dispatching", "running"].includes(command.state)
              ? "running"
              : "idle";
  const title =
    state === "completed"
      ? "Task completed"
      : state === "failed"
        ? "Task failed"
        : state === "blocked"
          ? "Waiting for your input"
          : state === "unknown"
            ? "Task status needs verification"
            : state === "running"
              ? "Working on your request"
              : command.state === "canceled"
                ? "Task canceled"
                : command.commandKind === "stop" ||
                    command.commandKind === "interrupt"
                  ? "Task stopped"
                  : "Task queued";
  const messages = (
    Array.isArray(payload.messages) ? payload.messages : []
  ).filter(record);
  const promptIndex = messages.findIndex(
    (message) =>
      message.role === "user" &&
      (message.id === command.clientUserMessageId || message.id === command.id)
  );
  const history: BuildActivityEvent[] = [];
  const historyMessages = messages.slice(
    0,
    promptIndex < 0 ? undefined : promptIndex
  );
  for (let index = 0; index < historyMessages.length; index++) {
    const request = historyMessages[index];
    if (
      request.role !== "user" ||
      typeof request.content !== "string" ||
      typeof request.id !== "string"
    )
      continue;
    let reply: Record<string, unknown> | undefined;
    for (
      let next = index + 1;
      next < historyMessages.length && historyMessages[next].role !== "user";
      next++
    ) {
      if (historyMessages[next].role === "assistant")
        reply = historyMessages[next];
    }
    const summary = replySummary(reply?.content);
    if (!summary) continue;
    const at = Date.parse(
      typeof reply?.createdAt === "string" ? reply.createdAt : ""
    );
    history.push({
      id: `exchange:${request.id}`,
      kind: "message",
      state: "idle",
      story: {
        title: `Agent reports: ${summary.slice(0, 180)}`,
        detail: `Request: ${request.content.slice(0, 1000)}\nReply: ${summary}`
      },
      ...(Number.isFinite(at) ? { at } : {})
    });
  }
  const prompt = messages[promptIndex]?.content;
  const nextPrompt = messages.findIndex(
    (message, index) => index > promptIndex && message.role === "user"
  );
  const reply =
    state === "completed" && promptIndex >= 0
      ? messages
          .slice(promptIndex + 1, nextPrompt < 0 ? undefined : nextPrompt)
          .filter(
            (message) =>
              message.role === "assistant" &&
              typeof message.content === "string"
          )
          .at(-1)?.content
      : null;
  const summary = replySummary(reply);
  const at = Date.parse(command.updatedAt ?? "");
  const direct: BuildActivity = {
    source: "live",
    state,
    events: [
      ...history.slice(-4),
      {
        id: `command:${command.id}`,
        ...(Number.isFinite(at) ? { at } : {}),
        kind:
          state === "completed"
            ? "completed"
            : state === "failed"
              ? "failed"
              : state === "blocked"
                ? "blocked"
                : "progress",
        state,
        story: {
          title: summary ? `Agent reports: ${summary.slice(0, 180)}` : title,
          detail:
            typeof prompt === "string"
              ? `Request: ${prompt.slice(0, 1000)}${summary ? `\nReply: ${summary}` : ""}`
              : "Status reported by the execution service."
        },
        technical: {
          status: command.state,
          execution: {
            client: runtime.execution.provider,
            model: runtime.execution.model,
            reasoning: runtime.execution.reasoningEffort,
            access: runtime.execution.permissionMode
          }
        }
      }
    ],
    ...(Number.isFinite(at) ? { updatedAt: at } : {})
  };
  return activity.events.length
    ? { ...activity, recentExchanges: direct.events }
    : direct;
}

function replySummary(reply: unknown): string {
  return typeof reply === "string"
    ? stripPersonalMemoryAttributionFooter(reply, { mode: "final" })
        .trim()
        .split(/\n\s*\n/u)[0]
        .replace(/^#{1,6}\s+/u, "")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
        .replace(/[*`]/gu, "")
        .replace(/\s+/gu, " ")
        .slice(0, 500)
    : "";
}
