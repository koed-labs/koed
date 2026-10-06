import { Button, Spinner } from "@koed/ui";
import { useEffect, useState } from "react";
import type {
  CliInstallApi,
  CliInstallProgressEnvelope,
  PrivacyInstallStatus,
  PrivacyOfflineSource
} from "../../../cli-install/protocol.js";
import type { LauncherStatus } from "../../../cli-install/launcher.js";
import "./cli-install-settings.css";

export function CliInstallSettingsSection({ api }: { api?: CliInstallApi }) {
  const [status, setStatus] = useState<PrivacyInstallStatus | null>(null);
  const [progress, setProgress] = useState<CliInstallProgressEnvelope | null>(
    null
  );
  const [offlineSource, setOfflineSource] =
    useState<PrivacyOfflineSource | null>(null);
  const [launcher, setLauncher] = useState<LauncherStatus | null>(null);
  const [consent, setConsent] = useState(false);
  const [pathConsent, setPathConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!api) return;
    try {
      const [nextStatus, nextLauncher] = await Promise.all([
        api.getStatus(),
        api.launcher("inspect")
      ]);
      setStatus(nextStatus);
      setLauncher(nextLauncher);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    if (!api) return;
    let active = true;
    const unsubscribe = api.subscribe((value) => {
      if (active) setProgress(value as CliInstallProgressEnvelope);
    });
    void refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setStatus((current) =>
        current?.state === "installing"
          ? { ...current, state: "failed", message }
          : current
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="koed-cli-install-settings"
      aria-label="Local assets and CLI"
    >
      <h2>Privacy Filter assets</h2>
      <p>
        Installing optional Privacy Filter assets downloads or imports a signed
        component. Koed does not install it without your explicit consent.
      </p>
      <p role="status">
        {status?.message ??
          (api
            ? "Checking Privacy Filter installer…"
            : "Desktop installer bridge unavailable. Update Koed Desktop, then retry.")}
      </p>
      {status?.state === "unavailable" ? (
        <Button
          disabled={!api || busy}
          onClick={() => void run(refresh)}
          variant="outline"
        >
          Retry installer status
        </Button>
      ) : null}
      <div className="koed-cli-install-actions">
        <Button
          disabled={!api || busy}
          onClick={() =>
            void run(async () =>
              setOfflineSource((await api!.selectOffline()) ?? null)
            )
          }
          variant="outline"
        >
          Choose offline component files
        </Button>
        {offlineSource ? (
          <span>Offline source: {offlineSource.archivePath}</span>
        ) : null}
      </div>
      <label className="koed-cli-install-consent">
        <input
          checked={consent}
          onChange={(event) => setConsent(event.currentTarget.checked)}
          type="checkbox"
        />{" "}
        I consent to install Privacy Filter assets on this device.
      </label>
      <div className="koed-cli-install-actions">
        <Button
          disabled={!api || !consent || busy || status?.state === "unavailable"}
          onClick={() => {
            setStatus((current) =>
              current ? { ...current, state: "installing" } : current
            );
            void run(() =>
              api!.installPrivacy(consent, offlineSource ?? undefined)
            );
          }}
        >
          {status?.state === "failed"
            ? "Retry install"
            : "Install Privacy Filter"}
        </Button>
        {status?.state === "installing" &&
        progress?.stage !== "activation" &&
        progress?.stage !== "restart" ? (
          <Button
            disabled={!api}
            onClick={() => void run(() => api!.cancel())}
            variant="outline"
          >
            Cancel
          </Button>
        ) : null}
        {busy ? (
          <Spinner aria-label="Privacy Filter operation in progress" />
        ) : null}
      </div>
      {progress ? (
        <div aria-live="polite" className="koed-cli-install-progress">
          <strong>{progress.stage}</strong>
          <span>{progress.message}</span>
          {progress.totalBytes && progress.completedBytes !== null ? (
            <progress
              max={progress.totalBytes}
              value={progress.completedBytes}
            />
          ) : null}
        </div>
      ) : null}

      <h2>Koed CLI launcher</h2>
      <p>
        Install a Koed-owned launcher, inspect its target and PATH visibility,
        or remove only an unchanged Koed-owned launcher.
      </p>
      {launcher ? (
        <p role="status">
          Launcher: {launcher.ownership}; target {launcher.target}; helper{" "}
          {launcher.helper}; PATH{" "}
          {launcher.pathVisible ? "visible" : "not visible"}.
        </p>
      ) : (
        <p role="status">Inspecting launcher…</p>
      )}
      <div className="koed-cli-install-actions">
        <Button
          disabled={!api || busy}
          onClick={() =>
            void run(async () => setLauncher(await api!.launcher("inspect")))
          }
          variant="outline"
        >
          Inspect CLI launcher
        </Button>
        <Button
          disabled={!api || busy || launcher?.helper !== "supported"}
          onClick={() =>
            void run(async () =>
              setLauncher(await api!.launcher("install", { consent: true }))
            )
          }
        >
          Install or relocate launcher
        </Button>
        <Button
          disabled={!api || busy || launcher?.ownership !== "koed"}
          onClick={() =>
            void run(async () => setLauncher(await api!.launcher("remove")))
          }
          variant="outline"
        >
          Remove launcher
        </Button>
      </div>
      <p>
        PATH changes are separate from launcher installation and require
        separate consent.
      </p>
      <label className="koed-cli-install-consent">
        <input
          checked={pathConsent}
          onChange={(event) => setPathConsent(event.currentTarget.checked)}
          type="checkbox"
        />{" "}
        I consent to change my shell startup file PATH block.
      </label>
      <div className="koed-cli-install-actions">
        <Button
          disabled={!api || !pathConsent || busy}
          onClick={() => void run(() => api!.updatePath("add", pathConsent))}
        >
          Add Koed to PATH
        </Button>
        <Button
          disabled={!api || !pathConsent || busy}
          onClick={() => void run(() => api!.updatePath("remove", pathConsent))}
          variant="outline"
        >
          Remove Koed PATH entry
        </Button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
