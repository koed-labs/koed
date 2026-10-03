"use client";

import {
  aiClientResourceCatalogSchema,
  aiClientResourceDiscoveryOperationSchema
} from "@koed/shared/ai-client-resource-catalog";
import { studioAuthenticatedRequest } from "./personal-agents-client";

export type ClientResourceCatalog = ReturnType<
  typeof aiClientResourceCatalogSchema.parse
>;
export type ClientResourceTarget = {
  hostedInstanceId: string;
  instanceId: string;
  provider: string;
  name: string;
  computerLabel: string;
  enabled: boolean;
  authenticationState: string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hosted = () =>
  typeof window !== "undefined" &&
  (window.location.pathname === "/studio" ||
    window.location.pathname.startsWith("/studio/"));
const resourceBase = () =>
  hosted() ? "/v1/ai-client-resources" : "/studio-api/ai-client-resources";

export async function loadClientResourceTargets(
  signal?: AbortSignal
): Promise<ClientResourceTarget[]> {
  const result = await studioAuthenticatedRequest(
    hosted()
      ? "/v1/memory/local-agent-settings"
      : `${resourceBase()}/instances`,
    {},
    signal
  );
  if (!record(result) || !Array.isArray(result.instances))
    throw new Error("AI Client configuration is unavailable.");
  const snapshots = Array.isArray(result.capabilitySnapshots)
    ? result.capabilitySnapshots
    : [];
  return result.instances.flatMap((value) => {
    if (
      !record(value) ||
      typeof value.hostedInstanceId !== "string" ||
      typeof value.instanceId !== "string" ||
      typeof value.driverId !== "string"
    )
      return [];
    const snapshot = snapshots.find(
      (item) => record(item) && item.hostedInstanceId === value.hostedInstanceId
    );
    return [
      {
        hostedInstanceId: value.hostedInstanceId,
        instanceId: value.instanceId,
        provider: value.driverId,
        name:
          typeof value.displayName === "string"
            ? value.displayName
            : value.driverId,
        computerLabel:
          typeof value.sourceDeviceLabel === "string" && value.sourceDeviceLabel
            ? value.sourceDeviceLabel
            : "Computer",
        enabled: value.enabled === true,
        authenticationState:
          record(snapshot) && typeof snapshot.authenticationState === "string"
            ? snapshot.authenticationState
            : "unknown"
      }
    ];
  });
}

export async function discoverClientResources(
  target: { hostedInstanceId: string; projectId: string | null },
  signal?: AbortSignal
): Promise<ClientResourceCatalog> {
  const base = `${resourceBase()}/discover`;
  let result = aiClientResourceDiscoveryOperationSchema.parse(
    await studioAuthenticatedRequest(
      base,
      {
        method: "POST",
        body: JSON.stringify({ ...target, requestId: crypto.randomUUID() })
      },
      signal
    )
  );
  const deadline = Date.now() + 45_000;
  while (result.state === "pending" || result.state === "running") {
    if (Date.now() >= deadline)
      throw new Error(
        "This computer has not returned its Skills yet. Try again when it is connected."
      );
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const aborted = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", aborted);
        resolve();
      }, 750);
      signal?.addEventListener("abort", aborted, { once: true });
    });
    result = aiClientResourceDiscoveryOperationSchema.parse(
      await studioAuthenticatedRequest(
        `${base}/${encodeURIComponent(result.operationId)}`,
        {},
        signal
      )
    );
  }
  if (result.state !== "completed" || !("catalog" in result) || !result.catalog)
    throw new Error(
      "This AI Client could not report its configured Skills and integrations."
    );
  const catalog = aiClientResourceCatalogSchema.parse(result.catalog);
  if (
    catalog.hostedInstanceId !== target.hostedInstanceId ||
    catalog.projectId !== target.projectId ||
    Date.parse(catalog.expiresAt) <= Date.now()
  )
    throw new Error(
      "AI Client configuration changed. Refresh its Skills before continuing."
    );
  return catalog;
}

export function clientLabel(provider: string): string {
  return provider === "codex"
    ? "Codex"
    : provider === "claude" || provider === "claude-code"
      ? "Claude"
      : provider === "pi"
        ? "Pi"
        : provider;
}
