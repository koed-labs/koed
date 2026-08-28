import type {
  ComponentState,
  ComponentStatus,
  KoedServerStatus
} from "../types.js";

const trayServiceDefinitions = [
  { key: "api", label: "API" },
  { key: "database", label: "Database" },
  { key: "redis", label: "Redis" },
  { key: "workerQueues", label: "Work queue" },
  { key: "embeddingService", label: "Embedding Service" },
  { key: "lcmSummaryService", label: "LCM Summary Service" }
] as const satisfies ReadonlyArray<{
  key: keyof KoedServerStatus;
  label: string;
}>;

export interface MenuBarServiceStatus {
  key: (typeof trayServiceDefinitions)[number]["key"];
  label: string;
  state: ComponentState | "unknown";
  stateLabel: string;
}

export interface MenuBarStatusSnapshot {
  summary: string;
  tooltip: string;
  services: MenuBarServiceStatus[];
  updatedAt: Date | null;
}

export interface MenuBarMenuItem {
  label?: string;
  type?: "normal" | "separator";
  enabled?: boolean;
  click?: () => void;
}

export interface DesktopMenuBar {
  dispose: () => void;
  refresh: () => Promise<void>;
}

interface TrayLike<TMenu> {
  destroy: () => void;
  onClick: (listener: () => void) => void;
  onRightClick?: (listener: () => void) => void;
  popUpContextMenu?: (menu: TMenu) => void;
  setContextMenu?: (menu: TMenu) => void;
  setToolTip: (tooltip: string) => void;
}

interface DesktopMenuBarOptions<TMenu> {
  tray: TrayLike<TMenu>;
  buildMenu: (template: MenuBarMenuItem[]) => TMenu;
  getStatus: () => unknown | Promise<unknown>;
  openDesktop: () => void | Promise<void>;
  quit: () => void;
  pollIntervalMs?: number;
  now?: () => Date;
}

const componentStates = new Set<ComponentState>([
  "not_configured",
  "starting",
  "healthy",
  "needs_attention"
]);

const componentState = (value: unknown): ComponentState | "unknown" => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "unknown";
  }
  const state = (value as ComponentStatus).state;
  return componentStates.has(state) ? state : "unknown";
};

const stateLabel = (
  state: MenuBarServiceStatus["state"]
): MenuBarServiceStatus["stateLabel"] => {
  switch (state) {
    case "healthy":
      return "Running";
    case "starting":
      return "Starting…";
    case "needs_attention":
      return "Needs attention";
    case "not_configured":
      return "Not configured";
    case "unknown":
      return "Unknown";
  }
};

const statusRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const statusUpdatedAt = (value: unknown): Date | null => {
  const record = statusRecord(value);
  if (!record || typeof record.generatedAt !== "string") return null;
  const date = new Date(record.generatedAt);
  return Number.isNaN(date.getTime()) ? null : date;
};

const isBypassedRedis = (value: unknown): boolean => {
  const redis = statusRecord(value);
  const details = statusRecord(redis?.details);
  return details?.required === false;
};

export const createMenuBarStatusSnapshot = (
  value: unknown
): MenuBarStatusSnapshot => {
  const record = statusRecord(value);
  const services = trayServiceDefinitions
    .filter(({ key }) => key !== "redis" || !isBypassedRedis(record?.redis))
    .map(({ key, label }) => {
      const state = componentState(record?.[key]);
      return { key, label, state, stateLabel: stateLabel(state) };
    });
  const healthyCount = services.filter(
    (service) => service.state === "healthy"
  ).length;
  const total = services.length;
  const baseSummary = `${healthyCount} of ${total} services running`;
  const summary = services.some((service) => service.state === "unknown")
    ? "Service status unavailable"
    : services.some((service) => service.state === "needs_attention")
      ? `${baseSummary} — needs attention`
      : services.some((service) => service.state === "starting")
        ? `${baseSummary} — starting`
        : services.some((service) => service.state === "not_configured")
          ? `${baseSummary} — setup required`
          : baseSummary;

  return {
    summary,
    tooltip: `Koed — ${summary}`,
    services,
    updatedAt: statusUpdatedAt(value)
  };
};

export const checkingMenuBarStatusSnapshot = (): MenuBarStatusSnapshot => ({
  summary: "Checking service status…",
  tooltip: "Koed — checking service status…",
  services: trayServiceDefinitions.map(({ key, label }) => ({
    key,
    label,
    state: "unknown",
    stateLabel: "Checking…"
  })),
  updatedAt: null
});

const formatUpdatedAt = (date: Date): string =>
  new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);

export const createMenuBarMenuTemplate = (
  snapshot: MenuBarStatusSnapshot,
  actions: {
    openDesktop: () => void;
    refresh: () => void;
    quit: () => void;
  }
): MenuBarMenuItem[] => {
  const exceptionalServices = snapshot.services.filter(
    (service) => service.state !== "healthy"
  );
  return [
    { label: snapshot.summary, enabled: false },
    ...(snapshot.updatedAt
      ? [
          {
            label: `Updated ${formatUpdatedAt(snapshot.updatedAt)}`,
            enabled: false
          }
        ]
      : []),
    ...(exceptionalServices.length > 0
      ? [
          { type: "separator" as const },
          ...exceptionalServices.map((service) => ({
            label: `${service.label} — ${service.stateLabel}`,
            enabled: false
          }))
        ]
      : []),
    { type: "separator" },
    { label: "Open Koed", click: actions.openDesktop },
    { label: "Refresh Status", click: actions.refresh },
    { type: "separator" },
    { label: "Quit Koed", click: actions.quit }
  ];
};

export const menuBarIconFilename = (
  platform: NodeJS.Platform
): string | null => {
  if (platform === "darwin") return "koed-trayTemplate.png";
  if (platform === "linux" || platform === "win32") {
    return "koed-tray-linux.png";
  }
  return null;
};

export const createDesktopMenuBar = <TMenu>({
  tray,
  buildMenu,
  getStatus,
  openDesktop,
  quit,
  pollIntervalMs = 30_000,
  now = () => new Date()
}: DesktopMenuBarOptions<TMenu>): DesktopMenuBar => {
  let snapshot = checkingMenuBarStatusSnapshot();
  let disposed = false;
  let refreshPromise: Promise<void> | null = null;
  let popupStatusMenu: TMenu | null = null;

  const setSnapshot = (next: MenuBarStatusSnapshot): void => {
    if (disposed) return;
    snapshot = next;
    tray.setToolTip(snapshot.tooltip);
    attachStatusMenu();
  };

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (refreshPromise) return refreshPromise;
    const currentRefresh = Promise.resolve()
      .then(getStatus)
      .then((status) => setSnapshot(createMenuBarStatusSnapshot(status)))
      .catch(() =>
        setSnapshot({
          ...createMenuBarStatusSnapshot(null),
          updatedAt: now()
        })
      )
      .finally(() => {
        if (refreshPromise === currentRefresh) refreshPromise = null;
      });
    refreshPromise = currentRefresh;
    return currentRefresh;
  };

  const showDesktop = (): void => {
    void Promise.resolve(openDesktop()).catch(() => undefined);
  };
  const refreshStatus = (): void => {
    void refresh();
  };
  const buildStatusMenu = (): TMenu =>
    buildMenu(
      createMenuBarMenuTemplate(snapshot, {
        openDesktop: showDesktop,
        refresh: refreshStatus,
        quit
      })
    );
  function attachStatusMenu(): void {
    tray.setContextMenu?.(buildStatusMenu());
  }
  const showStatusMenu = (): void => {
    popupStatusMenu = buildStatusMenu();
    tray.popUpContextMenu?.(popupStatusMenu);
  };

  tray.setToolTip(snapshot.tooltip);
  tray.onClick(showDesktop);
  tray.onRightClick?.(showStatusMenu);
  attachStatusMenu();
  const pollTimer = setInterval(refreshStatus, pollIntervalMs);
  pollTimer.unref?.();
  refreshStatus();

  return {
    refresh,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearInterval(pollTimer);
      popupStatusMenu = null;
      tray.destroy();
    }
  };
};
