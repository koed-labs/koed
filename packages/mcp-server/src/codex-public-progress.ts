/** Deliberately allowlisted public summaries. Raw reasoning content is never read. */
export type CodexPublicProgress = {
  threadId: string;
  turnId: string;
  id: string;
  title: string;
  detail?: string;
  delta?: boolean;
};
export function codexPublicProgress(
  method: string,
  value: unknown
): CodexPublicProgress | null {
  if (!value || typeof value !== "object") return null;
  const params = value as Record<string, unknown>;
  if (typeof params.threadId !== "string" || typeof params.turnId !== "string")
    return null;
  if (method === "item/reasoning/summaryTextDelta") {
    if (typeof params.itemId !== "string" || typeof params.delta !== "string")
      return null;
    return {
      threadId: params.threadId,
      turnId: params.turnId,
      id: `${params.itemId}:summary:${typeof params.summaryIndex === "number" ? params.summaryIndex : 0}`,
      title: "Thinking",
      detail: params.delta.slice(0, 2000),
      delta: true
    };
  }
  if (method !== "item/started" && method !== "item/completed") return null;
  const item = params.item as Record<string, unknown> | undefined;
  if (!item || typeof item.id !== "string") return null;
  const completed = method === "item/completed";
  const title =
    item.type === "commandExecution"
      ? completed
        ? "Command finished"
        : "Running a command"
      : item.type === "fileChange"
        ? completed
          ? "File changes prepared"
          : "Updating project files"
        : item.type === "mcpToolCall"
          ? completed
            ? "Tool finished"
            : "Using a tool"
          : item.type === "webSearch"
            ? completed
              ? "Search finished"
              : "Searching for information"
            : null;
  if (!title) return null;
  return {
    threadId: params.threadId,
    turnId: params.turnId,
    id: item.id,
    title
  };
}
