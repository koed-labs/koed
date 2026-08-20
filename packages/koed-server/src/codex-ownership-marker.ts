export const CODEX_MARKER_START = "# >>> koed";
export const CODEX_MARKER_END = "# <<< koed";

type CodexOwnershipParse =
  | { kind: "absent" }
  | { kind: "valid"; block: string; start: number; end: number }
  | { kind: "malformed"; reason: string };

const markerLine = (line: string, marker: string): boolean => {
  const withoutTrailingWhitespace = line.replace(/[\t ]+$/, "");
  return withoutTrailingWhitespace.replace(/^[\t ]+/, "") === marker;
};

export const parseCodexOwnershipBlock = (
  content: string
): CodexOwnershipParse => {
  const markers: Array<{
    marker: "start" | "end";
    start: number;
    end: number;
  }> = [];
  let offset = 0;
  for (const line of content.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    const value = line[0];
    if (!value) break;
    const lineContent = value.replace(/(?:\r\n|\n|\r)$/, "");
    if (markerLine(lineContent, CODEX_MARKER_START)) {
      markers.push({
        marker: "start",
        start: offset,
        end: offset + value.length
      });
    } else if (markerLine(lineContent, CODEX_MARKER_END)) {
      markers.push({
        marker: "end",
        start: offset,
        end: offset + value.length
      });
    }
    offset += value.length;
  }

  if (markers.length === 0) return { kind: "absent" };
  const starts = markers.filter(({ marker }) => marker === "start");
  const ends = markers.filter(({ marker }) => marker === "end");
  if (starts.length !== 1 || ends.length !== 1) {
    return {
      kind: "malformed",
      reason: "Codex Koed ownership markers are duplicated or incomplete."
    };
  }
  const start = starts[0]!;
  const end = ends[0]!;
  if (start.start > end.start) {
    return {
      kind: "malformed",
      reason: "Codex Koed ownership end marker appears before start marker."
    };
  }
  return {
    kind: "valid",
    block: content.slice(start.start, end.end),
    start: start.start,
    end: end.end
  };
};

export const hasCodexOwnershipBlock = (content: string): boolean =>
  parseCodexOwnershipBlock(content).kind === "valid";

export const stripCodexOwnershipBlock = (content: string): string => {
  const parsed = parseCodexOwnershipBlock(content);
  if (parsed.kind === "absent") return content;
  if (parsed.kind === "malformed") throw new Error(parsed.reason);
  return content.slice(0, parsed.start) + content.slice(parsed.end);
};
