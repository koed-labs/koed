import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react";
import { Check, ChevronRight, RotateCw, X } from "lucide-react";
import type {
  KoedServerStatus,
  ComponentStatus,
  DesktopApi,
  DesktopLaunchAtStartupState
} from "../../types.js";
import type {
  LocalAiClientAssignment,
  LocalAiClientReadModel
} from "../../ipc/local-ai-client-protocol.js";
import {
  assignmentFrom,
  modelMatches,
  statusFor
} from "../views/preferences/local-ai-client-settings-helpers.js";
import type {
  DesktopCommand,
  DesktopStatusStore
} from "../services/desktop-commands.js";
import type { ThemeStore } from "../state/theme.js";
import { useDesktopStatus } from "../state/use-status.js";
import { AgentLookPicker, Pixelkin, type AgentLook } from "./visual.js";
import "./settings.css";

export type V1SettingsAgent = { name: string; look: AgentLook };
export type V1SettingsTab = "general" | "agent" | "ai" | "services" | "about";
export type V1SettingsProps = {
  agent: V1SettingsAgent;
  onSaveAgent: (agent: V1SettingsAgent) => Promise<void> | void;
  statusStore: DesktopStatusStore;
  themeStore: ThemeStore;
  onClose: () => void;
  initialTab?: V1SettingsTab;
  onRestartOnboarding?: () => Promise<void> | void;
  launchAtStartup?: DesktopApi["launchAtStartup"];
  hardwareAcceleration?: DesktopApi["hardwareAcceleration"];
  localAiClients?: DesktopApi["localAiClients"];
};
type ClientId = "codex" | "claude" | "pi";
type Mutation =
  | `setup_${ClientId}`
  | `repair_${ClientId}`
  | `remove_${ClientId}`;
const clients: readonly { id: ClientId; label: string }[] = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
  { id: "pi", label: "Pi" }
];
const names: Record<ClientId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  pi: "Pi"
};
const tabNames: readonly { id: V1SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "agent", label: "Your agent" },
  { id: "ai", label: "AI models" },
  { id: "services", label: "Services" },
  { id: "about", label: "About" }
];
const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
const clientStatus = (id: ClientId, status: KoedServerStatus | null) =>
  id === "codex"
    ? status?.codex
    : id === "claude"
      ? status?.claudeCode
      : status?.pi;
const stateLabel = (component?: ComponentStatus | null) =>
  component?.state === "healthy"
    ? "Running"
    : component?.state === "starting"
      ? "Starting"
      : component?.state === "needs_attention"
        ? "Needs attention"
        : "Not configured";
function SettingRow({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="v1-setting-row">
      <div className="v1-setting-copy">
        <b>{title}</b>
        {description && <span>{description}</span>}
      </div>
      {children}
    </div>
  );
}
function ServiceRow({
  title,
  component
}: {
  title: string;
  component?: ComponentStatus | null;
}) {
  return (
    <SettingRow title={title} description={component?.message}>
      <span
        className={`v1-status-pill v1-state-${component?.state ?? "not_configured"}`}
      >
        <i />
        {stateLabel(component)}
      </span>
    </SettingRow>
  );
}
function V1Switch({
  label,
  checked,
  disabled,
  onChange
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="v1-settings-switch"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}
function LaunchSetting({ api }: { api?: DesktopApi["launchAtStartup"] }) {
  const [state, setState] = useState<DesktopLaunchAtStartupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!api) return;
    let active = true;
    void api
      .get()
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
  const change = async (enabled: boolean) => {
    const previous = state;
    setState({
      enabled,
      status: enabled ? "enabled" : "disabled",
      supported: true
    });
    setBusy(true);
    setError(null);
    try {
      setState(await api.set(enabled));
    } catch {
      setState(previous);
      setError("Launch at startup could not be changed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingRow
      title="Open Koed at login"
      description={
        state?.supported === false
          ? "Available in a packaged Koed app."
          : "Start Koed in the background when you sign in."
      }
    >
      <div className="v1-settings-toggle-wrap">
        <V1Switch
          label="Open Koed at login"
          checked={state?.enabled ?? false}
          disabled={!state || !state.supported || busy}
          onChange={(value) => void change(value)}
        />
        {state?.status === "requires-approval" && (
          <small role="status">
            Allow Koed in System Settings to finish setup.
          </small>
        )}
        {error && <small role="alert">{error}</small>}
      </div>
    </SettingRow>
  );
}
function HardwareSetting({
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
    if (!api) return;
    let active = true;
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
  const change = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setState(await api.set(enabled));
    } catch {
      setError("Hardware acceleration could not be changed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingRow
      title="Graphics acceleration"
      description={
        state?.managedByEnvironment
          ? "This setting is managed by the Operator environment."
          : "Uses your GPU for local inference. Restarts local services."
      }
    >
      <div className="v1-settings-toggle-wrap">
        <V1Switch
          label="Graphics acceleration"
          checked={state?.enabled ?? false}
          disabled={!state || state.managedByEnvironment || busy}
          onChange={(value) => void change(value)}
        />
        {error && <small role="alert">{error}</small>}
      </div>
    </SettingRow>
  );
}
function ConversationDefaults({ api }: { api?: DesktopApi["localAiClients"] }) {
  const [model, setModel] = useState<LocalAiClientReadModel | null>(null);
  const [draft, setDraft] = useState<LocalAiClientAssignment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!api) return;
    let active = true;
    void api
      .list()
      .then((response) => {
        if (!active) return;
        setModel(response.readModel);
        setDraft(assignmentFrom(response.readModel, "conversations"));
        return api.refresh();
      })
      .then((response) => {
        if (!active || !response) return;
        setModel(response.readModel);
        setDraft(assignmentFrom(response.readModel, "conversations"));
        if (response.refreshError) setError(response.refreshError);
      })
      .catch((cause) => {
        if (active) setError(errorText(cause));
      });
    return () => {
      active = false;
    };
  }, [api]);
  if (!api) return null;
  const choices =
    model?.instances.flatMap((instance) => {
      if (!statusFor(model, instance.instanceId, "conversations").available)
        return [];
      const snapshot = model.capabilitySnapshots.find(
        (item) => item.instanceId === instance.instanceId
      );
      return (
        snapshot?.models.map((candidate) => ({ instance, candidate })) ?? []
      );
    }) ?? [];
  const chosen =
    draft &&
    choices.find(
      ({ instance, candidate }) =>
        instance.instanceId === draft.ai_client_instance_id &&
        modelMatches(candidate, draft.model)
    );
  const efforts = chosen?.candidate.reasoningEfforts ?? [];
  const unavailable =
    model?.defaults.conversations.persistable === false &&
    !model?.settings.some((item) => item.flowKey === "conversations");
  const save = async () => {
    if (!draft || !model || unavailable) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.set("conversations", draft);
      setModel(response.readModel);
      setDraft(assignmentFrom(response.readModel, "conversations"));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="v1-conversation-defaults">
      <h4>New conversations</h4>
      <p>
        Choose the default AI Client, model, and reasoning for new
        Conversations.
      </p>
      {model && draft && !unavailable ? (
        <>
          <label>
            Default model
            <select
              aria-label="Default conversation model"
              disabled={busy || !choices.length}
              value={
                chosen
                  ? `${chosen.instance.instanceId}\u0000${chosen.candidate.id}`
                  : ""
              }
              onChange={(event) => {
                const choice = choices.find(
                  ({ instance, candidate }) =>
                    `${instance.instanceId}\u0000${candidate.id}` ===
                    event.target.value
                );
                if (!choice) return;
                const nextEfforts = choice.candidate.reasoningEfforts;
                setDraft((current) =>
                  current
                    ? {
                        ...current,
                        provider: choice.instance.driverId,
                        ai_client_instance_id: choice.instance.instanceId,
                        model: choice.candidate.id,
                        reasoning_effort: nextEfforts.includes(
                          current.reasoning_effort
                        )
                          ? current.reasoning_effort
                          : (nextEfforts[0] ?? "none")
                      }
                    : current
                );
              }}
            >
              <option value="" disabled>
                Choose model
              </option>
              {choices.map(({ instance, candidate }) => (
                <option
                  key={`${instance.instanceId}:${candidate.id}`}
                  value={`${instance.instanceId}\u0000${candidate.id}`}
                >
                  {instance.displayName} ·{" "}
                  {candidate.displayName ?? candidate.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reasoning
            <select
              aria-label="Default conversation reasoning"
              disabled={busy || !chosen || !efforts.length}
              value={draft.reasoning_effort}
              onChange={(event) =>
                setDraft((current) =>
                  current
                    ? { ...current, reasoning_effort: event.target.value }
                    : current
                )
              }
            >
              {efforts.length ? (
                efforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort === "xhigh"
                      ? "Extra high"
                      : effort.charAt(0).toUpperCase() + effort.slice(1)}
                  </option>
                ))
              ) : (
                <option value="none">Default</option>
              )}
            </select>
          </label>
          <button
            type="button"
            className="v1-settings-primary"
            disabled={busy || !chosen}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save default"}
          </button>
        </>
      ) : (
        <p>
          {unavailable
            ? "This default is managed outside Koed settings."
            : "Available models are loading or need a connected, authenticated AI Client."}
        </p>
      )}
      {error && (
        <p role="alert" className="v1-settings-error">
          {error}
        </p>
      )}
    </div>
  );
}
export function V1Settings({
  agent,
  onSaveAgent,
  statusStore,
  themeStore,
  onClose,
  initialTab = "general",
  onRestartOnboarding,
  launchAtStartup = window.koedDesktop?.launchAtStartup,
  hardwareAcceleration = window.koedDesktop?.hardwareAcceleration,
  localAiClients = window.koedDesktop?.localAiClients
}: V1SettingsProps) {
  const [tab, setTab] = useState<V1SettingsTab>(initialTab);
  const [draft, setDraft] = useState<V1SettingsAgent>(agent);
  const [pending, setPending] = useState<Mutation | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [savingAgent, setSavingAgent] = useState(false);
  const [themeError, setThemeError] = useState<string | null>(null);
  const [themeBusy, setThemeBusy] = useState(false);
  const [restartBusy, setRestartBusy] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const snapshot = useDesktopStatus(statusStore);
  const theme = useSyncExternalStore(
    themeStore.subscribe,
    themeStore.current,
    themeStore.current
  );
  useEffect(() => {
    setDraft(agent);
  }, [agent]);
  useEffect(() => {
    void statusStore.refresh();
  }, [statusStore]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (pending) setPending(null);
        else onClose();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [pending, onClose]);
  const setTheme = async (preference: "system" | "light" | "dark") => {
    setThemeError(null);
    setThemeBusy(true);
    try {
      await themeStore.set(preference);
    } catch (cause) {
      setThemeError(errorText(cause));
    } finally {
      setThemeBusy(false);
    }
  };
  const saveAgent = async () => {
    const name = draft.name.trim();
    if (!name) {
      setAgentError("Give your agent a name.");
      return;
    }
    setAgentError(null);
    setSavingAgent(true);
    try {
      await onSaveAgent({ ...draft, name });
      setDraft((current) => ({ ...current, name }));
    } catch (cause) {
      setAgentError(errorText(cause));
    } finally {
      setSavingAgent(false);
    }
  };
  const runCheck = async (id: ClientId) => {
    setActionError(null);
    try {
      const result = await statusStore.run<{
        ok?: boolean;
        message?: string;
        capabilityRefresh?: { refreshed?: boolean };
      }>(`check_${id}` as DesktopCommand);
      if (
        result?.capabilityRefresh?.refreshed === false ||
        result?.ok === false
      )
        throw new Error(result.message ?? "AI Client check needs attention.");
      await statusStore.refresh();
    } catch (cause) {
      setActionError(errorText(cause));
    }
  };
  const runMutation = async () => {
    const command = pending;
    if (!command) return;
    setPending(null);
    setActionError(null);
    try {
      const result = await statusStore.run<{ ok?: boolean; message?: string }>(
        command,
        { operatorConsented: true }
      );
      if (result?.ok === false)
        throw new Error(
          result.message ??
            "AI Client integration did not complete successfully."
        );
      await statusStore.refresh();
    } catch (cause) {
      setActionError(errorText(cause));
    }
  };
  const status = snapshot.status;
  return (
    <div
      className="v1-settings-modal"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="v1-settings-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <nav className="v1-settings-nav" aria-label="Settings sections">
          <h2>Settings</h2>
          {tabNames.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => {
                setTab(item.id);
                setActionError(null);
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="v1-settings-body" role="tabpanel">
          {tab === "general" && (
            <>
              <h3>General</h3>
              <div className="v1-settings-group">
                <SettingRow
                  title="Theme"
                  description="System follows your Mac."
                >
                  <div
                    className="v1-settings-segment"
                    role="group"
                    aria-label="Theme"
                  >
                    {(["system", "light", "dark"] as const).map((choice) => (
                      <button
                        key={choice}
                        type="button"
                        aria-pressed={theme.preference === choice}
                        disabled={themeBusy}
                        onClick={() => void setTheme(choice)}
                      >
                        {choice.charAt(0).toUpperCase() + choice.slice(1)}
                      </button>
                    ))}
                  </div>
                </SettingRow>
                <LaunchSetting api={launchAtStartup} />
                <HardwareSetting api={hardwareAcceleration} />
                {onRestartOnboarding && (
                  <SettingRow
                    title="Setup"
                    description="Meet your agent and connect your AI again. Your data stays in Koed."
                  >
                    <button
                      type="button"
                      className="v1-settings-secondary"
                      disabled={restartBusy}
                      onClick={() => {
                        setRestartError(null);
                        setRestartBusy(true);
                        void Promise.resolve()
                          .then(onRestartOnboarding)
                          .catch((cause) => setRestartError(errorText(cause)))
                          .finally(() => setRestartBusy(false));
                      }}
                    >
                      {restartBusy ? "Opening…" : "Run setup again"}
                    </button>
                  </SettingRow>
                )}
              </div>
              {(themeError || theme.error) && (
                <p className="v1-settings-error" role="alert">
                  {themeError || theme.error}
                </p>
              )}
              {restartError && (
                <p className="v1-settings-error" role="alert">
                  {restartError}
                </p>
              )}
            </>
          )}
          {tab === "agent" && (
            <>
              <h3>Your agent</h3>
              <p className="v1-settings-lead">
                Your chief of staff. Its name and look appear on the home screen
                and in replies.
              </p>
              <div className="v1-agent-card">
                <div className="v1-agent-preview">
                  <Pixelkin look={draft.look} size={112} />
                  <b>{draft.name.trim() || "Koed"}</b>
                  <span>Your chief of staff</span>
                </div>
                <div className="v1-agent-controls">
                  <label className="v1-field">
                    <span>Name</span>
                    <input
                      type="text"
                      maxLength={24}
                      value={draft.name}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          name: event.target.value
                        }))
                      }
                      placeholder="Give it a name"
                    />
                  </label>
                  <AgentLookPicker
                    look={draft.look}
                    onChange={(look) =>
                      setDraft((current) => ({ ...current, look }))
                    }
                  />
                  <button
                    type="button"
                    className="v1-settings-primary"
                    disabled={
                      savingAgent ||
                      (draft.name === agent.name &&
                        draft.look.shape === agent.look.shape &&
                        draft.look.color === agent.look.color &&
                        draft.look.top === agent.look.top)
                    }
                    onClick={() => void saveAgent()}
                  >
                    {savingAgent ? "Saving…" : "Save agent"}
                  </button>
                  {agentError && (
                    <p className="v1-settings-error" role="alert">
                      {agentError}
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
          {tab === "ai" && (
            <>
              <h3>AI models</h3>
              <p className="v1-settings-lead">
                Connect an AI Client to use it with Koed. Model and reasoning
                choices come from each connected client.
              </p>
              {actionError && (
                <p className="v1-settings-error" role="alert">
                  {actionError}
                </p>
              )}
              {snapshot.error && (
                <p className="v1-settings-error" role="alert">
                  {snapshot.error}
                </p>
              )}
              <div className="v1-client-list">
                {clients.map(({ id, label }) => {
                  const client = clientStatus(id, status),
                    readiness = status?.aiClients?.[id],
                    configured = client?.configured === true;
                  const installed =
                    readiness?.installed.state === "healthy" ||
                    (id === "claude"
                      ? status?.claudeCode?.detected
                      : id === "pi"
                        ? status?.pi?.detected
                        : undefined);
                  const auth = readiness?.authentication;
                  const description = !status
                    ? "Checking…"
                    : !installed && !configured
                      ? "Not installed"
                      : configured && auth === "unauthenticated"
                        ? "Sign in required"
                        : configured && auth === "unknown"
                          ? "Authentication unknown"
                          : configured && client?.state === "healthy"
                            ? "Connected"
                            : configured
                              ? (client?.message ?? "Needs attention")
                              : "Not connected";
                  const command: Mutation = `${configured ? "repair" : "setup"}_${id}`;
                  return (
                    <div className="v1-client-card" key={id}>
                      <div className="v1-client-heading">
                        <span className="v1-client-mark">
                          {label.charAt(0)}
                        </span>
                        <div>
                          <b>{label}</b>
                          <small>{description}</small>
                        </div>
                        <span
                          className={`v1-status-pill v1-state-${client?.state ?? "not_configured"}`}
                        >
                          <i />
                          {configured && client?.state === "healthy"
                            ? "Ready"
                            : stateLabel(client)}
                        </span>
                      </div>
                      <div className="v1-client-actions">
                        <button
                          type="button"
                          disabled={!!snapshot.busyCommand || !status}
                          onClick={() => void runCheck(id)}
                        >
                          <RotateCw size={14} />
                          Check
                        </button>
                        <button
                          type="button"
                          disabled={
                            !!snapshot.busyCommand ||
                            !status ||
                            (!installed && !configured)
                          }
                          onClick={() => setPending(command)}
                        >
                          {configured ? "Repair" : "Connect"}
                          <ChevronRight size={14} />
                        </button>
                        {configured && (
                          <button
                            type="button"
                            disabled={!!snapshot.busyCommand}
                            onClick={() => setPending(`remove_${id}`)}
                          >
                            Disconnect
                          </button>
                        )}
                      </div>
                      {readiness?.version && (
                        <p className="v1-client-version">{readiness.version}</p>
                      )}
                    </div>
                  );
                })}
              </div>
              <ConversationDefaults api={localAiClients} />
            </>
          )}
          {tab === "services" && (
            <>
              <h3>Services</h3>
              <p className="v1-settings-lead">
                Current state of Koed on this Mac.
              </p>
              {snapshot.error && (
                <p className="v1-settings-error" role="alert">
                  {snapshot.error}
                </p>
              )}
              <div className="v1-settings-group">
                <ServiceRow
                  title="Local control plane"
                  component={status?.api}
                />
                <ServiceRow title="Database" component={status?.database} />
                <ServiceRow
                  title="Memory engine"
                  component={status?.localAiRuntime}
                />
                <ServiceRow
                  title="Memory capture"
                  component={status?.captureHook}
                />
                <ServiceRow
                  title="Search index"
                  component={status?.embeddingService}
                />
                <ServiceRow
                  title="LCM summary service"
                  component={status?.lcmSummaryService}
                />
              </div>
              <button
                type="button"
                className="v1-settings-secondary"
                disabled={!!snapshot.busyCommand}
                onClick={() => void statusStore.refresh()}
              >
                Refresh status
              </button>
              {status && (
                <p className="v1-settings-caption">
                  Updated {new Date(status.generatedAt).toLocaleString()}
                </p>
              )}
            </>
          )}
          {tab === "about" && (
            <>
              <h3>About</h3>
              <div className="v1-settings-about">
                <span className="v1-settings-logo">
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
                <div>
                  <b>Koed</b>
                  <small>Local memory and AI Client integration</small>
                </div>
              </div>
              <div className="v1-settings-group">
                <SettingRow
                  title="Your data"
                  description="Your conversations, projects, and memory are managed by your Koed installation."
                />
              </div>
            </>
          )}
        </div>
        <button
          className="v1-settings-close"
          type="button"
          aria-label="Close settings"
          onClick={onClose}
        >
          <X size={19} />
        </button>
        {pending && (
          <div className="v1-settings-confirm-backdrop">
            <div
              className="v1-settings-confirm"
              role="alertdialog"
              aria-modal="true"
              aria-label="Confirm AI Client change"
            >
              <h3>
                {pending.startsWith("remove_")
                  ? "Disconnect"
                  : pending.startsWith("repair_")
                    ? "Repair"
                    : "Connect"}{" "}
                {names[pending.split("_")[1] as ClientId]}?
              </h3>
              <p>
                {pending.startsWith("remove_")
                  ? "Koed will remove its integration from this AI Client's local profile. Existing conversations and memory remain in Koed."
                  : "Koed will change this AI Client's local profile to configure its integration. Review the change before continuing."}
              </p>
              <div className="v1-settings-confirm-actions">
                <button type="button" onClick={() => setPending(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="v1-settings-primary"
                  onClick={() => void runMutation()}
                >
                  <Check size={15} />
                  Continue
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
