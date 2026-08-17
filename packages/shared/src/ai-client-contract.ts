export const aiClientIdentifierPattern =
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/;

export type AiClientDriverId = string;
export type AiClientInstanceId = string;
export type SupportedAiClientDriverId = "codex" | "claude" | "pi";

export const supportedAiClientDriverIds = ["codex", "claude", "pi"] as const;

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
  provenance: AiClientModelProvenance;
  options?: Record<string, unknown>;
}
