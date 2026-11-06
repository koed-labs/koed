import { useEffect, useState, useSyncExternalStore } from "react";
import { Badge, Button, Card } from "@koed/ui";
import { CircleCheck, CircleAlert, ShieldCheck, Terminal } from "lucide-react";
import type { DesktopApi } from "../../types.js";
import { getInstallSetupStore } from "../views/preferences/install-setup-store.js";
import {
  installationSteps,
  type InstallTool
} from "../views/preferences/InstallSetupContent.js";
import {
  Group,
  PageHeading,
  PageLink,
  Row,
  ConfirmAction,
  type Detail,
  details
} from "./settings-controls.js";
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
export function SettingsTools({
  api,
  onOpen
}: {
  api?: DesktopApi["cliInstall"];
  onOpen: (page: Detail) => void;
}) {
  const { state } = useInstaller(api);
  return (
    <Group title="Optional tools">
      {(["privacy", "cli"] as const).map((tool) => {
        const job = state?.[tool];
        const note = job?.checking
          ? "Checking…"
          : !job || job.unavailable
            ? "Unavailable · Review setup"
            : job.stage === "ready"
              ? "Installed · " +
                (tool === "cli"
                  ? "Use koed from your terminal."
                  : "Ready for Team sharing.")
              : job.stage === "progress"
                ? "Installation in progress"
                : job.stage === "failed"
                  ? "Installation needs attention · Review setup"
                  : details[tool].description;
        return <PageLink key={tool} page={tool} onOpen={onOpen} note={note} />;
      })}
    </Group>
  );
}
export function SettingsToolPage({
  tool,
  api,
  onBack
}: {
  tool: InstallTool;
  api?: DesktopApi["cliInstall"];
  onBack: () => void;
}) {
  const { store, state } = useInstaller(api);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const job = state?.[tool];
  const header = <PageHeading page={tool} onBack={onBack} />;
  if (!job || !store || !state)
    return (
      <>
        {header}
        <p role="status">
          Desktop installer bridge unavailable. Update Koed Desktop, then retry.
        </p>
      </>
    );
  const privacy = tool === "privacy";
  const ready = !job.unavailable && !job.checking && job.stage === "ready";
  const busy = !job.unavailable && job.stage === "progress";
  const failed = job.stage === "failed";
  const Icon = failed
    ? CircleAlert
    : ready
      ? CircleCheck
      : privacy
        ? ShieldCheck
        : Terminal;
  const title = job.checking
    ? "Checking installation"
    : job.unavailable
      ? "Setup unavailable"
      : (job.heading ??
        (ready
          ? details[tool].label + " is ready"
          : busy
            ? installationSteps[tool][job.step]
            : failed
              ? "Setup needs attention"
              : "Ready to install"));
  const description =
    job.message ||
    (ready
      ? privacy
        ? "Available for Team sharing on this device."
        : "Open a new terminal and run the command below."
      : privacy
        ? "Download the runtime and pinned model. Local services may restart during activation."
        : "Install the launcher and add it to your shell PATH.");
  const install = job.unavailable
    ? store.refresh
    : job.removing
      ? store.removeCli
      : privacy
        ? store.installPrivacy
        : store.installCli;
  return (
    <>
      {header}
      <Card className="tool-status">
        <Icon />
        <div>
          <strong>{title}</strong>
          <p role={failed || job.unavailable ? "alert" : "status"}>
            {description}
          </p>
        </div>
      </Card>
      {ready && !privacy && (
        <Group title="Try it in a new terminal">
          <pre className="code-line">
            <Terminal size={15} />
            koed status
          </pre>
        </Group>
      )}
      {!ready && !job.removing && !job.unavailable && !job.checking && (
        <Group title={busy ? "Installation progress" : "Installation steps"}>
          {installationSteps[tool].map((step, i) => (
            <Row key={step} title={step}>
              <Badge variant={busy && i === job.step ? "primary" : "outline"}>
                {(busy || failed) && i < job.step
                  ? "Complete"
                  : i === job.step && busy
                    ? "In progress"
                    : i === job.step && failed
                      ? "Needs attention"
                      : "Waiting"}
              </Badge>
            </Row>
          ))}
        </Group>
      )}
      {privacy && busy && job.step === 0 && (
        <progress
          aria-label="Privacy Filter download"
          max={100}
          value={job.percent ?? undefined}
        />
      )}
      <div className="actions">
        {!job.requiresPackagedApp && !busy && !ready && (
          <Button disabled={job.checking} onClick={() => void install()}>
            {job.unavailable
              ? "Retry status"
              : failed
                ? "Retry"
                : privacy
                  ? "Download and install"
                  : "Install command line"}
          </Button>
        )}
        {busy && privacy && job.step < 2 && (
          <Button
            variant="outline"
            disabled={state.cancelling}
            onClick={() => void store.cancelPrivacy()}
          >
            Cancel {job.step === 0 ? "download" : "installation"}
          </Button>
        )}
        {ready && !privacy && (
          <Button variant="outline" onClick={() => setConfirmRemove(true)}>
            Remove command line
          </Button>
        )}
      </div>
      {busy && (
        <p className="muted">
          You can go back. Setup continues in the background.
        </p>
      )}
      {confirmRemove && (
        <ConfirmAction
          title="Remove command line?"
          description="Remove the Koed launcher and its managed shell PATH entry from this device."
          label="Remove"
          destructive
          close={() => setConfirmRemove(false)}
          confirm={() => void store.removeCli()}
        />
      )}
    </>
  );
}
