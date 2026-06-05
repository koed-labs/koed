import {
  BotIcon,
  CpuIcon,
  SparklesIcon,
  UserIcon,
  WrenchIcon
} from "lucide-react";

import {
  patchSummaryText,
  summarizePatchDetails,
  type PatchDetails
} from "./diff";
import { codexIdePromptUserText } from "./codexIdePrompt";
import type { GraphEvent, GraphNode, ProjectGroup, ThreadGroup } from "./types";

export function threadSelectionKey(
  thread: Pick<ThreadGroup, "projectId" | "id">
) {
  return `${encodeURIComponent(thread.projectId)}:${encodeURIComponent(thread.id)}`;
}

function projectKey(
  event: Pick<GraphEvent, "projectId" | "projectPath" | "workspaceId">
) {
  return (
    event.projectId ??
    event.projectPath ??
    event.workspaceId ??
    "unknown-project"
  );
}

function projectLabel(
  event: Pick<GraphEvent, "projectName" | "projectPath" | "workspaceId">
) {
  return (
    event.projectName ??
    event.projectPath ??
    event.workspaceId ??
    "Unknown project"
  );
}

function threadKey(event: Pick<GraphEvent, "threadId" | "sessionId" | "id">) {
  return event.threadId ?? event.sessionId ?? event.id;
}

function threadLabel(
  event: Pick<GraphEvent, "threadName" | "threadId" | "sessionId">
) {
  const label = event.threadName
    ? codexIdePromptUserText(event.threadName)
    : "";
  return label || event.threadId || event.sessionId || "Untitled conversation";
}

function threadSample(event: Pick<GraphEvent, "contentPreview">) {
  return codexIdePromptUserText(event.contentPreview);
}

export function buildProjectGroups(events: GraphEvent[]): ProjectGroup[] {
  const projectMap = new Map<string, ProjectGroup>();
  const threadMap = new Map<string, ProjectGroup["threads"][number]>();

  for (const event of events) {
    const pKey = projectKey(event);
    let project = projectMap.get(pKey);
    if (!project) {
      project = {
        id: pKey,
        name: projectLabel(event),
        path: event.projectPath,
        eventCount: 0,
        threads: []
      };
      projectMap.set(pKey, project);
    }

    const tKey = threadKey(event);
    const compoundThreadKey = `${pKey}:${tKey}`;
    let thread = threadMap.get(compoundThreadKey);
    if (!thread) {
      thread = {
        id: tKey,
        name: threadLabel(event),
        projectId: pKey,
        projectName: project.name,
        sessionId: event.sessionId ?? null,
        eventCount: 0,
        invalidatedCount: 0,
        latestAt: event.timestamp,
        sample: threadSample(event)
      };
      threadMap.set(compoundThreadKey, thread);
      project.threads.push(thread);
    } else if (!thread.sessionId && event.sessionId) {
      thread.sessionId = event.sessionId;
    }

    project.eventCount += 1;
    thread.eventCount += 1;
    if (event.invalidatedAt) {
      thread.invalidatedCount += 1;
    }
    if (event.timestamp > thread.latestAt) {
      thread.latestAt = event.timestamp;
      thread.sample = threadSample(event);
    }
  }

  return [...projectMap.values()]
    .map((project) => ({
      ...project,
      threads: [...project.threads].sort((left, right) =>
        right.latestAt.localeCompare(left.latestAt)
      )
    }))
    .sort((left, right) => {
      const leftLatest = left.threads[0]?.latestAt ?? "";
      const rightLatest = right.threads[0]?.latestAt ?? "";
      return rightLatest.localeCompare(leftLatest);
    });
}

export function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function eventIcon(actor: string | null) {
  if (actor === "assistant" || actor === "agent") return BotIcon;
  if (actor === "subagent") return SparklesIcon;
  if (actor === "tool") return WrenchIcon;
  if (actor === "system") return CpuIcon;
  return UserIcon;
}

export function eventTone(actor: string | null) {
  if (actor === "assistant") return "border-border/70 bg-card/80";
  if (actor === "agent") return "border-border/70 bg-card/80";
  if (actor === "subagent") return "border-accent/40 bg-accent/10";
  if (actor === "tool") return "border-dashed border-info/30 bg-info/4";
  if (actor === "system") return "border-dashed border-warning/40 bg-warning/4";
  return "border-primary/20 bg-primary/4";
}

export function eventActorLabel(
  event: Pick<GraphEvent, "actor" | "eventType">
) {
  switch (event.actor) {
    case "agent":
      return "Agent";
    case "assistant":
      return "Assistant";
    case "subagent":
      return "Subagent";
    case "system":
      return "System";
    case "tool":
      return "Tool";
    case "user":
      return "User";
    default:
      return event.actor ?? event.eventType;
  }
}

export function eventDisplayText(
  event: Pick<GraphEvent, "content" | "contentFull" | "contentPreview">
) {
  return codexIdePromptUserText(
    event.contentFull ?? event.content ?? event.contentPreview
  );
}

export interface ToolEventSummary {
  label: string;
  preview: string;
  status?: string;
  toolCallId?: string;
  toolName?: string;
  patch?: PatchDetails | null;
}

export function toolEventSummary(
  event: Pick<
    GraphEvent,
    "content" | "contentFull" | "contentPreview" | "rawContent" | "metadata"
  >
): ToolEventSummary {
  const toolCall = metadataRecord(event.metadata.toolCall);
  const toolName =
    metadataString(event.metadata, [
      "toolName",
      "toolTitle",
      "tool",
      "functionName",
      "function"
    ]) ?? metadataString(toolCall, ["name", "title"]);
  const lowerToolName = (toolName ?? "").toLowerCase();
  const input = metadataRecord(event.metadata.input ?? toolCall.input);
  const output = metadataRecord(event.metadata.output ?? toolCall.output);
  const command =
    metadataString(event.metadata, ["command", "cmd"]) ??
    metadataString(input, ["command", "cmd"]);
  const path =
    metadataString(event.metadata, ["path", "filePath", "filename"]) ??
    metadataString(input, ["path", "filePath", "filename"]);
  const query =
    metadataString(event.metadata, ["query", "pattern", "search"]) ??
    metadataString(input, ["query", "pattern", "search"]);
  const outputPreview =
    metadataString(event.metadata, ["output", "result", "summary"]) ??
    metadataString(output, ["output", "result", "summary"]);
  const inputPreview = metadataValuePreview(
    event.metadata.input ?? toolCall.input
  );
  const outputValuePreview = metadataValuePreview(
    event.metadata.output ?? toolCall.output
  );
  const status =
    metadataString(event.metadata, ["status"]) ??
    metadataString(toolCall, ["status"]);
  const toolCallId =
    metadataString(event.metadata, ["toolCallId", "callId"]) ??
    metadataString(toolCall, ["id", "callId"]);
  const patch = summarizePatchDetails(event);
  const label = toolEventLabel(lowerToolName, toolName, {
    command,
    path,
    query
  });
  const preview = patch
    ? patchSummaryText(patch)
    : firstLine(
        command ??
          path ??
          query ??
          outputPreview ??
          inputPreview ??
          outputValuePreview ??
          eventDisplayText(event)
      ) || "No preview available";

  return {
    label,
    preview,
    ...(status ? { status } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(patch ? { patch } : {})
  };
}

function toolEventLabel(
  lowerToolName: string,
  toolName: string | undefined,
  signals: {
    command: string | undefined;
    path: string | undefined;
    query: string | undefined;
  }
) {
  if (
    signals.command ||
    /\b(exec|shell|bash|terminal|command|run)\b/.test(lowerToolName)
  ) {
    return "Ran command";
  }
  if (/\b(write|edit|patch|save|change|diff)\b/.test(lowerToolName)) {
    return "Changed files";
  }
  if (signals.path || /\b(read|open|cat|view|file)\b/.test(lowerToolName)) {
    return "Read file";
  }
  if (signals.query || /\b(search|find|grep|rg|list)\b/.test(lowerToolName)) {
    return "Searched files";
  }
  return toolName ? humanizeToolName(toolName) : "Tool call";
}

function metadataRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function metadataString(
  metadata: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  return undefined;
}

function metadataValuePreview(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function humanizeToolName(value: string) {
  const label = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : "Tool call";
}

export function firstLine(value: string) {
  return value.trim().split(/\n+/)[0] ?? "";
}

export function uniqueNodeIds(events: GraphEvent[]) {
  return [...new Set(events.flatMap((event) => event.linkedNodeIds))];
}

export function nodeMap(nodes: GraphNode[]) {
  return new Map(nodes.map((node) => [node.id, node]));
}
