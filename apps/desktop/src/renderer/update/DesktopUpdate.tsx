import { Button } from "@koed/ui";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { DesktopUpdateController } from "./use-desktop-update.js";
import "./desktop-update.css";

export function DesktopUpdateIndicator({
  update,
  onOpen
}: {
  update: DesktopUpdateController;
  onOpen: () => void;
}) {
  if (update.state?.status !== "available") return null;
  return (
    <button className="desktop-update-indicator" onClick={onOpen} type="button">
      Update available
    </button>
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
  const available = state?.status === "available" ? state.release : null;
  return (
    <section
      className="desktop-update-panel"
      aria-labelledby="desktop-update-title"
    >
      <h2 id="desktop-update-title">Updates</h2>
      <p>
        Installed version:{" "}
        {state?.installedVersion ?? installedVersion ?? "Loading…"}
      </p>
      {available ? (
        <>
          <p>Version {available.version} is available.</p>
          <p className="desktop-update-notes">{available.summary}</p>
          <Button disabled={update.busy} onClick={() => void update.open()}>
            <ExternalLink aria-hidden="true" /> View release
          </Button>
          <p>Download and install manually from the official release page.</p>
        </>
      ) : state?.status === "checking" || update.busy ? (
        <p role="status">Checking for updates…</p>
      ) : update.error || state?.status === "error" ? (
        <p role="alert">
          {update.error ?? "Update status could not be checked."}
        </p>
      ) : state?.status === "current" ? (
        <p role="status">You're up to date.</p>
      ) : state?.status === "disabled" ? (
        <p>Update notices are unavailable for this build.</p>
      ) : (
        <p>Update status not checked.</p>
      )}
      {state?.status !== "disabled" ? (
        <Button disabled={update.busy} onClick={() => void update.check()}>
          <RefreshCw aria-hidden="true" /> Check for updates
        </Button>
      ) : null}
      <details className="desktop-update-manual-steps">
        <summary>Update Koed manually</summary>
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
            Download the macOS arm64 release from the official page. Preserve
            homes, configuration, and models.
          </li>
        </ol>
      </details>
      <p>Koed does not download, install, or restart itself.</p>
    </section>
  );
}
