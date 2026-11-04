import type { DesktopThreadGroup } from "../../../project-memory-ui.js";

export function conversationClient(
  source: DesktopThreadGroup["sourceAiClient"]
) {
  if (source === "claude-code")
    return { id: "claude" as const, label: "Claude Code" };
  if (source === "codex" || source === "codex-cli")
    return { id: "codex" as const, label: "Codex" };
  if (source === "pi") return { id: "pi" as const, label: "Pi" };
  return { id: null, label: "AI Client" };
}
export type ConversationClient = ReturnType<typeof conversationClient>;

export function conversationTime(value: string, full = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(
    undefined,
    full
      ? { dateStyle: "medium", timeStyle: "medium" }
      : { hour: "numeric", minute: "2-digit" }
  ).format(date);
}
