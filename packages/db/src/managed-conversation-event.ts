import { createHash } from "node:crypto";

export const managedConversationEventMutationId = (value: string): string => {
  const hex = createHash("sha256")
    .update(`koed:managed-conversation:event:v1\n${value}`, "utf8")
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(
    13,
    16
  )}-${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(
    17,
    20
  )}-${hex.slice(20, 32)}`;
};
