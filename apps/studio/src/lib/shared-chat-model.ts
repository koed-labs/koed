export type SharedChatMessage = Readonly<{
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Explicit author identity for human conversations. */
  authoredByViewer?: boolean;
  author?: Readonly<{
    name: string;
    avatar?: { image?: string; spec?: Record<string, unknown> };
  }> | null;
}>;

export type SharedChatMode =
  | Readonly<{ kind: "agent"; controls: "execution" | "limited" }>
  | Readonly<{ kind: "human"; controls: "formatting" }>;

function isViewerAuthored(message: SharedChatMessage): boolean {
  return message.authoredByViewer ?? message.role === "user";
}

export function chatNavigationMessages<T extends SharedChatMessage>(
  messages: readonly T[]
): T[] {
  return messages.filter(isViewerAuthored);
}

export function chatNavigationPreview(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 160);
}

export function isChatNavigationCompact(containerWidth: number): boolean {
  return containerWidth < 600;
}

export function activeChatExchange<T extends SharedChatMessage>(
  messages: readonly T[],
  visibleMessageId: string | null
): string | null {
  if (!visibleMessageId) return null;
  const visibleIndex = messages.findIndex(
    (message) => message.id === visibleMessageId
  );
  if (visibleIndex < 0) return null;
  return (
    messages
      .slice(0, visibleIndex + 1)
      .filter(isViewerAuthored)
      .at(-1)?.id ?? null
  );
}
