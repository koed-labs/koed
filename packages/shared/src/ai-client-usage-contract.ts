/** Private Personal usage evidence. No source text or provider credential belongs here. */
export type AiClientUsageStatus = "ok" | "near_limit" | "limited" | "unknown";
export type AiClientUsageSource = "codex_app_server" | "claude_agent_sdk";
export type AiClientUsageCompletionOutcome =
  | "checked"
  | "failed"
  | "unsupported";

export interface AiClientUsageReading {
  instanceId: string;
  accountIdentityHash: string;
  source: AiClientUsageSource;
  bucketId: string;
  bucketName: string | null;
  window: string;
  windowDurationMins: number | null;
  usedPercent: number | null;
  status: AiClientUsageStatus;
  resetsAt: string | null;
  planType: string | null;
  /** An allowlisted provider payload, retained only on the Personal backend. */
  details: Record<string, unknown>;
  observedAt: string;
}

export interface AiClientUsageCompletion {
  instanceId: string;
  completionId: string;
  outcome: AiClientUsageCompletionOutcome;
  observedAt: string;
}

export interface AiClientUsageSnapshot extends AiClientUsageReading {
  id: string;
  createdAt: string;
}
