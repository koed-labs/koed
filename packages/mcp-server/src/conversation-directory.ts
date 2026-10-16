import path from "node:path";

export const isConversationDirectory = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  path.isAbsolute(value) &&
  !value.includes("\0");

/** Native request context wins over process context; never guess between roots. */
export const resolveMcpConversationDirectory = (input: {
  conversationCwd?: unknown;
  managedCwd?: string;
  metadata?: Record<string, unknown>;
  clientName?: unknown;
  startupCwd: string;
}): string | undefined => {
  for (const cwd of [input.conversationCwd, input.managedCwd]) {
    if (cwd === undefined) continue;
    if (!isConversationDirectory(cwd))
      throw new Error("Koed requires an absolute Conversation directory.");
    return cwd;
  }
  const turn = input.metadata?.["x-codex-turn-metadata"];
  if (turn && typeof turn === "object" && !Array.isArray(turn)) {
    const workspaces = (turn as Record<string, unknown>).workspaces;
    if (
      workspaces &&
      typeof workspaces === "object" &&
      !Array.isArray(workspaces)
    ) {
      const roots = Object.keys(workspaces);
      if (roots.length === 1 && isConversationDirectory(roots[0]))
        return roots[0];
    }
    return undefined;
  }
  if (typeof input.clientName === "string" && /codex/i.test(input.clientName))
    return undefined;
  // Compatibility for other stdio clients without native per-call context.
  return input.startupCwd;
};
