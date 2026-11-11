import { useCallback, useState } from "react";
import { Badge, Button } from "@koed-labs/ui";
import { Group, Row } from "../v1/settings-controls.js";
import { ArrowUpCircle, Check, Download, RefreshCw, X } from "lucide-react";
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
  update
}: {
  update: DesktopUpdateController;
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
          className="desktop-update-button desktop-update-button-primary"
          disabled={update.busy}
          onClick={() => void update.open()}
        >
          <Download aria-hidden="true" /> Download
        </button>
      </div>
    </section>
  );
}

export function DesktopUpdatePanel({
  update,
  installedVersion
}: {
  update?: DesktopUpdateController;
  installedVersion?: string;
}) {
  const state = update?.state;
  const version = availableUpdateVersion(update);
  const installed = state?.installedVersion ?? installedVersion ?? "Loading…";
  const checking = state?.status === "checking" || update?.busy;
  const status = version
    ? `Koed ${version} is available`
    : checking
      ? "Checking…"
      : state?.status === "current"
        ? "Up to date"
        : state?.status === "error"
          ? "Check failed"
          : state?.status === "disabled" || !update
            ? "Unavailable"
            : "Not checked";
  return (
    <Group title="Updates">
      <Row title={"Installed version " + installed}>
        <Badge variant="outline" role="status">
          {state?.status === "current" && <Check />}
          {status}
        </Badge>
      </Row>
      {update && state?.status !== "disabled" && (
        <div className="actions pad">
          {version && (
            <Button
              size="sm"
              disabled={update.busy}
              onClick={() => void update.open()}
            >
              <Download />
              Download {version}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={update.busy}
            onClick={() => void update.check()}
          >
            <RefreshCw />
            {version ? "Check again" : "Check for updates"}
          </Button>
        </div>
      )}
      {(update?.error || state?.status === "error") && (
        <p className="pad" role="alert">
          {update?.error ?? "Update status could not be checked."}
        </p>
      )}
    </Group>
  );
}
