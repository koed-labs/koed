import { aiClientHealth } from "./client-health.js";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react";
import {
  Activity,
  Check,
  ChevronRight,
  Info,
  RefreshCw,
  RotateCw,
  Settings2,
  SlidersHorizontal,
  X
} from "lucide-react";
import type {
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
import { useSettingsFocus } from "./settings-focus.js";
import "./settings.css";
import "./settings-parity.css";
import {
  useSettingsNavigation,
  type V1SettingsPage
} from "./settings-navigation.js";
import { SettingsToolPage, SettingsTools } from "./settings-tools.js";
import {
  SettingsServicePage,
  SettingsServicesOverview,
  settingsServiceComponents
} from "./settings-services.js";

export type V1SettingsTab = "general" | "ai" | "services" | "about";
export type V1SettingsProps = {
  statusStore: DesktopStatusStore;
  themeStore: ThemeStore;
  onClose: () => void;
  initialTab?: V1SettingsTab | "agent";
  initialPage?: V1SettingsPage;
  cliInstall?: DesktopApi["cliInstall"];
  onRestartOnboarding?: () => Promise<void> | void;
  launchAtStartup?: DesktopApi["launchAtStartup"];
  presentationPreferences?: DesktopApi["presentationPreferences"];
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
const tabNames: readonly {
  id: V1SettingsTab;
  label: string;
  Icon: typeof Check;
}[] = [
  { id: "general", label: "General", Icon: SlidersHorizontal },
  { id: "ai", label: "AI models", Icon: Settings2 },
  { id: "services", label: "Services", Icon: Activity },
  { id: "about", label: "About", Icon: Info }
];
const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
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
function PresentationSettings({
  api
}: {
  api?: DesktopApi["presentationPreferences"];
}) {
  const [state, setState] = useState<{
    graphicsAcceleration: boolean;
    showMenuBar: boolean;
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
        if (active) setError("Window settings could not be read.");
      });
    return () => {
      active = false;
    };
  }, [api]);
  if (!api) return null;
  const change = async (
    key: "graphicsAcceleration" | "showMenuBar",
    enabled: boolean
  ) => {
    if (!state) return;
    setBusy(true);
    setError(null);
    try {
      setState(await api.set({ ...state, [key]: enabled }));
    } catch {
      setError("Window settings could not be changed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SettingRow
        title="Show Koed in the menu bar"
        description="New chat, status and Quit, one click away."
      >
        <V1Switch
          label="Show Koed in the menu bar"
          checked={state?.showMenuBar ?? false}
          disabled={!state || busy}
          onChange={(value) => void change("showMenuBar", value)}
        />
      </SettingRow>
      <SettingRow
        title="Graphics acceleration"
        description="Turn off if the window flickers. Takes effect after a restart."
      >
        <V1Switch
          label="Graphics acceleration"
          checked={state?.graphicsAcceleration ?? false}
          disabled={!state || busy}
          onChange={(value) => void change("graphicsAcceleration", value)}
        />
      </SettingRow>
      {error && (
        <p className="v1-settings-error" role="alert">
          {error}
        </p>
      )}
    </>
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
  const selectModel = (
    instance: LocalAiClientReadModel["instances"][number],
    candidate: (typeof choices)[number]["candidate"]
  ) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            provider: instance.driverId,
            ai_client_instance_id: instance.instanceId,
            model: candidate.id,
            reasoning_effort: candidate.reasoningEfforts.includes(
              current.reasoning_effort
            )
              ? current.reasoning_effort
              : (candidate.reasoningEfforts[0] ?? "none")
          }
        : current
    );
  };
  return (
    <div className="v1-conversation-defaults">
      <h4>New Conversations</h4>
      <p>
        Koed has one default AI Client, model and reasoning level for new
        Conversations. You can change these in each Conversation.
      </p>
      {model && draft && !unavailable && choices.length ? (
        model.instances
          .filter((instance) =>
            choices.some(
              (choice) => choice.instance.instanceId === instance.instanceId
            )
          )
          .map((instance) => {
            const available = choices.filter(
              (choice) => choice.instance.instanceId === instance.instanceId
            );
            const selected =
              draft.ai_client_instance_id === instance.instanceId;
            const selectedModel = selected
              ? available.find(({ candidate }) =>
                  modelMatches(candidate, draft.model)
                )
              : undefined;
            const availableEfforts =
              selectedModel?.candidate.reasoningEfforts ?? [];
            return (
              <div
                className={`v1-model-card${selected ? " v1-model-card-selected" : ""}`}
                key={instance.instanceId}
              >
                <div className="v1-model-heading">
                  <b>{instance.displayName}</b>
                  {selected && <span>Selected for new Conversations</span>}
                </div>
                <div className="v1-model-controls">
                  <label>
                    Model
                    <select
                      aria-label={`${instance.displayName} model`}
                      disabled={busy}
                      value={selectedModel?.candidate.id ?? ""}
                      onChange={(event) => {
                        const choice = available.find(
                          ({ candidate }) => candidate.id === event.target.value
                        );
                        if (choice) selectModel(instance, choice.candidate);
                      }}
                    >
                      <option value="" disabled>
                        Choose model
                      </option>
                      {available.map(({ candidate }) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.displayName ?? candidate.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selectedModel && (
                    <div className="v1-model-reasoning">
                      <span>Reasoning</span>
                      <div
                        role="group"
                        aria-label={`${instance.displayName} reasoning`}
                      >
                        {availableEfforts.map((effort, index) => (
                          <button
                            key={effort}
                            type="button"
                            aria-label={
                              effort === "xhigh"
                                ? "Extra high"
                                : effort.charAt(0).toUpperCase() +
                                  effort.slice(1)
                            }
                            aria-pressed={draft.reasoning_effort === effort}
                            disabled={busy}
                            onClick={() =>
                              setDraft((current) =>
                                current
                                  ? { ...current, reasoning_effort: effort }
                                  : current
                              )
                            }
                            title={effort === "xhigh" ? "Extra high" : effort}
                          >
                            <span
                              className="v1-reasoning-bars"
                              aria-hidden="true"
                            >
                              {Array.from({ length: index + 1 }, (_, bar) => (
                                <i key={bar} />
                              ))}
                            </span>
                            <span>
                              {effort === "xhigh"
                                ? "Extra high"
                                : effort.charAt(0).toUpperCase() +
                                  effort.slice(1)}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {selected && (
                    <button
                      type="button"
                      className="v1-settings-primary"
                      disabled={busy || !chosen}
                      onClick={() => void save()}
                    >
                      {busy ? "Saving…" : "Save default"}
                    </button>
                  )}
                </div>
              </div>
            );
          })
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
  statusStore,
  themeStore,
  onClose,
  initialTab = "general",
  initialPage,
  cliInstall = window.koedDesktop?.cliInstall,
  onRestartOnboarding,
  launchAtStartup = window.koedDesktop?.launchAtStartup,
  presentationPreferences = window.koedDesktop?.presentationPreferences,
  localAiClients = window.koedDesktop?.localAiClients
}: V1SettingsProps) {
  const navigation = useSettingsNavigation(initialTab, initialPage);
  const { tab, page, setTab } = navigation;
  const [pending, setPending] = useState<Mutation | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  useSettingsFocus(sheetRef, pending !== null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [themeError, setThemeError] = useState<string | null>(null);
  const [themeBusy, setThemeBusy] = useState(false);
  const [restartBusy, setRestartBusy] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [serviceBusy, setServiceBusy] = useState<string | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [serviceNotice, setServiceNotice] = useState<string | null>(null);
  const servicesRefreshDeadline = useRef<number | null>(null);
  const snapshot = useDesktopStatus(statusStore);
  const theme = useSyncExternalStore(
    themeStore.subscribe,
    themeStore.current,
    themeStore.current
  );
  useEffect(() => {
    void statusStore.refresh();
  }, [statusStore]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (pending) setPending(null);
        else if (page) navigation.back();
        else onClose();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [pending, onClose, page, navigation.back]);
  useEffect(() => {
    if (tab === "services") void statusStore.refresh();
  }, [tab, page, statusStore]);
  const servicesStarting =
    tab === "services" &&
    settingsServiceComponents(snapshot.status).some(
      ([, component]) => component.state === "starting"
    );
  useEffect(() => {
    if (!servicesStarting) {
      servicesRefreshDeadline.current = null;
      return;
    }
    // A service can remain "starting" indefinitely; keep extra UI polling bounded.
    const now = Date.now();
    servicesRefreshDeadline.current ??= now + 60_000;
    if (
      snapshot.error ||
      snapshot.busyCommand ||
      now + 1500 > servicesRefreshDeadline.current
    )
      return;
    const timeout = setTimeout(() => void statusStore.refresh(), 1500);
    return () => clearTimeout(timeout);
  }, [
    servicesStarting,
    snapshot.revision,
    snapshot.error,
    snapshot.busyCommand,
    statusStore
  ]);
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
  const runService = async (
    action: "start" | "restart" | "open_logs" | "diagnostics" | "doctor"
  ) => {
    if (serviceBusy || snapshot.busyCommand) return;
    setServiceBusy(action);
    setServiceError(null);
    setServiceNotice(null);
    try {
      if (action === "restart") {
        const stopped = await window.koedDesktop?.invoke<{
          ok?: boolean;
          message?: string;
          error?: string;
        }>("stop");
        if (!stopped || stopped.ok === false)
          throw new Error(
            stopped?.message ?? stopped?.error ?? "Koed could not stop."
          );
      }
      if (action === "start" || action === "restart") {
        const started = await statusStore.run<{
          ok?: boolean;
          message?: string;
          error?: string;
        }>("start");
        if (started?.ok === false)
          throw new Error(
            started.message ?? started.error ?? "Koed could not start."
          );
      } else if (action === "open_logs") {
        const opened = await statusStore.run<{ ok?: boolean; error?: string }>(
          "open_logs"
        );
        if (opened?.ok === false)
          throw new Error(opened.error ?? "Logs could not be opened.");
      } else if (action === "doctor") {
        const result = await statusStore.run<{
          ok?: boolean;
          message?: string;
          error?: string;
        }>("doctor");
        if (!result || result.ok === false)
          throw new Error(
            result?.error ??
              result?.message ??
              "Diagnostics found issues that need attention."
          );
        setServiceNotice("Diagnostics completed.");
      } else {
        const clipboard = window.koedDesktop?.clipboard;
        if (!clipboard) throw new Error("Clipboard is unavailable.");
        const current = statusStore.current();
        const state = current.status;
        if (!state) throw new Error("Service status is unavailable.");
        const component = (value?: ComponentStatus | null) =>
          value ? { state: value.state } : null;
        const report = {
          generatedAt: state?.generatedAt ?? null,
          components: {
            api: component(state?.api),
            database: component(state?.database),
            localAiRuntime: component(state?.localAiRuntime),
            captureHook: component(state?.captureHook),
            embeddingService: component(state?.embeddingService),
            lcmSummaryService: component(state?.lcmSummaryService)
          }
        };
        await clipboard.writeText(JSON.stringify(report, null, 2));
        setServiceNotice("Diagnostics copied.");
      }
      if (action === "start" || action === "restart") {
        servicesRefreshDeadline.current = null;
        await statusStore.refresh();
      }
    } catch (cause) {
      setServiceError(errorText(cause));
    } finally {
      setServiceBusy(null);
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
        ref={sheetRef}
        className="v1-settings-sheet v1-settings-parity"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <nav
          className="v1-settings-nav"
          role="tablist"
          aria-label="Settings sections"
          onKeyDown={(event) => {
            const direction =
              event.key === "ArrowDown" || event.key === "ArrowRight"
                ? 1
                : event.key === "ArrowUp" || event.key === "ArrowLeft"
                  ? -1
                  : 0;
            if (!direction && event.key !== "Home" && event.key !== "End")
              return;
            event.preventDefault();
            const index =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabNames.length - 1
                  : (tabNames.findIndex((item) => item.id === tab) +
                      direction +
                      tabNames.length) %
                    tabNames.length;
            const next = tabNames[index]!;
            setTab(next.id);
            setActionError(null);
            event.currentTarget
              .querySelector<HTMLButtonElement>(`#v1-settings-tab-${next.id}`)
              ?.focus();
          }}
        >
          <h2>Settings</h2>
          {tabNames.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`v1-settings-tab-${item.id}`}
              aria-controls="v1-settings-panel"
              tabIndex={tab === item.id ? 0 : -1}
              aria-selected={tab === item.id}
              onClick={() => {
                setTab(item.id);
                setActionError(null);
              }}
            >
              <item.Icon size={17} aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </nav>
        <div
          ref={navigation.bodyRef}
          className="v1-settings-body"
          role="tabpanel"
          id="v1-settings-panel"
          aria-labelledby={`v1-settings-tab-${tab}`}
          key={`${tab}-${page ?? "overview"}`}
        >
          {(page === "privacy" || page === "cli") && (
            <SettingsToolPage
              tool={page}
              api={cliInstall}
              onBack={navigation.back}
            />
          )}
          {tab === "general" && !page && (
            <>
              <header className="v1-parity-heading">
                <h3>General</h3>
                <p>Make Koed feel at home on this Mac.</p>
              </header>
              <div className="v1-parity-appearance">
                <SettingRow
                  title="Appearance"
                  description="Choose how Koed looks."
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
              </div>
              <section className="v1-parity-group">
                <h4>On this device</h4>
                <div className="v1-parity-card">
                  <LaunchSetting api={launchAtStartup} />
                  <PresentationSettings api={presentationPreferences} />
                  {onRestartOnboarding && (
                    <SettingRow
                      title="Setup"
                      description="Check local setup and reconnect your AI Clients. Your data stays in Koed."
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
              </section>
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
              <SettingsTools api={cliInstall} onOpen={navigation.openPage} />
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
                  const health = aiClientHealth(id, status),
                    client = health.integration,
                    { installed, configured, description } = health;
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
                      {health.version && (
                        <p className="v1-client-version">{health.version}</p>
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
              {page === "health" || page === "embedding" ? (
                <SettingsServicePage
                  page={page}
                  status={snapshot.error ? null : status}
                  onBack={navigation.back}
                />
              ) : (
                <header className="v1-parity-heading">
                  <h3>Services</h3>
                  <p>Current state of Koed on this Mac.</p>
                </header>
              )}
              {snapshot.error && (
                <p className="v1-settings-error" role="alert">
                  {snapshot.error}
                </p>
              )}
              {serviceError && (
                <p className="v1-settings-error" role="alert">
                  {serviceError}
                </p>
              )}
              {serviceNotice && (
                <p className="v1-settings-caption" role="status">
                  {serviceNotice}
                </p>
              )}
              {!page && (
                <SettingsServicesOverview
                  status={snapshot.error ? null : status}
                  embeddingSupported={status?.embeddingState !== undefined}
                  onOpen={navigation.openPage}
                />
              )}
              <div className="v1-service-actions">
                <button
                  type="button"
                  className="v1-settings-primary"
                  disabled={!!serviceBusy || !!snapshot.busyCommand}
                  onClick={() =>
                    void runService(
                      status?.api?.state === "healthy" ? "restart" : "start"
                    )
                  }
                >
                  {serviceBusy === "start"
                    ? "Starting…"
                    : serviceBusy === "restart"
                      ? "Restarting…"
                      : status?.api?.state === "healthy"
                        ? "Restart Koed"
                        : "Start Koed"}
                </button>
                <button
                  type="button"
                  className="v1-settings-secondary"
                  disabled={!!serviceBusy || !!snapshot.busyCommand}
                  onClick={() => void runService("doctor")}
                >
                  {serviceBusy === "doctor"
                    ? "Running diagnostics…"
                    : "Run diagnostics"}
                </button>
                <button
                  type="button"
                  className="v1-settings-secondary"
                  disabled={!!serviceBusy || !!snapshot.busyCommand}
                  onClick={() => void runService("open_logs")}
                >
                  {serviceBusy === "open_logs" ? "Opening…" : "Open logs"}
                </button>
                <button
                  type="button"
                  className="v1-settings-secondary"
                  disabled={!!serviceBusy || !!snapshot.busyCommand}
                  onClick={() => void runService("diagnostics")}
                >
                  {serviceBusy === "diagnostics"
                    ? "Copying…"
                    : "Copy diagnostics"}
                </button>
                <button
                  type="button"
                  className="v1-settings-secondary v1-service-refresh"
                  aria-label="Refresh status"
                  title="Refresh status"
                  disabled={!!snapshot.busyCommand}
                  onClick={() => {
                    servicesRefreshDeadline.current = null;
                    void statusStore.refresh();
                  }}
                >
                  <RefreshCw size={15} aria-hidden="true" />
                </button>
              </div>
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
