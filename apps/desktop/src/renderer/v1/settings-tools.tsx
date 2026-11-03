import { useEffect, useSyncExternalStore } from "react";
import { ArrowLeft, ChevronRight, ShieldCheck, Terminal } from "lucide-react";
import type { DesktopApi } from "../../types.js";
import { getInstallSetupStore } from "../views/preferences/install-setup-store.js";
import { InstallSetupContent } from "../views/preferences/InstallSetupContent.js";
import type { V1SettingsPage } from "./settings-navigation.js";

type Tool = "privacy" | "cli";
const titles = { privacy: "Privacy Filter", cli: "Command line" };
const description = {
  privacy: "Filters personal information before Team sharing.",
  cli: "Use the koed command from your terminal."
};
const noSubscribe = () => () => {};
const noSnapshot = () => null;
function useInstaller(api?: DesktopApi["cliInstall"]) {
  const store = api ? getInstallSetupStore(api) : null;
  const state = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.snapshot ?? noSnapshot
  );
  useEffect(() => {
    if (store) void store.refresh();
  }, [store]);
  return { store, state };
}
export function SettingsBack({
  parent,
  onBack
}: {
  parent: string;
  onBack: () => void;
}) {
  return (
    <button
      type="button"
      className="v1-settings-back"
      aria-label={`Back to ${parent}`}
      onClick={onBack}
    >
      <ArrowLeft size={15} />
      {parent}
    </button>
  );
}
export function SettingsTools({
  api,
  onOpen
}: {
  api?: DesktopApi["cliInstall"];
  onOpen: (page: V1SettingsPage) => void;
}) {
  const { state } = useInstaller(api);
  return (
    <section className="v1-parity-group">
      <h4>Optional tools</h4>
      <div className="v1-tool-grid">
        {(["privacy", "cli"] as const).map((tool) => {
          const job = state?.[tool];
          const Icon = tool === "privacy" ? ShieldCheck : Terminal;
          const action =
            !job || job.unavailable
              ? "Review setup"
              : job.checking
                ? "Checking…"
                : job.stage === "progress"
                  ? "View progress"
                  : job.stage === "failed"
                    ? "Review setup"
                    : job.stage === "ready"
                      ? "Manage"
                      : "Set up";
          return (
            <button
              key={tool}
              type="button"
              className="v1-tool-card"
              data-settings-page={tool}
              aria-label={`${titles[tool]}: Set up or manage`}
              onClick={() => onOpen(tool)}
            >
              <span className="v1-tool-mark">
                <Icon size={20} />
              </span>
              <span className="v1-tool-copy">
                <strong>{titles[tool]}</strong>
                <span>{description[tool]}</span>
              </span>
              <span className="v1-tool-footer">
                <span className="v1-tool-action">
                  {action}
                  <ChevronRight size={14} />
                </span>
                <small>
                  {job?.checking
                    ? "Checking…"
                    : !job || job.unavailable
                      ? "Unavailable"
                      : job.stage === "ready"
                        ? "Installed"
                        : job.stage === "progress"
                          ? "Installing"
                          : ""}
                </small>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
export function SettingsToolPage({
  tool,
  api,
  onBack
}: {
  tool: Tool;
  api?: DesktopApi["cliInstall"];
  onBack: () => void;
}) {
  const { store, state } = useInstaller(api);
  const job = state?.[tool];
  return (
    <>
      <header className="v1-parity-heading">
        <SettingsBack parent="General" onBack={onBack} />
        <h3>{titles[tool]}</h3>
        <p>
          {tool === "privacy"
            ? "Helps remove personally identifiable information before memory is shared with your Team."
            : "Use the koed command from any terminal."}
        </p>
      </header>
      {store && state && job ? (
        <div className="v1-tool-content">
          <InstallSetupContent
            tool={tool}
            job={job}
            nested
            onInstall={() => {
              if (job.unavailable) void store.refresh();
              else if (job.removing) void store.removeCli();
              else if (tool === "privacy") void store.installPrivacy();
              else void store.installCli();
            }}
            onCancel={() => void store.cancelPrivacy()}
            onRemove={() => void store.removeCli()}
            disabled={job.checking}
            cancelDisabled={state.cancelling}
            heading={
              job.checking
                ? "Checking installation"
                : job.unavailable
                  ? "Setup unavailable"
                  : job.heading
            }
            message={job.message}
            retryStatus={job.unavailable}
            removing={job.removing}
            statusOnly={job.requiresPackagedApp}
          />
        </div>
      ) : (
        <p className="v1-settings-caption" role="status">
          Desktop installer bridge unavailable. Update Koed Desktop, then retry.
        </p>
      )}
    </>
  );
}
