export type TextEdit = { text: string; start: number; end: number };

export type ComposerFormat =
  | "bold"
  | "italic"
  | "strike"
  | "inline-code"
  | "code-block"
  | "quote"
  | "bullet-list"
  | "numbered-list";

function wrap(
  text: string,
  start: number,
  end: number,
  marker: string
): TextEdit {
  const selected = text.slice(start, end);
  const next = `${text.slice(0, start)}${marker}${selected}${marker}${text.slice(end)}`;
  if (!selected) {
    const caret = start + marker.length;
    return { text: next, start: caret, end: caret };
  }
  return { text: next, start: start + marker.length, end: end + marker.length };
}

function codeBlock(text: string, start: number, end: number): TextEdit {
  const before = text.slice(0, start);
  const selected = text.slice(start, end);
  const after = text.slice(end);
  const leading = before && !before.endsWith("\n") ? "\n" : "";
  const trailing = after && !after.startsWith("\n") ? "\n" : "";
  const block = leading + "```\n" + selected + "\n```" + trailing;
  const caret = before.length + leading.length + 4;
  return {
    text: `${before}${block}${after}`,
    start: caret,
    end: caret + selected.length
  };
}

function prefixLines(
  text: string,
  start: number,
  end: number,
  prefixForLine: (index: number) => string
): TextEdit {
  const lineStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const nextNewline = text.indexOf("\n", end);
  const lineEnd = nextNewline < 0 ? text.length : nextNewline;
  const block = text.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  const prefixed = lines
    .map((line, index) => `${prefixForLine(index)}${line}`)
    .join("\n");
  const next = `${text.slice(0, lineStart)}${prefixed}${text.slice(lineEnd)}`;
  const added = prefixed.length - block.length;
  const firstPrefix = prefixForLine(0).length;
  return { text: next, start: start + firstPrefix, end: end + added };
}

export function formatComposerText(
  text: string,
  start: number,
  end: number,
  format: ComposerFormat
): TextEdit {
  switch (format) {
    case "bold":
      return wrap(text, start, end, "**");
    case "italic":
      return wrap(text, start, end, "*");
    case "strike":
      return wrap(text, start, end, "~~");
    case "inline-code":
      return wrap(text, start, end, "`");
    case "code-block":
      return codeBlock(text, start, end);
    case "quote":
      return prefixLines(text, start, end, () => "> ");
    case "bullet-list":
      return prefixLines(text, start, end, () => "- ");
    case "numbered-list":
      return prefixLines(text, start, end, (index) => `${index + 1}. `);
  }
}
