"use client";

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { LocalAiClientReadModel } from "../../../../desktop/src/ipc/local-ai-client-protocol.js";
import { loadHostedLaunchOptions } from "@/lib/hosted-managed-chats";
import {
  useStudioDesktopAvailability,
  useStudioSettingsComputer
} from "./StudioSettingsComputerContext";

type ProviderRow = {
  id: string;
  provider: string;
  client: string;
  status: string;
  driverId?: "codex" | "claude" | "pi";
  instanceId?: string;
  enabled?: boolean;
  computer?: string | null;
};

type ProviderAction = "setup" | "repair" | "check";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(...values: unknown[]): string | null {
  return (
    values.find(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0
    ) ?? null
  );
}

function providerActionMessage(result: unknown, driverId: string): string {
  const operation = record(result);
  const status = record(operation?.status);
  const operationReadiness = record(operation?.readiness);
  const readinessMap =
    record(status?.aiClientInstances) ?? record(status?.aiClients);
  const readiness =
    operationReadiness?.driverId === driverId
      ? operationReadiness
      : record(readinessMap?.[driverId]);
  const profile = record(readiness?.profile);
  const directStatus = record(
    driverId === "claude" ? status?.claudeCode : status?.[driverId]
  );
  const diagnosis = nonEmptyString(
    operation?.message,
    operation?.error,
    profile?.message,
    directStatus?.message
  );
  const nextStep = nonEmptyString(
    operation?.action,
    profile?.action,
    directStatus?.action
  );
  if (diagnosis && nextStep && diagnosis !== nextStep)
    return `${diagnosis} Next step: ${nextStep}`;
  return (
    diagnosis ?? nextStep ?? "No additional diagnostic details were returned."
  );
}

function claudeAuthenticationIsRequired(result: unknown): boolean {
  const operation = record(result);
  const status = record(operation?.status);
  const operationReadiness = record(operation?.readiness);
  const readinessMap =
    record(status?.aiClientInstances) ?? record(status?.aiClients);
  const readiness =
    operationReadiness?.driverId === "claude"
      ? operationReadiness
      : record(readinessMap?.claude);
  const profile = record(readiness?.profile);
  const details = record(profile?.details);
  return (
    readiness?.authentication === "unauthenticated" ||
    details?.authenticated === false ||
    details?.authenticationState === "unauthenticated"
  );
}

const providerNames: Record<string, string> = {
  codex: "OpenAI",
  claude: "Anthropic",
  pi: "Pi"
};
const clientNames: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  pi: "Pi"
};

function localProviders(model: LocalAiClientReadModel): ProviderRow[] {
  return model.instances.map((instance) => {
    const snapshot = model.capabilitySnapshots
      .filter((item) =>
        instance.hostedInstanceId
          ? item.hostedInstanceId === instance.hostedInstanceId
          : item.instanceId === instance.instanceId
      )
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
    const status = !instance.enabled
      ? "Disabled"
      : !snapshot
        ? "Configured · status not checked"
        : snapshot.stale || Date.parse(snapshot.expiresAt) <= Date.now()
          ? "Configured · status out of date"
          : snapshot.authenticationState === "unauthenticated"
            ? "Sign-in required"
            : snapshot.healthState !== "healthy"
              ? "Needs attention"
              : snapshot.authenticationState === "authenticated"
                ? "Ready"
                : "Configured · sign-in not verified";
    return {
      id:
        instance.hostedInstanceId ??
        `${instance.driverId}:${instance.instanceId}`,
      provider: providerNames[instance.driverId] ?? instance.driverId,
      client: instance.displayName || clientNames[instance.driverId],
      status,
      driverId: instance.driverId,
      instanceId: instance.hostedInstanceId ?? instance.instanceId,
      enabled: instance.enabled,
      computer: instance.sourceDeviceLabel
    };
  });
}

export function StudioAiClientSettings() {
  const desktop = useStudioDesktopAvailability();
  return (
    <section
      className="mt-8 border-b border-border pb-8"
      aria-labelledby="ai-clients-heading"
    >
      <h2
        id="ai-clients-heading"
        className="text-sm font-medium text-foreground-secondary"
      >
        AI providers
      </h2>
      <p className="mt-1 text-xs leading-5 text-muted">
        Configured AI providers. Choose models in your Agent or chat controls.
      </p>
      {desktop === null ? (
        <p className="mt-4 text-xs text-muted">Checking Desktop connection…</p>
      ) : desktop ? (
        <LocalProviders />
      ) : (
        <RemoteProviders />
      )}
    </section>
  );
}

function LocalProviders() {
  const [providers, setProviders] = useState<ProviderRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [configuring, setConfiguring] = useState<ProviderRow | null>(null);
  const [claudeExecutablePath, setClaudeExecutablePath] = useState("");
  const [busyAction, setBusyAction] = useState<{
    driverId: string;
    action: ProviderAction;
  } | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{
    providerId: string;
    message: string;
  } | null>(null);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const clients = window.koedDesktop?.localAiClients;
      if (!clients)
        throw new Error("Desktop AI provider settings are unavailable.");
      // Page entry only reads the saved catalog. Probing requires an explicit action.
      const response = await clients.list();
      if (!signal?.aborted) setProviders(localProviders(response.readModel));
    } catch (cause) {
      if (!signal?.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "AI providers could not be loaded."
        );
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => refresh(controller.signal));
    return () => controller.abort();
  }, [refresh]);

  async function runAction(
    driverId: "codex" | "claude" | "pi",
    action: ProviderAction
  ) {
    const bridge = window.koedDesktop;
    if (!bridge?.localAiClients) return;
    const provider = providers?.find((item) => item.driverId === driverId);
    const providerId = provider?.id ?? `${driverId}:${driverId}.default`;
    setLoading(true);
    setError(null);
    setNotice(null);
    setActionFeedback(null);
    setBusyAction({ driverId, action });
    try {
      const result = await bridge.invoke<unknown>(
        `${action}_${driverId}`,
        action === "check"
          ? undefined
          : {
              operatorConsented: true,
              ...(driverId === "claude" &&
              action === "repair" &&
              claudeExecutablePath.trim()
                ? { executablePath: claudeExecutablePath.trim() }
                : {})
            }
      );
      let checkResult: unknown = null;
      if (driverId === "claude" && action === "repair") {
        setBusyAction({ driverId, action: "check" });
        checkResult = await bridge.invoke<unknown>("check_claude");
      }
      const response = await bridge.localAiClients.list();
      setProviders(localProviders(response.readModel));
      const outcome = record(result);
      const ok = outcome?.ok === true;
      const actionSummary = providerActionMessage(result, driverId);
      const summary =
        actionSummary === "No additional diagnostic details were returned."
          ? action === "check"
            ? "Provider status checked."
            : action === "repair"
              ? "Provider integration repaired."
              : "Provider integration configured."
          : actionSummary;
      if (driverId === "claude" && action === "repair") {
        const checkOutcome = record(checkResult);
        const checkSummary = providerActionMessage(checkResult, driverId);
        const authGuidance = claudeAuthenticationIsRequired(checkResult)
          ? " Run claude auth login in Terminal where Claude Code is available to sign in."
          : "";
        setActionFeedback({
          providerId,
          message: `Claude Code repair ${ok ? "finished" : "needs attention"}: ${summary} Status check ${checkOutcome?.ok === true ? "finished" : "needs attention"}: ${checkSummary}${authGuidance}`
        });
      } else {
        const label = clientNames[driverId] ?? driverId;
        const authGuidance =
          driverId === "claude" && claudeAuthenticationIsRequired(result)
            ? " Run claude auth login in Terminal where Claude Code is available to sign in."
            : "";
        setActionFeedback({
          providerId,
          message: `${label} ${action === "check" ? "status check" : action === "repair" ? "repair" : "setup"} ${ok ? "finished" : "needs attention"}: ${summary}${authGuidance}`
        });
      }
      if (response.refreshError) setError(response.refreshError);
      setAdding(false);
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Provider operation failed.";
      setActionFeedback({
        providerId,
        message: `${clientNames[driverId] ?? driverId} ${action} failed: ${message}`
      });
    } finally {
      setLoading(false);
      setBusyAction(null);
    }
  }

  async function toggle(provider: ProviderRow) {
    const clients = window.koedDesktop?.localAiClients;
    if (!clients || !provider.instanceId) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const response = await clients.setEnabled(
        provider.instanceId,
        !provider.enabled
      );
      setProviders(localProviders(response.readModel));
      setNotice(
        provider.enabled
          ? "Provider disabled for future use. Running work can finish; installation, sign-in, and history are kept."
          : "Provider enabled. Check status before starting new work."
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Provider availability could not be changed."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <ProviderList
        providers={providers}
        loading={loading}
        error={error}
        refresh={() => void refresh()}
        actions={(provider) => (
          <div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={loading}
                onClick={() => {
                  setActionFeedback(null);
                  setConfiguring(provider);
                }}
                className="rounded-md border border-border px-3 py-2 text-xs disabled:opacity-50"
              >
                Configure
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() =>
                  provider.driverId &&
                  void runAction(provider.driverId, "check")
                }
                className="rounded-md border border-border px-3 py-2 text-xs disabled:opacity-50"
              >
                {busyAction?.driverId === provider.driverId &&
                busyAction?.action === "check"
                  ? `Checking ${provider.client} status…`
                  : "Check status"}
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() => void toggle(provider)}
                className="rounded-md border border-border px-3 py-2 text-xs disabled:opacity-50"
              >
                {provider.enabled ? "Disable" : "Enable"}
              </button>
            </div>
            {actionFeedback?.providerId === provider.id ? (
              <p role="status" className="mt-2 text-xs leading-5 text-muted">
                {actionFeedback.message}
              </p>
            ) : null}
            {configuring?.id === provider.id ? (
              <div className="mt-3 rounded-md border border-border bg-surface/50 p-4">
                <h3 className="text-sm font-medium">
                  Configure {provider.provider}
                </h3>
                <p className="mt-2 text-xs leading-5 text-muted">
                  Repair updates Koed’s integration in the installed AI Client.
                  It does not change the AI Client account or credentials.
                </p>
                {provider.driverId === "claude" ? (
                  <div className="mt-3 space-y-2 text-xs leading-5 text-muted">
                    <label className="block">
                      Claude Code executable path (optional)
                      <input
                        type="text"
                        value={claudeExecutablePath}
                        onChange={(event) =>
                          setClaudeExecutablePath(event.currentTarget.value)
                        }
                        placeholder="Auto-detect Claude Code"
                        autoComplete="off"
                        spellCheck={false}
                        className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground"
                      />
                    </label>
                    <p>
                      Leave empty to detect automatically. Choose Claude Code,
                      not the Claude Desktop application. Claude Code is
                      installed separately or bundled as a CLI by Claude
                      Desktop; its GUI application executable is not the CLI.
                    </p>
                    <p>
                      1. Repair the Koed integration, then Studio checks Claude
                      Code status automatically.
                    </p>
                    <p>
                      2. If the check says sign-in is required, run{" "}
                      <code>claude auth login</code> in Terminal where Claude
                      Code is available. If it is installed only through Claude
                      Desktop, use Claude Desktop’s Code sign-in or the full
                      Claude Code executable path.
                    </p>
                    <p>
                      Claude Desktop sign-in does not authenticate Claude Code.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="rounded bg-background px-2 py-1">
                        claude auth login
                      </code>
                      <button
                        type="button"
                        disabled={loading}
                        onClick={async () => {
                          try {
                            const clipboard = window.koedDesktop?.clipboard;
                            if (!clipboard)
                              throw new Error("Clipboard unavailable.");
                            await clipboard.writeText("claude auth login");
                            setActionFeedback({
                              providerId: provider.id,
                              message: "Copied claude auth login."
                            });
                          } catch {
                            setActionFeedback({
                              providerId: provider.id,
                              message:
                                "Could not copy the command. Select it and copy it manually."
                            });
                          }
                        }}
                        className="rounded-md border border-border px-3 py-2 text-xs disabled:opacity-50"
                      >
                        Copy command
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() =>
                      provider.driverId &&
                      void runAction(provider.driverId, "repair")
                    }
                    className="rounded-md border border-border px-3 py-2 text-xs disabled:opacity-50"
                  >
                    {busyAction?.driverId === provider.driverId &&
                    busyAction?.action === "repair"
                      ? `Repairing ${provider.client} integration…`
                      : provider.driverId === "claude"
                        ? "Repair and check status"
                        : "Repair Koed integration"}
                  </button>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => setConfiguring(null)}
                    className="px-3 py-2 text-xs text-muted disabled:opacity-50"
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      />
      {notice ? (
        <p role="status" className="mt-3 text-xs leading-5 text-muted">
          {notice}
        </p>
      ) : null}
      <p className="mt-3 text-xs leading-5 text-subtle">
        Koed reuses existing local AI Client installations and sign-in. Ready
        means the last check succeeded.
      </p>
      <button
        type="button"
        disabled={loading}
        onClick={() => {
          setAdding(!adding);
          setConfiguring(null);
        }}
        className="mt-3 rounded-md border border-border px-3 py-2 text-xs disabled:opacity-50"
      >
        Add AI provider
      </button>
      {adding ? (
        <div className="mt-3 rounded-md border border-border bg-surface/50 p-4">
          <h3 className="text-sm font-medium">Connect an AI provider</h3>
          <p className="mt-2 text-xs leading-5 text-muted">
            Use an installed AI Client on this Mac. Connecting or repairing
            updates its Koed integration. To configure another computer, open
            Studio Desktop there. Account sign-in and subscription settings
            remain in that AI Client.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(Object.keys(providerNames) as ("codex" | "claude" | "pi")[])
              .filter(
                (id) => !providers?.some((provider) => provider.driverId === id)
              )
              .map((id) => (
                <button
                  key={id}
                  type="button"
                  disabled={loading}
                  onClick={() => void runAction(id, "setup")}
                  className="rounded-md border border-border px-3 py-2 text-xs disabled:opacity-50"
                >
                  Connect {providerNames[id]} · {clientNames[id]}
                </button>
              ))}
            {adding &&
            Object.keys(providerNames).every((id) =>
              providers?.some((provider) => provider.driverId === id)
            ) ? (
              <p className="text-xs text-muted">
                All supported providers are configured. Use Configure or Enable
                on an existing provider.
              </p>
            ) : null}
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                setAdding(false);
                setConfiguring(null);
              }}
              className="px-3 py-2 text-xs text-muted disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function RemoteProviders() {
  const [catalog, setCatalog] = useState<Awaited<
    ReturnType<typeof loadHostedLaunchOptions>
  > | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { selectedDeviceId, setSelectedDeviceId } = useStudioSettingsComputer();
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const next = await loadHostedLaunchOptions(signal);
        if (signal?.aborted) return;
        setCatalog(next);
        setSelectedDeviceId((current) =>
          next.runners.some((runner) => runner.deviceId === current)
            ? current
            : (next.runners[0]?.deviceId ?? "")
        );
      } catch (cause) {
        if (!signal?.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "AI providers could not be loaded."
          );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [setSelectedDeviceId]
  );
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => refresh(controller.signal));
    return () => controller.abort();
  }, [refresh]);
  const providers =
    catalog?.instances
      .filter((instance) => instance.runnerDeviceId === selectedDeviceId)
      .map((instance) => ({
        id:
          instance.hostedInstanceId ??
          `${instance.driverId}:${instance.instanceId}`,
        provider: providerNames[instance.driverId] ?? instance.driverId,
        client: clientNames[instance.driverId] ?? instance.driverId,
        status: instance.ready
          ? "Ready"
          : instance.readiness === "authentication_required"
            ? "Sign-in required"
            : instance.readiness === "stale"
              ? "Configured · status out of date"
              : instance.readiness === "disabled"
                ? "Disabled"
                : "Needs attention"
      })) ?? null;
  return (
    <>
      {catalog && catalog.runners.length > 0 ? (
        <label className="mt-4 block max-w-sm text-xs text-muted">
          Computer
          <select
            aria-label="Execution computer"
            value={selectedDeviceId}
            onChange={(event) => setSelectedDeviceId(event.currentTarget.value)}
            className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
          >
            {catalog.runners.map((runner) => (
              <option key={runner.deviceId} value={runner.deviceId}>
                {runner.displayName}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <ProviderList
        providers={providers}
        loading={loading}
        error={error}
        refresh={() => void refresh()}
      />
      <p className="mt-2 text-xs text-subtle">
        Connect or repair providers in Studio Desktop on the selected computer.
      </p>
    </>
  );
}

function ProviderList({
  providers,
  loading,
  error,
  refresh,
  actions
}: {
  providers: ProviderRow[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  actions?: (provider: ProviderRow) => React.ReactNode;
}) {
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-subtle">Last reported provider status.</p>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          aria-label="Refresh AI providers"
          className="inline-flex min-h-9 items-center gap-2 rounded-md border border-border px-3 text-xs text-foreground-secondary hover:border-border-strong disabled:opacity-50"
        >
          <RefreshCw
            aria-hidden="true"
            className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
      </div>
      {loading && providers === null ? (
        <p className="mt-3 text-xs text-muted">Loading configured providers…</p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-xs text-warning">
          {error}
        </p>
      ) : null}
      {providers?.length ? (
        <ul
          aria-label="Configured AI providers"
          className="mt-3 divide-y divide-border rounded-md border border-border"
        >
          {providers.map((provider) => (
            <li
              key={provider.id}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
            >
              <div>
                <strong className="text-sm font-medium">
                  {provider.provider}
                </strong>
                <span className="ml-2 text-xs text-muted">
                  {provider.client}
                </span>
                {provider.computer ? (
                  <span className="ml-2 text-xs text-subtle">
                    {provider.computer}
                  </span>
                ) : null}
              </div>
              <span className="text-xs text-muted">{provider.status}</span>
              {actions ? (
                <div className="w-full pt-1">{actions(provider)}</div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : providers !== null && !loading ? (
        <p className="mt-3 text-xs text-muted">
          No AI providers are configured for this computer.
        </p>
      ) : null}
    </div>
  );
}
