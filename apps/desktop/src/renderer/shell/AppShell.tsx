import {
  Bell,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Inbox,
  LoaderCircle,
  Menu,
  MonitorSmartphone,
  Plus,
  Search,
  Settings,
  UserRound,
  X
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
  type ReactNode
} from "react";
import "./shell.css";

export type TeamRailItem = {
  connectionState?: "healthy" | "degraded" | "offline";
  id: string;
  name: string;
  unreadCount: number;
};

export type AppShellProps = {
  activeScope: "inbox" | "personal" | { teamId: string };
  children: ReactNode;
  contextNavigation: ReactNode;
  health?: {
    label: string;
    state: "healthy" | "needs_attention" | "starting";
  };
  identityLabel: string;
  inspector?: ReactNode;
  inspectorLabel?: string;
  inspectorOpen: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onActivateInbox: () => void;
  onActivatePersonal: () => void;
  onActivateTeam: (teamId: string) => void;
  onAddTeam: () => void;
  onCloseInspector: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onOpenHealth: () => void;
  onOpenCommandPalette: () => void;
  onOpenDevices: () => void;
  onOpenPreferences: () => void;
  onToggleInspector: () => void;
  personalUnreadCount: number;
  scopeLine: ReactNode;
  teams: readonly TeamRailItem[];
  routeFocusKey: string;
};

const teamInitials = (name: string): string =>
  name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => Array.from(part)[0] ?? "")
    .join("")
    .toLocaleUpperCase() || "?";

export const teamDiscIndex = (teamId: string): number => {
  let hash = 2166136261;
  for (const character of teamId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 8;
};

function RailButton({
  active = false,
  badge,
  children,
  label,
  onClick,
  onKeyDown,
  tabIndex,
  buttonRef
}: {
  active?: boolean;
  badge?: number;
  buttonRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
  label: string;
  onClick: () => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  tabIndex?: number;
}) {
  return (
    <button
      aria-current={active ? "page" : undefined}
      aria-label={label}
      className="desktop-rail-button"
      data-active={active || undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
      ref={buttonRef}
      tabIndex={tabIndex}
      title={label}
      type="button"
    >
      {children}
      {badge ? (
        <span className="desktop-rail-badge" aria-label={`${badge} unread`}>
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </button>
  );
}

function Rail({
  activeScope,
  identityLabel,
  onActivateInbox,
  onActivatePersonal,
  onActivateTeam,
  onAddTeam,
  onOpenCommandPalette,
  onOpenDevices,
  onOpenPreferences,
  personalUnreadCount,
  teams
}: Pick<
  AppShellProps,
  | "activeScope"
  | "identityLabel"
  | "onActivateInbox"
  | "onActivatePersonal"
  | "onActivateTeam"
  | "onAddTeam"
  | "onOpenCommandPalette"
  | "onOpenDevices"
  | "onOpenPreferences"
  | "personalUnreadCount"
  | "teams"
>) {
  const activeTeamId =
    typeof activeScope === "object" ? activeScope.teamId : null;
  const [rovingTeamId, setRovingTeamId] = useState(
    activeTeamId ?? teams[0]?.id ?? null
  );
  const teamButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    setRovingTeamId((current) => {
      if (activeTeamId && teams.some(({ id }) => id === activeTeamId)) {
        return activeTeamId;
      }
      if (current && teams.some(({ id }) => id === current)) return current;
      return teams[0]?.id ?? null;
    });
  }, [activeTeamId, teams]);

  const focusTeam = (index: number) => {
    const team = teams[index];
    if (!team) return;
    setRovingTeamId(team.id);
    window.requestAnimationFrame(() => {
      const button = teamButtonRefs.current.get(team.id);
      button?.scrollIntoView({ block: "nearest" });
      button?.focus();
    });
  };

  return (
    <nav className="desktop-rail" aria-label="Koed scopes">
      <div className="desktop-rail-fixed">
        <RailButton
          active={activeScope === "inbox"}
          label="Inbox"
          onClick={onActivateInbox}
        >
          <Inbox aria-hidden="true" />
        </RailButton>
        <RailButton
          active={activeScope === "personal"}
          badge={personalUnreadCount}
          label="Personal"
          onClick={onActivatePersonal}
        >
          <span className="desktop-personal-mark" aria-hidden="true">
            K
          </span>
        </RailButton>
      </div>

      <div className="desktop-team-rail" aria-label="Teams">
        {teams.map((team, index) => {
          const active =
            typeof activeScope === "object" && activeScope.teamId === team.id;
          return (
            <RailButton
              active={active}
              badge={team.unreadCount}
              buttonRef={(button) => {
                if (button) teamButtonRefs.current.set(team.id, button);
                else teamButtonRefs.current.delete(team.id);
              }}
              key={team.id}
              label={team.name}
              onClick={() => onActivateTeam(team.id)}
              onKeyDown={(event) => {
                const targetIndex =
                  event.key === "ArrowDown"
                    ? Math.min(teams.length - 1, index + 1)
                    : event.key === "ArrowUp"
                      ? Math.max(0, index - 1)
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? teams.length - 1
                          : null;
                if (targetIndex === null) return;
                event.preventDefault();
                focusTeam(targetIndex);
              }}
              tabIndex={rovingTeamId === team.id ? 0 : -1}
            >
              <span
                className="desktop-team-disc"
                data-swatch={teamDiscIndex(team.id)}
                aria-hidden="true"
              >
                {teamInitials(team.name)}
              </span>
              {team.connectionState && team.connectionState !== "healthy" ? (
                <span
                  className="desktop-team-connection"
                  data-state={team.connectionState}
                  aria-label={`${team.connectionState} connection`}
                />
              ) : null}
            </RailButton>
          );
        })}
      </div>

      <div className="desktop-rail-fixed desktop-rail-bottom">
        <RailButton label="Devices" onClick={onOpenDevices}>
          <MonitorSmartphone aria-hidden="true" />
        </RailButton>
        <RailButton label="Add or join Team" onClick={onAddTeam}>
          <Plus aria-hidden="true" />
        </RailButton>
        <RailButton label="Search and commands" onClick={onOpenCommandPalette}>
          <Search aria-hidden="true" />
        </RailButton>
        <RailButton label="Preferences" onClick={onOpenPreferences}>
          <Settings aria-hidden="true" />
        </RailButton>
        <RailButton
          label={`Identity: ${identityLabel}`}
          onClick={onOpenPreferences}
        >
          <UserRound aria-hidden="true" />
        </RailButton>
      </div>
    </nav>
  );
}

export function ScopeLine({ children }: { children: ReactNode }) {
  return <div className="desktop-scope-line">{children}</div>;
}

export function AppShell({
  activeScope,
  children,
  contextNavigation,
  health,
  identityLabel,
  inspector,
  inspectorLabel = "Inspector",
  inspectorOpen,
  canGoBack,
  canGoForward,
  onActivateInbox,
  onActivatePersonal,
  onActivateTeam,
  onAddTeam,
  onCloseInspector,
  onGoBack,
  onGoForward,
  onOpenHealth,
  onOpenCommandPalette,
  onOpenDevices,
  onOpenPreferences,
  onToggleInspector,
  personalUnreadCount,
  scopeLine,
  teams,
  routeFocusKey
}: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mainPaneWidth, setMainPaneWidth] = useState(0);
  const mainRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setSidebarOpen(false);
    const frame = window.requestAnimationFrame(() => {
      const main = mainRef.current;
      const routeTarget = main?.querySelector<HTMLElement>(
        "[data-route-focus], [data-personal-route-focus]"
      );
      (routeTarget ?? main)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [routeFocusKey]);

  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const update = () => setMainPaneWidth(main.getBoundingClientRect().width);
    update();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(main);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenCommandPalette();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        onOpenPreferences();
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "i"
      ) {
        event.preventDefault();
        onToggleInspector();
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        if (event.key === "ArrowLeft" && canGoBack) {
          event.preventDefault();
          onGoBack();
        } else if (event.key === "ArrowRight" && canGoForward) {
          event.preventDefault();
          onGoForward();
        }
      }
      if (event.key === "Escape") {
        if (inspectorOpen) onCloseInspector();
        else setSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    inspectorOpen,
    canGoBack,
    canGoForward,
    onCloseInspector,
    onGoBack,
    onGoForward,
    onOpenCommandPalette,
    onOpenPreferences,
    onToggleInspector
  ]);

  return (
    <div
      className="desktop-app-shell"
      data-inspector-mode={mainPaneWidth >= 760 ? "docked" : "overlay"}
      data-inspector-open={inspectorOpen || undefined}
      data-sidebar-open={sidebarOpen || undefined}
    >
      <Rail
        activeScope={activeScope}
        identityLabel={identityLabel}
        onActivateInbox={onActivateInbox}
        onActivatePersonal={onActivatePersonal}
        onActivateTeam={onActivateTeam}
        onAddTeam={onAddTeam}
        onOpenCommandPalette={onOpenCommandPalette}
        onOpenDevices={onOpenDevices}
        onOpenPreferences={onOpenPreferences}
        personalUnreadCount={personalUnreadCount}
        teams={teams}
      />
      <aside
        className="desktop-context-sidebar"
        aria-label="Context navigation"
      >
        <div className="desktop-sidebar-mobile-header">
          <strong>Navigation</strong>
          <button
            aria-label="Close navigation"
            onClick={() => setSidebarOpen(false)}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </div>
        {contextNavigation}
      </aside>
      {sidebarOpen ? (
        <button
          aria-label="Close navigation"
          className="desktop-shell-scrim"
          onClick={() => setSidebarOpen(false)}
          type="button"
        />
      ) : null}
      <main
        className="desktop-main"
        ref={mainRef}
        tabIndex={-1}
        data-route-focus="main"
      >
        <header className="desktop-main-bar">
          <button
            aria-label="Open navigation"
            className="desktop-mobile-nav-trigger"
            onClick={() => setSidebarOpen(true)}
            type="button"
          >
            <Menu aria-hidden="true" />
          </button>
          <div
            className="desktop-history-controls"
            aria-label="Navigation history"
          >
            <button
              aria-label="Go back"
              disabled={!canGoBack}
              onClick={onGoBack}
              title="Back (Alt+Left)"
              type="button"
            >
              <ChevronLeft aria-hidden="true" />
            </button>
            <button
              aria-label="Go forward"
              disabled={!canGoForward}
              onClick={onGoForward}
              title="Forward (Alt+Right)"
              type="button"
            >
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
          {scopeLine}
          {health ? (
            <button
              aria-label={`Local health: ${health.label}`}
              className="desktop-health-trigger"
              data-state={health.state}
              onClick={onOpenHealth}
              title={health.label}
              type="button"
            >
              {health.state === "healthy" ? (
                <CircleCheck aria-hidden="true" />
              ) : health.state === "needs_attention" ? (
                <CircleAlert aria-hidden="true" />
              ) : (
                <LoaderCircle aria-hidden="true" />
              )}
            </button>
          ) : null}
          {inspector ? (
            <button
              aria-expanded={inspectorOpen}
              aria-label={inspectorOpen ? "Close Inspector" : "Open Inspector"}
              className="desktop-inspector-trigger"
              onClick={onToggleInspector}
              type="button"
            >
              {inspectorOpen ? (
                <ChevronRight aria-hidden="true" />
              ) : (
                <ChevronLeft aria-hidden="true" />
              )}
            </button>
          ) : null}
        </header>
        <div className="desktop-main-content">{children}</div>
      </main>
      {inspector && inspectorOpen ? (
        <aside className="desktop-inspector" aria-label={inspectorLabel}>
          <header>
            <strong>{inspectorLabel}</strong>
            <button
              aria-label="Close Inspector"
              onClick={onCloseInspector}
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          </header>
          <div className="desktop-inspector-content">{inspector}</div>
        </aside>
      ) : null}
    </div>
  );
}

export function EmptyRoute({
  action,
  description,
  icon = <CircleHelp aria-hidden="true" />,
  title
}: {
  action?: ReactNode;
  description: string;
  icon?: ReactNode;
  title: string;
}) {
  return (
    <section className="desktop-empty-route">
      <span className="desktop-empty-route-icon">{icon}</span>
      <h1>{title}</h1>
      <p>{description}</p>
      {action}
    </section>
  );
}

export function InboxSummary({
  approvals,
  faults,
  outbox,
  unread
}: {
  approvals: number;
  faults: number;
  outbox: number;
  unread: number;
}) {
  const total = approvals + faults + outbox + unread;
  return (
    <span className="desktop-inbox-summary" aria-label={`${total} Inbox items`}>
      <Bell aria-hidden="true" />
      {total}
    </span>
  );
}
