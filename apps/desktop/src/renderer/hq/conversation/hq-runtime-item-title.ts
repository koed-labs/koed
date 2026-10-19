import type { ManagedConversationRuntimeItem } from "../../../ipc/managed-conversation-protocol.js";

const label = (value: unknown): string =>
  typeof value === "string" ? value.trim().slice(0, 120) : "";

export function hqRuntimeItemTitle(
  item: ManagedConversationRuntimeItem
): string {
  if (item.itemKind === "user_input") {
    const questions = item.payload?.questions;
    const first = Array.isArray(questions) ? questions[0] : null;
    const question =
      first && typeof first === "object" && !Array.isArray(first)
        ? (first as Record<string, unknown>)
        : null;
    return (
      label(question?.header) ||
      label(question?.question) ||
      "Question from AI Client"
    );
  }
  if (item.itemKind === "file_approval") return "Approve file changes?";
  if (item.itemKind === "permissions_approval") return "Approve permissions?";
  const command = item.payload?.command;
  const commandLabel = Array.isArray(command)
    ? command
        .filter((part): part is string => typeof part === "string")
        .join(" ")
    : label(command);
  return (
    label(commandLabel) || label(item.payload?.toolName) || "Approve command?"
  );
}
