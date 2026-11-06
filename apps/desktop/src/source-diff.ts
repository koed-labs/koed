import { parsePatchFiles, type ParsedPatch } from "@pierre/diffs";

export type SourcePatchFileSummary = {
  name: string;
  displayName: string;
  changeType: string;
  additions: number;
  deletions: number;
};

export type SourcePatchDetails = {
  sourceText: string;
  normalizedText: string;
  files: SourcePatchFileSummary[];
  fileDiffs: ParsedPatch["files"];
  additions: number;
  deletions: number;
  patchMetadata?: string;
  parseError?: string;
  supported: boolean;
  summary: string;
};

const PATCH_HINTS = [
  /^\*\*\* Begin Patch/mu,
  /^\*\*\* Update File:/mu,
  /^\*\*\* Add File:/mu,
  /^\*\*\* Delete File:/mu,
  /^diff --git /mu,
  /^@@ /mu,
  /^--- (?:a\/|\/dev\/null)/mu,
  /^\+\+\+ (?:b\/|\/dev\/null)/mu
];

const APPLY_PATCH_FILE_MARKER = /^\*\*\* (Update|Add|Delete) File:\s*(.+)$/u;

const looksLikePatchText = (text: string): boolean => {
  const trimmed = text.trim();
  return Boolean(trimmed && PATCH_HINTS.some((hint) => hint.test(trimmed)));
};

const splitApplyPatchBlocks = (
  sourceText: string
): Array<{
  kind: "update" | "add" | "delete";
  name: string;
  body: string[];
}> | null => {
  const lines = sourceText.replace(/\r\n/gu, "\n").split("\n");
  const startIndex = lines.findIndex(
    (line) => line.trim() === "*** Begin Patch"
  );
  if (startIndex === -1) return null;

  const blocks: Array<{
    kind: "update" | "add" | "delete";
    name: string;
    body: string[];
  }> = [];
  let current: (typeof blocks)[number] | null = null;

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "*** End Patch") break;
    const markerMatch = APPLY_PATCH_FILE_MARKER.exec(line);
    if (markerMatch) {
      if (current) blocks.push(current);
      const marker = markerMatch[1];
      const name = markerMatch[2];
      current =
        marker && name
          ? {
              kind: marker.toLocaleLowerCase() as "update" | "add" | "delete",
              name: name.trim(),
              body: []
            }
          : null;
      continue;
    }
    current?.body.push(line);
  }
  if (current) blocks.push(current);
  return blocks;
};

const convertApplyPatchToUnifiedDiff = (sourceText: string): string | null => {
  const blocks = splitApplyPatchBlocks(sourceText);
  if (!blocks?.length) return null;

  const normalizedBlocks = blocks.flatMap((block) => {
    const patchPath = block.name.replace(/\\/gu, "/").replace(/^\/+/, "");
    const header = [
      `diff --git a/${patchPath} b/${patchPath}`,
      block.kind === "add" ? "--- /dev/null" : `--- a/${patchPath}`,
      block.kind === "delete" ? "+++ /dev/null" : `+++ b/${patchPath}`
    ];
    const hunks: string[] = [];
    let currentHunk: string[] = [];
    const flushHunk = () => {
      if (!currentHunk.length) return;
      const formattedLines = currentHunk.map((line) =>
        line.startsWith("+") ||
        line.startsWith("-") ||
        line.startsWith(" ") ||
        line.startsWith("\\ No newline at end of file")
          ? line
          : ` ${line}`
      );
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
        `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${formattedLines.join("\n")}`
      );
      currentHunk = [];
    };
    for (const line of block.body) {
      if (line.trim().startsWith("@@")) {
        flushHunk();
      } else {
        currentHunk.push(line);
      }
    }
    flushHunk();
    return hunks.length ? [`${header.join("\n")}\n${hunks.join("\n")}\n`] : [];
  });
  return normalizedBlocks.length ? normalizedBlocks.join("\n") : null;
};

const normalizePatchText = (
  sourceText: string
): {
  normalizedText: string | null;
  parseMode: "apply_patch" | "unified" | "unknown";
} => {
  const trimmed = sourceText.trim();
  if (!trimmed) return { normalizedText: null, parseMode: "unknown" };
  if (trimmed.startsWith("*** Begin Patch")) {
    const converted = convertApplyPatchToUnifiedDiff(trimmed);
    return {
      normalizedText: converted,
      parseMode: converted ? "apply_patch" : "unknown"
    };
  }
  return looksLikePatchText(trimmed)
    ? { normalizedText: trimmed, parseMode: "unified" }
    : { normalizedText: null, parseMode: "unknown" };
};

const countFileChanges = (
  file: ParsedPatch["files"][number]
): { additions: number; deletions: number } => {
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
};

const displayName = (name: string): string =>
  name.replace(/\\/gu, "/").split("/").filter(Boolean).at(-1) ?? name;

const summarizeFiles = (files: SourcePatchFileSummary[]): string => {
  if (!files.length) return "Patch ready to render";
  const previews = files.slice(0, 3).map((file) => {
    const counts = [
      file.additions ? `+${file.additions}` : null,
      file.deletions ? `-${file.deletions}` : null
    ]
      .filter(Boolean)
      .join("/");
    return `${file.displayName}${counts ? ` (${counts})` : ""}`;
  });
  const remainder = files.length > 3 ? ` +${files.length - 3} more` : "";
  return `${files.length} ${files.length === 1 ? "file" : "files"} changed: ${previews.join(", ")}${remainder}`;
};

export const parseSourcePatch = (
  sourceText: string
): SourcePatchDetails | null => {
  const { normalizedText, parseMode } = normalizePatchText(sourceText);
  if (!normalizedText) {
    return looksLikePatchText(sourceText)
      ? {
          sourceText,
          normalizedText: sourceText,
          files: [],
          fileDiffs: [],
          additions: 0,
          deletions: 0,
          parseError: "Patch text could not be normalized",
          supported: false,
          summary: "Patch text could not be parsed; showing raw text"
        }
      : null;
  }
  try {
    const parsedPatches = parsePatchFiles(normalizedText);
    const fileDiffs = parsedPatches.flatMap((patch) => patch.files);
    const files = fileDiffs.map((file) => {
      const counts = countFileChanges(file);
      return {
        name: file.name,
        displayName: displayName(file.name),
        changeType: file.type,
        ...counts
      };
    });
    const patchMetadata = parsedPatches
      .map((patch) => patch.patchMetadata?.trim() ?? "")
      .filter(Boolean)
      .join("\n");
    return {
      sourceText,
      normalizedText,
      files,
      fileDiffs,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      ...(patchMetadata ? { patchMetadata } : {}),
      supported:
        files.length > 0 ||
        parseMode === "apply_patch" ||
        parseMode === "unified",
      summary: summarizeFiles(files)
    };
  } catch (error) {
    return {
      sourceText,
      normalizedText: sourceText,
      files: [],
      fileDiffs: [],
      additions: 0,
      deletions: 0,
      parseError: error instanceof Error ? error.message : String(error),
      supported: false,
      summary: "Patch text could not be parsed; showing raw text"
    };
  }
};
