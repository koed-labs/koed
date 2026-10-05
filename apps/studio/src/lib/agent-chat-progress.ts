import type { RuntimeSnapshot } from "./managed-agent-chat";
import { pendingChatRequests } from "./managed-chat-requests";
import type { BuildActivity } from "./studio-build-activity";
import type { TeamAgentRequest } from "@koed/shared/team-agent-requests";

export type AgentChatProgress = Readonly<{
  key: string;
  state:
    | "sending"
    | "queued"
    | "working"
    | "responding"
    | "waiting"
    | "uncertain";
  label: string;
  /** Only explicit, user-facing progress signals; never raw provider reasoning. */
  steps: readonly { id: string; title: string; detail?: string }[];
}>;

export function managedChatProgress(
  runtime: RuntimeSnapshot | null,
  sending = false,
  activity?: BuildActivity | null
): AgentChatProgress | null {
  const command = runtime?.latestCommand;
  const key = `${runtime?.execution.id ?? "new"}:${command?.id ?? "sending"}`;
  if (
    !runtime ||
    !command ||
    command.commandKind !== "prompt" ||
    ["completed", "failed", "canceled"].includes(command.state) ||
    ["failed", "fenced", "stopped"].includes(runtime.execution.state)
  )
    return sending
      ? {
          key: `${key}:sending`,
          state: "sending",
          label: "Sending your message…",
          steps: []
        }
      : null;
  if (command.state === "indeterminate")
    return {
      key,
      state: "uncertain",
      label: "Checking task status…",
      steps: []
    };
  if (
    pendingChatRequests({
      ...runtime,
      items: runtime.items.filter(
        (item) =>
          item.executionGeneration === runtime.execution.executionGeneration
      )
    }).length > 0
  )
    return {
      key,
      state: "waiting",
      label: "Waiting for your input",
      steps: []
    };
  if (["queued", "blocked"].includes(command.state))
    return { key, state: "queued", label: "Waiting to start…", steps: [] };
  if (!["dispatching", "running"].includes(command.state)) return null;
  // Scope phase updates to an actively running selected Job, rather than an older Job in the inspector.
  const selectedJob = activity?.jobs?.find(
    (job) => job.id === activity.selectedJobId
  );
  const steps =
    activity?.source === "live" && selectedJob?.state === "running"
      ? activity.events
          .filter((event) => event.kind === "phase" && event.story?.title)
          .slice(-5)
          .map((event) => ({
            id: event.id,
            title: event.story!.title.slice(0, 180),
            ...(event.story?.detail
              ? { detail: event.story.detail.slice(0, 500) }
              : {})
          }))
      : [];
  const responding = runtime.items.some(
    (item) =>
      item.executionGeneration === runtime.execution.executionGeneration &&
      item.itemKind === "transient_output" &&
      item.state === "pending" &&
      item.presentation?.mode !== "hidden" &&
      item.presentation?.renderer === "message" &&
      Boolean(item.presentation.policyKey) &&
      typeof item.payload.text === "string" &&
      item.payload.text.trim()
  );
  return {
    key,
    state: responding ? "responding" : "working",
    label: responding
      ? "Writing the reply…"
      : (steps.at(-1)?.title ?? "Working on your request…"),
    steps
  };
}

/** Team channels receive shared status only, never the owner's private runtime or reasoning. */
export function teamRequestProgress(
  request: TeamAgentRequest
): AgentChatProgress | null {
  if (request.status !== "accepted") return null;
  const state = request.jobStatus;
  if (state === "running")
    return {
      key: request.id,
      state: "working",
      label: `${request.agentName} is working…`,
      steps: []
    };
  if (state === "queued" || state === null)
    return {
      key: request.id,
      state: "queued",
      label: `${request.agentName} is waiting to start…`,
      steps: []
    };
  if (state === "waiting")
    return {
      key: request.id,
      state: "waiting",
      label: `${request.agentName} is waiting for input`,
      steps: []
    };
  return null;
}
