import electronUpdater from "electron-updater";
import type {
  DesktopUpdateChannel,
  DesktopUpdateRelease,
  DesktopUpdateState
} from "@koed/shared";

export type {
  DesktopUpdateChannel,
  DesktopUpdateRelease,
  DesktopUpdateState
} from "@koed/shared";

export const DESKTOP_UPDATE_STARTUP_DELAY_MS = 5_000;
export const DESKTOP_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const DESKTOP_UPDATE_JITTER_RATIO = 0.2;
export const DESKTOP_UPDATE_INSTALL_EXIT_TIMEOUT_MS = 15_000;

export type DesktopUpdateCheckSource = "background" | "manual";

type DesktopUpdateEvent =
  | "checking-for-update"
  | "update-available"
  | "update-not-available"
  | "download-progress"
  | "update-downloaded"
  | "error";

export type DesktopUpdateEventPayload = {
  "checking-for-update": [];
  "update-available": [unknown];
  "update-not-available": [unknown?];
  "download-progress": [unknown];
  "update-downloaded": [unknown];
  error: [unknown];
};

export interface DesktopUpdateAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  channel?: string;
  allowDowngrade?: boolean;
  allowPrerelease?: boolean;
  on<Event extends DesktopUpdateEvent>(
    event: Event,
    listener: (...args: DesktopUpdateEventPayload[Event]) => void
  ): void;
  removeListener<Event extends DesktopUpdateEvent>(
    event: Event,
    listener: (...args: DesktopUpdateEventPayload[Event]) => void
  ): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface DesktopUpdateTimerApi {
  setTimeout(handler: () => void, timeoutMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DesktopUpdateCoordinatorOptions {
  readonly updater?: DesktopUpdateAdapter;
  readonly appIsPackaged: boolean;
  readonly supported?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly channel?: DesktopUpdateChannel;
  readonly startupDelayMs?: number;
  readonly intervalMs?: number;
  readonly jitterRatio?: number;
  readonly random?: () => number;
  readonly timers?: DesktopUpdateTimerApi;
  readonly prepareForInstall?: () => Promise<void>;
  readonly recoverAfterInstallFailure?: () => Promise<void> | void;
  readonly installExitTimeoutMs?: number;
}

export type DesktopUpdateStateListener = (state: DesktopUpdateState) => void;

const DEFAULT_TIMER_API: DesktopUpdateTimerApi = {
  setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>)
};

const strictDisplayText = (
  value: unknown,
  maxLength: number
): string | undefined => {
  if (typeof value !== "string") return undefined;

  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  )
    return undefined;

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > maxLength) return undefined;
  if (
    /(?:^|\s)[A-Za-z][A-Za-z0-9+.-]*:(?:\/\/|[^\s/])/i.test(normalized) ||
    /(^|\s)\/\//.test(normalized) ||
    /(^|[\s(])\/[^\s]*/.test(normalized) ||
    /[A-Za-z]:[\\/]/.test(normalized) ||
    /(^|\s)\\\\/.test(normalized) ||
    /\b(?:authorization|proxy-authorization|bearer|api[-_ ]?(?:key|token)|access[-_ ]?token|refresh[-_ ]?token|secret|password|credential|[a-z0-9-]+-header|x-[a-z0-9-]+)\b/i.test(
      normalized
    ) ||
    /\b(?:token|key|api[_-]?key|api[-_ ]?token)\s*(?:=|:)\s*\S+/i.test(
      normalized
    )
  )
    return undefined;
  return normalized;
};

const safeVersion = (value: unknown): string =>
  strictDisplayText(value, 64)?.replace(/[^0-9A-Za-z.+_-]/g, "") || "unknown";

const safeChannel = (
  value: unknown,
  fallback: DesktopUpdateChannel
): DesktopUpdateChannel =>
  value === "beta" ? "beta" : value === "stable" ? "stable" : fallback;

const safePublishedAt = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
};

const releaseInfo = (
  value: unknown,
  fallbackChannel: DesktopUpdateChannel
): DesktopUpdateRelease | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const info = value as Record<string, unknown>;
  const version = safeVersion(info.version);
  if (version === "unknown") return undefined;

  let notes: string | undefined;
  if (Array.isArray(info.releaseNotes)) {
    const safeNotes: string[] = [];
    let aggregateLength = 0;
    for (const note of info.releaseNotes.slice(0, 24)) {
      const rawNote =
        typeof note === "string"
          ? note
          : note && typeof note === "object"
            ? (note as Record<string, unknown>).note
            : undefined;
      const safeNote = strictDisplayText(rawNote, 512);
      if (!safeNote) continue;
      const nextLength =
        aggregateLength + (safeNotes.length > 0 ? 1 : 0) + safeNote.length;
      if (nextLength > 2_000) break;
      safeNotes.push(safeNote);
      aggregateLength = nextLength;
    }
    notes = safeNotes.length > 0 ? safeNotes.join(" ") : undefined;
  } else {
    notes = strictDisplayText(info.releaseNotes, 2_000);
  }

  const releaseName = strictDisplayText(info.releaseName ?? info.name, 120);
  const publishedAt = safePublishedAt(info.releaseDate ?? info.publishedAt);

  return {
    version,
    channel: safeChannel(info.channel, fallbackChannel),
    ...(releaseName ? { releaseName } : {}),
    ...(notes ? { releaseNotes: notes } : {}),
    ...(publishedAt ? { publishedAt } : {})
  };
};

const safeErrorMessage = (source: "check" | "download" | "install"): string => {
  switch (source) {
    case "check":
      return "Koed could not check for updates.";
    case "download":
      return "Koed could not download this update.";
    case "install":
      return "Koed could not prepare this update for installation.";
  }
};

export const isDesktopUpdateSupported = (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): boolean => platform === "darwin" && arch === "arm64";

const electronUpdaterAdapter = (): DesktopUpdateAdapter =>
  electronUpdater.autoUpdater as unknown as DesktopUpdateAdapter;

export class DesktopUpdateCoordinator {
  private readonly updater: DesktopUpdateAdapter;
  private readonly enabled: boolean;
  private readonly channel: DesktopUpdateChannel;
  private readonly startupDelayMs: number;
  private readonly intervalMs: number;
  private readonly jitterRatio: number;
  private readonly random: () => number;
  private readonly timers: DesktopUpdateTimerApi;
  private readonly prepareForInstall: () => Promise<void>;
  private readonly recoverAfterInstallFailure: () => Promise<void> | void;
  private readonly installExitTimeoutMs: number;
  private readonly listeners = new Set<DesktopUpdateStateListener>();
  private readonly boundListeners = new Map<
    DesktopUpdateEvent,
    (...args: never[]) => void
  >();
  private startupTimer: unknown;
  private periodicTimer: unknown;
  private installRecoveryTimer: unknown;
  private started = false;
  private disposed = false;
  private operationGeneration = 0;
  private checkInFlight: Promise<void> | null = null;
  private checkOperation: {
    readonly token: number;
    readonly source: DesktopUpdateCheckSource;
  } | null = null;
  private downloadOperation: {
    readonly token: number;
    readonly release: DesktopUpdateRelease;
  } | null = null;
  private installOperation: {
    readonly token: number;
    readonly release: DesktopUpdateRelease;
  } | null = null;
  private hasStartedCheck = false;
  private currentRelease: DesktopUpdateRelease | undefined;
  private state: DesktopUpdateState;

  constructor(options: DesktopUpdateCoordinatorOptions) {
    this.updater = options.updater ?? electronUpdaterAdapter();
    this.channel = options.channel ?? "stable";
    this.startupDelayMs = Math.max(
      0,
      options.startupDelayMs ?? DESKTOP_UPDATE_STARTUP_DELAY_MS
    );
    this.intervalMs = Math.max(
      1_000,
      options.intervalMs ?? DESKTOP_UPDATE_INTERVAL_MS
    );
    this.jitterRatio = Math.max(
      0,
      Math.min(1, options.jitterRatio ?? DESKTOP_UPDATE_JITTER_RATIO)
    );
    this.random = options.random ?? Math.random;
    this.timers = options.timers ?? DEFAULT_TIMER_API;
    this.prepareForInstall =
      options.prepareForInstall ?? (async () => undefined);
    this.recoverAfterInstallFailure =
      options.recoverAfterInstallFailure ?? (() => undefined);
    this.installExitTimeoutMs = Math.max(
      1_000,
      options.installExitTimeoutMs ?? DESKTOP_UPDATE_INSTALL_EXIT_TIMEOUT_MS
    );

    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    if ("channel" in this.updater)
      this.updater.channel = this.channel === "stable" ? "latest" : "beta";
    if ("allowDowngrade" in this.updater) this.updater.allowDowngrade = false;
    if ("allowPrerelease" in this.updater)
      this.updater.allowPrerelease = this.channel === "beta";

    const supported =
      options.supported ??
      isDesktopUpdateSupported(
        options.platform ?? process.platform,
        options.arch ?? process.arch
      );
    this.enabled = options.appIsPackaged && supported;
    this.state = this.enabled
      ? { status: "idle" }
      : {
          status: "disabled",
          reason: options.appIsPackaged ? "unsupported" : "unpackaged"
        };
  }

  getState(): DesktopUpdateState {
    return this.state;
  }

  subscribe(listener: DesktopUpdateStateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (!this.enabled || this.started || this.disposed) return;
    this.started = true;
    this.bindUpdaterEvents();
    this.startupTimer = this.timers.setTimeout(() => {
      this.startupTimer = undefined;
      void this.requestCheck("background");
    }, this.startupDelayMs);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    this.operationGeneration += 1;
    this.checkOperation = null;
    this.downloadOperation = null;
    this.installOperation = null;
    this.checkInFlight = null;
    if (this.startupTimer !== undefined)
      this.timers.clearTimeout(this.startupTimer);
    if (this.periodicTimer !== undefined)
      this.timers.clearTimeout(this.periodicTimer);
    if (this.installRecoveryTimer !== undefined)
      this.timers.clearTimeout(this.installRecoveryTimer);
    this.startupTimer = undefined;
    this.periodicTimer = undefined;
    this.installRecoveryTimer = undefined;
    for (const [event, listener] of this.boundListeners) {
      this.updater.removeListener(event, listener as never);
    }
    this.boundListeners.clear();
    this.listeners.clear();
  }

  async requestCheck(
    source: DesktopUpdateCheckSource = "manual"
  ): Promise<DesktopUpdateState> {
    if (!this.enabled || this.disposed) return this.state;
    if (
      this.state.status === "available" ||
      this.state.status === "downloading" ||
      this.state.status === "ready" ||
      this.state.status === "installing" ||
      (source === "background" && this.state.status === "error")
    ) {
      if (source === "background") this.schedulePeriodicCheck();
      return this.state;
    }
    if (this.checkInFlight) {
      await this.checkInFlight;
      return this.state;
    }

    const token = ++this.operationGeneration;
    this.hasStartedCheck = true;
    this.checkOperation = { token, source };
    this.setState({ status: "checking" });
    const operation = (async () => {
      try {
        const result = await this.updater.checkForUpdates();
        if (
          this.isCurrentOperation(token) &&
          this.state.status === "checking"
        ) {
          const resultInfo =
            result && typeof result === "object"
              ? (result as Record<string, unknown>).updateInfo
              : undefined;
          const available =
            result &&
            typeof result === "object" &&
            (result as Record<string, unknown>).isUpdateAvailable === true;
          if (available) this.handleAvailable(resultInfo, source);
          else this.setState({ status: "idle" });
        }
      } catch {
        if (this.isCurrentOperation(token))
          this.handleFailure("check", source === "background");
      } finally {
        if (this.checkOperation?.token === token) {
          this.checkOperation = null;
          this.checkInFlight = null;
        }
        if (this.started && this.startupTimer === undefined && !this.disposed)
          this.schedulePeriodicCheck();
      }
    })();
    this.checkInFlight = operation;
    await operation;
    return this.state;
  }

  async downloadUpdate(): Promise<DesktopUpdateState> {
    if (!this.enabled || this.disposed || this.state.status !== "available")
      return this.state;
    const release = this.state.release;
    const token = ++this.operationGeneration;
    this.downloadOperation = { token, release };
    this.setState({ status: "downloading", release, progress: 0 });
    try {
      await this.updater.downloadUpdate();
      if (
        this.isCurrentOperation(token) &&
        this.downloadOperation?.token === token &&
        (this.state as DesktopUpdateState).status === "downloading"
      )
        this.setState({ status: "ready", release });
    } catch {
      if (this.isCurrentOperation(token)) this.handleFailure("download", false);
    } finally {
      if (this.downloadOperation?.token === token)
        this.downloadOperation = null;
    }
    return this.state;
  }

  async installUpdate(): Promise<DesktopUpdateState> {
    const retryableError =
      this.state.status === "error" &&
      this.state.recoverable &&
      this.state.release;
    if (
      !this.enabled ||
      this.disposed ||
      (this.state.status !== "ready" && !retryableError) ||
      this.installOperation
    )
      return this.state;
    const release =
      this.state.status === "ready"
        ? this.state.release
        : this.state.status === "error"
          ? this.state.release
          : undefined;
    if (!release) return this.state;
    const token = ++this.operationGeneration;
    this.installOperation = { token, release };
    this.setState({ status: "installing", release });
    try {
      await this.prepareForInstall();
      if (
        !this.isCurrentOperation(token) ||
        this.installOperation?.token !== token ||
        this.state.status !== "installing"
      )
        return this.state;
      this.updater.quitAndInstall(false, true);
      if (
        this.installOperation?.token === token &&
        this.state.status === "installing"
      ) {
        this.installRecoveryTimer = this.timers.setTimeout(() => {
          this.installRecoveryTimer = undefined;
          void this.recoverFailedInstall(token, release);
        }, this.installExitTimeoutMs);
      }
    } catch {
      await this.recoverFailedInstall(token, release);
    }
    return this.state;
  }

  check(): Promise<DesktopUpdateState> {
    return this.requestCheck("manual");
  }

  download(): Promise<DesktopUpdateState> {
    return this.downloadUpdate();
  }

  install(): Promise<DesktopUpdateState> {
    return this.installUpdate();
  }

  private bindUpdaterEvents(): void {
    const bind = <Event extends DesktopUpdateEvent>(
      event: Event,
      listener: (...args: DesktopUpdateEventPayload[Event]) => void
    ): void => {
      this.updater.on(event, listener);
      this.boundListeners.set(event, listener as (...args: never[]) => void);
    };
    bind("checking-for-update", () => {
      if (this.state.status === "idle" && this.checkOperation)
        this.setState({ status: "checking" });
    });
    bind("update-available", (info) => {
      if (
        this.state.status === "checking" ||
        (this.state.status === "idle" &&
          !this.hasStartedCheck &&
          !this.currentRelease)
      )
        this.handleAvailable(info, this.checkOperation?.source ?? "manual");
    });
    bind("update-not-available", () => {
      if (this.state.status === "checking" && this.checkOperation)
        this.setState({ status: "idle" });
    });
    bind("download-progress", (progress) => {
      if (this.state.status !== "downloading" || !this.downloadOperation)
        return;
      const percent =
        progress && typeof progress === "object"
          ? Number((progress as Record<string, unknown>).percent)
          : Number(progress);
      const bounded = Number.isFinite(percent)
        ? Math.max(0, Math.min(100, percent))
        : 0;
      this.setState({
        status: "downloading",
        release: this.downloadOperation.release,
        progress: bounded
      });
    });
    bind("update-downloaded", (info) => {
      if (this.state.status !== "downloading" || !this.downloadOperation)
        return;
      const release =
        releaseInfo(info, this.channel) ?? this.downloadOperation.release;
      this.currentRelease = release;
      this.setState({ status: "ready", release });
    });
    bind("error", () => {
      if (this.state.status === "checking" && this.checkOperation) {
        this.handleFailure(
          "check",
          this.checkOperation.source === "background"
        );
      } else if (
        this.state.status === "downloading" &&
        this.downloadOperation
      ) {
        this.handleFailure("download", false);
      } else if (this.state.status === "installing" && this.installOperation) {
        void this.recoverFailedInstall(
          this.installOperation.token,
          this.installOperation.release
        );
      }
    });
  }

  private handleAvailable(
    info: unknown,
    source: DesktopUpdateCheckSource = "manual"
  ): void {
    const release = releaseInfo(info, this.channel);
    if (!release) {
      this.handleFailure("check", source === "background");
      return;
    }
    this.currentRelease = release;
    this.setState({ status: "available", release });
  }

  private handleFailure(
    source: "check" | "download" | "install",
    background: boolean
  ): void {
    if (background) {
      this.setState({ status: "idle" });
      return;
    }
    this.setState({
      status: "error",
      message: safeErrorMessage(source),
      ...(this.currentRelease ? { release: this.currentRelease } : {}),
      ...(source === "install" ? { recoverable: true } : {})
    });
  }

  private async recoverFailedInstall(
    token: number,
    release: DesktopUpdateRelease
  ): Promise<void> {
    if (
      !this.isCurrentOperation(token) ||
      this.installOperation?.token !== token
    )
      return;
    if (this.installRecoveryTimer !== undefined) {
      this.timers.clearTimeout(this.installRecoveryTimer);
      this.installRecoveryTimer = undefined;
    }
    this.installOperation = null;
    this.setState({
      status: "error",
      message: safeErrorMessage("install"),
      release,
      recoverable: true
    });
    try {
      await this.recoverAfterInstallFailure();
    } catch {
      // The sanitized recoverable state remains visible if relaunch fails.
    }
  }

  private isCurrentOperation(token: number): boolean {
    return !this.disposed && this.operationGeneration === token;
  }

  private schedulePeriodicCheck(): void {
    if (
      this.periodicTimer !== undefined ||
      this.startupTimer !== undefined ||
      this.disposed ||
      !this.enabled ||
      !this.started
    )
      return;
    const randomValue = Math.max(0, Math.min(1, this.random()));
    const jitter = (randomValue * 2 - 1) * this.jitterRatio;
    const delay = Math.max(1_000, Math.round(this.intervalMs * (1 + jitter)));
    this.periodicTimer = this.timers.setTimeout(() => {
      this.periodicTimer = undefined;
      void this.requestCheck("background");
    }, delay);
  }

  private setState(state: DesktopUpdateState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

export const createDesktopUpdateCoordinator = (
  options: DesktopUpdateCoordinatorOptions
): DesktopUpdateCoordinator => new DesktopUpdateCoordinator(options);

export const createElectronDesktopUpdateCoordinator = (
  options: Omit<DesktopUpdateCoordinatorOptions, "updater">
): DesktopUpdateCoordinator =>
  new DesktopUpdateCoordinator({
    ...options,
    updater: electronUpdaterAdapter()
  });
