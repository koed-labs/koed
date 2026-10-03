"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import {
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
  const [targets, setTargets] = useState<ClientResourceTarget[]>([]);
  const [selected, setSelected] = useState("");
  const [result, setResult] = useState<{
    key: string;
    catalog: ClientResourceCatalog;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void loadClientResourceTargets(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setTargets(value);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "AI Clients could not be loaded."
          );
      });
    return () => controller.abort();
  }, [revision]);
  const current =
    targets.find((target) => target.hostedInstanceId === selected) ??
    targets[0];
  const currentKey = current?.hostedInstanceId ?? "";
  useEffect(() => {
    if (!currentKey) return;
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      setBusy(true);
      setError(null);
      try {
        const catalog = await discoverClientResources(
          { hostedInstanceId: currentKey, projectId: null },
          controller.signal
        );
        if (!controller.signal.aborted) setResult({ key: currentKey, catalog });
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Configured resources could not be loaded."
          );
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    });
    return () => controller.abort();
  }, [currentKey, revision]);
  const catalog = result?.key === currentKey ? result.catalog : null;
  const resources =
    catalog?.resources.filter(
      (resource) =>
        (kind === "skills"
          ? resource.kind === "skill"
          : resource.kind !== "skill") &&
        `${resource.name} ${resource.description ?? ""}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())
    ) ?? [];

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
          onClick={() => setRevision((value) => value + 1)}
          disabled={busy}
          className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-hover disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
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
            value={currentKey}
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
      {busy ? (
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
              </div>
              <span className="shrink-0 text-xs text-muted">
                {!current?.enabled
                  ? "Disabled"
                  : current.authenticationState === "unauthenticated"
                    ? "Needs sign-in"
                    : resource.status === "ready"
                      ? "Available"
                      : resource.status === "disabled"
                        ? "Disabled"
                        : "Unavailable"}
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
