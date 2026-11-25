import type { KoedServerStatus } from "../../types.js";
import type { LocalAiClientReadModel } from "../../ipc/local-ai-client-protocol.js";
import { memoryModelFlowKeys } from "@koed-labs/shared/ai-client-flow-defaults";
import {
  modelMatches,
  snapshotFor
} from "../views/preferences/local-ai-client-settings-helpers.js";
import { clients, type ClientId } from "./onboarding/model.js";

// One reading of an AI Client's health, shared by Settings and Home so they
// never disagree. It combines the client's integration check
// (status.codex/claudeCode/pi) with its automatic_capture readiness.
export type AiClientHealth = {
  installed: boolean;
  configured: boolean;
  needsAttention: boolean;
  repairable: boolean;
  connected: boolean;
  unknown: boolean;
  signedOut: boolean;
  captureReady: boolean;
  mcpInstalled: boolean;
  description: string;
  version: string | null;
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
  const capture = status.aiClients?.[id]?.capabilities?.find(
    ({ id: capability }) => capability === "automatic_capture"
  );
  if (!capture || capture.support === "unsupported") return null;
  // Unknown or stale readiness is uncertainty, not a fault.
  if (
    capture.readiness === "ready" ||
    capture.readiness === "unknown" ||
    capture.readiness === "stale" ||
    capture.readiness === "unauthenticated"
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
  const details = integration?.details;
  const signedOut =
    details?.authenticated === false ||
    details?.authenticationState === "unauthenticated" ||
    (readiness?.snapshotState !== "stale" &&
      readiness?.authentication === "unauthenticated");
  const capture = status && configured ? captureProblem(id, status) : null;
  const profileReady =
    integration?.state === "healthy" ||
    (details?.captureConfigured === true && details?.mcpConfigured === true) ||
    (id === "pi" && details?.packageRegistered === true);
  const detectionUnknown =
    !installed &&
    (readiness?.snapshotState === "stale" ||
      readiness?.snapshotState === "unknown");
  const unknown =
    !status ||
    details?.inspectionState === "unknown" ||
    integration?.state === "starting";
  const partialProfile =
    id === "claude" &&
    ((details?.mcpConfigured === true &&
      details?.captureConfigured === false) ||
      (details?.mcpConfigured === false &&
        details?.captureConfigured === true));
  const repairable =
    !unknown &&
    !profileReady &&
    (integration?.state === "needs_attention" ||
      ((configured || partialProfile) &&
        integration?.state === "not_configured"));
  const needsAttention = repairable || capture !== null;
  const connected =
    configured && !needsAttention && profileReady && !detectionUnknown;
  return {
    installed,
    configured,
    needsAttention,
    repairable,
    connected,
    unknown: unknown || (configured && !connected && !needsAttention),
    signedOut,
    captureReady:
      !capture && (details?.captureConfigured === true || profileReady),
    mcpInstalled: details?.mcpConfigured === true || profileReady,
    description:
      capture ??
      (needsAttention ? (integration?.message ?? "Needs attention") : ""),
    version: readiness?.version ?? null
  };
}

const freshCapability = (read: LocalAiClientReadModel, instanceId: string) => {
  const snapshot = snapshotFor(read, instanceId);
  return snapshot &&
    !snapshot.stale &&
    Date.parse(snapshot.expiresAt) > Date.now()
    ? snapshot
    : undefined;
};

const signedOutReason = (provider: ClientId, label: string) =>
  provider === "claude"
    ? "Sign in with `claude auth login`, then check again."
    : `Sign in to ${label}, then check again.`;

export function clientSignedOut(
  provider: ClientId,
  read: LocalAiClientReadModel | null,
  status: KoedServerStatus | null,
  instanceId?: string
) {
  const profile = status?.aiClients?.[provider];
  const integration = clientIntegrationStatus(provider, status);
  const sameProfile = !instanceId || instanceId === profile?.instanceId;
  if (sameProfile && aiClientHealth(provider, status).signedOut) return true;
  if (
    sameProfile &&
    (integration?.details?.authenticated === true ||
      integration?.details?.authenticationState === "unknown")
  )
    return false;
  const target =
    instanceId ??
    profile?.instanceId ??
    read?.instances.find((item) => item.driverId === provider)?.instanceId;
  return !!(
    read &&
    target &&
    read.instances.some(
      (item) => item.instanceId === target && item.driverId === provider
    ) &&
    freshCapability(read, target)?.authenticationState === "unauthenticated"
  );
}

export function clientModelLimitation(
  provider: ClientId,
  read: LocalAiClientReadModel | null,
  status: KoedServerStatus | null,
  instanceId?: string
): string | null {
  const label = clients.find((client) => client.id === provider)!.label;
  const profile = status?.aiClients?.[provider];
  if (clientSignedOut(provider, read, status, instanceId))
    return signedOutReason(provider, label);
  const target =
    instanceId ??
    profile?.instanceId ??
    read?.instances.find((instance) => instance.driverId === provider)
      ?.instanceId;
  if (!read || !target) return null;
  const instance = read.instances.find(
    (item) => item.instanceId === target && item.driverId === provider
  );
  if (!instance) return null;
  if (!instance.enabled)
    return `${label} is disabled. Choose another AI Client.`;
  const snapshot = freshCapability(read, target);
  if (!snapshot) return null;
  if (
    snapshot.localSynthesis?.support === "unsupported" ||
    snapshot.healthState === "incompatible"
  )
    return `${label} doesn’t support this Memory Model setup. Choose another AI Client.`;
  if (snapshot.localSynthesis?.readiness === "not_ready")
    return `Local Synthesis isn’t ready in ${label}. Check again or choose another AI Client.`;
  return null;
}

export function savedMemoryModelProblems(
  read: LocalAiClientReadModel | null,
  status: KoedServerStatus | null
) {
  if (!read) return [];
  return read.settings.flatMap((setting) => {
    if (!memoryModelFlowKeys.some((key) => key === setting.flowKey)) return [];
    const { provider, aiClientInstanceId, model, reasoningEffort } = setting;
    const limitation = clientModelLimitation(
      provider,
      read,
      status,
      aiClientInstanceId
    );
    const snapshot = freshCapability(read, aiClientInstanceId);
    const instance = read.instances.find(
      (item) => item.instanceId === aiClientInstanceId
    );
    const catalogReady =
      instance?.driverId === provider &&
      snapshot?.healthState === "healthy" &&
      !snapshot.modelCatalogPartial &&
      snapshot.authenticationState === "authenticated" &&
      snapshot.localSynthesis?.support === "supported" &&
      snapshot.localSynthesis.readiness === "ready";
    const reason =
      limitation ??
      (!instance || instance.driverId !== provider
        ? "The saved AI Client is no longer available. Choose another AI Client."
        : catalogReady &&
            !snapshot.models.some(
              (item) =>
                modelMatches(item, model) &&
                (item.reasoningEfforts.length
                  ? item.reasoningEfforts.includes(reasoningEffort)
                  : reasoningEffort === "none")
            )
          ? "The saved model or reasoning level is no longer offered. Choose a different model or reasoning level."
          : null);
    return reason ? [{ provider, model, reasoningEffort, reason }] : [];
  });
}
