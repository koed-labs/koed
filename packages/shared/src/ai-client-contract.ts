export const aiClientIdentifierPattern =
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/;

export type AiClientDriverId = string;
export type AiClientInstanceId = string;
export type SupportedAiClientDriverId = "codex" | "claude" | "pi";

export const supportedAiClientDriverIds = ["codex", "claude", "pi"] as const;
export const aiClientDriverIdMaxLength = 96;
export const aiClientInstanceIdMaxLength = 128;

export const aiClientCapabilityIds = {
  setup: "setup",
  check: "check",
  repair: "repair",
  remove: "remove",
  automaticCapture: "automatic_capture",
  mcpRecall: "mcp_recall",
  localSynthesis: "local_synthesis",
  managedConversationStart: "managed_conversation_start",
  managedConversationResume: "managed_conversation_resume",
  managedConversationSend: "managed_conversation_send",
  managedConversationCancel: "managed_conversation_cancel",
  approvals: "approvals",
  streaming: "streaming",
  sessionIdentity: "session_identity",
  handoff: "handoff",
  fork: "fork"
} as const;

export type AiClientCapabilityId =
  (typeof aiClientCapabilityIds)[keyof typeof aiClientCapabilityIds];

export type AiClientCapabilitySupport = "supported" | "unsupported";
export type AiClientCapabilityReadiness =
  | "ready"
  | "not_ready"
  | "unauthenticated"
  | "unavailable"
  | "stale"
  | "unknown";
export type AiClientDiagnosticSeverity = "info" | "warning" | "error";
export type AiClientRecoveryActionId = "setup" | "check" | "repair" | "remove";

export interface AiClientDiagnostic {
  code: string;
  message: string;
  severity: AiClientDiagnosticSeverity;
  details?: Record<string, unknown>;
}

export interface AiClientRecoveryAction {
  id: AiClientRecoveryActionId;
  label: string;
  available: boolean;
}

export interface AiClientCapabilityDescriptor {
  id: AiClientCapabilityId;
  support: AiClientCapabilitySupport;
  readiness: AiClientCapabilityReadiness;
  diagnostics: AiClientDiagnostic[];
  recoveryAction?: AiClientRecoveryAction;
}

export interface AiClientModelIdentity {
  provider: string;
  model: string;
  fullId?: string;
}

export interface AiClientExecutionTarget {
  driverId: AiClientDriverId;
  instanceId: AiClientInstanceId;
  model: AiClientModelIdentity;
  reasoningEffort?: string;
}

export interface AiClientCapabilitySnapshot {
  driverId: AiClientDriverId;
  instanceId: AiClientInstanceId;
  displayName: string;
  clientVersion: string | null;
  authenticationState: "authenticated" | "unauthenticated" | "unknown";
  healthState: "healthy" | "unavailable" | "incompatible" | "error";
  capabilities: AiClientCapabilityDescriptor[];
  models: AiClientModelCapability[];
  diagnostics: AiClientDiagnostic[];
  observedAt: string;
  expiresAt: string;
}

export const assertAiClientDriverId = (value: string): AiClientDriverId => {
  if (!aiClientIdentifierPattern.test(value) || value.length > 96) {
    throw new Error("Invalid AI Client driver identifier");
  }
  return value;
};

export const assertAiClientInstanceId = (value: string): AiClientInstanceId => {
  if (!aiClientIdentifierPattern.test(value) || value.length > 128) {
    throw new Error("Invalid AI Client instance identifier");
  }
  return value;
};

export const isSupportedAiClientDriverId = (
  value: string
): value is SupportedAiClientDriverId =>
  supportedAiClientDriverIds.some((candidate) => candidate === value);

export const defaultAiClientInstanceId = (
  driverId: SupportedAiClientDriverId
): AiClientInstanceId => `${driverId}.default`;

export type AiClientModelProvenance =
  | "reported"
  | "configured"
  | "known-compatible"
  | "last-known-good";

export interface AiClientModelCapability {
  id: string;
  displayName?: string;
  provider?: string;
  model?: string;
  fullId?: string;
  provenance: AiClientModelProvenance;
  supportedReasoningEfforts?: string[];
  options?: Record<string, unknown>;
}
