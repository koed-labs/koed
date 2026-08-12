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
  ExternalLink,
  Network,
  RefreshCw,
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
import type { ComponentStatus } from "../../../types.js";
import type { DesktopStatusStore } from "../../services/desktop-commands.js";
import { useDesktopStatus } from "../../state/use-status.js";
import "./preferences.css";

export type PreferencesSection =
  | "general"
  | "capture"
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
  launch?: LocalLaunchCapability;
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
  { id: "team-connection", label: "Team Connection" },
  { id: "about", label: "About" },
  { id: "advanced", label: "Advanced Diagnostics" }
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
  launch,
  onThemeChange,
  theme
}: Pick<PreferencesViewProps, "launch" | "onThemeChange" | "theme">) {
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

function AdvancedSection({
  statusStore
}: Pick<PreferencesViewProps, "statusStore">) {
  const snapshot = useDesktopStatus(statusStore);
  const [actionError, setActionError] = useState<string | null>(null);
  const status = snapshot.status;

  useEffect(() => {
    if (!status) void statusStore.refresh();
  }, [status, statusStore]);

  const run = async (
    action: "doctor" | "repair_codex" | "open_logs" | "status"
  ) => {
    setActionError(null);
    try {
      if (action === "status") await statusStore.refresh();
      else await statusStore.run(action);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
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
          ["Codex", status.codex],
          ["LCM Summary Service", status.lcmSummaryService],
          ["Personal Device Sync", status.personalDeviceSync]
        ] as const
      ).flatMap(([label, component]) => (component ? [[label, component]] : []))
    : [];

  return (
    <div className="koed-preference-section">
      <p className="koed-advanced-intro">
        Operator diagnostics describe local implementation detail. They do not
        expose API Token values or remote credentials.
      </p>
      <details className="koed-diagnostics">
        <summary>
          Local service status <ChevronDown aria-hidden="true" />
        </summary>
        {!status ? (
          <p role="status">Status has not loaded.</p>
        ) : (
          <dl>
            {components.map(([label, component]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  <strong>{component.state.replaceAll("_", " ")}</strong>
                  {component.message ? <span>{component.message}</span> : null}
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
          disabled={snapshot.busyCommand !== null}
          onClick={() => void run("status")}
          variant="outline"
        >
          <RefreshCw aria-hidden="true" /> Refresh status
        </Button>
        <Button
          disabled={snapshot.busyCommand !== null}
          onClick={() => void run("doctor")}
          variant="outline"
        >
          <Wrench aria-hidden="true" /> Run diagnostics
        </Button>
        <Button
          disabled={snapshot.busyCommand !== null}
          onClick={() => void run("repair_codex")}
          variant="outline"
        >
          Repair AI Client integration
        </Button>
        <Button
          disabled={snapshot.busyCommand !== null}
          onClick={() => void run("open_logs")}
          variant="outline"
        >
          <ExternalLink aria-hidden="true" /> Open logs
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
  launch,
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
            launch={launch}
            onThemeChange={onThemeChange}
            theme={theme}
          />
        ) : null}
        {section === "capture" ? <CaptureSection capture={capture} /> : null}
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
