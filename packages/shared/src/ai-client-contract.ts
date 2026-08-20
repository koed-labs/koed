export const aiClientIdentifierPattern =
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/;

export type AiClientDriverId = string;
export type AiClientInstanceId = string;
export type SupportedAiClientDriverId = "codex" | "claude" | "pi";

export const supportedAiClientDriverIds = ["codex", "claude", "pi"] as const;
export const aiClientDriverIdMaxLength = 96;
export const aiClientInstanceIdMaxLength = 128;
export const aiClientDiagnosticCodeMaxLength = 160;
export const aiClientDiagnosticMessageMaxLength = 2000;

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

const aiClientDiagnosticMessages: Record<string, string> = {
  discovery_failed: "AI Client discovery failed.",
  profile_check: "AI Client profile check completed.",
  capability_snapshot_stale: "Capability snapshot is stale.",
  capability_snapshot_unknown: "Capability snapshot is unavailable.",
  model_unavailable: "Configured model is unavailable.",
  profile_readiness_overlay: "Current AI Client profile readiness was used.",
  codex_version_unavailable: "Codex version could not be determined."
};

const sanitizeDiagnosticCode = (value: unknown): string => {
  if (
    typeof value === "string" &&
    Object.hasOwn(aiClientDiagnosticMessages, value)
  ) {
    return value;
  }
  return "diagnostic";
};

export const aiClientModelLabel = (model: {
  id: string;
  displayName?: string | null;
  provider?: string | null;
  model?: string | null;
  fullId?: string | null;
}): string => {
  const fullId =
    model.fullId?.trim() ||
    [model.provider?.trim(), model.model?.trim()].filter(Boolean).join("/") ||
    model.id.trim();
  const displayName = model.displayName?.trim();
  return displayName && displayName !== fullId
    ? `${displayName} (${fullId})`
    : fullId;
};

export const sanitizeAiClientDiagnostics = (
  diagnostics: unknown
): AiClientDiagnostic[] => {
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics
    .flatMap((candidate) => {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      ) {
        return [];
      }
      const item = candidate as Record<string, unknown>;
      const severity =
        item.severity === "info" ||
        item.severity === "warning" ||
        item.severity === "error"
          ? item.severity
          : "warning";
      const code = sanitizeDiagnosticCode(item.code);
      const result: AiClientDiagnostic = {
        code,
        message:
          aiClientDiagnosticMessages[code] ??
          "AI Client diagnostic unavailable.",
        severity
      };
      return [result];
    })
    .slice(0, 100);
};
