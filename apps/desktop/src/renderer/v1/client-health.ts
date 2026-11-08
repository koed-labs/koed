import type { ComponentStatus, KoedServerStatus } from "../../types.js";
import type { ClientId } from "./onboarding/model.js";

// One reading of an AI Client's health, shared by Settings and Home so they
// never disagree. It combines the client's integration check
// (status.codex/claudeCode/pi) with its automatic_capture readiness.
export type AiClientHealth = {
  installed: boolean;
  configured: boolean;
  // A configured client whose integration or automatic capture is unhealthy.
  needsAttention: boolean;
  description: string;
  version: string | null;
  integration: ComponentStatus | undefined;
};

export const clientIntegrationStatus = (
  id: ClientId,
  status: KoedServerStatus | null
) =>
  id === "codex"
    ? status?.codex
    : id === "claude"
      ? status?.claudeCode
      : status?.pi;

const captureProblem = (
  id: ClientId,
  status: KoedServerStatus
): string | null => {
  const capture = status.aiClients?.[id]?.capabilities.find(
    ({ id: capability }) => capability === "automatic_capture"
  );
  if (!capture || capture.support === "unsupported") return null;
  // Unknown or stale readiness is uncertainty, not a fault.
  if (
    capture.readiness === "ready" ||
    capture.readiness === "unknown" ||
    capture.readiness === "stale"
  )
    return null;
  return (
    capture.diagnostics.find(({ severity }) => severity !== "info")?.message ??
    capture.diagnostics[0]?.message ??
    "Automatic capture isn’t ready."
  );
};

export function aiClientHealth(
  id: ClientId,
  status: KoedServerStatus | null
): AiClientHealth {
  const integration = clientIntegrationStatus(id, status);
  const readiness = status?.aiClients?.[id];
  const configured = integration?.configured === true;
  const installed =
    readiness?.installed.state === "healthy" ||
    (id === "claude"
      ? status?.claudeCode?.detected === true
      : id === "pi"
        ? status?.pi?.detected === true
        : false);
  const auth = readiness?.authentication;
  const capture = status && configured ? captureProblem(id, status) : null;
  const description = !status
    ? "Checking…"
    : !installed && !configured
      ? "Not installed"
      : configured && auth === "unauthenticated"
        ? "Sign in required"
        : configured && auth === "unknown"
          ? "Authentication unknown"
          : configured && integration?.state === "healthy"
            ? (capture ?? "Connected")
            : configured
              ? (integration?.message ?? "Needs attention")
              : "Not connected";
  return {
    installed,
    configured,
    needsAttention:
      configured &&
      (auth === "unauthenticated" ||
        integration?.state === "needs_attention" ||
        integration?.state === "not_configured" ||
        capture !== null),
    description,
    version: readiness?.version ?? null,
    integration
  };
}
