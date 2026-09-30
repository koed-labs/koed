export type TeamAgentSummaryMessage = Readonly<{
  id: string;
  role: "user" | "assistant";
  content: string;
}>;

/** Return only the assistant turn paired with the exact summary prompt message. */
export function teamSummaryReplyForTurn(
  messages: readonly TeamAgentSummaryMessage[],
  userMessageId: string
): string | null {
  const promptIndex = messages.findIndex(
    (message) => message.id === userMessageId && message.role === "user"
  );
  if (promptIndex < 0) return null;
  const tail = messages.slice(promptIndex + 1);
  const nextPromptIndex = tail.findIndex((message) => message.role === "user");
  const response = tail
    .slice(0, nextPromptIndex < 0 ? undefined : nextPromptIndex)
    .filter((message) => message.role === "assistant")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return response || null;
}
