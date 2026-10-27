import { Button } from "@koed/ui";
import { ArrowUpCircle } from "lucide-react";
import type { DesktopUpdateController } from "./use-desktop-update.js";
import "./desktop-update.css";

export function DesktopUpdateIndicator({
  update,
  onOpen
}: {
  update: DesktopUpdateController;
  onOpen: () => void;
}) {
  if (!update.state?.release) return null;
  return (
    <Button
      aria-label="Update available"
      onClick={onOpen}
      size="sm"
      variant="outline"
    >
      <ArrowUpCircle aria-hidden="true" /> Update available
    </Button>
  );
}

const statusMessage = (update: DesktopUpdateController): string => {
  if (update.error) return update.error;
  switch (update.state?.status) {
    case "current":
      return "Koed is up to date.";
    case "checking":
      return "Checking for updates…";
    case "available":
      return "A new version of Koed is available.";
    case "error":
      return "Could not check for a supported update. Wait at least one minute before trying again.";
    case "idle":
      return "Check for the latest stable version of Koed.";
    default:
      return "Update checks are unavailable in this build.";
  }
};

function ManualUpdateInstructions() {
  return (
    <section aria-label="Manual update instructions">
      <h3>Update manually</h3>
      <ol>
        <li>
          Open the official release. Use its macOS arm64 download and
          signed-install verification instructions. Never bypass Gatekeeper.
        </li>
        <li>
          Pause AI Client and CLI activity that could restart services, then
          quit Desktop.
        </li>
        <li>
          For each home using this app, use its installed Desktop CLI launcher:{" "}
          <code>koed status --json</code>. If a CLI-started runtime remains,
          explicitly run <code>koed stop --json</code> and require{" "}
          <code>ok: true</code>.
        </li>
        <li>
          Recheck <code>koed status --json</code>; require{" "}
          <code>lifecycle.state: stopped</code>. Closing Desktop alone may leave
          CLI runtimes alive. Unknown ownership or remaining activity blocks
          replacement.
        </li>
        <li>
          Replace Koed at its existing supported location, reopen and verify
          version and services. Keep your Koed home, Personal Memory,
          configuration and models; do not reset or downgrade them.
        </li>
      </ol>
      <p>
        The installed launcher is bound to its home; prefixing another{" "}
        <code>KOED_HOME</code> does not select that home. If you cannot verify
        every runtime using this app, do not replace it yet.
      </p>
    </section>
  );
}

export function DesktopUpdatePanel({
  update
}: {
  update: DesktopUpdateController;
}) {
  const state = update.state;
  const disabled = !state || state.status === "disabled";
  return (
    <section
      aria-labelledby="desktop-update-title"
      className="desktop-update-panel"
    >
      <h2 id="desktop-update-title">Updates</h2>
      <p>Installed version: {state?.installedVersion ?? "Unavailable"}</p>
      <p aria-live="polite" role="status">
        {statusMessage(update)}
      </p>
      {state?.checkedAt ? (
        <p>
          Checks are limited to one per minute; a repeat may show the previous
          result.
        </p>
      ) : null}
      {state?.release ? (
        <>
          <p>Latest stable version: {state.release.version}</p>
          {state.release.summary ? (
            <p className="desktop-update-summary">{state.release.summary}</p>
          ) : null}
        </>
      ) : null}
      <div className="desktop-update-actions">
        <Button
          disabled={disabled || update.busy || state.status === "checking"}
          onClick={update.check}
          variant="outline"
        >
          Check for updates
        </Button>
        {state?.release ? (
          <Button disabled={update.busy} onClick={update.open}>
            View release
          </Button>
        ) : null}
      </div>
      {state?.release ? <ManualUpdateInstructions /> : null}
    </section>
  );
}
