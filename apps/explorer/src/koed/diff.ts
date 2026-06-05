import { parsePatchFiles, type ParsedPatch } from "@pierre/diffs";

import type { GraphEvent } from "./types";

export interface PatchFileSummary {
  name: string;
  displayName: string;
  changeType: string;
  additions: number;
  deletions: number;
}

export interface PatchDetails {
  sourceText: string;
  normalizedText: string;
  files: PatchFileSummary[];
  fileDiffs: ParsedPatch["files"];
  additions: number;
  deletions: number;
  patchMetadata?: string;
  parseError?: string;
  supported: boolean;
}

const PATCH_HINTS = [
  /^\*\*\* Begin Patch/m,
  /^\*\*\* Update File:/m,
  /^\*\*\* Add File:/m,
  /^\*\*\* Delete File:/m,
  /^diff --git /m,
  /^@@ /m,
  /^--- a\//m,
  /^\+\+\+ b\//m
];

const APPLY_PATCH_FILE_MARKER = /^\*\*\* (Update|Add|Delete) File:\s*(.+)$/;

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function firstDefinedString(...values: unknown[]): string | null {
  for (const value of values) {
    if (isString(value) && value.trim()) {
      return value;
    }
  }
  return null;
}

function recordText(value: unknown): string | null {
  if (isString(value) && value.trim()) {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return (
    firstDefinedString(
      record.input,
      record.patch,
      record.diff,
      record.contents,
      record.text,
      record.content,
      record.rawText,
      record.rawContent
    ) ?? null
  );
}

// Treat Codex-style tool-call records as renderable patches when the payload lives in
// metadata.toolCall.input / patch / diff or the mirrored raw transcript payload.
function extractPatchSourceText(
  event: Pick<GraphEvent, "metadata" | "content" | "contentFull" | "rawContent">
): string | null {
  const metadata = event.metadata ?? {};
  const toolCall = isString((metadata as Record<string, unknown>).toolCall)
    ? null
    : ((metadata as Record<string, unknown>).toolCall as
        | Record<string, unknown>
        | undefined);
  const rawTranscriptPayload = (metadata as Record<string, unknown>)
    .rawTranscriptPayload as Record<string, unknown> | undefined;

  return (
    recordText(toolCall?.input) ??
    recordText(toolCall?.patch) ??
    recordText(toolCall?.diff) ??
    recordText(rawTranscriptPayload?.input) ??
    recordText(rawTranscriptPayload?.patch) ??
    recordText(rawTranscriptPayload?.diff) ??
    recordText(event.rawContent) ??
    recordText(event.contentFull) ??
    recordText(event.content)
  );
}

function looksLikePatchText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return PATCH_HINTS.some((hint) => hint.test(trimmed));
}

function splitApplyPatchBlocks(sourceText: string): Array<{
  kind: "update" | "add" | "delete";
  name: string;
  body: string[];
}> | null {
  const lines = sourceText.replace(/\r\n/g, "\n").split("\n");
  const startIndex = lines.findIndex(
    (line) => line.trim() === "*** Begin Patch"
  );
  if (startIndex === -1) {
    return null;
  }

  const blocks: Array<{
    kind: "update" | "add" | "delete";
    name: string;
    body: string[];
  }> = [];
  let current: {
    kind: "update" | "add" | "delete";
    name: string;
    body: string[];
  } | null = null;

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "*** End Patch") {
      break;
    }

    const markerMatch = APPLY_PATCH_FILE_MARKER.exec(line);
    if (markerMatch) {
      if (current) {
        blocks.push(current);
      }
      const marker = markerMatch[1];
      const name = markerMatch[2];
      if (!marker || !name) {
        current = null;
        continue;
      }
      current = {
        kind: marker.toLowerCase() as "update" | "add" | "delete",
        name: name.trim(),
        body: []
      };
      continue;
    }

    if (!current) {
      continue;
    }

    current.body.push(line);
  }

  if (current) {
    blocks.push(current);
  }

  return blocks;
}

function convertApplyPatchToUnifiedDiff(sourceText: string): string | null {
  const blocks = splitApplyPatchBlocks(sourceText);
  if (!blocks || blocks.length === 0) {
    return null;
  }

  const normalizedBlocks = blocks
    .map((block) => {
      const patchPath = block.name.replace(/\\/g, "/").replace(/^\/+/, "");
      const header = [
        `diff --git a/${patchPath} b/${patchPath}`,
        block.kind === "add" ? "--- /dev/null" : `--- a/${patchPath}`,
        block.kind === "delete" ? "+++ /dev/null" : `+++ b/${patchPath}`
      ];

      const hunks: string[] = [];
      let currentHunk: string[] = [];
      const flushHunk = () => {
        if (currentHunk.length === 0) {
          return;
        }
        const formattedLines = currentHunk.map((line) => {
          if (
            line.startsWith("+") ||
            line.startsWith("-") ||
            line.startsWith(" ") ||
            line.startsWith("\\ No newline at end of file")
          ) {
            return line;
          }
          return ` ${line}`;
        });
        const additions = formattedLines.filter((line) =>
          line.startsWith("+")
        ).length;
        const deletions = formattedLines.filter((line) =>
          line.startsWith("-")
        ).length;
        const context = formattedLines.length - additions - deletions;
        const oldCount =
          block.kind === "add" ? 0 : Math.max(0, deletions + context);
        const newCount =
          block.kind === "delete" ? 0 : Math.max(0, additions + context);
        const oldStart = block.kind === "add" ? 0 : 1;
        const newStart = block.kind === "delete" ? 0 : 1;
        hunks.push(
          `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${formattedLines.join(
            "\n"
          )}`
        );
        currentHunk = [];
      };

      for (const line of block.body) {
        if (line.trim().startsWith("@@")) {
          flushHunk();
          continue;
        }
        currentHunk.push(line);
      }
      flushHunk();

      const body = hunks.join("\n");
      return body ? `${header.join("\n")}\n${body}\n` : null;
    })
    .filter((value): value is string => Boolean(value));

  return normalizedBlocks.length > 0 ? normalizedBlocks.join("\n") : null;
}

function normalizePatchText(sourceText: string): {
  normalizedText: string | null;
  parseMode: "apply_patch" | "unified_diff" | "unknown";
} {
  const trimmed = sourceText.trim();
  if (!trimmed) {
    return { normalizedText: null, parseMode: "unknown" };
  }

  if (trimmed.startsWith("*** Begin Patch")) {
    const converted = convertApplyPatchToUnifiedDiff(trimmed);
    return {
      normalizedText: converted,
      parseMode: converted ? "apply_patch" : "unknown"
    };
  }

  if (looksLikePatchText(trimmed)) {
    return { normalizedText: trimmed, parseMode: "unified_diff" };
  }

  return { normalizedText: null, parseMode: "unknown" };
}

function countFileLineChanges(file: ParsedPatch["files"][number]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;

  for (const hunk of file.hunks) {
    for (const segment of hunk.hunkContent) {
      if (segment.type === "change") {
        additions += segment.additions;
        deletions += segment.deletions;
      }
    }
  }

  return { additions, deletions };
}

function shortDisplayName(name: string): string {
  const normalized = name.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? normalized;
}

function formatFileSummary(
  file: ParsedPatch["files"][number]
): PatchFileSummary {
  const counts = countFileLineChanges(file);
  return {
    name: file.name,
    displayName: shortDisplayName(file.name),
    changeType: file.type,
    additions: counts.additions,
    deletions: counts.deletions
  };
}

function summarizeFiles(files: PatchFileSummary[]): string {
  if (files.length === 0) {
    return "";
  }

  const previewFiles = files.slice(0, 3);
  const previewText = previewFiles
    .map((file) => {
      const counts = [
        file.additions > 0 ? `+${file.additions}` : null,
        file.deletions > 0 ? `-${file.deletions}` : null
      ]
        .filter(Boolean)
        .join("/");
      const suffix = counts ? ` (${counts})` : "";
      return `${file.displayName}${suffix}`;
    })
    .join(", ");

  const extra =
    files.length > previewFiles.length
      ? ` +${files.length - previewFiles.length} more`
      : "";
  return `${files.length} file${files.length === 1 ? "" : "s"} changed: ${previewText}${extra}`;
}

export function summarizePatchDetails(
  event: Pick<GraphEvent, "metadata" | "content" | "contentFull" | "rawContent">
): PatchDetails | null {
  const sourceText = extractPatchSourceText(event);
  if (!sourceText) {
    return null;
  }

  const { normalizedText, parseMode } = normalizePatchText(sourceText);
  if (!normalizedText) {
    return looksLikePatchText(sourceText)
      ? {
          sourceText,
          normalizedText: sourceText,
          files: [],
          fileDiffs: [] as ParsedPatch["files"],
          additions: 0,
          deletions: 0,
          parseError: "Patch text could not be normalized",
          supported: false
        }
      : null;
  }

  try {
    const parsedPatches = parsePatchFiles(normalizedText);
    const fileDiffs = parsedPatches.flatMap((patch) => patch.files);
    const files = fileDiffs.map(formatFileSummary);
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    const patchMetadata = parsedPatches
      .map((patch) => patch.patchMetadata?.trim() ?? "")
      .filter(Boolean)
      .join("\n");

    return {
      sourceText,
      normalizedText,
      files,
      fileDiffs,
      additions,
      deletions,
      ...(patchMetadata ? { patchMetadata } : {}),
      supported:
        files.length > 0 ||
        parseMode === "unified_diff" ||
        parseMode === "apply_patch"
    };
  } catch (error) {
    return {
      sourceText,
      normalizedText: sourceText,
      files: [],
      fileDiffs: [] as ParsedPatch["files"],
      additions: 0,
      deletions: 0,
      parseError: error instanceof Error ? error.message : String(error),
      supported: false
    };
  }
}

export function patchSummaryText(details: PatchDetails): string {
  if (details.files.length > 0) {
    return summarizeFiles(details.files);
  }
  if (details.supported) {
    return "Patch ready to render";
  }
  return "Patch text could not be parsed; showing raw text";
}
