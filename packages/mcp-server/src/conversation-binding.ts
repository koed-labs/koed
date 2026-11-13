import type { LocalRuntimeConversationBinding } from "./local-runtime-protocol.js";

const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= 4096 &&
  !value.includes("\0");

const nativeBinding = (
  id: unknown,
  source: unknown
): LocalRuntimeConversationBinding | undefined => {
  if (id === undefined && source === undefined) return undefined;
  if (
    !validId(id) ||
    !["codex-cli", "claude-code", "pi"].includes(source as string)
  )
    throw new Error("Koed requires a valid native Conversation ID and source.");
  return {
    externalSessionId: id,
    sourceRuntime: source as "codex-cli" | "claude-code" | "pi"
  };
};

/**
 * Resolve invocation-local context, not authorization. Body-only identity is a
 * client claim: the adapter cannot prove that a native hook produced it.
 * Native metadata and trusted resolvers constrain that claim when available.
 * MCP transport sessions are unrelated to native Conversation identity.
 */
export const resolveMcpConversationBinding = (input: {
  conversationId?: unknown;
  conversationSource?: unknown;
  metadata?: Record<string, unknown>;
  clientName?: unknown;
  trustedConversation?: LocalRuntimeConversationBinding;
}): LocalRuntimeConversationBinding | undefined => {
  const hook = nativeBinding(input.conversationId, input.conversationSource);
  const isCodex =
    (typeof input.clientName === "string" && /codex/i.test(input.clientName)) ||
    input.metadata?.["x-codex-turn-metadata"] !== undefined;
  const native = isCodex
    ? nativeBinding(
        input.metadata?.threadId,
        input.metadata?.threadId === undefined ? undefined : "codex-cli"
      )
    : undefined;
  const trusted = input.trustedConversation;
  if (trusted) {
    if ("sessionId" in trusted) {
      if (
        !validId(trusted.sessionId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          trusted.sessionId
        )
      )
        throw new Error("Koed requires a valid captured Conversation ID.");
    } else nativeBinding(trusted.externalSessionId, trusted.sourceRuntime);
  }
  const candidates = [trusted, native, hook].filter(
    (value): value is LocalRuntimeConversationBinding => value !== undefined
  );
  const selected = candidates[0];
  for (const candidate of candidates.slice(1)) {
    const matches =
      selected &&
      "externalSessionId" in selected &&
      "externalSessionId" in candidate &&
      selected.externalSessionId === candidate.externalSessionId &&
      selected.sourceRuntime === candidate.sourceRuntime;
    // A captured UUID cannot be compared with an unverified native reference.
    if (!matches)
      throw new Error("Koed received conflicting Conversation context.");
  }
  return selected;
};
