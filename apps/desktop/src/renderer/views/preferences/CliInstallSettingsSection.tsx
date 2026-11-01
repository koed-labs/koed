import { useEffect, useState, useSyncExternalStore } from "react";
import { ChevronRight, ShieldCheck, Terminal } from "lucide-react";
import type { CliInstallApi } from "../../../cli-install/protocol.js";
import { InstallSetupDialog, type InstallTool } from "./InstallSetupDialog.js";
import { getInstallSetupStore } from "./install-setup-store.js";
import "./cli-install-settings.css";

type SettingsProps = {
  api?: CliInstallApi;
  tools?: readonly InstallTool[];
  heading?: string;
};

export function CliInstallSettingsSection({
  api,
  tools,
  heading = "Optional tools"
}: SettingsProps) {
  if (!api)
    return (
      <section className="koed-general-group">
        <h2>{heading}</h2>
        <div
          className="koed-general-card koed-general-appearance"
          role="status"
        >
          Desktop installer bridge unavailable. Update Koed Desktop, then retry.
        </div>
      </section>
    );
  return <InstallSettings api={api} tools={tools} heading={heading} />;
}
function InstallSettings({
  api,
  tools = ["privacy", "cli"],
  heading
}: SettingsProps & { api: CliInstallApi }) {
  const store = getInstallSetupStore(api);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const [tool, setTool] = useState<InstallTool | null>(null);
  const selected = state[tool ?? "privacy"];
  useEffect(() => {
    void store.refresh();
  }, [store]);
  return (
    <section className="koed-general-group">
      <h2>{heading}</h2>
      <div className="koed-general-card">
        {tools.map((kind) => {
          const job = state[kind];
          const Icon = kind === "privacy" ? ShieldCheck : Terminal;
          const title = kind === "privacy" ? "Privacy Filter" : "Command line";
          const description = job.checking
            ? "Checking installation…"
            : job.unavailable
              ? "Setup unavailable · Review details"
              : job.stage === "progress"
                ? "Installation in progress"
                : job.stage === "failed"
                  ? "Setup needs attention"
                  : job.stage === "ready"
                    ? "Installed on this device"
                    : kind === "privacy"
                      ? "Filters personal information before Team sharing."
                      : "Use the koed command from your terminal.";
          return (
            <div className="koed-general-row" key={kind}>
              <span className="koed-general-row-icon">
                <Icon size={18} />
              </span>
              <div className="koed-general-row-copy">
                <strong>{title}</strong>
                <p>{description}</p>
              </div>
              <button
                className="koed-general-action"
                type="button"
                aria-label={`${title}: ${job.stage === "progress" ? "View progress" : "Set up or manage"}`}
                onClick={() => {
                  setTool(kind);
                  void store.refresh();
                }}
              >
                {job.stage === "progress"
                  ? "View progress"
                  : job.stage === "failed" || job.unavailable
                    ? "Review"
                    : job.stage === "ready"
                      ? "Manage"
                      : "Set up"}
                <ChevronRight size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <InstallSetupDialog
        tool={tool ?? "privacy"}
        job={selected}
        open={tool !== null}
        onOpenChange={(open) => {
          if (!open) setTool(null);
        }}
        onInstall={() => {
          if (selected.unavailable) void store.refresh();
          else if (selected.removing) void store.removeCli();
          else if (tool === "privacy") void store.installPrivacy();
          else void store.installCli();
        }}
        onCancel={() => void store.cancelPrivacy()}
        onRemove={() => void store.removeCli()}
        disabled={selected.checking}
        cancelDisabled={state.cancelling}
        heading={
          selected.checking
            ? "Checking installation"
            : selected.unavailable
              ? "Setup unavailable"
              : selected.heading
        }
        message={selected.message}
        retryStatus={selected.unavailable}
        removing={selected.removing}
        statusOnly={selected.requiresPackagedApp}
      />
    </section>
  );
}
