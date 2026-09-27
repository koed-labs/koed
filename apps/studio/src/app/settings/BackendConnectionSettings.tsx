"use client";

import { useEffect, useMemo, useState } from "react";
import {
  StudioCollaborationSettingsClient,
  type StudioCollaborationSettingsSnapshot
} from "@/lib/studio-collaboration-settings";

const connectionLabel = (state: string) => {
  switch (state) {
    case "live":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "access_revoked":
      return "Access revoked";
    case "unavailable":
      return "Unavailable";
    default:
      return "Disconnected";
  }
};

export function BackendConnectionSettings() {
  const client = useMemo(() => new StudioCollaborationSettingsClient(), []);
  const [snapshot, setSnapshot] =
    useState<StudioCollaborationSettingsSnapshot | null>(null);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((value) => {
        if (active) setSnapshot(value);
      })
      .catch((reason: unknown) => {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "Backend connection settings could not be loaded."
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client]);

  const runAction = async (
    action: () => Promise<StudioCollaborationSettingsSnapshot>
  ) => {
    setPending(true);
    setError(null);
    try {
      setSnapshot(await action());
      setRemoteUrl("");
    } catch (reason) {
      const failedSnapshot =
        reason && typeof reason === "object" && "snapshot" in reason
          ? (reason as { snapshot?: StudioCollaborationSettingsSnapshot })
              .snapshot
          : undefined;
      if (failedSnapshot) setSnapshot(failedSnapshot);
      setError(
        reason instanceof Error
          ? reason.message
          : "Backend connection could not be updated."
      );
    } finally {
      setPending(false);
    }
  };

  const connection = snapshot?.connection;
  const canManage = snapshot !== null;

  return (
    <section
      className="mt-8 border-b border-border pb-8"
      aria-labelledby="backend-connection-heading"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2
          id="backend-connection-heading"
          className="text-sm font-medium text-foreground-secondary"
        >
          Team backend
        </h2>
        <p className="text-xs text-subtle">
          {loading
            ? "Checking connection…"
            : connection
              ? connectionLabel(connection.state)
              : "Desktop connection controls"}
        </p>
      </div>
      <p className="mt-1 text-xs leading-5 text-muted">
        Connect this Desktop installation to a Koed Team backend. Enrollment
        opens in your browser; credentials stay on this device.
      </p>
      {connection?.backendId ? (
        <p className="mt-3 text-xs text-subtle">
          Backend ID <span className="font-mono">{connection.backendId}</span>
          {connection.connectedAt
            ? ` · Connected ${new Date(connection.connectedAt).toLocaleString()}`
            : ""}
        </p>
      ) : null}
      {connection?.state === "live" && snapshot?.teams.length ? (
        <p className="mt-2 text-xs text-subtle">
          {snapshot.teams.length} Team{snapshot.teams.length === 1 ? "" : "s"}{" "}
          available in Studio.
        </p>
      ) : null}
      <label
        htmlFor="team-backend-url"
        className="mt-5 block text-xs font-medium text-foreground-secondary"
      >
        Backend URL
      </label>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          id="team-backend-url"
          type="url"
          inputMode="url"
          autoComplete="url"
          placeholder="https://koed.example.com"
          value={remoteUrl}
          onChange={(event) => setRemoteUrl(event.target.value)}
          disabled={!canManage || pending}
          className="min-h-10 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-sm text-foreground outline-none placeholder:text-subtle focus:border-border-strong"
        />
        <button
          type="button"
          onClick={() => void runAction(() => client.connect(remoteUrl))}
          disabled={!canManage || pending || !remoteUrl.trim()}
          className="min-h-10 rounded-lg border border-border bg-surface-hover px-4 text-sm font-medium text-foreground transition-colors hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          {connection?.state === "live" ? "Switch backend" : "Connect"}
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void runAction(() => client.reconnect())}
          disabled={!canManage || pending || !connection?.backendId}
          className="min-h-9 rounded-lg border border-border px-3 text-xs font-medium text-foreground-secondary transition-colors hover:border-border-strong hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          Reconnect
        </button>
        <button
          type="button"
          onClick={() => void runAction(() => client.disconnect())}
          disabled={!canManage || pending || !connection?.backendId}
          className="min-h-9 rounded-lg border border-border px-3 text-xs font-medium text-foreground-secondary transition-colors hover:border-border-strong hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          Disconnect
        </button>
      </div>
      {pending ? (
        <p className="mt-3 text-xs text-muted" role="status">
          Updating backend connection…
        </p>
      ) : null}
      {error ? (
        <p className="mt-3 text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
