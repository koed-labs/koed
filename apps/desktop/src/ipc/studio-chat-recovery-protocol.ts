export const studioChatRecoveryCommandChannel =
  "koed:studio-chat-recovery:command";

export type StudioChatRecoveryRequest =
  | { operation: "read"; ownerId: string; executionId: string }
  | { operation: "write"; ownerId: string; executionId: string; value: string }
  | { operation: "delete"; ownerId: string; executionId: string };

export type StudioChatRecoveryResult =
  | { operation: "read"; value: string | null }
  | { operation: "write" | "delete"; ok: true };

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;

export const parseStudioChatRecoveryRequest = (
  value: unknown
): StudioChatRecoveryRequest => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Studio chat recovery request.");
  }
  const request = value as Record<string, unknown>;
  if (!validId(request.ownerId) || !validId(request.executionId)) {
    throw new Error("Invalid Studio chat recovery identity.");
  }
  if (request.operation === "read" || request.operation === "delete") {
    return {
      operation: request.operation,
      ownerId: request.ownerId,
      executionId: request.executionId
    };
  }
  if (request.operation === "write") {
    if (
      typeof request.value !== "string" ||
      new TextEncoder().encode(request.value).byteLength > 2_000_000
    ) {
      throw new Error("Invalid Studio chat recovery value.");
    }
    return {
      operation: "write",
      ownerId: request.ownerId,
      executionId: request.executionId,
      value: request.value
    };
  }
  throw new Error("Unsupported Studio chat recovery operation.");
};

export const parseStudioChatRecoveryResult = (
  value: unknown
): StudioChatRecoveryResult => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Studio chat recovery response.");
  }
  const result = value as Record<string, unknown>;
  if (
    result.operation === "read" &&
    (result.value === null || typeof result.value === "string")
  ) {
    return { operation: "read", value: result.value as string | null };
  }
  if ((result.operation === "write" || result.operation === "delete") && result.ok === true) {
    return { operation: result.operation, ok: true };
  }
  throw new Error("Invalid Studio chat recovery response.");
};
