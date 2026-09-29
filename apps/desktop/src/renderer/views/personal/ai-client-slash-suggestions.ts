/** Provider-discovered slash command from an AI Client instance. */
export type ManagedConversationSlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  kind: "command" | "skill";
  source: "provider" | "builtin" | "global-file" | "project-file";
  verification?: "verified" | "unverified";
  scope: "global" | "project";
  invocation?:
    | { type: "prompt" }
    | { type: "control_action"; actionId: "codex.compact" };
};

/** Character range covering the full slash command (including the slash). */
export type SlashCommandRange = {
  start: number;
  end: number;
};

/** Active slash command range and query text, derived from text + cursor. */
export type ActiveSlashCommand = {
  query: string;
  range: SlashCommandRange;
};

const SLASH_BOUNDARIES = /[\s\n\t]/;

/**
 * Finds the active slash command range at or before cursorIndex.
 * Slash must be at input start or preceded by whitespace.
 * Query cannot cross whitespace, quote, newline, or another slash.
 * Cursor may be in middle of text.
 *
 * Range covers the slash through cursor position.
 *
 * @returns ActiveSlashCommand when a slash command is active, null otherwise.
 */
export function findActiveSlashCommand({
  text,
  cursorIndex
}: {
  text: string;
  cursorIndex: number;
}): ActiveSlashCommand | null {
  const boundedCursorIndex = Math.min(cursorIndex, text.length);
  if (boundedCursorIndex < 1) return null;

  // Search backwards from cursor to find the last slash within the query region.
  let searchPos = boundedCursorIndex - 1;
  while (searchPos >= 0) {
    const char = text[searchPos]!;
    if (char === "/") break;
    if (char === '"' || char === "'" || char === "`") return null;
    if (SLASH_BOUNDARIES.test(char)) return null;
    searchPos--;
  }

  if (searchPos < 0) return null;

  // Slash must be at start of text or preceded by whitespace.
  if (searchPos > 0) {
    const prev = text[searchPos - 1]!;
    if (!SLASH_BOUNDARIES.test(prev)) return null;
  }

  const slashIndex = searchPos;
  const rangeEnd = boundedCursorIndex;

  // Reject if a quote appears between the slash and cursor.
  for (let i = slashIndex + 1; i < rangeEnd; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") return null;
  }

  // Return range covering the query text only (after the slash).
  return {
    query: text.slice(slashIndex + 1, rangeEnd),
    range: { start: slashIndex + 1, end: rangeEnd }
  };
}

/**
 * Filters commands by query (case-insensitive).
 * Matches against command name and description.
 * Preserves original order for equal matches.
 *
 * @param commands - Provider-discovered commands.
 * @param query - Typed text after the slash.
 * @returns Filtered commands (all when query is empty).
 */
export function filterSlashCommands(
  commands: ManagedConversationSlashCommand[],
  query: string
): ManagedConversationSlashCommand[] {
  if (query.length === 0) return commands;

  const lowerQuery = query.toLowerCase();
  return commands.filter(
    (cmd) =>
      cmd.name.toLowerCase().includes(lowerQuery) ||
      cmd.description.toLowerCase().includes(lowerQuery)
  );
}

/**
 * Replaces the full slash command (slash + query) with the selected command.
 * Catalog names are slash-free; the slash is prepended at insert time.
 * Preserves text after the range.
 * Appends one space only when replacement reaches end of input.
 *
 * @param text - Full input text.
 * @param range - Character range of the full slash command.
 * @param commandName - Selected command name (slash-free from catalog).
 * @returns Updated text with /commandName substituted.
 */
export function applySlashCommandReplacement({
  text,
  range,
  commandName
}: {
  text: string;
  range: SlashCommandRange;
  commandName: string;
}): string {
  // Replace only the query portion; keep surrounding text and the slash.
  // Catalog names are slash-free, so the slash is explicitly re-added.
  // range.start points to the character after the slash, so slice to
  // range.start-1 to exclude the slash, then prepend it with the command.
  const before = text.slice(0, range.start - 1);
  const after = text.slice(range.end);
  const replacement = `${before}/${commandName}`;

  if (range.end >= text.length) {
    return `${replacement} `;
  }

  return `${replacement}${after}`;
}

/**
 * Checks if a keypress should be consumed by the autocomplete menu.
 * Enter is only handled when not composing (IME).
 *
 * @param options - Key event context.
 * @returns True when the key should be consumed by autocomplete.
 */
export function slashCommandKeypressIsHandled({
  key,
  open,
  isComposing,
  disabled = false
}: {
  key: string;
  open: boolean;
  isComposing: boolean;
  disabled?: boolean;
}): boolean {
  if (!open || disabled) return false;
  if (isComposing && key === "Enter") return false;

  const handledKeys = ["ArrowDown", "ArrowUp", "Tab", "Escape", "Enter"];
  return handledKeys.includes(key);
}
