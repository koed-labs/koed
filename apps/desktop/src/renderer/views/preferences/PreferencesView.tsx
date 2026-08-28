import {
  Button,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  Input,
  Spinner
} from "@koed/ui";
import type { CollaborationSnapshot } from "@koed/shared/collaboration";
import type { DesktopThemePreference } from "../../../window/theme-preference.js";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  Network,
  Play,
  RefreshCw,
  Trash2,
  Wrench
} from "lucide-react";
import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactNode
} from "react";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
import type { ComponentStatus, KoedServerStatus } from "../../../types.js";
import type { DesktopStatusStore } from "../../services/desktop-commands.js";
import type { DesktopApi } from "../../../types.js";
import { clientMetaLine, summarizeCapabilities } from "../ai-client-card.js";
import { LocalAiClientSettingsSection } from "./LocalAiClientSettingsSection.js";
import { useDesktopStatus } from "../../state/use-status.js";
import "../ai-client-card.css";
import "./preferences.css";

export type PreferencesSection =
  | "general"
  | "capture"
  | "ai-clients"
  | "team-connection"
  | "about"
  | "advanced";

export type CapturePreferencesCapability = {
  pause?: {
    pausedUntil: string | null;
    onPause: (minutes: number) => void | Promise<void>;
    onResume: () => void | Promise<void>;
  };
  policy?: {
    description: string;
    label: string;
    onOpen: () => void;
  };
  state?: {
    onChange: (state: "enabled" | "disabled" | "ask") => void | Promise<void>;
    value: "enabled" | "disabled" | "ask";
  };
};

export type LocalLaunchCapability = {
  enabled: boolean;
  label: string;
  onChange: (enabled: boolean) => void | Promise<void>;
};

export type PreferencesViewProps = {
  acknowledgements?: readonly string[];
  capture?: CapturePreferencesCapability;
  collaborationClient?: CollaborationRendererClient;
  collaborationSnapshot?: CollaborationSnapshot | null;
  initialSection?: PreferencesSection;
  hardwareAcceleration?: DesktopApi["hardwareAcceleration"];
  launch?: LocalLaunchCapability;
  localAiClients?: DesktopApi["localAiClients"];
  onSectionChange?: (section: PreferencesSection) => void;
  onThemeChange: (theme: DesktopThemePreference) => void;
  statusStore: DesktopStatusStore;
  theme: DesktopThemePreference;
  version: string;
};

const sections: readonly {
  id: PreferencesSection;
  label: string;
}[] = [
  { id: "general", label: "General" },
  { id: "ai-clients", label: "Agents" },
  { id: "team-connection", label: "Teams" },
  { id: "advanced", label: "Services" },
  { id: "about", label: "About" }
];

const sectionTitle = (section: PreferencesSection): string =>
  sections.find(({ id }) => id === section)?.label ?? "Preferences";

function SettingRow({
  children,
  description,
  label
}: {
  children: ReactNode;
  description: string;
  label: string;
}) {
  return (
    <div className="koed-preference-row">
      <div>
        <strong>{label}</strong>
        <p>{description}</p>
      </div>
      <div className="koed-preference-control">{children}</div>
    </div>
  );
}

function GeneralSection({
  hardwareAcceleration,
  launch,
  onThemeChange,
  theme
}: Pick<
  PreferencesViewProps,
  "hardwareAcceleration" | "launch" | "onThemeChange" | "theme"
>) {
  return (
    <div className="koed-preference-section">
      <fieldset className="koed-theme-options">
        <legend>Theme</legend>
        <p>Use a light theme, dark theme, or follow this device.</p>
        <div>
          {(["light", "dark", "system"] as const).map((option) => (
            <label key={option}>
              <input
                checked={theme === option}
                name="theme"
                onChange={() => onThemeChange(option)}
                type="radio"
                value={option}
              />
              <span>{option[0]!.toLocaleUpperCase() + option.slice(1)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <HardwareAccelerationSetting api={hardwareAcceleration} />
      {launch ? (
        <SettingRow
          description="This preference stays on this device."
          label={launch.label}
        >
          <input
            aria-label={launch.label}
            checked={launch.enabled}
            onChange={(event) =>
              void launch.onChange(event.currentTarget.checked)
            }
            type="checkbox"
          />
        </SettingRow>
      ) : null}
    </div>
  );
}

function HardwareAccelerationSetting({
  api
}: {
  api?: DesktopApi["hardwareAcceleration"];
}) {
  const [state, setState] = useState<{
    enabled: boolean;
    managedByEnvironment: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!api) return;
    void api
      .get()
      .then((value) => {
        if (active) setState(value);
      })
      .catch(() => {
        if (active) setError("Hardware acceleration could not be read.");
      });
    return () => {
      active = false;
    };
  }, [api]);

  if (!api) return null;
  return (
    <SettingRow
      description={
        state?.managedByEnvironment
          ? "This setting is managed by the Operator environment."
          : "Use a compatible local GPU for Koed inference. Changing this restarts local Koed services."
      }
      label="Hardware acceleration"
    >
      <div className="koed-preference-toggle-state">
        <input
          aria-label="Hardware acceleration"
          checked={state?.enabled ?? false}
          disabled={state === null || state.managedByEnvironment || busy}
          onChange={(event) => {
            const enabled = event.currentTarget.checked;
            setBusy(true);
            setError(null);
            void api
              .set(enabled)
              .then(setState)
              .catch(() =>
                setError("Hardware acceleration could not be changed.")
              )
              .finally(() => setBusy(false));
          }}
          type="checkbox"
        />
        {busy ? <Spinner aria-label="Restarting local Koed services" /> : null}
        {error ? <span role="alert">{error}</span> : null}
      </div>
    </SettingRow>
  );
}

function CaptureSection({ capture }: Pick<PreferencesViewProps, "capture">) {
  if (!capture || (!capture.state && !capture.pause && !capture.policy)) {
    return (
      <div className="koed-preference-unavailable" role="status">
        <AlertTriangle aria-hidden="true" />
        <div>
          <strong>Capture controls are unavailable</strong>
          <p>
            This Desktop connection does not expose Capture State, Capture
            Pause, or Capture Policy commands. No setting has been inferred.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="koed-preference-section">
      {capture.state ? (
        <SettingRow
          description="Decides whether eligible AI Client activity may be captured automatically."
          label="Capture State"
        >
          <select
            aria-label="Capture State"
            onChange={(event) =>
              void capture.state!.onChange(
                event.currentTarget.value as "enabled" | "disabled" | "ask"
              )
            }
            value={capture.state.value}
          >
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
            <option value="ask">Ask first</option>
          </select>
        </SettingRow>
      ) : null}
      {capture.pause ? (
        <SettingRow
          description={
            capture.pause.pausedUntil
              ? `Automatic capture is paused until ${new Date(capture.pause.pausedUntil).toLocaleString()}.`
              : "Temporarily block automatic capture without changing or deleting your Capture Policy."
          }
          label="Capture Pause"
        >
          {capture.pause.pausedUntil ? (
            <Button
              onClick={() => void capture.pause!.onResume()}
              variant="outline"
            >
              Resume capture
            </Button>
          ) : (
            <select
              aria-label="Pause capture"
              defaultValue=""
              onChange={(event) => {
                const minutes = Number(event.currentTarget.value);
                if (minutes > 0) void capture.pause!.onPause(minutes);
                event.currentTarget.value = "";
              }}
            >
              <option disabled value="">
                Pause…
              </option>
              <option value="60">For 1 hour</option>
              <option value="480">For 8 hours</option>
              <option value="1440">For 24 hours</option>
            </select>
          )}
        </SettingRow>
      ) : null}
      {capture.policy ? (
        <SettingRow
          description={capture.policy.description}
          label="Capture Policy"
        >
          <Button onClick={capture.policy.onOpen} variant="outline">
            {capture.policy.label}
          </Button>
        </SettingRow>
      ) : null}
      <p className="koed-trust-note">
        Capture records eligible AI Client Conversations into Personal Memory.
        Team Chat is not automatically AI Client context.
      </p>
    </div>
  );
}

const connectionLabel = (
  snapshot: CollaborationSnapshot | null | undefined
): string => {
  switch (snapshot?.connection.state) {
    case "live":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "access_revoked":
      return "Access revoked";
    case "unavailable":
      return "Unavailable";
    case "disconnected":
    case undefined:
      return "Not connected";
  }
};

function TeamConnectionSection({
  collaborationClient,
  collaborationSnapshot
}: Pick<
  PreferencesViewProps,
  "collaborationClient" | "collaborationSnapshot"
>) {
  const [remoteUrl, setRemoteUrl] = useState(
    collaborationClient?.currentRemoteUrl() ?? ""
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const inputId = useId();
  const state = collaborationSnapshot?.connection.state ?? "disconnected";

  useEffect(() => {
    setRemoteUrl(collaborationClient?.currentRemoteUrl() ?? "");
  }, [collaborationClient, collaborationSnapshot?.connection.backendId]);

  if (!collaborationClient) {
    return (
      <div className="koed-preference-unavailable" role="status">
        <Network aria-hidden="true" />
        <div>
          <strong>Team Connection is unavailable</strong>
          <p>The collaboration client is not available in this window.</p>
        </div>
      </div>
    );
  }

  const submit = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const connect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = remoteUrl.trim();
    if (!normalized) {
      setError("Enter a remote Team Backend URL.");
      return;
    }
    void submit(() =>
      collaborationClient.connectRemote({ remoteUrl: normalized })
    );
  };

  return (
    <div className="koed-preference-section">
      <div className="koed-connection-state" data-state={state}>
        {state === "live" ? (
          <Check aria-hidden="true" />
        ) : state === "connecting" || state === "reconnecting" ? (
          <Spinner aria-hidden="true" />
        ) : (
          <Network aria-hidden="true" />
        )}
        <div>
          <strong>{connectionLabel(collaborationSnapshot)}</strong>
          <p>
            Personal Memory stays local when the remote Team Backend is removed.
          </p>
        </div>
      </div>
      <form className="koed-connection-form" onSubmit={connect}>
        <label htmlFor={inputId}>Remote Team Backend URL</label>
        <Input
          autoComplete="url"
          id={inputId}
          onChange={(event) => setRemoteUrl(event.currentTarget.value)}
          placeholder="https://team.example.com"
          type="url"
          value={remoteUrl}
        />
        {state === "live" ? (
          <p>
            Connecting to a different backend clears authorized Team state from
            this device. It does not change Personal Memory.
          </p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <div className="koed-connection-actions">
          {state !== "disconnected" ? (
            <Button
              disabled={busy}
              onClick={() => setConfirmRemove(true)}
              type="button"
              variant="destructive-outline"
            >
              Remove connection
            </Button>
          ) : null}
          {state !== "live" && collaborationSnapshot?.connection.backendId ? (
            <Button
              disabled={busy}
              onClick={() => void submit(() => collaborationClient.reconnect())}
              type="button"
              variant="outline"
            >
              <RefreshCw aria-hidden="true" /> Reconnect
            </Button>
          ) : null}
          <Button disabled={busy} type="submit">
            {busy
              ? "Working…"
              : state === "live"
                ? "Change backend"
                : "Connect"}
          </Button>
        </div>
      </form>

      <Dialog onOpenChange={setConfirmRemove} open={confirmRemove}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Remove Team Connection?</DialogTitle>
            <DialogDescription>
              Koed will clear authorized Team state from this device. Personal
              Memory remains local and available.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              onClick={() => {
                setConfirmRemove(false);
                void submit(() => collaborationClient.disconnect());
              }}
              variant="destructive"
            >
              Remove connection
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function AboutSection({
  acknowledgements = [
    "DM Sans — SIL Open Font License 1.1",
    "React and Electron — open-source software",
    "Base UI and Lucide — open-source interface components"
  ],
  version
}: Pick<PreferencesViewProps, "acknowledgements" | "version">) {
  return (
    <div className="koed-preference-section">
      <dl className="koed-about-list">
        <div>
          <dt>Version</dt>
          <dd>{version}</dd>
        </div>
        <div>
          <dt>License</dt>
          <dd>Apache License 2.0</dd>
        </div>
      </dl>
      <section aria-labelledby="koed-acknowledgements-title">
        <h2 id="koed-acknowledgements-title">Acknowledgements</h2>
        <ul>
          {acknowledgements.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

type IntegrationMutationCommand =
  | "setup_codex"
  | "repair_codex"
  | "remove_codex"
  | "setup_pi"
  | "repair_pi"
  | "remove_pi"
  | "setup_claude"
  | "repair_claude"
  | "remove_claude";

const integrationConsentCopy: Record<
  IntegrationMutationCommand,
  { title: string; description: string; confirmLabel: string }
> = {
  setup_codex: {
    title: "Set up the Codex integration?",
    description:
      "Koed will add its marked Codex integration block and Supported Capture Hook. Unrelated settings, credentials, and other clients remain untouched.",
    confirmLabel: "Set up Codex"
  },
  repair_codex: {
    title: "Repair the Codex integration?",
    description:
      "Koed will replace only its marked Codex integration block and Supported Capture Hook. Unrelated settings and credentials remain untouched.",
    confirmLabel: "Repair Codex"
  },
  remove_codex: {
    title: "Remove the Codex integration?",
    description:
      "Koed will remove only its marked Codex integration block. Unrelated settings and credentials remain untouched.",
    confirmLabel: "Remove Codex"
  },
  setup_pi: {
    title: "Set up the Pi integration?",
    description:
      "Koed will register its local package in your active global Pi profile, or remove only that Koed-owned package. It preserves unrelated Pi settings, packages, and provider credentials.",
    confirmLabel: "Set up Pi"
  },
  repair_pi: {
    title: "Repair the Pi integration?",
    description:
      "Koed will replace only its package in the active Pi profile. Unrelated packages, settings, and provider credentials remain untouched.",
    confirmLabel: "Repair Pi"
  },
  remove_pi: {
    title: "Remove the Pi integration?",
    description:
      "Koed will remove only its package from the active Pi profile and preserve unrelated packages, settings, and provider credentials.",
    confirmLabel: "Remove Pi"
  },
  setup_claude: {
    title: "Set up the Claude Code integration?",
    description:
      "Koed will add its MCP Server and Supported Capture Hook to Claude Code settings, or remove only those Koed-owned entries. It preserves unrelated settings, hooks, and provider credentials.",
    confirmLabel: "Set up Claude Code"
  },
  repair_claude: {
    title: "Repair the Claude Code integration?",
    description:
      "Koed will replace only its MCP Server and Supported Capture Hook entries in Claude Code. Unrelated settings, hooks, and provider credentials remain untouched.",
    confirmLabel: "Repair Claude Code"
  },
  remove_claude: {
    title: "Remove the Claude Code integration?",
    description:
      "Koed will remove only its owned MCP Server and Supported Capture Hook entries. Unrelated settings, hooks, and provider credentials remain untouched.",
    confirmLabel: "Remove Claude Code"
  }
};

function AiClientsSection({
  localAiClients,
  statusStore
}: Pick<PreferencesViewProps, "localAiClients" | "statusStore">) {
  return (
    <div className="koed-preference-section">
      <AiClientIntegrationsSection statusStore={statusStore} />
      <LocalAiClientSettingsSection localAiClients={localAiClients} />
    </div>
  );
}

const preferenceClients: readonly {
  id: "codex" | "claude" | "pi";
  label: string;
}[] = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
  { id: "pi", label: "Pi" }
];

const flatClientStatus = (
  id: "codex" | "claude" | "pi",
  status: KoedServerStatus | null
): (ComponentStatus & { configured: boolean }) | undefined =>
  id === "codex"
    ? status?.codex
    : id === "claude"
      ? status?.claudeCode
      : status?.pi;

function AiClientIntegrationsSection({
  statusStore
}: Pick<PreferencesViewProps, "statusStore">) {
  const snapshot = useDesktopStatus(statusStore);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] =
    useState<IntegrationMutationCommand | null>(null);
  const status = snapshot.status;

  useEffect(() => {
    void statusStore.refresh();
  }, [statusStore]);

  const run = async (
    action:
      | "check_codex"
      | "check_claude"
      | "check_pi"
      | IntegrationMutationCommand
  ) => {
    setActionError(null);
    try {
      const mutatesProfile = !action.startsWith("check_");
      await statusStore.run(
        action,
        mutatesProfile ? { operatorConsented: true } : undefined
      );
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section
      aria-labelledby="koed-pref-ai-clients-title"
      className="koed-pref-client-section"
    >
      <div className="koed-pref-client-heading">
        <h2 id="koed-pref-ai-clients-title">Connections</h2>
      </div>
      {actionError ? (
        <p className="koed-diagnostic-error" role="alert">
          {actionError}
        </p>
      ) : null}
      <div className="koed-pref-client-grid">
        {preferenceClients.map(({ id, label }) => {
          const readiness = status?.aiClients?.[id];
          const detected = readiness?.installed.state === "healthy";
          const flat = flatClientStatus(id, status);
          const profileState = flat?.state ?? "not_configured";
          const capabilitySummaries = summarizeCapabilities(
            readiness?.capabilities
          );
          const metaLine =
            profileState === "healthy"
              ? clientMetaLine(readiness, detected)
              : profileState === "starting"
                ? null
                : detected
                  ? "Could not be started"
                  : "Not installed";
          const pillClass =
            profileState === "healthy"
              ? "is-success"
              : profileState === "needs_attention"
                ? "is-warning"
                : profileState === "starting"
                  ? "is-active"
                  : "is-off";
          const pillText =
            profileState === "healthy"
              ? "Healthy"
              : profileState === "needs_attention"
                ? "Needs attention"
                : profileState === "starting"
                  ? "Starting…"
                  : "Not set up";
          const notConfigured = profileState === "not_configured";
          const primaryCommand =
            `${notConfigured ? "setup" : "repair"}_${id}` as IntegrationMutationCommand;
          const removeCommand = `remove_${id}` as IntegrationMutationCommand;
          return (
            <div
              className="koed-client-card koed-pref-client-card"
              data-state={profileState === "starting" ? "active" : undefined}
              key={id}
            >
              <span className="koed-client-head">
                <strong>{label}</strong>
                <span className={`koed-client-pill ${pillClass}`}>
                  {profileState === "starting" ? (
                    <Spinner aria-hidden="true" className="koed-client-spin" />
                  ) : null}
                  {pillText}
                </span>
              </span>
              {metaLine ? (
                <span className="koed-client-meta">{metaLine}</span>
              ) : null}
              <span className="koed-client-caps">
                {capabilitySummaries.map((capability) => (
                  <span
                    aria-label={`${capability.label}: ${capability.statusLabel}`}
                    className="koed-client-cap"
                    key={capability.id}
                    title={`${capability.label}: ${capability.statusLabel}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`koed-client-cap-dot ${capability.dotClass}`}
                    />
                    {capability.label}
                  </span>
                ))}
              </span>
              <span className="koed-pref-client-actions">
                <Button
                  aria-label={`${notConfigured ? "Set up" : "Repair"} ${label}`}
                  disabled={snapshot.busyCommand !== null}
                  onClick={() => setPendingCommand(primaryCommand)}
                  size="icon"
                  title={`${notConfigured ? "Set up" : "Repair"} ${label}`}
                  variant="outline"
                >
                  {notConfigured ? (
                    <Play aria-hidden="true" />
                  ) : (
                    <Wrench aria-hidden="true" />
                  )}
                </Button>
                <Button
                  aria-label={`Check ${label}`}
                  disabled={snapshot.busyCommand !== null}
                  onClick={() => void run(`check_${id}`)}
                  size="icon"
                  title={`Check ${label}`}
                  variant="outline"
                >
                  <RefreshCw aria-hidden="true" />
                </Button>
                {!notConfigured ? (
                  <Button
                    aria-label={`Remove ${label}`}
                    disabled={snapshot.busyCommand !== null}
                    onClick={() => setPendingCommand(removeCommand)}
                    size="icon"
                    title={`Remove ${label}`}
                    variant="destructive-outline"
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
      <Dialog
        onOpenChange={(open) => {
          if (!open) setPendingCommand(null);
        }}
        open={pendingCommand !== null}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {pendingCommand
                ? integrationConsentCopy[pendingCommand].title
                : "AI Client integration"}
            </DialogTitle>
            <DialogDescription>
              {pendingCommand
                ? integrationConsentCopy[pendingCommand].description
                : "Koed changes only its own AI Client integration state."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              onClick={() => {
                const command = pendingCommand;
                setPendingCommand(null);
                if (command) void run(command);
              }}
            >
              {pendingCommand
                ? integrationConsentCopy[pendingCommand].confirmLabel
                : "Continue"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </section>
  );
}

function AdvancedSection({
  statusStore
}: Pick<PreferencesViewProps, "statusStore">) {
  const snapshot = useDesktopStatus(statusStore);
  const [actionError, setActionError] = useState<string | null>(null);
  const [runningAction, setRunningAction] = useState<
    "doctor" | "status" | null
  >(null);
  const status = snapshot.status;

  useEffect(() => {
    void statusStore.refresh();
  }, [statusStore]);

  const servicesAreStarting = status
    ? [
        status.api,
        status.database,
        status.workerQueues,
        status.embeddingService
      ].some((component) => component.state === "starting")
    : false;

  useEffect(() => {
    if (!servicesAreStarting) return;
    const timeout = setTimeout(() => void statusStore.refresh(), 1_500);
    return () => clearTimeout(timeout);
  }, [servicesAreStarting, snapshot.revision, statusStore]);

  const run = async (action: "doctor" | "open_logs" | "status") => {
    setActionError(null);
    if (action !== "open_logs") setRunningAction(action);
    try {
      if (action === "status") await statusStore.refresh();
      else await statusStore.run(action);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (action !== "open_logs") setRunningAction(null);
    }
  };

  const components: [string, ComponentStatus][] = status
    ? (
        [
          ["Server package", status.serverPackage],
          ["API", status.api],
          ["Database", status.database],
          ["Worker queues", status.workerQueues],
          ["Embedding Service", status.embeddingService],
          ["MCP Server", status.mcpServer],
          ["Capture Hook", status.captureHook],
          ["LCM Summary Service", status.lcmSummaryService],
          ["Personal Device Sync", status.personalDeviceSync]
        ] as const
      ).flatMap(([label, component]) => (component ? [[label, component]] : []))
    : [];
  const servicesNeedingAttention = components.filter(
    ([, component]) => component.state !== "healthy"
  ).length;
  const allServicesAreHealthy =
    components.length > 0 && servicesNeedingAttention === 0;

  return (
    <div className="koed-preference-section">
      <details className="koed-diagnostics">
        <summary>
          <span
            className="koed-diagnostics-summary-status"
            data-state={allServicesAreHealthy ? "healthy" : "needs_attention"}
          >
            {allServicesAreHealthy ? (
              <CircleCheck aria-hidden="true" />
            ) : (
              <CircleAlert aria-hidden="true" />
            )}
            {status
              ? allServicesAreHealthy
                ? "All services are healthy"
                : `${servicesNeedingAttention}/${components.length} services need attention`
              : "Service status unavailable"}
          </span>
          <ChevronDown
            aria-hidden="true"
            className="koed-diagnostics-chevron"
          />
        </summary>
        {!status ? (
          <p role="status">Status has not loaded.</p>
        ) : (
          <dl>
            {components.map(([label, component]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  <strong>
                    {component.state === "healthy"
                      ? "Healthy"
                      : component.state.replaceAll("_", " ")}
                  </strong>
                  {component.state !== "healthy" && component.message ? (
                    <span>{component.message}</span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </details>
      {snapshot.error || actionError ? (
        <p className="koed-diagnostic-error" role="alert">
          {actionError ?? snapshot.error}
        </p>
      ) : null}
      <div className="koed-diagnostic-actions">
        <Button
          aria-busy={runningAction === "status"}
          aria-label={
            runningAction === "status" ? "Refreshing status" : "Refresh status"
          }
          disabled={snapshot.busyCommand !== null || runningAction !== null}
          onClick={() => void run("status")}
          size="icon"
          title={
            runningAction === "status" ? "Refreshing status" : "Refresh status"
          }
          variant="outline"
        >
          {runningAction === "status" ? (
            <Spinner aria-hidden="true" />
          ) : (
            <RefreshCw aria-hidden="true" />
          )}
        </Button>
        <Button
          aria-busy={runningAction === "doctor"}
          aria-label={
            runningAction === "doctor"
              ? "Running diagnostics"
              : "Run diagnostics"
          }
          disabled={snapshot.busyCommand !== null || runningAction !== null}
          onClick={() => void run("doctor")}
          size="icon"
          title={
            runningAction === "doctor"
              ? "Running diagnostics"
              : "Run diagnostics"
          }
          variant="outline"
        >
          {runningAction === "doctor" ? (
            <Spinner aria-hidden="true" />
          ) : (
            <Wrench aria-hidden="true" />
          )}
        </Button>
        <Button
          aria-label="Open logs"
          disabled={snapshot.busyCommand !== null || runningAction !== null}
          onClick={() => void run("open_logs")}
          size="icon"
          title="Open logs"
          variant="outline"
        >
          <ExternalLink aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

export function PreferencesView({
  acknowledgements,
  capture,
  collaborationClient,
  collaborationSnapshot,
  initialSection = "general",
  hardwareAcceleration,
  launch,
  localAiClients,
  onSectionChange,
  onThemeChange,
  statusStore,
  theme,
  version
}: PreferencesViewProps) {
  const visibleInitialSection =
    initialSection === "capture" ? "general" : initialSection;
  const [section, setSection] = useState<PreferencesSection>(
    visibleInitialSection
  );

  useEffect(
    () => setSection(initialSection === "capture" ? "general" : initialSection),
    [initialSection]
  );

  const selectSection = (next: PreferencesSection) => {
    setSection(next);
    onSectionChange?.(next);
  };

  return (
    <main className="koed-preferences">
      <nav aria-label="Preference sections">
        <h1>Preferences</h1>
        {sections.map((item) => (
          <button
            aria-current={section === item.id ? "page" : undefined}
            data-active={section === item.id || undefined}
            key={item.id}
            onClick={() => selectSection(item.id)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </nav>
      <section
        aria-labelledby="koed-preference-section-title"
        className="koed-preferences-content"
      >
        <header>
          <h1 id="koed-preference-section-title">{sectionTitle(section)}</h1>
        </header>
        {section === "general" ? (
          <GeneralSection
            hardwareAcceleration={hardwareAcceleration}
            launch={launch}
            onThemeChange={onThemeChange}
            theme={theme}
          />
        ) : null}
        {section === "capture" ? <CaptureSection capture={capture} /> : null}
        {section === "ai-clients" ? (
          <AiClientsSection
            localAiClients={localAiClients}
            statusStore={statusStore}
          />
        ) : null}
        {section === "team-connection" ? (
          <TeamConnectionSection
            collaborationClient={collaborationClient}
            collaborationSnapshot={collaborationSnapshot}
          />
        ) : null}
        {section === "about" ? (
          <AboutSection acknowledgements={acknowledgements} version={version} />
        ) : null}
        {section === "advanced" ? (
          <AdvancedSection statusStore={statusStore} />
        ) : null}
      </section>
    </main>
  );
}
