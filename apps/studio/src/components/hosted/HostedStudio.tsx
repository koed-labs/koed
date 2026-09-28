"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowUpRight,
  Bell,
  CircleAlert,
  FolderOpen,
  Globe2,
  LoaderCircle,
  PanelLeft,
  PanelLeftClose,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  User,
  Users
} from "lucide-react";
import {
  HostedRequestError,
  hostedWorkosLoginUrl,
  loadHostedSession,
  signInAndLoadHostedSession,
  selectHostedTeamId,
  type HostedAuthProvider,
  type HostedSessionResult,
  type HostedTeam,
  type HostedUser
} from "@/lib/hosted-session";
import { HostedManagedChats } from "./HostedManagedChats";
import { HostedTeamChannels } from "./HostedTeamChannels";

type HostedStudioProps = { view: "home" | "collaboration" };

const roleLabel = (value: string) =>
  value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

export function HostedStudio({ view }: HostedStudioProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [session, setSession] = useState<HostedSessionResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [loginError, setLoginError] = useState<string | null>(null);
  const previousUser = useRef<HostedUser | null>(null);
  const requestSequence = useRef(0);
  const loginSequence = useRef(0);
  const mounted = useRef(false);
  const requestedTeamId = searchParams.get("team");

  const storeResult = useCallback((result: HostedSessionResult) => {
    if (result.status === "authenticated") {
      previousUser.current = result.user;
      setSession(result);
    } else if (result.status === "session_changed") {
      previousUser.current = null;
      setSession(result);
    } else if (result.status === "signed_out" && previousUser.current) {
      setSession({
        status: "revoked",
        user: previousUser.current,
        providers: result.providers,
        message:
          "This session expired or was revoked. Sign in again to continue."
      });
    } else {
      setSession(result);
    }
  }, []);

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setBusy(true);
    const result = await loadHostedSession();
    if (sequence !== requestSequence.current) return;
    storeResult(result);
    setBusy(false);
  }, [storeResult]);

  useEffect(() => {
    mounted.current = true;
    const sequence = ++requestSequence.current;
    loadHostedSession().then((result) => {
      if (sequence !== requestSequence.current) return;
      storeResult(result);
      setBusy(false);
    });
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, storeResult]);

  const teams = useMemo(
    () => (session?.status === "authenticated" ? session.teams : []),
    [session]
  );
  const activeTeamId = selectHostedTeamId(teams, requestedTeamId);
  const activeTeam =
    view === "collaboration"
      ? (teams.find((team) => team.id === activeTeamId) ?? null)
      : null;

  const handleLocalLogin = async (email: string, password: string) => {
    const loginAttempt = ++loginSequence.current;
    requestSequence.current += 1;
    setLoginError(null);
    setBusy(true);
    try {
      const { requestSequence: sessionRequest, result } =
        await signInAndLoadHostedSession(
          email,
          password,
          () => ++requestSequence.current
        );
      if (
        !mounted.current ||
        loginAttempt !== loginSequence.current ||
        sessionRequest !== requestSequence.current
      ) {
        return;
      }
      storeResult(result);
      setBusy(false);
    } catch (error) {
      if (!mounted.current || loginAttempt !== loginSequence.current) return;
      setLoginError(
        error instanceof HostedRequestError
          ? error.message
          : "Studio could not sign in. Check your connection and retry."
      );
      setBusy(false);
    }
  };

  const startWorkosLogin = () => {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.assign(hostedWorkosLoginUrl(returnTo));
  };

  const currentUser =
    session?.status === "authenticated" || session?.status === "revoked"
      ? session.user
      : session?.status === "unavailable"
        ? session.user
        : undefined;

  return (
    <div className="flex h-screen min-h-0 w-full bg-background text-foreground">
      <HostedGlobalNav
        teams={teams}
        personalActive={view === "home"}
        onOpenPersonal={() => router.push("/")}
        activeTeamId={view === "collaboration" ? activeTeamId : null}
        onOpenTeam={(id) =>
          router.push(`/collaboration?team=${encodeURIComponent(id)}`)
        }
      />
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {view !== "collaboration" && <header className="z-10 flex h-14 shrink-0 items-center justify-between bg-background/80 px-4 pt-4 backdrop-blur-sm drag-region">
          <div className="flex min-w-0 items-center gap-3 no-drag">
            {activeTeam && (
              <>
              </>
            )}
            <div className="truncate text-sm text-muted">
              <span className="text-foreground-secondary">Studio</span>
              <span className="mx-2 text-faint">/</span>
              <span className="text-foreground">
                {view === "home" ? "Home" : (activeTeam?.name ?? "Team")}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3 no-drag">
            {currentUser && (
              <span className="hidden max-w-56 truncate text-xs text-muted sm:inline">
                {currentUser.email}
              </span>
            )}
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={busy}
              aria-label="Refresh Studio"
              title="Refresh Studio"
              className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
            </button>
          </div>
        </header>}

        <div className={`relative min-h-0 flex-1 ${view === "collaboration" ? "flex overflow-hidden" : "overflow-y-auto p-4"}`}>
          {session === null || (busy && session.status === "unavailable") ? (
            <LoadingState />
          ) : session.status === "signed_out" ? (
            <SignInPanel
              providers={session.providers}
              busy={busy}
              error={loginError}
              onLocalLogin={handleLocalLogin}
              onWorkosLogin={startWorkosLogin}
            />
          ) : session.status === "revoked" ? (
            <SignInPanel
              providers={session.providers}
              busy={busy}
              error={loginError}
              notice={session.message}
              onLocalLogin={handleLocalLogin}
              onWorkosLogin={startWorkosLogin}
            />
          ) : session.status === "unavailable" ? (
            <StatePanel
              icon={<CircleAlert className="h-5 w-5" />}
              title="Koed is temporarily unavailable"
              body={session.message}
              action={
                <button
                  type="button"
                  onClick={() => void refresh()}
                  className="rounded-lg bg-chip px-4 py-2 text-sm font-medium text-chip-foreground hover:opacity-90"
                >
                  Retry connection
                </button>
              }
            />
          ) : session.status === "session_changed" ? (
            <StatePanel
              icon={<CircleAlert className="h-5 w-5" />}
              title="Session changed"
              body={session.message}
              action={
                <button
                  type="button"
                  onClick={() => void refresh()}
                  className="rounded-lg bg-chip px-4 py-2 text-sm font-medium text-chip-foreground hover:opacity-90"
                >
                  Refresh session
                </button>
              }
            />
          ) : view === "home" ? (
            <>
              <HostedManagedChats
                key={session.user.id}
                onAuthorizationLost={refresh}
              />
              <HostedOverview teams={session.teams} />
            </>
          ) : activeTeam ? (
            <HostedTeamChannels key={`${typeof window === "undefined" ? "" : window.location.origin}:${session.user.id}:${activeTeam.id}`} team={activeTeam} user={session.user} allTeams={session.teams} onAuthorizationLost={refresh} />
          ) : (
            <HostedTeamNavigation teams={session.teams} selectedTeamId={activeTeamId} onSelect={(id) => router.push(`/collaboration?team=${encodeURIComponent(id)}`)} />
          )}
        </div>
      </main>
    </div>
  );
}

function TeamMark({ index }: { index: number }) {
  const colors = [
    "text-team-1",
    "text-team-2",
    "text-team-3",
    "text-team-4",
    "text-team-5",
    "text-team-6"
  ];
  return (
    <span
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface text-[10px] font-semibold ${colors[index % colors.length]}`}
    >
      T{index + 1}
    </span>
  );
}

function HostedGlobalNav({
  teams,
  personalActive,
  onOpenPersonal,
  activeTeamId,
  onOpenTeam
}: {
  teams: HostedTeam[];
  personalActive: boolean;
  onOpenPersonal: () => void;
  activeTeamId: string | null;
  onOpenTeam: (teamId: string) => void;
}) {
  const colors = [
    "text-team-1",
    "text-team-2",
    "text-team-3",
    "text-team-4",
    "text-team-5",
    "text-team-6"
  ];
  return (
    <div className="relative z-50 flex h-screen w-[72px] flex-shrink-0 flex-col items-center border-r border-border bg-sidebar py-4 pt-10">
      <button
        type="button"
        onClick={onOpenPersonal}
        aria-label="Personal Workspace"
        aria-current={personalActive ? "page" : undefined}
        title="Personal Workspace"
        className={`relative mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-surface-hover text-muted transition-colors hover:text-foreground ${personalActive ? "text-foreground ring-2 ring-accent ring-offset-2 ring-offset-sidebar" : ""}`}
      >
        <User className="h-5 w-5" />
      </button>

      <div className="my-2 h-px w-8 bg-surface-hover" />

      <nav aria-label="Teams" className="mt-2 flex flex-col gap-3">
        {teams.map((team, index) => (
          <button
            key={team.id}
            type="button"
            onClick={() => onOpenTeam(team.id)}
            aria-label={`Open ${team.name}`}
            aria-current={activeTeamId === team.id ? "page" : undefined}
            title={team.name}
            className={`relative flex h-10 w-10 items-center justify-center rounded-[20px] border border-border bg-surface text-sm font-semibold transition-all duration-200 hover:rounded-xl hover:bg-surface-hover hover:text-foreground ${activeTeamId === team.id ? "rounded-xl bg-surface-hover text-foreground ring-2 ring-accent ring-offset-2 ring-offset-sidebar" : `text-muted ${colors[index % colors.length]}`}`}
          >
            T{index + 1}
          </button>
        ))}
        <button
          type="button"
          disabled
          aria-label="Add New Team is unavailable"
          title="Team creation is unavailable in hosted Studio"
          className="flex h-10 w-10 cursor-not-allowed items-center justify-center rounded-[20px] border border-border bg-surface text-muted opacity-50"
        >
          <Plus className="h-5 w-5" />
        </button>
      </nav>

      <div className="mt-auto">
        <button
          type="button"
          disabled
          aria-label="Settings unavailable"
          title="Settings are unavailable in hosted Studio"
          className="flex h-10 w-10 cursor-not-allowed items-center justify-center rounded-xl text-muted opacity-50"
        >
          <Settings className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}

function HostedContextSidebar({
  id,
  team,
  onClose
}: {
  id: string;
  team: HostedTeam;
  onClose: () => void;
}) {
  return (
    <div
      id={id}
      role="navigation"
      aria-label="Team navigation"
      className="relative flex h-screen w-72 max-w-[calc(100vw-72px)] flex-shrink-0 flex-col border-r border-border bg-surface pt-6 drag-region"
    >
      <div className="px-3 py-2 no-drag">
        <div className="mb-1 flex items-center gap-2">
          <div className="min-w-0 flex-1 px-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
              Team
            </p>
            <p className="truncate text-sm font-medium text-foreground">
              {team.name}
            </p>
            <p className="mt-1 truncate text-[11px] text-muted">
              {roleLabel(team.membership.role)} ·{" "}
              {roleLabel(team.membership.status)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close team navigation"
            title="Close Sidebar"
            className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-foreground-secondary"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-0.5 px-3 py-2 no-drag">
        <UnavailableNavItem
          icon={<Bell className="mr-2 h-4 w-4" />}
          label="For you"
        />
        <UnavailableNavItem
          icon={<Globe2 className="mr-2 h-4 w-4" />}
          label="Public Square"
        />
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2 pt-0.5 no-drag">
        <p className="flex items-center px-4 py-1.5 text-sm font-medium text-foreground-secondary">
          <FolderOpen className="mr-2 h-4 w-4 text-subtle" />
          Workspaces
        </p>
        {team.workspaces.length > 0 ? (
          team.workspaces.map((workspace) => (
            <div
              key={workspace.id}
              className="flex min-w-0 items-center justify-between gap-2 rounded-md px-3 py-1.5 text-sm text-foreground-secondary"
              title={`${workspace.name} · ${workspace.access} access`}
            >
              <span className="min-w-0 truncate">{workspace.name}</span>
              <span className="shrink-0 text-[10px] text-subtle">
                {workspace.access === "write" ? "Write" : "Read"}
              </span>
            </div>
          ))
        ) : (
          <p className="px-4 py-1.5 text-xs text-muted">
            No authorized Workspaces
          </p>
        )}
        <button
          type="button"
          disabled
          title="Channel creation is unavailable in hosted Studio"
          className="flex w-full cursor-not-allowed items-center rounded-md px-3 py-1.5 text-left text-subtle opacity-50"
        >
          <Plus className="mr-2.5 h-3.5 w-3.5" />
          <span className="text-xs">New channel</span>
          <span className="ml-auto text-[10px]">Unavailable</span>
        </button>

        <div className="mt-4 flex items-center px-4 py-1.5 text-sm font-medium text-foreground-secondary">
          <Users className="mr-2 h-4 w-4 text-subtle" />
          Colleagues
        </div>
        {team.members.map((member) => (
          <div
            key={member.id}
            className="flex min-w-0 items-center gap-2 rounded-md px-4 py-1.5 text-sm text-foreground-secondary"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-[9px] text-muted">
              {member.name?.slice(0, 1).toUpperCase() ?? (
                <User className="h-3 w-3" />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {member.name || "Team member"}
            </span>
            {member.id === team.membership.userId && (
              <span className="shrink-0 text-[10px] text-subtle">You</span>
            )}
          </div>
        ))}
      </div>

      <div className="border-t border-border px-4 py-3 text-[11px] leading-5 text-muted">
        Team conversation views and actions are unavailable in hosted Studio.
      </div>
    </div>
  );
}

function UnavailableNavItem({
  icon,
  label
}: {
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      disabled
      title={`${label} is not available in hosted Studio`}
      aria-label={`${label}, unavailable in hosted Studio`}
      className="flex w-full cursor-not-allowed items-center rounded-md px-3 py-1.5 text-left text-muted opacity-50"
    >
      {icon}
      {label}
      <span className="ml-auto text-[10px]">Unavailable</span>
    </button>
  );
}

function LoadingState() {
  return (
    <div className="flex min-h-64 items-center justify-center rounded-2xl border border-border bg-surface/50">
      <div className="flex items-center gap-3 text-sm text-muted" role="status">
        <LoaderCircle className="h-4 w-4 animate-spin" />
        Connecting to Koed…
      </div>
    </div>
  );
}

function StatePanel({
  icon,
  title,
  body,
  action
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action: React.ReactNode;
}) {
  return (
    <section className="mx-auto flex min-h-72 max-w-xl flex-col items-center justify-center rounded-2xl border border-border bg-surface/50 px-6 py-10 text-center">
      <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-surface text-muted">
        {icon}
      </div>
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-2 max-w-md text-sm leading-6 text-muted">{body}</p>
      <div className="mt-6">{action}</div>
    </section>
  );
}

function SignInPanel({
  providers,
  busy,
  error,
  notice,
  onLocalLogin,
  onWorkosLogin
}: {
  providers: HostedAuthProvider[];
  busy: boolean;
  error: string | null;
  notice?: string;
  onLocalLogin: (email: string, password: string) => Promise<void>;
  onWorkosLogin: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const hasProvider =
    providers.includes("local") || providers.includes("workos");
  return (
    <section className="mx-auto max-w-xl rounded-2xl border border-border bg-surface/50 p-6 md:p-8">
      <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-xl bg-surface text-muted">
        <ShieldCheck className="h-5 w-5" />
      </div>
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">
        Secure backend session
      </p>
      <h3 className="mt-2 text-xl font-semibold">Sign in to Koed Studio</h3>
      <p className="mt-2 text-sm leading-6 text-muted">
        Studio checks the session on this Koed backend and loads only the Teams
        your account is authorized to navigate.
      </p>
      {notice && (
        <p
          className="mt-4 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning"
          role="status"
        >
          {notice}
        </p>
      )}

      {providers.includes("local") && (
        <form
          className="mt-7 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onLocalLogin(email.trim(), password);
          }}
        >
          <label className="block space-y-1.5 text-xs font-medium text-foreground-secondary">
            Email
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-accent"
            />
          </label>
          <label className="block space-y-1.5 text-xs font-medium text-foreground-secondary">
            Password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-accent"
            />
          </label>
          {error && (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-chip px-4 py-2.5 text-sm font-medium text-chip-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      )}

      {providers.includes("workos") && (
        <button
          type="button"
          onClick={onWorkosLogin}
          disabled={busy}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground-secondary transition hover:bg-surface-hover disabled:opacity-50"
        >
          Continue with WorkOS <ArrowUpRight className="h-4 w-4" />
        </button>
      )}

      {!hasProvider && (
        <p className="mt-6 rounded-lg border border-border px-4 py-3 text-sm text-muted">
          This Koed deployment has no browser sign-in provider available.
        </p>
      )}
    </section>
  );
}

function HostedOverview({ teams }: { teams: HostedTeam[] }) {
  return (
    <div>
      <div className="max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">
          Authorized Team access
        </p>
        <h3 className="mt-2 text-2xl font-semibold tracking-tight">
          Your Koed Teams
        </h3>
        <p className="mt-2 text-sm leading-6 text-muted">
          Team names, membership, and Workspace navigation below come from this
          Koed session. Team conversations and actions are currently unavailable
          in hosted Studio.
        </p>
      </div>
      {teams.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-border bg-surface/50 p-6">
          <h4 className="font-medium">No Team memberships found</h4>
          <p className="mt-2 text-sm leading-6 text-muted">
            This account has no Teams available for navigation on this Koed
            deployment.
          </p>
        </div>
      ) : (
        <div className="mt-7 grid gap-4 lg:grid-cols-2">
          {teams.map((team, index) => (
            <article
              key={team.id}
              className="rounded-2xl border border-border bg-surface/50 p-5 transition-colors hover:border-border-strong"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <TeamMark index={index} />
                  <div className="min-w-0">
                    <h4 className="truncate font-semibold">{team.name}</h4>
                    <p className="mt-1 text-xs text-muted">
                      {roleLabel(team.membership.role)} ·{" "}
                      {roleLabel(team.membership.status)}
                    </p>
                  </div>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] text-success">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Authorized
                </span>
              </div>
              <div className="mt-5 border-t border-border pt-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-subtle">
                  Workspaces
                </p>
                <p className="mt-1.5 text-sm text-foreground-secondary">
                  {team.workspaces.length === 0
                    ? "No authorized Workspaces"
                    : `${team.workspaces.length} authorized ${team.workspaces.length === 1 ? "Workspace" : "Workspaces"}`}
                </p>
              </div>
              <Link
                href={`/collaboration?team=${encodeURIComponent(team.id)}`}
                className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-accent hover:text-accent-hover"
              >
                Open Team navigation <ArrowUpRight className="h-4 w-4" />
              </Link>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function HostedTeamNavigation({
  teams,
  selectedTeamId,
  onSelect
}: {
  teams: HostedTeam[];
  selectedTeamId: string | null;
  onSelect: (id: string) => void;
}) {
  const team = teams.find((item) => item.id === selectedTeamId) ?? null;
  if (!team) {
    return (
      <div className="rounded-2xl border border-border bg-surface/50 p-6">
        <h3 className="font-semibold">No Team navigation available</h3>
        <p className="mt-2 text-sm leading-6 text-muted">
          This account has no authorized Team membership on this Koed
          deployment.
        </p>
      </div>
    );
  }
  return (
    <div className="max-w-3xl">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">
        Authorized navigation
      </p>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 className="text-2xl font-semibold tracking-tight">{team.name}</h3>
          <p className="mt-2 text-sm text-muted">
            {roleLabel(team.membership.role)} membership ·{" "}
            {roleLabel(team.membership.status)}
          </p>
        </div>
        {teams.length > 1 && (
          <label className="space-y-1.5 text-xs font-medium text-muted">
            Switch Team
            <select
              value={team.id}
              onChange={(event) => onSelect(event.target.value)}
              className="block min-w-48 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
            >
              {teams.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="mt-8 rounded-2xl border border-border bg-surface/50">
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <FolderOpen className="h-4 w-4 text-muted" />
          <div>
            <h4 className="text-sm font-medium">Workspaces</h4>
            <p className="mt-0.5 text-xs text-muted">
              Only Workspaces returned by the authorized Team navigation
              endpoint appear here.
            </p>
          </div>
        </div>
        {team.workspaces.length > 0 ? (
          <ul className="divide-y divide-border">
            {team.workspaces.map((workspace) => (
              <li
                key={workspace.id}
                className="flex items-center justify-between gap-4 px-5 py-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {workspace.name}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {workspace.access === "write" ? "Can edit" : "Read access"}
                    {workspace.lifecycle !== "active" &&
                      ` · ${roleLabel(workspace.lifecycle)}`}
                  </p>
                </div>
                <span className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted">
                  {workspace.access === "write" ? "Write" : "Read"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-5 py-6 text-sm text-muted">
            No authorized Workspaces are available in this Team.
          </div>
        )}
      </div>
      <p className="mt-5 rounded-xl border border-border bg-sidebar px-4 py-3 text-sm leading-6 text-muted">
        Team conversations, channel lists, and actions are currently unavailable
        in hosted Studio.
      </p>
    </div>
  );
}
