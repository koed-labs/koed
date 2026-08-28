import type { AiClientCapabilityDescriptor } from "@koed/shared";
import type { AiClientReadiness } from "../../types.js";

export type AiClientCapabilitySummary = {
  dotClass: "" | "is-ready" | "is-attention";
  id: string;
  label: string;
};

export const capabilityLabel = (capabilityId: string): string =>
  capabilityId === "automatic_capture"
    ? "Auto-capture"
    : capabilityId === "mcp_recall"
      ? "MCP Recall"
      : capabilityId === "local_synthesis"
        ? "Local Synthesis"
        : "Managed Conversation";

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
      dotClass:
        capability.readiness === "ready"
          ? "is-ready"
          : capability.readiness === "unknown" ||
              capability.support === "unsupported"
            ? ""
            : "is-attention",
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

export const clientMetaLine = (
  readiness: AiClientReadiness | undefined,
  detected: boolean
): string =>
  detected
    ? `${readiness?.version ? `v${readiness.version}` : "Version unknown"} · ${authenticationLabel(readiness?.authentication)}`
    : "Not installed";
