import type { PersonalDesktopConversationEvent } from "@koed/shared";

export type PersonalToolDisplay = NonNullable<
  PersonalDesktopConversationEvent["toolDisplay"]
>;

type ToolEventSource = {
  actor?: unknown;
  content?: unknown;
  contentPreview?: unknown;
  metadata?: unknown;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const bounded = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;

const scalar = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
};

const field = (
  source: Record<string, unknown>,
  keys: readonly string[]
): string | undefined => {
  for (const key of keys) {
    const value = scalar(source[key]);
    if (value) return value;
  }
  return undefined;
};

const firstLine = (value: string | undefined): string | undefined => {
  const line = value?.split(/\r?\n/u).find((candidate) => candidate.trim());
  return line ? bounded(line.trim(), 2_048) : undefined;
};

const looksLikePatch = (value: string | undefined): boolean =>
  Boolean(
    value &&
    (/^\*\*\* Begin Patch/mu.test(value) ||
      /^\*\*\* (?:Add|Update|Delete) File:/mu.test(value) ||
      /^diff --git /mu.test(value) ||
      (/^--- (?:a\/|\/dev\/null)/mu.test(value) &&
        /^\+\+\+ (?:b\/|\/dev\/null)/mu.test(value)))
  );

const patchText = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    const candidate = scalar(value);
    if (candidate && looksLikePatch(candidate)) {
      return bounded(candidate, 1_048_576);
    }
    const nested = record(value);
    for (const key of ["patch", "diff", "input", "contents", "text"]) {
      const nestedCandidate = scalar(nested[key]);
      if (nestedCandidate && looksLikePatch(nestedCandidate)) {
        return bounded(nestedCandidate, 1_048_576);
      }
    }
  }
  return undefined;
};

const kindAndLabel = (
  toolName: string,
  signals: {
    command?: string;
    path?: string;
    query?: string;
    patchSource?: string;
  }
): Pick<PersonalToolDisplay, "kind" | "label"> => {
  const lowerName = toolName.toLocaleLowerCase().replace(/[_-]+/gu, " ");
  if (
    signals.command ||
    /\b(exec|shell|bash|terminal|command|run)\b/u.test(lowerName)
  ) {
    return { kind: "command", label: "Ran command" };
  }
  if (
    signals.patchSource ||
    /\b(write|edit|patch|save|change|diff)\b/u.test(lowerName)
  ) {
    return { kind: "file_change", label: "Changed files" };
  }
  if (signals.path || /\b(read|open|cat|view|file)\b/u.test(lowerName)) {
    return { kind: "file_read", label: "Read file" };
  }
  if (signals.query || /\b(search|find|grep|rg|list)\b/u.test(lowerName)) {
    return { kind: "search", label: "Searched files" };
  }
  const humanized = toolName
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return {
    kind: "tool",
    label: humanized
      ? humanized.charAt(0).toLocaleUpperCase() + humanized.slice(1)
      : "Tool call"
  };
};

export const buildPersonalToolDisplay = (
  source: ToolEventSource
): PersonalToolDisplay | undefined => {
  if (source.actor !== "tool") return undefined;
  const metadata = record(source.metadata);
  const toolCall = record(metadata.toolCall);
  const rawTranscriptPayload = record(metadata.rawTranscriptPayload);
  const input = record(
    metadata.input ?? toolCall.input ?? rawTranscriptPayload.input
  );
  const output = record(
    metadata.output ?? toolCall.output ?? rawTranscriptPayload.output
  );
  const toolName = bounded(
    field(metadata, [
      "toolName",
      "toolTitle",
      "tool",
      "functionName",
      "function"
    ]) ??
      field(toolCall, ["name", "title"]) ??
      field(rawTranscriptPayload, ["name", "title"]) ??
      "",
    256
  );
  const command =
    field(metadata, ["command", "cmd"]) ?? field(input, ["command", "cmd"]);
  const path =
    field(metadata, ["path", "filePath", "filename"]) ??
    field(input, ["path", "filePath", "filename"]);
  const query =
    field(metadata, ["query", "pattern", "search"]) ??
    field(input, ["query", "pattern", "search"]);
  const explicitOutput =
    field(metadata, ["result", "summary", "output"]) ??
    field(output, ["result", "summary", "output"]);
  const patchSource = patchText(
    toolCall.input,
    toolCall.patch,
    toolCall.diff,
    rawTranscriptPayload.input,
    rawTranscriptPayload.patch,
    rawTranscriptPayload.diff,
    metadata.input,
    source.content
  );
  const classification = kindAndLabel(toolName, {
    ...(command ? { command } : {}),
    ...(path ? { path } : {}),
    ...(query ? { query } : {}),
    ...(patchSource ? { patchSource } : {})
  });
  const preview =
    firstLine(command) ??
    firstLine(path) ??
    firstLine(query) ??
    firstLine(explicitOutput) ??
    firstLine(scalar(metadata.input ?? toolCall.input)) ??
    firstLine(scalar(metadata.output ?? toolCall.output)) ??
    firstLine(scalar(source.content)) ??
    firstLine(scalar(source.contentPreview)) ??
    "No preview available";
  const status = bounded(
    field(metadata, ["status"]) ??
      field(toolCall, ["status"]) ??
      field(rawTranscriptPayload, ["status"]) ??
      "",
    64
  );
  const callId = bounded(
    field(metadata, ["toolCallId", "callId"]) ??
      field(toolCall, ["id", "callId"]) ??
      field(rawTranscriptPayload, ["id", "callId"]) ??
      "",
    512
  );

  return {
    ...classification,
    preview,
    ...(toolName ? { toolName } : {}),
    ...(status ? { status } : {}),
    ...(callId ? { callId } : {}),
    ...(patchSource ? { patchSource } : {})
  };
};
