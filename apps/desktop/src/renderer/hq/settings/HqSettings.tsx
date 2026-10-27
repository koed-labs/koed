import { useEffect, useId, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button, DialogTitle, DialogDescription } from "@koed/ui";
import { HqSettingsModal } from "./HqSettingsModal.js";
import type { CollaborationSnapshot } from "@koed/shared/collaboration";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
import type { DesktopApi } from "../../../types.js";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import type { DesktopThemePreference } from "../../../window/theme-preference.js";
import type { DesktopStatusStore } from "../../services/desktop-commands.js";
import { HqSettingsAgents } from "./HqSettingsAgents.js";
import { HqRolePreferenceSettings } from "../onboarding/HqRolePreferenceSettings.js";
import { HqSettingsServices } from "./HqSettingsServices.js";
import { HqSettingsDeleted } from "./HqSettingsDeleted.js";
import { HqSettingsPhone } from "./HqSettingsPhone.js";
import "./hq-settings.css";

export type HqSettingsSection =
  | "general"
  | "agents"
  | "teams"
  | "phone"
  | "services"
  | "deleted"
  | "about";
export type HqSettingsProps = {
  statusStore: DesktopStatusStore;
  theme: DesktopThemePreference;
  onThemeChange: (theme: DesktopThemePreference) => void;
  version: string;
  onClose: () => void;
  initialSection?: HqSettingsSection;
  onSectionChange?: (section: HqSettingsSection) => void;
  launchAtStartup?: DesktopApi["launchAtStartup"];
  hardwareAcceleration?: DesktopApi["hardwareAcceleration"];
  localAiClients?: DesktopApi["localAiClients"];
  phoneGateway?: DesktopApi["phoneGateway"];
  collaborationClient?: CollaborationRendererClient;
  collaborationSnapshot?: CollaborationSnapshot | null;
  teamCollaborationEnabled?: boolean;
  personalMemoryApi?: PersonalDesktopApi;
  personalMemoryAuthorityKey?: string;
  onChatRestored?: (sessionId: string, batchId: string | null) => void;
  onOpenSharing?: () => void;
  acknowledgements?: readonly string[];
};
const sections: readonly HqSettingsSection[] = [
  "general",
  "agents",
  "teams",
  "phone",
  "services",
  "deleted",
  "about"
];
const label = (value: string) => value[0]!.toUpperCase() + value.slice(1);
export const hqSettingsShortcut = (
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >
) =>
  event.key === "," &&
  (event.metaKey || event.ctrlKey) &&
  !event.altKey &&
  !event.shiftKey;

export function HqSettings(props: HqSettingsProps) {
  const titleId = useId();
  const { initialSection = "general", teamCollaborationEnabled = true } = props;
  const visible = (value: HqSettingsSection) =>
    value === "teams" && !teamCollaborationEnabled ? "general" : value;
  const [section, setSection] = useState<HqSettingsSection>(
    visible(initialSection)
  );
  useEffect(
    () =>
      setSection(
        initialSection === "teams" && !teamCollaborationEnabled
          ? "general"
          : initialSection
      ),
    [initialSection, teamCollaborationEnabled]
  );
  return (
    <HqSettingsModal
      className="hq-settings"
      labelledBy={titleId}
      onClose={props.onClose}
    >
      <aside className="hq-settings__rail">
        <DialogTitle
          id={titleId}
          render={<h1 />}
          tabIndex={-1}
          data-hq-settings-initial-focus=""
        >
          Settings
        </DialogTitle>
        <nav aria-label="Settings sections">
          {sections
            .filter((id) => id !== "teams" || teamCollaborationEnabled)
            .filter((id) => id !== "phone" || Boolean(props.phoneGateway))
            .map((id) => (
              <button
                key={id}
                type="button"
                aria-current={section === id ? "page" : undefined}
                onClick={() => {
                  setSection(id);
                  props.onSectionChange?.(id);
                }}
              >
                {label(id)}
              </button>
            ))}
        </nav>
      </aside>
      <section
        className="hq-settings__content"
        aria-labelledby="hq-settings-title"
      >
        <header>
          <div>
            <h2 id="hq-settings-title">{label(section)}</h2>
          </div>
          <Button
            aria-label="Close Settings"
            className="hq-settings__close"
            size="icon"
            variant="ghost"
            onClick={props.onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </header>
        {section === "general" ? (
          <>
            <HqSettingRow
              title="Theme"
              description="System follows this device."
            >
              <div
                className="hq-settings__themes"
                role="group"
                aria-label="Theme"
              >
                {(["system", "light", "dark"] as const).map((theme) => (
                  <button
                    key={theme}
                    type="button"
                    aria-pressed={props.theme === theme}
                    onClick={() => props.onThemeChange(theme)}
                  >
                    {label(theme)}
                  </button>
                ))}
              </div>
            </HqSettingRow>
            <Startup api={props.launchAtStartup} />
            <Acceleration api={props.hardwareAcceleration} />
          </>
        ) : null}
        {section === "agents" ? (
          <>
            <HqRolePreferenceSettings
              key={props.personalMemoryAuthorityKey}
              authorityKey={props.personalMemoryAuthorityKey}
              personalMemoryApi={props.personalMemoryApi}
            />
            <HqSettingsAgents
              statusStore={props.statusStore}
              localAiClients={props.localAiClients}
              authorityKey={props.personalMemoryAuthorityKey ?? ""}
            />
          </>
        ) : null}
        {section === "teams" ? (
          <>
            {props.onOpenSharing ? (
              <HqSettingRow
                title="Sharing"
                description="See who can access your Projects and how they were shared."
              >
                <button type="button" onClick={props.onOpenSharing}>
                  Open Sharing
                </button>
              </HqSettingRow>
            ) : null}
            <Teams
              client={props.collaborationClient}
              snapshot={props.collaborationSnapshot}
            />
          </>
        ) : null}
        {section === "phone" ? (
          <HqSettingsPhone api={props.phoneGateway} />
        ) : null}
        {section === "services" ? (
          <HqSettingsServices statusStore={props.statusStore} />
        ) : null}
        {section === "deleted" ? (
          <HqSettingsDeleted
            api={props.personalMemoryApi}
            authorityKey={props.personalMemoryAuthorityKey}
            onRestored={props.onChatRestored}
          />
        ) : null}
        {section === "about" ? (
          <>
            <HqSettingRow
              title="Koed"
              description="Your memory, on your infrastructure."
            >
              <span>Version {props.version}</span>
            </HqSettingRow>
            <HqSettingRow title="License" description="Apache License 2.0" />
            <section className="hq-settings__group">
              <h3>Acknowledgements</h3>
              <ul>
                {(
                  props.acknowledgements ?? [
                    "DM Sans — SIL Open Font License 1.1",
                    "React and Electron — open-source software",
                    "Base UI and Lucide — open-source interface components"
                  ]
                ).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          </>
        ) : null}
      </section>
    </HqSettingsModal>
  );
}
export function HqSettingRow({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="hq-settings__row">
      <div>
        <h3>{title}</h3>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="hq-settings__control">{children}</div>
    </div>
  );
}
export function HqSettingsDialog({
  title,
  description,
  onClose,
  children,
  actions
}: {
  title: string;
  description: string;
  onClose: () => void;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <HqSettingsModal
      className="hq-settings-dialog"
      labelledBy={titleId}
      describedBy={descriptionId}
      onClose={onClose}
    >
      <header>
        <DialogTitle
          id={titleId}
          tabIndex={-1}
          data-hq-settings-initial-focus=""
        >
          {title}
        </DialogTitle>
        <DialogDescription id={descriptionId}>{description}</DialogDescription>
        <Button
          aria-label="Close"
          size="icon"
          variant="ghost"
          className="hq-settings-dialog__close"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </header>
      {children}
      <footer>
        <Button
          className="hq-settings__action"
          variant="outline"
          onClick={onClose}
        >
          Close
        </Button>
        {actions}
      </footer>
    </HqSettingsModal>
  );
}
function Startup({ api }: { api?: DesktopApi["launchAtStartup"] }) {
  const [state, setState] = useState<Awaited<
    ReturnType<NonNullable<typeof api>["get"]>
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void api
      ?.get()
      .then((value) => {
        if (active) setState(value);
      })
      .catch(() => {
        if (active) setError("Launch at startup could not be read.");
      });
    return () => {
      active = false;
    };
  }, [api]);
  if (!api) return null;
  return (
    <HqSettingRow
      title="Launch Koed at startup"
      description={
        state?.supported === false
          ? "Available in a packaged Koed app."
          : "Start Koed in the background when you sign in."
      }
    >
      <input
        className="hq-settings__switch"
        role="switch"
        aria-label="Launch Koed at startup"
        type="checkbox"
        checked={state?.enabled ?? false}
        disabled={!state?.supported || busy}
        onChange={(event) => {
          const previous = state;
          const enabled = event.currentTarget.checked;
          setBusy(true);
          setError(null);
          void api
            .set(enabled)
            .then(setState)
            .catch(() => {
              setState(previous);
              setError("Launch at startup could not be changed.");
            })
            .finally(() => setBusy(false));
        }}
      />
      {state?.status === "requires-approval" ? (
        <p role="status">Allow Koed in System Settings to finish setup.</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </HqSettingRow>
  );
}
function Acceleration({ api }: { api?: DesktopApi["hardwareAcceleration"] }) {
  const [state, setState] = useState<Awaited<
    ReturnType<NonNullable<typeof api>["get"]>
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void api
      ?.get()
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
    <HqSettingRow
      title="Hardware acceleration"
      description={
        state?.managedByEnvironment
          ? "This setting is managed by the Operator environment."
          : "Use a compatible local GPU for Koed inference. Changes restart local Koed services."
      }
    >
      <input
        className="hq-settings__switch"
        role="switch"
        type="checkbox"
        aria-label="Hardware acceleration"
        checked={state?.enabled ?? false}
        disabled={!state || state.managedByEnvironment || busy}
        onChange={(event) => {
          setBusy(true);
          setError(null);
          void api
            .set(event.currentTarget.checked)
            .then(setState)
            .catch(() =>
              setError("Hardware acceleration could not be changed.")
            )
            .finally(() => setBusy(false));
        }}
      />
      {error ? <p role="alert">{error}</p> : null}
    </HqSettingRow>
  );
}
function Teams({
  client,
  snapshot
}: {
  client?: CollaborationRendererClient;
  snapshot?: CollaborationSnapshot | null;
}) {
  const [url, setUrl] = useState(client?.currentRemoteUrl() ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remove, setRemove] = useState(false);
  useEffect(
    () => setUrl(client?.currentRemoteUrl() ?? ""),
    [client, snapshot?.connection.backendId]
  );
  const state = snapshot?.connection.state ?? "disconnected";
  const run = async (operation: () => Promise<unknown>) => {
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
  if (!client)
    return <p role="status">Team Connection is unavailable in this window.</p>;
  return (
    <>
      <HqSettingRow
        title="Team Connection"
        description="Personal Memory stays local when a remote Team Backend is removed."
      >
        <span role="status">
          {state === "live" ? "Connected" : state.replaceAll("_", " ")}
        </span>
      </HqSettingRow>
      <form
        className="hq-settings__group"
        onSubmit={(event) => {
          event.preventDefault();
          if (!url.trim()) {
            setError("Enter a remote Team Backend URL.");
            return;
          }
          void run(() => client.connectRemote({ remoteUrl: url.trim() }));
        }}
      >
        <label htmlFor="hq-team-url">Remote Team Backend URL</label>
        <input
          id="hq-team-url"
          type="url"
          autoComplete="url"
          placeholder="https://team.example.com"
          value={url}
          onChange={(event) => setUrl(event.currentTarget.value)}
        />
        {state === "live" ? (
          <p>
            Changing backend clears authorized Team state from this device.
            Personal Memory stays local.
          </p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <div className="hq-settings__actions">
          {state !== "disconnected" ? (
            <Button
              type="button"
              disabled={busy}
              className="hq-settings__danger-outline"
              variant="destructive-outline"
              onClick={() => setRemove(true)}
            >
              Remove connection
            </Button>
          ) : null}
          {state !== "live" && snapshot?.connection.backendId ? (
            <Button
              type="button"
              disabled={busy}
              className="hq-settings__action"
              variant="outline"
              onClick={() => void run(() => client.reconnect())}
            >
              Reconnect
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
      {remove ? (
        <HqSettingsDialog
          title="Remove Team Connection?"
          description="Koed will clear authorized Team state from this device. Personal Memory remains local and available."
          onClose={() => setRemove(false)}
          actions={
            <Button
              className="hq-settings__danger"
              variant="destructive"
              onClick={() => {
                setRemove(false);
                void run(() => client.disconnect());
              }}
            >
              Remove connection
            </Button>
          }
        />
      ) : null}
    </>
  );
}
