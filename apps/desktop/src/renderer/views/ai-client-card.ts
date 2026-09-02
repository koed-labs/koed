import type { AiClientCapabilityDescriptor } from "@koed/shared";
import type { AiClientReadiness } from "../../types.js";

export type AiClientCapabilitySummary = {
  dotClass: "is-ready" | "is-attention" | "is-unknown" | "is-unsupported";
  id: string;
  label: string;
  statusLabel: string;
};

export const capabilityLabel = (capabilityId: string): string =>
  capabilityId === "automatic_capture"
    ? "Auto-capture"
    : capabilityId === "mcp_recall"
      ? "MCP Recall"
      : capabilityId === "local_synthesis"
        ? "Local Synthesis"
        : "Managed Conversation";

const capabilityStatus = (
  capability: AiClientCapabilityDescriptor
): Pick<AiClientCapabilitySummary, "dotClass" | "statusLabel"> => {
  if (capability.support === "unsupported") {
    return { dotClass: "is-unsupported", statusLabel: "Unsupported" };
  }
  if (capability.readiness === "ready") {
    return { dotClass: "is-ready", statusLabel: "Ready" };
  }
  if (capability.readiness === "unknown") {
    return { dotClass: "is-unknown", statusLabel: "Unknown" };
  }
  const labels = {
    not_ready: "Not ready",
    unauthenticated: "Sign-in required",
    unavailable: "Unavailable",
    stale: "Status stale"
  } as const;
  return {
    dotClass: "is-attention",
    statusLabel: labels[capability.readiness]
  };
};

export const summarizeCapabilities = (
  capabilities: AiClientCapabilityDescriptor[] | undefined
): AiClientCapabilitySummary[] => {
  const seenLabels = new Set<string>();
  return (capabilities ?? [])
    .filter(
      (capability) =>
        capability.readiness !== "unknown" ||
        ["automatic_capture", "mcp_recall", "local_synthesis"].includes(
          capability.id
        )
    )
    .filter((capability) => {
      const label = capabilityLabel(capability.id);
      if (seenLabels.has(label)) return false;
      seenLabels.add(label);
      return true;
    })
    .slice(0, 5)
    .map((capability) => ({
      ...capabilityStatus(capability),
      id: capability.id,
      label: capabilityLabel(capability.id)
    }));
};

export const authenticationLabel = (
  authentication: AiClientReadiness["authentication"] | undefined
): string =>
  authentication === "authenticated"
    ? "Authenticated"
    : authentication === "unauthenticated"
      ? "Unauthenticated"
      : "Auth unknown";

export const clientVersionLabel = (
  version: string | null | undefined
): string => {
  const trimmed = version?.trim();
  if (!trimmed) return "Version unknown";

  const semanticVersion = trimmed.match(
    /\b(?:v)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/
  )?.[1];
  return semanticVersion ? `v${semanticVersion}` : trimmed;
};

export const clientMetaLine = (
  readiness: AiClientReadiness | undefined,
  detected: boolean
): string =>
  detected
    ? `${clientVersionLabel(readiness?.version)} · ${authenticationLabel(readiness?.authentication)}`
    : "Not installed";
