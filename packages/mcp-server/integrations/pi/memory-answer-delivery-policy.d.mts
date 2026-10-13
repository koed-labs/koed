export type MemoryAnswerDeliveryMode = "auto" | "blocking" | "non_blocking";
export type MemoryAnswerDeliveryRoute =
  | "mcp_result"
  | "codex_stop"
  | "pi_blocking"
  | "pi_follow_up";
export type MemoryAnswerDeliveryFallbackReason =
  | "integration_disabled"
  | "receipt_store_unavailable"
  | "missing_receipt"
  | "unsupported_context"
  | "team_ineligible"
  | "capacity_limit"
  | "deferred_unavailable";
export interface MemoryAnswerDeliveryDecision {
  requestedMode: MemoryAnswerDeliveryMode;
  effectiveRoute: MemoryAnswerDeliveryRoute;
  fallbackReason: MemoryAnswerDeliveryFallbackReason | null;
}
export declare const MEMORY_ANSWER_DELIVERY_MODES: readonly [
  "auto",
  "blocking",
  "non_blocking"
];
export declare function normalizeMemoryAnswerDeliveryMode(
  value: unknown
): MemoryAnswerDeliveryMode;
export declare function splitMemoryAnswerDeliveryInput(
  input: Record<string, unknown>
): {
  requestedMode: MemoryAnswerDeliveryMode;
  executionInput: Record<string, unknown>;
};
export declare function resolveMemoryAnswerDelivery(options: {
  requestedMode: MemoryAnswerDeliveryMode;
  blockingRoute: "mcp_result" | "pi_blocking";
  deferredRoute?: "codex_stop" | "pi_follow_up";
  unavailableReason?: MemoryAnswerDeliveryFallbackReason;
}): MemoryAnswerDeliveryDecision;
