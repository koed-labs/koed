import type {
  CliInstallApi,
  PrivacyInstallStatus
} from "../../../cli-install/protocol.js";
import type { LauncherStatus } from "../../../cli-install/launcher.js";
import type { InstallState, InstallTool } from "./InstallSetupDialog.js";

type Job = InstallState & {
  message?: string;
  heading?: string;
  unavailable?: boolean;
  requiresPackagedApp?: boolean;
  checking?: boolean;
  removing?: boolean;
};
export type SetupSnapshot = {
  privacy: Job;
  cli: Job;
  launcher: LauncherStatus | null;
  privacyStatus: PrivacyInstallStatus | null;
  cancelling: boolean;
};
const idle = (): Job => ({
  stage: "idle",
  step: 0,
  percent: null,
  running: false,
  checking: true
});
const errorMessage = (cause: unknown) =>
  (cause instanceof Error ? cause.message : String(cause)).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    ""
  );

// One controller per Desktop bridge keeps operations alive across navigation.
const stores = new WeakMap<CliInstallApi, InstallSetupStore>();
export function getInstallSetupStore(api: CliInstallApi) {
  let store = stores.get(api);
  if (!store) {
    store = new InstallSetupStore(api);
    stores.set(api, store);
  }
  return store;
}
export class InstallSetupStore {
  private state: SetupSnapshot = {
    privacy: idle(),
    cli: idle(),
    launcher: null,
    privacyStatus: null,
    cancelling: false
  };
  private cancelRequested = false;
  private listeners = new Set<() => void>();
  constructor(private api: CliInstallApi) {
    api.subscribe((event) => {
      if (!this.state.privacy.running) return;
      const step = /activation|restart/.test(event.stage)
        ? 2
        : /verif|extract/.test(event.stage)
          ? 1
          : 0;
      const percent =
        event.totalBytes && event.completedBytes !== null
          ? Math.max(
              0,
              Math.min(
                100,
                Math.round((event.completedBytes / event.totalBytes) * 100)
              )
            )
          : null;
      this.job("privacy", {
        step,
        percent,
        message:
          step === 0
            ? "Downloading the components needed on this device."
            : step === 1
              ? "Checking files before they are installed."
              : event.stage === "restart"
                ? "Restarting local Koed services to activate Privacy Filter."
                : "Activating the verified Privacy Filter components."
      });
    });
    void this.refresh();
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(next: Partial<SetupSnapshot>) {
    this.state = { ...this.state, ...next };
    this.listeners.forEach((listener) => listener());
  }
  private job(tool: InstallTool, next: Partial<Job>) {
    this.update({ [tool]: { ...this.state[tool], ...next } });
  }
  refresh = async () => {
    await Promise.all([this.refreshPrivacy(), this.refreshLauncher()]);
  };
  private async refreshPrivacy() {
    try {
      const status = await this.api.getStatus();
      this.update({ privacyStatus: status });
      if (!this.state.privacy.running)
        this.job("privacy", {
          checking: false,
          unavailable: status.state === "unavailable",
          requiresPackagedApp: status.reason === "packaged_app_required",
          stage:
            status.state === "ready"
              ? "ready"
              : status.state === "failed"
                ? "failed"
                : status.state === "installing"
                  ? "progress"
                  : "idle",
          message:
            status.state === "unavailable" || status.state === "failed"
              ? status.message
              : undefined
        });
    } catch (cause) {
      this.job("privacy", {
        checking: false,
        unavailable: true,
        message: errorMessage(cause)
      });
    }
  }
  private async refreshLauncher() {
    try {
      const launcher = await this.api.launcher("inspect");
      this.update({ launcher });
      if (!this.state.cli.running) {
        const ready =
          launcher.ownership === "koed" &&
          launcher.target === "valid" &&
          launcher.template === "current" &&
          (launcher.pathConfigured || launcher.pathVisible);
        this.job("cli", {
          checking: false,
          unavailable: false,
          stage: ready ? "ready" : "idle",
          message: undefined
        });
      }
    } catch (cause) {
      this.job("cli", {
        checking: false,
        unavailable: true,
        message: errorMessage(cause)
      });
    }
  }
  installPrivacy = async () => {
    if (this.state.privacy.running) return;
    this.cancelRequested = false;
    this.job("privacy", {
      stage: "progress",
      step: 0,
      percent: null,
      running: true,
      message: undefined,
      heading: undefined
    });
    try {
      const status = await this.api.installPrivacy(true);
      this.update({ privacyStatus: status });
      this.job("privacy", {
        stage:
          status.state === "ready"
            ? "ready"
            : status.state === "not_installed"
              ? "idle"
              : "failed",
        message: status.state === "ready" ? undefined : status.message
      });
    } catch (cause) {
      this.job("privacy", {
        stage:
          this.cancelRequested && /cancelled/i.test(errorMessage(cause))
            ? "idle"
            : "failed",
        heading:
          this.cancelRequested && /cancelled/i.test(errorMessage(cause))
            ? undefined
            : "Couldn’t install Privacy Filter",
        message: errorMessage(cause)
      });
    } finally {
      this.job("privacy", { running: false });
      this.update({ cancelling: false });
    }
  };
  cancelPrivacy = async () => {
    if (this.state.cancelling || this.state.privacy.step >= 2) return;
    this.cancelRequested = true;
    this.update({ cancelling: true });
    try {
      await this.api.cancel();
    } catch (cause) {
      this.cancelRequested = false;
      this.job("privacy", {
        message: `Couldn’t cancel installation: ${errorMessage(cause)}`
      });
    }
  };
  installCli = async () => {
    if (this.state.cli.running) return;
    this.job("cli", {
      stage: "progress",
      step: 0,
      running: true,
      message: undefined,
      heading: undefined,
      removing: false
    });
    try {
      const observed = await this.api.launcher("inspect");
      const launcher =
        observed.ownership === "koed" &&
        observed.target === "valid" &&
        observed.template === "current"
          ? observed
          : await this.api.launcher("install", { consent: true });
      this.update({ launcher });
      this.job("cli", { step: 1 });
      await this.api.updatePath("add", true);
      this.job("cli", { stage: "ready" });
    } catch (cause) {
      const partial = this.state.cli.step === 1;
      this.job("cli", {
        stage: "failed",
        heading: partial
          ? "Couldn’t update PATH"
          : "Couldn’t install command line",
        message: `${partial ? "The launcher was installed, but PATH setup failed. " : ""}${errorMessage(cause)}`
      });
    } finally {
      this.job("cli", { running: false });
    }
  };
  removeCli = async () => {
    if (this.state.cli.running) return;
    this.job("cli", {
      stage: "progress",
      step: 1,
      running: true,
      removing: true,
      heading: "Removing command line",
      message: "Removing the Koed-managed PATH entry and launcher."
    });
    try {
      await this.api.updatePath("remove", true);
      const launcher = await this.api.launcher("remove");
      this.update({ launcher });
      this.job("cli", {
        stage: "idle",
        removing: false,
        step: 0,
        heading: undefined,
        message: undefined
      });
    } catch (cause) {
      this.job("cli", {
        stage: "failed",
        heading: "Couldn’t remove command line",
        message: `${errorMessage(cause)} Review setup before trying again.`
      });
    } finally {
      this.job("cli", { running: false });
    }
  };
}
