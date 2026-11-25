// AI Clients and agent harnesses inject context blocks into user turns
// (Claude Code's <system-reminder>, Paseo's <paseo-system>, Codex's
// <environment_context>). They are not the User's words, so they must never
// become a Conversation title.
const HARNESS_TAGS = [
  "system-reminder",
  "paseo-system",
  "environment_context",
  "user-prompt-submit-hook",
  "local-command-stdout",
  "command-message",
  "command-name",
  "command-args"
] as const;

const tagPattern = HARNESS_TAGS.join("|");
const CLOSED_BLOCK = new RegExp(
  `<(${tagPattern})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`,
  "gi"
);
// Stored titles are length-capped, so a block can be cut before its closing
// tag. Everything from an unclosed opening tag onward is harness text.
const UNCLOSED_BLOCK = new RegExp(`<(?:${tagPattern})\\b[\\s\\S]*$`, "i");

// Removes harness blocks but keeps the rest of the text, line breaks
// included, for parsers that still need its structure.
export const stripHarnessBlocks = (text: string): string =>
  text.replace(CLOSED_BLOCK, " ").replace(UNCLOSED_BLOCK, " ").trim();

export const stripHarnessMarkup = (text: string): string =>
  stripHarnessBlocks(text).replace(/\s+/g, " ").trim();

// Returns a displayable Conversation title, or null when the stored title is
// empty or only harness text.
export const displayConversationTitle = (
  title: string | null | undefined
): string | null => {
  if (!title) {
    return null;
  }
  return stripHarnessMarkup(title) || null;
};
