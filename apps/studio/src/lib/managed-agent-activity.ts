import { pendingChatRequests } from "./managed-chat-requests";
import type { RuntimeSnapshot } from "./managed-agent-chat";
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
  if (activity.events.length) return activity;
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
  const prompts = (Array.isArray(payload.messages) ? payload.messages : [])
    .filter(record)
    .filter(
      (message) =>
        message.role === "user" && typeof message.content === "string"
    );
  const prompt = prompts.find(
    (message) =>
      message.id === command.clientUserMessageId || message.id === command.id
  )?.content;
  const at = Date.parse(command.updatedAt ?? "");
  return {
    source: "live",
    state,
    events: [
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
          title,
          detail:
            typeof prompt === "string"
              ? `Request: ${prompt.slice(0, 1000)}`
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
}
