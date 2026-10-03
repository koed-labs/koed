"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { LocalAiClientSettingsSection } from "../../../.desktop-ui/index.js";
import "../../../../desktop/src/renderer/views/preferences/preferences.css";
import { loadHostedLaunchOptions } from "@/lib/hosted-managed-chats";
import { studioAuthenticatedRequest } from "@/lib/personal-agents-client";
import {
  useStudioDesktopAvailability,
  useStudioSettingsComputer
} from "./StudioSettingsComputerContext";

export function StudioAiClientSettings() {
  const desktopAvailability = useStudioDesktopAvailability();

  return (
    <section
      className="mt-8 border-b border-border pb-8"
      aria-labelledby="ai-clients-heading"
    >
      <h2
        id="ai-clients-heading"
        className="text-sm font-medium text-foreground-secondary"
      >
        AI Clients &amp; models
      </h2>
      <p className="mt-1 text-xs leading-5 text-muted">
        Choose the AI Client and model used for Koed Conversations and memory
        services.
      </p>
      {desktopAvailability === null ? (
        <p className="mt-4 text-xs text-muted">Checking Desktop connection…</p>
      ) : desktopAvailability ? (
        <div className="mt-4">
          <LocalAiClientSettingsSection
            localAiClients={window.koedDesktop?.localAiClients}
          />
        </div>
      ) : (
        <RemoteComputerCatalog />
      )}
    </section>
  );
}

function RemoteComputerCatalog() {
  const [catalog, setCatalog] = useState<Awaited<
    ReturnType<typeof loadHostedLaunchOptions>
  > | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown> | null>(
    null
  );
  const { selectedDeviceId, setSelectedDeviceId } = useStudioSettingsComputer();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const [next, nextSettings] = await Promise.all([
          loadHostedLaunchOptions(signal),
          studioAuthenticatedRequest(
            "/v1/memory/local-agent-settings",
            {},
            signal
          )
        ]);
        if (signal?.aborted) return;
        setCatalog(next);
        setSettings(isRecord(nextSettings) ? nextSettings : null);
        setSelectedDeviceId((current) =>
          next.runners.some((runner) => runner.deviceId === current)
            ? current
            : (next.runners[0]?.deviceId ?? "")
        );
      } catch (cause) {
        if (signal?.aborted) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Computer status could not be loaded."
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

  const selected = catalog?.runners.find(
    ({ deviceId }) => deviceId === selectedDeviceId
  );
  const instances =
    catalog?.instances.filter(
      (instance) => instance.runnerDeviceId === selectedDeviceId
    ) ?? [];

  return (
    <div className="mt-4 rounded-lg border border-border bg-surface/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">
            Authorized execution computers
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            Status and model choices come from each computer’s reported AI
            Client capabilities. Stale reports are marked.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label="Refresh computer AI Client status"
          className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-xs text-foreground-secondary hover:border-border-strong disabled:opacity-50"
        >
          <RefreshCw
            aria-hidden="true"
            className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
      </div>

      {loading && !catalog ? (
        <p className="mt-4 text-xs text-muted">
          Checking authorized computers…
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="mt-4 flex items-start gap-2 text-xs text-warning"
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 h-4 w-4 shrink-0"
          />
          <span>{error}</span>
        </p>
      ) : null}
      {catalog && catalog.runners.length > 0 ? (
        <>
          <label className="mt-4 block max-w-sm text-xs text-muted">
            Computer
            <select
              aria-label="Execution computer"
              value={selectedDeviceId}
              onChange={(event) =>
                setSelectedDeviceId(event.currentTarget.value)
              }
              className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            >
              {catalog.runners.map((runner) => (
                <option key={runner.deviceId} value={runner.deviceId}>
                  {runner.displayName}
                </option>
              ))}
            </select>
          </label>
          <div className="mt-4 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-sm">
                {selected?.displayName ?? "Selected computer"}
              </strong>
              <span className="text-[11px] text-muted">
                {instances.length
                  ? "AI Client reports available"
                  : "No AI Client report"}
              </span>
            </div>
            {instances.length ? (
              <ul className="mt-3 divide-y divide-border">
                {instances.map((instance) => (
                  <li
                    key={
                      instance.hostedInstanceId ??
                      `${instance.runnerDeviceId}:${instance.instanceId}`
                    }
                    className="py-3 first:pt-0 last:pb-0"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <strong className="text-xs font-medium">
                        {instance.driverId} ·{" "}
                        {instance.sourceDeviceLabel ||
                          selected?.displayName ||
                          "Computer"}
                      </strong>
                      <span className="text-[11px] text-muted">
                        {remoteReadinessLabel(
                          instance.ready,
                          instance.readiness
                        )}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-subtle">
                      {instance.models.length}{" "}
                      {instance.readiness === "stale"
                        ? "last-known"
                        : "reported"}{" "}
                      model{instance.models.length === 1 ? "" : "s"}
                    </p>
                    {instance.models.length ? (
                      <ul className="mt-2 flex flex-wrap gap-1.5">
                        {instance.models.map((model) => (
                          <li
                            key={`${instance.hostedInstanceId ?? instance.instanceId}:${model.id}`}
                            className="rounded border border-border px-2 py-1 text-[11px] text-foreground-secondary"
                          >
                            {model.displayName || model.id}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-muted">
                Open Koed Studio Desktop on this computer, finish local setup,
                then refresh this list.
              </p>
            )}
          </div>
          <RemoteFlowDefaults
            catalog={catalog}
            selectedDeviceId={selectedDeviceId}
            settingsPayload={settings}
          />
          <p className="mt-3 text-xs leading-5 text-muted">
            Install, sign in, or repair an AI Client in Koed Studio Desktop on
            the selected computer.
          </p>
        </>
      ) : catalog && !loading ? (
        <div className="mt-4 rounded-md border border-border p-4 text-xs leading-5 text-muted">
          No authorized execution computer is connected. Open Koed Studio
          Desktop on the computer you want to use, then choose Settings →
          Devices → Manage devices to pair it.
        </div>
      ) : null}
    </div>
  );
}

const remoteFlows = [
  { key: "conversations", label: "Conversations" },
  { key: "mcp_memory_answer", label: "Memory Answer" },
  { key: "lcm_summary", label: "LCM Summary" },
  { key: "session_title", label: "Session Title" },
  { key: "curated_memory_review", label: "Curated Memory Review" }
] as const;

type RemoteFlowKey = (typeof remoteFlows)[number]["key"];
type RemoteAssignment = {
  provider: string;
  ai_client_instance_id: string;
  model: string;
  reasoning_effort: string;
  timeout_ms: number;
  max_attempts: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const existingAssignment = (
  payload: Record<string, unknown> | null,
  flowKey: RemoteFlowKey
): RemoteAssignment | null => {
  const setting = Array.isArray(payload?.settings)
    ? payload.settings.find(
        (value) => isRecord(value) && value.flowKey === flowKey
      )
    : null;
  if (isRecord(setting)) {
    const provider =
      typeof setting.provider === "string" ? setting.provider : null;
    const instance =
      typeof setting.aiClientInstanceId === "string"
        ? setting.aiClientInstanceId
        : null;
    const model = typeof setting.model === "string" ? setting.model : null;
    if (provider && instance && model) {
      return {
        provider,
        ai_client_instance_id: instance,
        model,
        reasoning_effort:
          typeof setting.reasoningEffort === "string"
            ? setting.reasoningEffort
            : "medium",
        timeout_ms:
          typeof setting.timeoutMs === "number" ? setting.timeoutMs : 120_000,
        max_attempts:
          typeof setting.maxAttempts === "number" ? setting.maxAttempts : 3
      };
    }
  }
  const defaults = isRecord(payload?.defaults) ? payload.defaults : null;
  const documented = isRecord(defaults?.[flowKey]) ? defaults[flowKey] : null;
  const assignment = isRecord(documented?.assignment)
    ? documented.assignment
    : null;
  if (!assignment) return null;
  const provider =
    typeof assignment.provider === "string" ? assignment.provider : null;
  const instance =
    typeof assignment.ai_client_instance_id === "string"
      ? assignment.ai_client_instance_id
      : null;
  const model = typeof assignment.model === "string" ? assignment.model : null;
  if (!provider || !instance || !model) return null;
  return {
    provider,
    ai_client_instance_id: instance,
    model,
    reasoning_effort:
      typeof assignment.reasoning_effort === "string"
        ? assignment.reasoning_effort
        : "medium",
    timeout_ms:
      typeof assignment.timeout_ms === "number"
        ? assignment.timeout_ms
        : 120_000,
    max_attempts:
      typeof assignment.max_attempts === "number" ? assignment.max_attempts : 3
  };
};

function RemoteFlowDefaults({
  catalog,
  selectedDeviceId,
  settingsPayload
}: {
  catalog: Awaited<ReturnType<typeof loadHostedLaunchOptions>>;
  selectedDeviceId: string;
  settingsPayload: Record<string, unknown> | null;
}) {
  const selectedInstances = catalog.instances.filter(
    (instance) => instance.runnerDeviceId === selectedDeviceId && instance.ready
  );
  const allInstances = catalog.instances;
  const ambiguousIds = new Set(
    allInstances
      .filter(
        (instance, _index, items) =>
          items.filter(
            (candidate) =>
              candidate.driverId === instance.driverId &&
              candidate.instanceId === instance.instanceId
          ).length > 1
      )
      .map((instance) => `${instance.driverId}:${instance.instanceId}`)
  );
  const [drafts, setDrafts] = useState<
    Partial<Record<RemoteFlowKey, RemoteAssignment>>
  >({});
  const [saving, setSaving] = useState<RemoteFlowKey | null>(null);
  const [saved, setSaved] = useState<RemoteFlowKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  const update = (flowKey: RemoteFlowKey, value: RemoteAssignment) => {
    setDrafts((current) => ({ ...current, [flowKey]: value }));
    setSaved(null);
    setError(null);
  };
  const save = async (flowKey: RemoteFlowKey, assignment: RemoteAssignment) => {
    if (
      ambiguousIds.has(
        `${assignment.provider}:${assignment.ai_client_instance_id}`
      )
    )
      return;
    setSaving(flowKey);
    setError(null);
    setSaved(null);
    try {
      await studioAuthenticatedRequest(
        `/v1/memory/local-agent-settings/${encodeURIComponent(flowKey)}`,
        { method: "PUT", body: JSON.stringify(assignment) }
      );
      setSettingsPayloadAfterSave(flowKey, assignment);
      setSaved(flowKey);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save this default."
      );
    } finally {
      setSaving(null);
    }
  };

  const [savedAssignments, setSavedAssignments] = useState<
    Partial<Record<RemoteFlowKey, RemoteAssignment>>
  >({});
  const setSettingsPayloadAfterSave = (
    flowKey: RemoteFlowKey,
    assignment: RemoteAssignment
  ) => {
    setSavedAssignments((current) => ({ ...current, [flowKey]: assignment }));
  };

  return (
    <div className="mt-4 rounded-md border border-border p-4">
      <h3 className="text-sm font-medium">Defaults for new work</h3>
      <p className="mt-1 text-xs leading-5 text-muted">
        These account defaults use each AI Client’s provider-local ID. If that
        provider and Client ID are reported by more than one computer, the
        choice is disabled because the saved assignment cannot name a computer.
      </p>
      {settingsPayload === null ? (
        <p className="mt-3 text-xs text-muted">
          Account AI Client defaults are unavailable.
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          {remoteFlows.map(({ key, label }) => {
            const options = selectedInstances.flatMap((instance) =>
              instance.models
                .filter((model) => model.supportedReasoningEfforts.length > 0)
                .map((model) => ({ instance, model }))
            );
            const savedAssignment =
              drafts[key] ??
              savedAssignments[key] ??
              existingAssignment(settingsPayload, key);
            const initialOption = options[0];
            const draft =
              savedAssignment ??
              (initialOption
                ? {
                    provider: initialOption.instance.driverId,
                    ai_client_instance_id: initialOption.instance.instanceId,
                    model: initialOption.model.id,
                    reasoning_effort:
                      initialOption.model.supportedReasoningEfforts[0] ??
                      "medium",
                    timeout_ms: 120_000,
                    max_attempts: 3
                  }
                : null);
            const matchingOption = options.find(
              ({ instance, model }) =>
                instance.instanceId === draft?.ai_client_instance_id &&
                instance.driverId === draft?.provider &&
                model.id === draft?.model
            );
            const value =
              draft && matchingOption
                ? `${matchingOption.instance.hostedInstanceId ?? matchingOption.instance.instanceId}\u0000${draft.model}`
                : "";
            return (
              <div
                key={key}
                className="grid gap-2 border-t border-border pt-3 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-end"
              >
                <div>
                  <strong className="text-xs font-medium">{label}</strong>
                  {savedAssignment ? (
                    <p className="mt-1 text-[11px] text-subtle">
                      Saved: {savedAssignment.provider} ·{" "}
                      {savedAssignment.model}
                    </p>
                  ) : (
                    <p className="mt-1 text-[11px] text-subtle">
                      Choose an available default
                    </p>
                  )}
                </div>
                <label className="text-xs text-muted">
                  Agent and model
                  <select
                    aria-label={`${label} default Agent and model`}
                    value={value}
                    onChange={(event) => {
                      const [hostedInstanceId, modelId] =
                        event.currentTarget.value.split("\u0000");
                      const selected = options.find(
                        ({ instance, model }) =>
                          (instance.hostedInstanceId ?? instance.instanceId) ===
                            hostedInstanceId && model.id === modelId
                      );
                      if (!selected || !draft) return;
                      update(key, {
                        ...draft,
                        provider: selected.instance.driverId,
                        ai_client_instance_id: selected.instance.instanceId,
                        model: selected.model.id,
                        reasoning_effort:
                          selected.model.supportedReasoningEfforts.includes(
                            draft.reasoning_effort
                          )
                            ? draft.reasoning_effort
                            : (selected.model.supportedReasoningEfforts[0] ??
                              "medium")
                      });
                    }}
                    disabled={!draft || options.length === 0}
                    className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground"
                  >
                    <option value="">Choose a verified Agent and model</option>
                    {options.map(({ instance, model }) => (
                      <option
                        key={`${instance.hostedInstanceId ?? instance.instanceId}:${model.id}`}
                        value={`${instance.hostedInstanceId ?? instance.instanceId}\u0000${model.id}`}
                        disabled={ambiguousIds.has(
                          `${instance.driverId}:${instance.instanceId}`
                        )}
                      >
                        {instance.sourceDeviceLabel ?? "Computer"} ·{" "}
                        {instance.driverId} · {model.displayName || model.id}
                        {ambiguousIds.has(
                          `${instance.driverId}:${instance.instanceId}`
                        )
                          ? " — choose is unavailable across computers"
                          : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => draft && void save(key, draft)}
                  disabled={
                    !draft ||
                    !matchingOption ||
                    !matchingOption.model.supportedReasoningEfforts.includes(
                      draft.reasoning_effort
                    ) ||
                    saving !== null ||
                    ambiguousIds.has(
                      `${draft.provider}:${draft.ai_client_instance_id}`
                    )
                  }
                  className="min-h-9 rounded-md border border-border px-3 text-xs text-foreground-secondary hover:border-border-strong disabled:opacity-50"
                >
                  {saving === key
                    ? "Saving…"
                    : saved === key
                      ? "Saved"
                      : "Save default"}
                </button>
                {draft &&
                matchingOption &&
                !matchingOption.model.supportedReasoningEfforts.includes(
                  draft.reasoning_effort
                ) ? (
                  <p className="text-[11px] text-warning sm:col-start-2">
                    Choose a model with a supported reasoning effort before
                    saving.
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-xs text-warning">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const remoteReadinessLabel = (ready: boolean, readiness: string): string => {
  if (ready) return "Healthy and authenticated";
  if (readiness === "authentication_required") return "Sign-in required";
  if (readiness === "stale") return "Last report is stale";
  if (readiness === "disabled") return "Client disabled";
  if (readiness === "not_observed") return "No capability report yet";
  if (
    readiness === "unavailable" ||
    readiness === "incompatible" ||
    readiness === "error"
  ) {
    return `Client ${readiness}`;
  }
  return "Needs attention";
};
