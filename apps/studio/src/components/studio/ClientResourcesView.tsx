"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import {
  clientResourceAvailability,
  clientResourceAvailabilityLabel,
  clientResourceErrorMessage,
  clientResourceExecutionSupportLabel,
  clientLabel,
  discoverClientResources,
  loadClientResourceTargets,
  type ClientResourceCatalog,
  type ClientResourceTarget
} from "@/lib/client-resources-client";

export function ClientResourcesView({
  kind,
  query = ""
}: {
  kind: "skills" | "plugins";
  query?: string;
}) {
  const [targetSnapshot, setTargetSnapshot] = useState<{
    revision: number;
    targets: ClientResourceTarget[];
  } | null>(null);
  const [selected, setSelected] = useState("");
  const [result, setResult] = useState<{
    key: string;
    catalog: ClientResourceCatalog;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [clockNow, setClockNow] = useState(() => Date.now());

  const targets =
    targetSnapshot?.revision === revision ? targetSnapshot.targets : [];
  const targetsLoading = targetSnapshot?.revision !== revision;

  useEffect(() => {
    const controller = new AbortController();
    void loadClientResourceTargets(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setTargetSnapshot({ revision, targets: value });
          setError(null);
          setBusy(value.length > 0);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setTargetSnapshot({ revision, targets: [] });
          setError(clientResourceErrorMessage(cause));
          setBusy(false);
        }
      });
    return () => controller.abort();
  }, [revision]);
  const current =
    targets.find((target) => target.hostedInstanceId === selected) ??
    targets[0];
  const currentKey = current
    ? JSON.stringify([
        current.hostedInstanceId,
        current.instanceId,
        current.provider
      ])
    : "";
  const currentHostedInstanceId = current?.hostedInstanceId;
  const currentInstanceId = current?.instanceId;
  const currentProvider = current?.provider;
  const currentEnabled = current?.enabled;
  const currentAuthenticationState = current?.authenticationState;
  const selectedHostedInstanceId = current?.hostedInstanceId ?? "";
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      if (
        !currentHostedInstanceId ||
        !currentInstanceId ||
        !currentProvider ||
        !currentKey
      ) {
        setResult(null);
        return;
      }
      setBusy(true);
      setError(null);
      if (currentEnabled === false) {
        setError(
          "This AI Client is disabled in Koed. Enable it in the original Client settings, then refresh."
        );
        setBusy(false);
        return;
      }
      if (currentAuthenticationState === "unauthenticated") {
        setError(
          "Sign in through the original AI Client, then refresh its configured resources."
        );
        setBusy(false);
        return;
      }
      try {
        const catalog = await discoverClientResources(
          { hostedInstanceId: currentHostedInstanceId, projectId: null },
          controller.signal
        );
        if (
          !controller.signal.aborted &&
          catalog.aiClientInstanceId === currentInstanceId &&
          catalog.provider === currentProvider
        )
          setResult({ key: currentKey, catalog });
        else if (!controller.signal.aborted)
          setError(
            "The selected AI Client changed during discovery. Refresh and select it again."
          );
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(clientResourceErrorMessage(cause));
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    });
    return () => controller.abort();
  }, [
    currentAuthenticationState,
    currentEnabled,
    currentHostedInstanceId,
    currentInstanceId,
    currentKey,
    currentProvider
  ]);
  const catalog = result?.key === currentKey ? result.catalog : null;
  const catalogExpiresAt = catalog?.expiresAt;
  useEffect(() => {
    if (!catalogExpiresAt) return;
    const delay = Date.parse(catalogExpiresAt) - Date.now();
    const timer = setTimeout(
      () => setClockNow(Date.now()),
      Math.max(0, delay) + 1
    );
    return () => clearTimeout(timer);
  }, [catalogExpiresAt]);
  const catalogExpired = Boolean(
    catalog && Date.parse(catalog.expiresAt) <= clockNow
  );
  const isBusy = targetsLoading || busy;
  const resources =
    catalog && !catalogExpired
      ? catalog.resources.filter(
          (resource) =>
            (kind === "skills"
              ? resource.kind === "skill"
              : resource.kind !== "skill") &&
            `${resource.name} ${resource.description ?? ""}`
              .toLocaleLowerCase()
              .includes(query.trim().toLocaleLowerCase())
        )
      : [];

  return (
    <section
      aria-label={`AI Client ${kind}`}
      className="mt-6 border-t border-border pt-6"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground-secondary">
          Configured in your AI Clients
        </h2>
        <button
          type="button"
          onClick={() => {
            setResult(null);
            setError(null);
            setBusy(true);
            setRevision((value) => value + 1);
          }}
          disabled={isBusy}
          className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-hover disabled:opacity-50"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${isBusy ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
      </div>
      <p className="mb-4 text-xs leading-5 text-muted">
        Install, configure and connect accounts in the original AI Client.
        Project Skills appear in the selected Project’s Agent chat.
      </p>
      {targets.length > 0 && (
        <label className="mb-4 block text-xs text-muted">
          AI Client and computer
          <select
            value={selectedHostedInstanceId}
            onChange={(event) => setSelected(event.target.value)}
            className="mt-2 block max-w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
          >
            {targets.map((target) => (
              <option
                key={target.hostedInstanceId}
                value={target.hostedInstanceId}
              >
                {clientLabel(target.provider)} · {target.name} ·{" "}
                {target.computerLabel}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <p role="status" className="mb-3 text-sm text-muted">
          {error}
        </p>
      )}
      {catalogExpired ? (
        <p role="status" className="py-5 text-sm text-muted">
          This resource list expired. Refresh to read the Client again.
        </p>
      ) : isBusy ? (
        <p role="status" className="py-5 text-sm text-muted">
          Reading this Client’s configuration…
        </p>
      ) : resources.length ? (
        <div className="divide-y divide-border rounded-lg border border-border">
          {resources.map((resource) => (
            <div
              key={resource.resourceId}
              className="flex items-start gap-3 px-4 py-3"
            >
              <span
                aria-hidden="true"
                className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border text-[10px] text-muted"
              >
                {catalog?.provider === "codex"
                  ? "C"
                  : catalog?.provider === "claude"
                    ? "CC"
                    : "Pi"}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">
                  {resource.name}
                </p>
                {resource.description && (
                  <p className="mt-1 text-xs leading-5 text-muted">
                    {resource.description}
                  </p>
                )}
                <p className="mt-1 text-xs text-subtle">
                  {clientLabel(catalog!.provider)} ·{" "}
                  {catalog!.computerLabel ??
                    current?.computerLabel ??
                    "Computer"}{" "}
                  · {resource.source}
                </p>
                <p className="mt-1 text-xs text-subtle">
                  {clientResourceExecutionSupportLabel(resource, current)}
                </p>
              </div>
              <span className="shrink-0 text-xs text-muted">
                {clientResourceAvailabilityLabel(
                  clientResourceAvailability(resource)
                )}
              </span>
            </div>
          ))}
        </div>
      ) : (
        !error && (
          <p className="flex items-center gap-2 py-5 text-sm text-muted">
            <Search className="h-4 w-4" />
            {targets.length
              ? `No configured ${kind} reported for this Client.`
              : "Connect a computer with an AI Client to see its configuration."}
          </p>
        )
      )}
    </section>
  );
}
