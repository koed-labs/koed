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
  enabled: boolean | null;
  authenticationState: string;
};

export type ClientResourceAvailability =
  | "available"
  | "configured"
  | "needs_sign_in"
  | "disabled"
  | "unavailable"
  | "unknown";

export type ClientResourceExecutionSupport =
  | "koed_managed"
  | "inventory_only"
  | "unknown";

type ClientResourceWithAvailability =
  ClientResourceCatalog["resources"][number] & {
    availability?: ClientResourceAvailability;
    executionSupport?: ClientResourceExecutionSupport;
  };

export const CLIENT_RESOURCE_DISCOVERY_DEADLINE_MS = 60_000;
const CLIENT_RESOURCE_DISCOVERY_POLL_MS = 750;

export class ClientResourceDiscoveryError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "ClientResourceDiscoveryError";
  }
}

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
        enabled: typeof value.enabled === "boolean" ? value.enabled : null,
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
  const requestId = crypto.randomUUID();
  const controller = new AbortController();
  let timedOut = false;
  const cancellationError = () =>
    signal?.reason ?? new DOMException("Request canceled", "AbortError");
  const abortFromCaller = () => controller.abort(cancellationError());
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeCallerAbort = () => {};
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(
        new ClientResourceDiscoveryError(
          "The selected computer did not return its resources before discovery timed out. Reconnect it and retry.",
          "AiClientResourceDiscoveryTimedOut"
        )
      );
    }, CLIENT_RESOURCE_DISCOVERY_DEADLINE_MS);
  });
  const cancellationPromise = new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    const rejectCanceled = () => reject(cancellationError());
    if (signal.aborted) rejectCanceled();
    else {
      signal.addEventListener("abort", rejectCanceled, { once: true });
      removeCallerAbort = () =>
        signal.removeEventListener("abort", rejectCanceled);
    }
  });

  const operation = async (): Promise<ClientResourceCatalog> => {
    const parseOperation = (value: unknown) => {
      try {
        return aiClientResourceDiscoveryOperationSchema.parse(value);
      } catch {
        throw new ClientResourceDiscoveryError(
          "The selected computer returned an invalid resource response. Refresh and try again."
        );
      }
    };
    const assertOperationScope = (value: ReturnType<typeof parseOperation>) => {
      if (
        value.requestId !== requestId ||
        value.hostedInstanceId !== target.hostedInstanceId ||
        value.projectId !== target.projectId
      )
        throw new ClientResourceDiscoveryError(
          "The selected AI Client or Project changed during discovery. Refresh and select it again.",
          "AiClientResourceTargetScopeMismatch"
        );
    };
    const parseCatalog = (value: unknown) => {
      try {
        return aiClientResourceCatalogSchema.parse(value);
      } catch {
        throw new ClientResourceDiscoveryError(
          "The selected computer returned an invalid resource catalog. Refresh and try again."
        );
      }
    };

    try {
      if (signal?.aborted) throw cancellationError();
      let result = parseOperation(
        await studioAuthenticatedRequest(
          base,
          {
            method: "POST",
            body: JSON.stringify({ ...target, requestId })
          },
          controller.signal
        )
      );
      assertOperationScope(result);
      while (result.state === "pending" || result.state === "running") {
        if (signal?.aborted) throw cancellationError();
        await new Promise<void>((resolve, reject) => {
          if (controller.signal.aborted) {
            reject(controller.signal.reason);
            return;
          }
          const aborted = () => {
            clearTimeout(timer);
            reject(controller.signal.reason);
          };
          const timer = setTimeout(() => {
            controller.signal.removeEventListener("abort", aborted);
            resolve();
          }, CLIENT_RESOURCE_DISCOVERY_POLL_MS);
          controller.signal.addEventListener("abort", aborted, { once: true });
        });
        result = parseOperation(
          await studioAuthenticatedRequest(
            `${base}/${encodeURIComponent(result.operationId)}`,
            {},
            controller.signal
          )
        );
        assertOperationScope(result);
      }
      if (signal?.aborted) throw cancellationError();
      if (timedOut)
        throw new ClientResourceDiscoveryError(
          "The selected computer did not return its resources before discovery timed out. Reconnect it and retry.",
          "AiClientResourceDiscoveryTimedOut"
        );
      if (result.state === "failed")
        throw resourceDiscoveryFailure(result.errorCode);
      if (result.state !== "completed" || !result.catalog)
        throw new ClientResourceDiscoveryError(
          "This AI Client could not report its configured Skills and integrations. Reconnect the computer and retry."
        );
      const catalog = parseCatalog(result.catalog);
      if (
        catalog.hostedInstanceId !== target.hostedInstanceId ||
        catalog.projectId !== target.projectId ||
        Date.parse(catalog.expiresAt) <= Date.now()
      )
        throw new ClientResourceDiscoveryError(
          "AI Client configuration changed. Refresh its Skills before continuing.",
          "AiClientResourceTargetScopeMismatch"
        );
      return catalog;
    } catch (cause) {
      if (signal?.aborted) throw cancellationError();
      if (cause instanceof ClientResourceDiscoveryError) throw cause;
      if (timedOut)
        throw new ClientResourceDiscoveryError(
          "The selected computer did not return its resources before discovery timed out. Reconnect it and retry.",
          "AiClientResourceDiscoveryTimedOut"
        );
      throw new ClientResourceDiscoveryError(
        "The selected computer could not be reached. Reconnect it and retry."
      );
    }
  };

  try {
    return await Promise.race([
      operation(),
      timeoutPromise,
      cancellationPromise
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    removeCallerAbort();
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

function resourceDiscoveryFailure(code?: string): ClientResourceDiscoveryError {
  const messages: Record<string, string> = {
    AiClientResourceProjectUnavailable:
      "The selected Project is no longer available on this computer. Choose another Project and retry.",
    AiClientResourceTargetScopeMismatch:
      "The selected AI Client or Project changed during discovery. Refresh and select it again.",
    AiClientConfigurationUnavailable:
      "This AI Client's local configuration could not be read. Check its settings in the original Client, then reconnect this computer.",
    AiClientExecutableUnavailable:
      "The original AI Client executable is unavailable. Restore it in its original installation, then reconnect this computer.",
    AiClientProviderUnsupported:
      "This AI Client does not support native resource discovery.",
    AiClientResourceOwnerInvalid:
      "The AI Client resource request could not be authorized. Refresh this view and try again.",
    AiClientCodexAuthenticationRequired:
      "Sign in through Codex, then refresh the configured resources.",
    AiClientClaudeAuthenticationRequired:
      "Sign in through Claude Code, then refresh the configured resources.",
    AiClientPiAuthenticationRequired:
      "Sign in through Pi, then refresh the configured resources.",
    AiClientCodexVersionUnsupported:
      "Update Codex in its original installation, then reconnect this computer.",
    AiClientClaudeVersionUnsupported:
      "Update Claude Code in its original installation, then reconnect this computer.",
    AiClientPiVersionUnsupported:
      "Update Pi in its original installation, then reconnect this computer.",
    AiClientResourceDiscoveryTimedOut:
      "The selected computer did not return its resources before discovery timed out. Reconnect it and retry.",
    AiClientResourceLeaseLost:
      "The computer disconnected before discovery finished. Reconnect it and retry."
  };
  const message =
    (code && messages[code]) ??
    "The selected computer could not report its configured resources. Reconnect it and retry.";
  return new ClientResourceDiscoveryError(message, code);
}

export function clientResourceAvailability(
  resource: ClientResourceCatalog["resources"][number]
): ClientResourceAvailability {
  const extended = resource as ClientResourceWithAvailability;
  if (extended.availability) return extended.availability;
  switch (resource.status) {
    case "ready":
      return "available";
    case "disabled":
      return "disabled";
    case "unavailable":
      return "unavailable";
  }
}

export function clientResourceAvailabilityLabel(
  availability: ClientResourceAvailability
): string {
  switch (availability) {
    case "available":
      return "Available in Client";
    case "configured":
      return "Installed/configured";
    case "needs_sign_in":
      return "Needs sign-in";
    case "disabled":
      return "Disabled in Client";
    case "unavailable":
      return "Unavailable in Client";
    case "unknown":
      return "Status unknown";
  }
}

export function clientResourceExecutionSupport(
  resource: ClientResourceCatalog["resources"][number]
): ClientResourceExecutionSupport {
  return (
    (resource as ClientResourceWithAvailability).executionSupport ?? "unknown"
  );
}

export function clientResourceExecutionSupportLabel(
  resource: ClientResourceCatalog["resources"][number],
  target?: ClientResourceTarget
): string {
  if (target?.enabled === false) return "Unavailable in Koed: Client disabled";
  if (target?.authenticationState === "unauthenticated")
    return "Needs sign-in through original Client";
  const supportLabel = (() => {
    switch (clientResourceExecutionSupport(resource)) {
      case "koed_managed":
        return "Usable in Koed chat";
      case "inventory_only":
        return "Inventory only · not usable in Koed chat";
      case "unknown":
        return "Use in Koed chat not verified";
    }
  })();
  if (target?.enabled === null)
    return `Client enabled state unknown · ${supportLabel}`;
  return supportLabel;
}

export function clientResourceErrorMessage(cause: unknown): string {
  if (!(cause instanceof Error))
    return "Configured resources could not be loaded.";
  return cause.message;
}

export function clientResourceCanBeSelected(
  resource: ClientResourceCatalog["resources"][number]
): boolean {
  return (
    resource.kind === "skill" &&
    resource.invocation === "native_skill" &&
    clientResourceAvailability(resource) === "available" &&
    clientResourceExecutionSupport(resource) === "koed_managed"
  );
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
