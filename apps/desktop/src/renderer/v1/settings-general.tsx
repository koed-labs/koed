import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Switch } from "@koed/ui";
import { Laptop, Sun, Moon, Check } from "lucide-react";
import type { DesktopApi, DesktopLaunchAtStartupState } from "../../types.js";
import type { ThemeStore } from "../state/theme.js";
import { Group, Row } from "./settings-controls.js";
const themes = [
  { value: "system", label: "System", Icon: Laptop },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon }
] as const;
type Theme = (typeof themes)[number]["value"];
function Appearance({
  theme,
  select,
  disabled
}: {
  theme: Theme;
  select: (theme: Theme) => void;
  disabled: boolean;
}) {
  return (
    <section className="group-block" aria-label="Appearance">
      <h3>Appearance</h3>
      <div className="themes" role="group" aria-label="Theme">
        {themes.map(({ value, label, Icon }) => {
          return (
            <Button
              key={value}
              variant="outline"
              className="theme-tile"
              aria-pressed={theme === value}
              disabled={disabled}
              onClick={() => select(value)}
            >
              <span
                aria-hidden="true"
                className={`theme-sample sample-${value}`}
              >
                <span className="sample-window">
                  <span className="sample-nav">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="sample-page">
                    <b />
                    <i />
                    <i />
                  </span>
                </span>
              </span>
              <span className="theme-label">
                <Icon />
                {label}
                {theme === value && <Check className="selected-check" />}
              </span>
            </Button>
          );
        })}
      </div>
    </section>
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
    <Row
      title="Open Koed at login"
      description={
        state?.supported === false
          ? "Available in a packaged Koed app."
          : "Start Koed in the background when you sign in."
      }
    >
      <div className="settings-login">
        <Switch
          aria-label="Open Koed at login"
          checked={state?.enabled ?? false}
          disabled={!state || !state.supported || busy}
          onCheckedChange={(value) => void change(value)}
        />
        {state?.status === "requires-approval" && (
          <small role="status">
            Allow Koed in System Settings to finish setup.
          </small>
        )}
        {error && <small role="alert">{error}</small>}
      </div>
    </Row>
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
      <Row
        title="Show Koed in the menu bar"
        description="Open Koed, check service status, or quit from the menu bar."
      >
        <Switch
          aria-label="Show Koed in the menu bar"
          checked={state?.showMenuBar ?? false}
          disabled={!state || busy}
          onCheckedChange={(value) => void change("showMenuBar", value)}
        />
      </Row>
      <Row
        title="Graphics acceleration"
        description="Takes effect after restarting Koed."
      >
        <Switch
          aria-label="Graphics acceleration"
          checked={state?.graphicsAcceleration ?? false}
          disabled={!state || busy}
          onCheckedChange={(value) =>
            void change("graphicsAcceleration", value)
          }
        />
      </Row>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
export function GeneralPreferences({
  themeStore,
  launchAtStartup,
  presentationPreferences,
  onRestartOnboarding
}: {
  themeStore: ThemeStore;
  launchAtStartup?: DesktopApi["launchAtStartup"];
  presentationPreferences?: DesktopApi["presentationPreferences"];
  onRestartOnboarding?: () => void | Promise<void>;
}) {
  const theme = useSyncExternalStore(themeStore.subscribe, themeStore.current);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const restart = async () => {
    setOpening(true);
    setError("");
    try {
      await onRestartOnboarding?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpening(false);
    }
  };
  return (
    <>
      <Appearance
        theme={theme.preference}
        disabled={theme.loading}
        select={(preference) => void themeStore.set(preference)}
      />
      {theme.error && <p role="alert">{theme.error}</p>}
      <Group title="On this device">
        <LaunchSetting api={launchAtStartup} />
        <PresentationSettings api={presentationPreferences} />
        {onRestartOnboarding && (
          <Row
            title="Setup"
            description="Check local setup and reconnect your AI Clients."
          >
            <Button
              size="sm"
              variant="outline"
              disabled={opening}
              onClick={() => void restart()}
            >
              {opening ? "Opening…" : "Run setup again"}
            </Button>
          </Row>
        )}
      </Group>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
