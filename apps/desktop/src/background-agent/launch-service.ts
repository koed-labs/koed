import type {
  LoginItemSettings,
  LoginItemSettingsOptions,
  Settings
} from "electron";

export const BACKGROUND_AGENT_LAUNCH_ARGUMENT = "--koed-background-agent";
export const BACKGROUND_AGENT_SERVICE_NAME =
  "ai.koed.desktop.background-agent.plist";
export const BACKGROUND_AGENT_MACH_SERVICE_NAME =
  "ai.koed.desktop.background-agent";
const agentServiceType = "agentService" as const;

export type BackgroundAgentLaunchState = {
  enabled: boolean;
  status: "unsupported" | "disabled" | "enabled" | "requires-approval";
  supported: boolean;
};

export interface BackgroundAgentLaunchService {
  get(): Promise<BackgroundAgentLaunchState>;
  set(enabled: boolean): Promise<BackgroundAgentLaunchState>;
  wasOpenedAtLogin(): boolean;
}

interface BackgroundAgentLaunchServiceInput {
  appIsPackaged: boolean;
  nativeBridgeAvailable: boolean;
  agentPlistPresent: boolean;
  teamId?: string;
  getLoginItemSettings?: (
    options?: LoginItemSettingsOptions
  ) => LoginItemSettings;
  platform: NodeJS.Platform;
  setLoginItemSettings?: (settings: Settings) => void;
}

const unsupportedState = (): BackgroundAgentLaunchState => ({
  enabled: false,
  status: "unsupported",
  supported: false
});

const disabledState = (): BackgroundAgentLaunchState => ({
  enabled: false,
  status: "disabled",
  supported: true
});

const enabledState = (): BackgroundAgentLaunchState => ({
  enabled: true,
  status: "enabled",
  supported: true
});

const serviceOptions = (): LoginItemSettingsOptions => ({
  type: agentServiceType,
  serviceName: BACKGROUND_AGENT_SERVICE_NAME
});

const validTeamId = (teamId: string | undefined) =>
  typeof teamId === "string" && /^[A-Z0-9]{10}$/u.test(teamId);

export const isBackgroundAgentLaunch = (argv: readonly string[]) =>
  argv.includes(BACKGROUND_AGENT_LAUNCH_ARGUMENT);

export const createBackgroundAgentLaunchService = (
  input: BackgroundAgentLaunchServiceInput
): BackgroundAgentLaunchService => {
  const supported =
    input.platform === "darwin" &&
    input.appIsPackaged &&
    input.nativeBridgeAvailable &&
    input.agentPlistPresent &&
    validTeamId(input.teamId);

  const get = async (): Promise<BackgroundAgentLaunchState> => {
    if (!supported) return unsupportedState();
    if (!input.getLoginItemSettings)
      throw new Error("Background Agent login settings are unavailable.");
    return stateFromSettings(input.getLoginItemSettings(serviceOptions()));
  };

  const set = async (enabled: boolean): Promise<BackgroundAgentLaunchState> => {
    if (!supported) return unsupportedState();
    if (!input.setLoginItemSettings)
      throw new Error("Background Agent login settings are unavailable.");
    input.setLoginItemSettings({
      openAtLogin: enabled,
      type: agentServiceType,
      serviceName: BACKGROUND_AGENT_SERVICE_NAME,
      args: [BACKGROUND_AGENT_LAUNCH_ARGUMENT]
    });
    return get();
  };

  return {
    get,
    set,
    wasOpenedAtLogin: () =>
      supported &&
      Boolean(input.getLoginItemSettings?.(serviceOptions()).wasOpenedAtLogin)
  };
};

const stateFromSettings = (
  settings: LoginItemSettings
): BackgroundAgentLaunchState => {
  if (settings.status === "requires-approval") {
    return {
      enabled: settings.openAtLogin,
      status: "requires-approval",
      supported: true
    };
  }
  return settings.openAtLogin &&
    (settings.status === undefined || settings.status === "enabled")
    ? enabledState()
    : disabledState();
};
