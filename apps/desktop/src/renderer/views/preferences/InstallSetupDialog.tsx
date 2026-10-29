import {
  Button,
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Spinner
} from "@koed/ui";
import {
  Check,
  CircleAlert,
  CircleCheck,
  ShieldCheck,
  Terminal
} from "lucide-react";

export type InstallStage = "idle" | "progress" | "failed" | "ready";
export type InstallState = {
  stage: InstallStage;
  step: number;
  percent: number | null;
  running: boolean;
};
export type InstallTool = "privacy" | "cli";

export const installationSteps = {
  privacy: ["Download components", "Verify files", "Restart Koed services"],
  cli: ["Install launcher", "Add to PATH"]
};

export function InstallSetupDialog({
  tool,
  job,
  open,
  onOpenChange,
  onInstall,
  onCancel,
  onRemove,
  message,
  heading,
  disabled = false,
  cancelDisabled = false,
  retryStatus = false,
  removing = false,
  statusOnly = false
}: {
  tool: InstallTool;
  job: InstallState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: () => void;
  onCancel: () => void;
  onRemove: () => void;
  message?: string;
  heading?: string;
  disabled?: boolean;
  cancelDisabled?: boolean;
  retryStatus?: boolean;
  removing?: boolean;
  statusOnly?: boolean;
}) {
  const privacy = tool === "privacy";
  const busy = !retryStatus && job.stage === "progress";
  const failed = job.stage === "failed";
  const ready = !retryStatus && job.stage === "ready";
  const canCancel = privacy && busy && job.step < 2;
  const Icon = failed
    ? CircleAlert
    : ready
      ? CircleCheck
      : privacy
        ? ShieldCheck
        : Terminal;
  const title = busy
    ? privacy
      ? [
          "Downloading Privacy Filter",
          "Verifying downloaded files",
          "Finishing installation"
        ][job.step]
      : ["Installing command line", "Adding Koed to PATH"][job.step]
    : failed
      ? privacy
        ? "Download interrupted"
        : "Couldn’t update PATH"
      : ready
        ? privacy
          ? "Privacy Filter is ready"
          : "Command line is ready"
        : privacy
          ? "Ready to install"
          : "Command line not installed";
  const description = busy
    ? privacy
      ? [
          "Downloading the components needed on this device.",
          "Checking the files before they are installed.",
          "Restarting local Koed services to activate Privacy Filter."
        ][job.step]
      : [
          "Creating the Koed launcher on this device.",
          "Updating your shell startup file so you can run koed from any folder."
        ][job.step]
    : failed
      ? privacy
        ? "The connection was interrupted. Check your internet connection, then try again."
        : "The launcher was installed, but your shell startup file couldn’t be updated. Check that you have permission to edit it, then retry."
      : ready
        ? privacy
          ? "Installed and available for Team sharing."
          : "Open a new terminal and run koed status to get started."
        : privacy
          ? "Downloads the required local components. Koed services may restart to finish installation."
          : "Installs the Koed launcher and adds it to PATH by updating your shell startup file.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="koed-setup-dialog">
        <DialogHeader>
          <DialogTitle>
            {privacy ? "Privacy Filter" : "Command line"}
          </DialogTitle>
          <DialogDescription>
            {privacy
              ? "Helps remove personally identifiable information (PII) before memory is shared with your Team."
              : "Use the koed command from any terminal."}
          </DialogDescription>
        </DialogHeader>
        <div className="koed-setup-dialog-body">
          <div
            className="koed-setup-install-state"
            data-stage={job.stage}
            role={failed ? "alert" : "status"}
            aria-live={failed ? "assertive" : "polite"}
          >
            <div className="koed-setup-install-state-heading">
              <span className="koed-setup-install-state-icon">
                {busy ? (
                  <Spinner aria-label="Installation in progress" />
                ) : (
                  <Icon size={19} />
                )}
              </span>
              <div>
                <strong>{heading ?? title}</strong>
                <p>{message ?? description}</p>
              </div>
            </div>
            {privacy && busy && job.step === 0 && (
              <div className="koed-setup-download-progress">
                <div>
                  <span>Downloading</span>
                  <span>{job.percent === null ? "" : `${job.percent}%`}</span>
                </div>
                <progress
                  aria-label="Privacy Filter download"
                  value={job.percent ?? undefined}
                  max={100}
                />
              </div>
            )}
          </div>

          {!removing && (busy || (failed && !privacy)) && (
            <ol
              className="koed-setup-install-steps"
              aria-label="Installation steps"
            >
              {installationSteps[tool].map((step, index) => {
                const state =
                  index < job.step
                    ? "complete"
                    : index === job.step
                      ? failed
                        ? "failed"
                        : "active"
                      : "pending";
                return (
                  <li
                    key={step}
                    data-step={state}
                    aria-current={
                      state === "active" || state === "failed"
                        ? "step"
                        : undefined
                    }
                  >
                    <span className="koed-setup-step-icon">
                      {state === "complete" ? (
                        <Check size={13} />
                      ) : state === "failed" ? (
                        <CircleAlert size={13} />
                      ) : (
                        <span>{index + 1}</span>
                      )}
                    </span>
                    <span>{step}</span>
                    <small>
                      {state === "complete"
                        ? "Complete"
                        : state === "failed"
                          ? "Needs attention"
                          : state === "active"
                            ? "In progress"
                            : "Waiting"}
                    </small>
                  </li>
                );
              })}
            </ol>
          )}

          {busy && (
            <p className="koed-setup-install-background">
              You can close this window. Setup will continue in the background.
            </p>
          )}
          {ready && !privacy && (
            <p className="koed-setup-removal-note">
              Removing the command line also removes its Koed-managed PATH
              entry.
            </p>
          )}
          {!statusOnly &&
            ((!busy && !ready) || (ready && !privacy) || canCancel) && (
              <div className="koed-setup-dialog-actions">
                {canCancel ? (
                  <Button
                    disabled={cancelDisabled}
                    variant="outline"
                    onClick={onCancel}
                  >
                    {job.step === 0 ? "Cancel download" : "Cancel installation"}
                  </Button>
                ) : ready ? (
                  <Button
                    disabled={disabled}
                    variant="outline"
                    onClick={onRemove}
                  >
                    Remove command line
                  </Button>
                ) : (
                  <Button disabled={disabled} onClick={onInstall}>
                    {retryStatus
                      ? "Retry status"
                      : failed
                        ? removing
                          ? "Retry removal"
                          : privacy
                            ? job.step === 0
                              ? "Retry download"
                              : "Retry installation"
                            : "Retry setup"
                        : privacy
                          ? "Download and install"
                          : "Install command line"}
                  </Button>
                )}
              </div>
            )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
