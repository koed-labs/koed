"use client";

import { RefreshCw, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DesktopSetupSnapshot } from "../../../../desktop/src/types.js";
import { DesktopStatusStore } from "../../../.desktop-ui/index.js";
import { SetupChecklist } from "../../../.desktop-ui/index.js";
import { useDesktopStatus } from "../../../.desktop-ui/index.js";
import { loadHostedLaunchOptions } from "@/lib/hosted-managed-chats";
import {
  useStudioDesktopAvailability,
  useStudioSettingsComputer
} from "./StudioSettingsComputerContext";

const setupLabels: Record<string, string> = {
  package: "Koed package",
  runtime: "Local runtime",
  model: "Embedding model",
  services: "Local services",
  integration: "Koed core integration",
  verification: "Verification"
};

const clientLabels: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  pi: "Pi"
};

export function StudioSetupSettings() {
  const statusStore = useMemo(() => new DesktopStatusStore(), []);
  const [setup, setSetup] = useState<DesktopSetupSnapshot | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guidedSetupOpen, setGuidedSetupOpen] = useState(false);
  const [remoteCatalog, setRemoteCatalog] = useState<Awaited<
    ReturnType<typeof loadHostedLaunchOptions>
  > | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(true);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const { selectedDeviceId, setSelectedDeviceId } = useStudioSettingsComputer();
  const { status } = useDesktopStatus(statusStore);
  const desktopAvailability = useStudioDesktopAvailability();

  const refresh = useCallback(async () => {
    const bridge = window.koedDesktop;
    if (!bridge?.setup) {
      setError("Open this page in Koed Studio Desktop to inspect local setup.");
      return;
    }
    setChecking(true);
    setError(null);
    try {
      const [snapshot] = await Promise.all([
        bridge.setup.inspect(),
        statusStore.refresh()
      ]);
      setSetup(snapshot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChecking(false);
    }
  }, [statusStore]);

  useEffect(() => {
    if (desktopAvailability !== true) return;
    void Promise.resolve().then(() => refresh());
  }, [desktopAvailability, refresh]);

  useEffect(() => {
    if (desktopAvailability !== false) return;
    const controller = new AbortController();
    void loadHostedLaunchOptions(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setRemoteCatalog(next);
        setSelectedDeviceId((current) =>
          next.runners.some((runner) => runner.deviceId === current)
            ? current
            : (next.runners[0]?.deviceId ?? "")
        );
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setRemoteError(
          cause instanceof Error
            ? cause.message
            : "Computer status could not be loaded."
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setRemoteLoading(false);
      });
    return () => controller.abort();
  }, [desktopAvailability, setSelectedDeviceId]);

  const completeGuidedSetup = useCallback(async () => {
    setGuidedSetupOpen(false);
    await refresh();
  }, [refresh]);

  const clients = Object.entries(status?.aiClients ?? {})
    .filter(([id]) => id in clientLabels)
    .sort(([left], [right]) => left.localeCompare(right));
  const remoteRunner = remoteCatalog?.runners.find(
    (runner) => runner.deviceId === selectedDeviceId
  );
  const remoteInstances =
    remoteCatalog?.instances.filter(
      (instance) => instance.runnerDeviceId === selectedDeviceId
    ) ?? [];

  return (
    <section
      className="mt-8 border-b border-border pb-8"
      aria-labelledby="setup-health-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2
            id="setup-health-heading"
            className="text-sm font-medium text-foreground-secondary"
          >
            Setup &amp; health
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted">
            Local installation and verified AI Client status for this computer.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={checking}
          aria-label="Refresh setup and health"
          className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-xs text-foreground-secondary hover:border-border-strong disabled:opacity-50"
        >
          <RefreshCw
            aria-hidden="true"
            className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
      </div>

      {desktopAvailability === null ? (
        <p className="mt-4 text-xs text-muted">Checking Desktop connection…</p>
      ) : !desktopAvailability ? (
        <div className="mt-4 rounded-lg border border-border bg-surface/50 p-4">
          <p className="text-xs leading-5 text-muted">
            The selected computer’s verified Client and model status is shown
            here and in AI Clients &amp; models. The web transport does not
            publish its Koed package, runtime, service, or verification stages.
            Open Koed Studio Desktop on that computer to inspect those stages or
            run local setup and repair.
          </p>
          {remoteError ? (
            <p role="alert" className="mt-3 text-xs text-warning">
              {remoteError}
            </p>
          ) : null}
          {remoteCatalog?.runners.length ? (
            <>
              <label className="mt-3 block max-w-sm text-xs text-muted">
                Execution computer
                <select
                  aria-label="Setup status computer"
                  value={selectedDeviceId}
                  onChange={(event) =>
                    setSelectedDeviceId(event.currentTarget.value)
                  }
                  className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                >
                  {remoteCatalog.runners.map((runner) => (
                    <option key={runner.deviceId} value={runner.deviceId}>
                      {runner.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <div className="mt-3 rounded-md border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-xs font-medium">
                    {remoteRunner?.displayName ?? "Selected computer"}
                  </strong>
                  <span className="text-[11px] text-muted">
                    {remoteInstances.length
                      ? "Client reports available"
                      : "No Client report"}
                  </span>
                </div>
                {remoteInstances.length ? (
                  <ul className="mt-2 divide-y divide-border">
                    {remoteInstances.map((instance) => (
                      <li
                        key={
                          instance.hostedInstanceId ??
                          `${instance.runnerDeviceId}:${instance.instanceId}`
                        }
                        className="py-2 first:pt-0 last:pb-0"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <strong className="font-medium">
                            {instance.driverId} ·{" "}
                            {instance.sourceDeviceLabel ||
                              remoteRunner?.displayName}
                          </strong>
                          <span className="text-muted">
                            {remoteReadiness(
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
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs text-muted">
                    Open Koed Studio Desktop on this computer, finish setup and
                    sign in to a supported AI Client, then refresh.
                  </p>
                )}
              </div>
            </>
          ) : (
            <p className="mt-3 text-xs text-muted">
              {remoteLoading
                ? "Checking authorized computers…"
                : "No authorized computer is connected. Connect one in Koed Studio Desktop → Settings → Devices."}
            </p>
          )}
        </div>
      ) : (
        <>
          {error ? (
            <p role="alert" className="mt-4 text-sm text-warning">
              {error}
            </p>
          ) : null}
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-surface/40 p-4">
              <h3 className="text-sm font-medium">Koed on this computer</h3>
              {setup ? (
                <ul className="mt-3 space-y-2 text-xs text-muted">
                  {setup.stages.map((stage) => (
                    <li
                      key={stage.id}
                      className="flex items-start justify-between gap-3"
                    >
                      <span>{setupLabels[stage.id] ?? stage.id}</span>
                      <span
                        className={
                          stage.state === "complete"
                            ? "text-success"
                            : stage.state === "failed"
                              ? "text-warning"
                              : ""
                        }
                      >
                        {stage.state === "complete"
                          ? "Verified"
                          : stage.state === "failed"
                            ? stage.message
                            : stage.state === "running"
                              ? "In progress"
                              : "Needs setup"}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-xs text-muted">
                  {checking
                    ? "Checking local setup…"
                    : "Setup details are unavailable."}
                </p>
              )}
              {status ? (
                <p className="mt-3 border-t border-border pt-3 text-xs text-muted">
                  Services:{" "}
                  <span className="text-foreground-secondary">
                    {status.state.replaceAll("_", " ")}
                  </span>
                  {status.lastVerification.checkedAt
                    ? ` · Last verified ${new Date(status.lastVerification.checkedAt).toLocaleString()}`
                    : " · No completed verification yet"}
                </p>
              ) : null}
            </div>

            <div className="rounded-lg border border-border bg-surface/40 p-4">
              <h3 className="text-sm font-medium">Connected AI Clients</h3>
              {clients.length ? (
                <ul className="mt-3 space-y-3">
                  {clients.map(([id, client]) => (
                    <li
                      key={id}
                      className="border-b border-border pb-3 last:border-0 last:pb-0"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <strong className="text-xs font-medium">
                          {clientLabels[id]}
                        </strong>
                        <span className="text-[11px] text-muted">
                          {client.profile.state.replaceAll("_", " ")}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-subtle">
                        Installed: {client.installed.state.replaceAll("_", " ")}{" "}
                        · Profile: {client.profile.state.replaceAll("_", " ")} ·
                        Sign-in: {client.authentication.replaceAll("_", " ")}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-xs text-muted">
                  No AI Client status is available yet.
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setGuidedSetupOpen(true)}
            className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground hover:opacity-90"
          >
            <Wrench aria-hidden="true" className="h-4 w-4" />
            Guided setup or repair
          </button>
        </>
      )}

      {guidedSetupOpen && desktopAvailability === true ? (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-background">
          <SetupChecklist
            nativeRunConfirmation
            statusStore={statusStore}
            onComplete={completeGuidedSetup}
          />
          <button
            type="button"
            onClick={() => setGuidedSetupOpen(false)}
            className="fixed right-6 top-5 z-[60] rounded-md border border-border bg-background px-3 py-2 text-xs text-muted hover:text-foreground"
          >
            Close
          </button>
        </div>
      ) : null}
    </section>
  );
}

function remoteReadiness(ready: boolean, readiness: string) {
  if (ready) return "Healthy and authenticated";
  if (readiness === "authentication_required") return "Sign-in required";
  if (readiness === "stale") return "Last report is stale";
  if (readiness === "disabled") return "Client disabled";
  if (readiness === "not_observed") return "No capability report yet";
  return `Needs attention · ${readiness.replaceAll("_", " ")}`;
}
