import { useCallback, useState } from "react";
import { ArrowUpCircle, ExternalLink, RefreshCw, X } from "lucide-react";
import type { DesktopUpdateController } from "./use-desktop-update.js";
import "./desktop-update.css";

const dismissedVersionKey = "koed.desktop.update.dismissedVersion";

const readDismissedVersion = (): string | null => {
  try {
    return window.localStorage.getItem(dismissedVersionKey);
  } catch {
    return null;
  }
};

/** The available version, or null when no update is available. */
export const availableUpdateVersion = (
  update: DesktopUpdateController | undefined
): string | null =>
  update?.state?.status === "available"
    ? (update.state.release?.version ?? null)
    : null;

/**
 * A small dot marking a control that leads to the update. It stays visible
 * after the sidebar notice is dismissed so the update remains discoverable.
 */
export function DesktopUpdateDot({
  update
}: {
  update: DesktopUpdateController | undefined;
}) {
  if (!availableUpdateVersion(update)) return null;
  return <span className="desktop-update-dot" aria-hidden="true" />;
}

/**
 * The sidebar notice: shown throughout the app while an update is available,
 * dismissible per version.
 */
export function DesktopUpdateNotice({
  update,
  onDetails
}: {
  update: DesktopUpdateController;
  onDetails: () => void;
}) {
  const version = availableUpdateVersion(update);
  const [dismissed, setDismissed] = useState(readDismissedVersion);
  const dismiss = useCallback(() => {
    if (!version) return;
    try {
      window.localStorage.setItem(dismissedVersionKey, version);
    } catch {
      // Dismissal then lasts only for this session.
    }
    setDismissed(version);
  }, [version]);
  if (!version || dismissed === version) return null;
  return (
    <section
      className="desktop-update-notice"
      aria-labelledby="desktop-update-notice-title"
    >
      <header>
        <ArrowUpCircle aria-hidden="true" />
        <b id="desktop-update-notice-title">Update available</b>
        <button
          type="button"
          className="desktop-update-notice-close"
          aria-label={`Dismiss Koed ${version} update notice`}
          onClick={dismiss}
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <p>
        Koed {version} is ready to download. You have{" "}
        {update.state?.installedVersion}.
      </p>
      {update.error ? <p role="alert">{update.error}</p> : null}
      <div className="desktop-update-actions">
        <button
          type="button"
          className="desktop-update-button"
          onClick={onDetails}
        >
          How to update
        </button>
        <button
          type="button"
          className="desktop-update-button desktop-update-button-primary"
          disabled={update.busy}
          onClick={() => void update.open()}
        >
          Download
        </button>
      </div>
    </section>
  );
}

export function DesktopUpdatePanel({
  update,
  installedVersion
}: {
  update: DesktopUpdateController;
  installedVersion?: string;
}) {
  const state = update.state;
  const version = availableUpdateVersion(update);
  const installed = state?.installedVersion ?? installedVersion ?? "Loading…";
  const status = version ? null : state?.status === "checking" ||
    update.busy ? (
    <p role="status">Checking for updates…</p>
  ) : state?.status === "error" ? (
    <p role="alert">{update.error ?? "Update status could not be checked."}</p>
  ) : state?.status === "current" ? (
    <p role="status">You're up to date.</p>
  ) : state?.status === "disabled" ? (
    <p>Update notices are unavailable for this build.</p>
  ) : (
    <p>Update status not checked.</p>
  );
  return (
    <section
      className="desktop-update-panel"
      aria-labelledby="desktop-update-title"
    >
      <h4 id="desktop-update-title">Updates</h4>
      {version ? (
        <div className="desktop-update-available">
          <p className="desktop-update-headline">Koed {version} is available</p>
          <p>
            You have {installed}. Updating means stopping Koed for a moment, so
            AI Clients can't recall memory until it's running again.
          </p>
          <div className="desktop-update-actions">
            <button
              type="button"
              className="desktop-update-button desktop-update-button-primary"
              disabled={update.busy}
              onClick={() => void update.open()}
            >
              <ExternalLink aria-hidden="true" /> Download {version}
            </button>
            <button
              type="button"
              className="desktop-update-button desktop-update-button-quiet"
              disabled={update.busy}
              onClick={() => void update.check()}
            >
              Check again
            </button>
          </div>
        </div>
      ) : (
        <>
          <p>Installed version: {installed}</p>
          {status}
          {state?.status !== "disabled" ? (
            <div className="desktop-update-actions">
              <button
                type="button"
                className="desktop-update-button"
                disabled={update.busy}
                onClick={() => void update.check()}
              >
                <RefreshCw aria-hidden="true" /> Check for updates
              </button>
            </div>
          ) : null}
        </>
      )}
      {update.error && state?.status !== "error" ? (
        <p role="alert">{update.error}</p>
      ) : null}
      <details className="desktop-update-manual-steps" open={Boolean(version)}>
        <summary>How to update Koed</summary>
        <p>
          Koed doesn't install updates itself. Download the new version from the
          release page, then:
        </p>
        <ol>
          <li>Pause AI Client and CLI activity.</li>
          <li>
            For each Koed home, use its existing Desktop CLI launcher to run{" "}
            <code>koed stop --json</code>.
          </li>
          <li>
            Continue only when output reports <code>ok: true</code> and a status
            check reports <code>lifecycle.state: stopped</code>.
          </li>
          <li>
            If home or service ownership is unclear, stop; do not terminate
            processes or replace files.
          </li>
          <li>
            Install the macOS arm64 release. Preserve homes, configuration, and
            models.
          </li>
        </ol>
      </details>
    </section>
  );
}
