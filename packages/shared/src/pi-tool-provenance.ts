/** Tool identity comes from native Pi fields, never display text or tool arguments. */
export interface PiToolProvenance {
  toolName: string;
  toolCallId: string | null;
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const identifier = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 240
    ? value
    : null;

export const readPiToolProvenance = (input: {
  sourceKind: string;
  sourceEventType: string | null;
  rawJson: unknown;
}): PiToolProvenance | null => {
  if (input.sourceKind !== "pi") return null;
  const raw = record(input.rawJson);
  if (raw.type !== "pi_session_record") return null;
  const source = record(raw.sourceRecord);
  const message = record(source.message);
  const block = record(raw.contentBlock);
  if (input.sourceEventType === "tool_call" && block.type === "toolCall") {
    if (
      raw.sourceRecord !== undefined
        ? source.type !== "message" || message.role !== "assistant"
        : !identifier(raw.sourceRecordReference)
    )
      return null;
    const toolName = identifier(block.name);
    return toolName ? { toolName, toolCallId: identifier(block.id) } : null;
  }
  if (source.type !== "message") return null;
  if (
    input.sourceEventType === "tool_result" &&
    message.role === "toolResult"
  ) {
    const toolName = identifier(message.toolName);
    return toolName
      ? { toolName, toolCallId: identifier(message.toolCallId) }
      : null;
  }
  if (
    input.sourceEventType === "bash_execution" &&
    message.role === "bashExecution"
  ) {
    return { toolName: "bash", toolCallId: null };
  }
  return null;
};

/** A normalized value may be absent, but may not contradict its native record. */
export const resolvePiToolProvenance = (
  input: Parameters<typeof readPiToolProvenance>[0] & {
    toolName: string | null;
    toolCallId: string | null;
  }
): { toolName: string | null; toolCallId: string | null } => {
  const native = readPiToolProvenance(input);
  if (
    native &&
    ((input.toolName !== null && input.toolName !== native.toolName) ||
      (input.toolCallId !== null &&
        native.toolCallId !== null &&
        input.toolCallId !== native.toolCallId))
  )
    throw new Error("Pi tool provenance contradicts its native source record");
  return {
    toolName: input.toolName ?? native?.toolName ?? null,
    toolCallId: input.toolCallId ?? native?.toolCallId ?? null
  };
};
