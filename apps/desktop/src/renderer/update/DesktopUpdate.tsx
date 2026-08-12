import type { DesktopUpdateState } from "@koed/shared";
import {
  Check,
  CircleAlert,
  Download,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Sparkles,
  X
} from "lucide-react";
import { Button } from "@koed/ui";
import { useEffect } from "react";
import type { DesktopUpdateController } from "./use-desktop-update.js";
import "./update.css";

const stateLabel = (state: DesktopUpdateState): string => {
  switch (state.status) {
    case "disabled":
      return "Updates unavailable";
    case "idle":
      return "Up to date";
    case "checking":
      return "Checking for updates";
    case "available":
      return "Update available";
    case "downloading":
      return "Downloading update";
    case "ready":
      return "Update ready to install";
    case "installing":
      return "Restarting with update";
    case "error":
      return "Update unavailable";
  }
};

const releaseFor = (state: DesktopUpdateState) =>
  "release" in state ? state.release : null;

const triggerIcon = (state: DesktopUpdateState) => {
  switch (state.status) {
    case "available":
      return <Sparkles aria-hidden="true" />;
    case "downloading":
      return <Download aria-hidden="true" />;
    case "ready":
      return <Check aria-hidden="true" />;
    case "checking":
      return <LoaderCircle aria-hidden="true" />;
    case "error":
      return <CircleAlert aria-hidden="true" />;
    default:
      return <RefreshCw aria-hidden="true" />;
  }
};

function ReleaseDetails({
  controller
}: {
  controller: DesktopUpdateController;
}) {
  const release = releaseFor(controller.state);
  if (!release) return null;
  return (
    <div className="desktop-update-release">
      <div>
        <strong>{release.releaseName ?? "Koed Desktop update"}</strong>
        <span>Version {release.version}</span>
      </div>
      {release.releaseNotes ? <p>{release.releaseNotes}</p> : null}
    </div>
  );
}

function UpdateActions({
  controller
}: {
  controller: DesktopUpdateController;
}) {
  const { state, busy } = controller;
  if (controller.manualError) {
    if (state.status === "available") {
      return (
        <Button
          disabled={busy !== null}
          onClick={controller.download}
          type="button"
        >
          <Download aria-hidden="true" /> Try download again
        </Button>
      );
    }
    if (state.status === "ready") {
      return (
        <Button
          disabled={busy !== null}
          onClick={controller.install}
          type="button"
        >
          <RotateCcw aria-hidden="true" /> Try restart again
        </Button>
      );
    }
    return (
      <Button
        disabled={busy !== null}
        onClick={controller.check}
        type="button"
        variant="outline"
      >
        <RefreshCw aria-hidden="true" /> Check again
      </Button>
    );
  }
  if (state.status === "available") {
    return (
      <Button
        disabled={busy !== null}
        onClick={controller.download}
        type="button"
      >
        <Download aria-hidden="true" /> Download update
      </Button>
    );
  }
  if (state.status === "ready") {
    return (
      <Button
        disabled={busy !== null}
        onClick={controller.install}
        type="button"
      >
        <RotateCcw aria-hidden="true" /> Restart and update
      </Button>
    );
  }
  if (state.status === "error") {
    return (
      <Button
        disabled={busy !== null}
        onClick={controller.check}
        type="button"
        variant="outline"
      >
        <RefreshCw aria-hidden="true" /> Check again
      </Button>
    );
  }
  return (
    <Button
      disabled={busy !== null || state.status === "checking"}
      onClick={controller.check}
      type="button"
      variant="outline"
    >
      <RefreshCw aria-hidden="true" /> Check for updates
    </Button>
  );
}

export function DesktopUpdateSurface({
  controller,
  mode = "popover"
}: {
  controller: DesktopUpdateController;
  mode?: "popover" | "preferences";
}) {
  const { state } = controller;
  const release = releaseFor(state);
  const isReady = state.status === "ready";
  const errorVisible =
    Boolean(controller.manualError) || state.status === "error";

  return (
    <section
      aria-labelledby={
        mode === "popover" ? "desktop-update-title" : "koed-update-title"
      }
      className={`desktop-update-surface desktop-update-surface-${mode}`}
      data-state={state.status}
    >
      <header>
        <div>
          <span className="desktop-update-kicker">Desktop updates</span>
          <h2
            id={
              mode === "popover" ? "desktop-update-title" : "koed-update-title"
            }
          >
            {stateLabel(state)}
          </h2>
        </div>
        {mode === "popover" ? (
          <button
            aria-label="Close update details"
            className="desktop-update-close"
            onClick={controller.closeSurface}
            title="Close update details"
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        ) : null}
      </header>
      <div className="desktop-update-copy">
        <p>Current version {controller.version}</p>
        {state.status === "disabled" ? (
          <p>Updates are available only from a packaged Koed Desktop build.</p>
        ) : null}
        {state.status === "checking" ? (
          <p>Checking the stable update channel…</p>
        ) : null}
        {state.status === "idle" ? (
          <p>{controller.notice ?? "No update is waiting to be downloaded."}</p>
        ) : null}
        {state.status === "downloading" ? (
          <div
            className="desktop-update-progress"
            aria-label={`Download progress ${state.progress}%`}
          >
            <progress max="100" value={state.progress} />
            <span>{Math.round(state.progress)}%</span>
          </div>
        ) : null}
        {isReady ? (
          <p className="desktop-update-warning" role="note">
            Restarting will close Koed and reopen it with the downloaded update.
          </p>
        ) : null}
        {errorVisible ? (
          <p className="desktop-update-error" role="alert">
            {controller.manualError ??
              "Updates are temporarily unavailable. Try again when you are ready."}
          </p>
        ) : null}
        {release ? <ReleaseDetails controller={controller} /> : null}
      </div>
      <footer>
        <UpdateActions controller={controller} />
      </footer>
    </section>
  );
}

export function DesktopUpdateIndicator({
  controller
}: {
  controller: DesktopUpdateController;
}) {
  const { state } = controller;
  const isQuietBackgroundError =
    state.status === "error" && !controller.manualError;
  const indicatorState: DesktopUpdateState = isQuietBackgroundError
    ? { status: "idle" }
    : state;
  useEffect(() => {
    if (!controller.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") controller.closeSurface();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [controller]);
  return (
    <div className="desktop-update-control">
      <button
        aria-expanded={controller.open}
        aria-label={stateLabel(indicatorState)}
        className="desktop-update-trigger"
        data-state={indicatorState.status}
        onClick={controller.openSurface}
        title={`${stateLabel(indicatorState)} · Current version ${controller.version}`}
        type="button"
      >
        {triggerIcon(indicatorState)}
        {indicatorState.status === "available" ||
        indicatorState.status === "ready" ? (
          <span aria-hidden="true" className="desktop-update-dot" />
        ) : null}
      </button>
      {controller.open ? (
        <DesktopUpdateSurface controller={controller} />
      ) : null}
    </div>
  );
}

export function DesktopUpdateSection({
  controller
}: {
  controller: DesktopUpdateController;
}) {
  return <DesktopUpdateSurface controller={controller} mode="preferences" />;
}
