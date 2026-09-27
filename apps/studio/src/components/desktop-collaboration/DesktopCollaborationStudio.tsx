"use client";

import { useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  Building2,
  ChevronRight,
  CircleHelp,
  Radio,
  RefreshCw,
  Settings,
  User,
  Users
} from "lucide-react";
import type {
  DesktopCollaborationConnectionState,
  DesktopCollaborationSnapshot,
  DesktopCollaborationTeam
} from "@/lib/desktop-collaboration";

type Section = "overview" | "people" | "workspaces";

const connectionLabel: Record<DesktopCollaborationConnectionState, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting",
  live: "Connected",
  reconnecting: "Reconnecting",
  unavailable: "Unavailable",
  access_revoked: "Access revoked"
};

export function DesktopCollaborationStudio({
  snapshot,
  onRetry
}: {
  snapshot: DesktopCollaborationSnapshot;
  onRetry: () => void;
}) {
  const [activeTeamId, setActiveTeamId] = useState(
    snapshot.teams[0]?.id ?? null
  );
  const [section, setSection] = useState<Section>("overview");
  const activeTeam =
    snapshot.teams.find((team) => team.id === activeTeamId) ??
    snapshot.teams[0] ??
    null;
  const live = snapshot.connection.state === "live";
  const noTeamTitle: Record<DesktopCollaborationConnectionState, string> = {
    disconnected: "No Team backend selected",
    connecting: "Connecting to Team backend",
    live: "No Teams available",
    reconnecting: "Reconnecting to Team backend",
    unavailable: "Team backend unavailable",
    access_revoked: "Team access changed"
  };
  const noTeamMessage: Record<DesktopCollaborationConnectionState, string> = {
    disconnected:
      "Open Settings to connect a Team backend and load its authorized Teams here.",
    connecting:
      "Studio is waiting for the selected Team backend connection to become available.",
    live: "This backend has no Teams available to this User.",
    reconnecting:
      "Studio is reconnecting to the selected backend. Team navigation will return when it is live.",
    unavailable:
      "The Team connection could not be checked. Open Settings to connect or retry after the backend is restored.",
    access_revoked:
      "Access to the selected backend was revoked. Refresh after reconnecting to see current Teams."
  };

  const chooseTeam = (team: DesktopCollaborationTeam) => {
    setActiveTeamId(team.id);
    setSection("overview");
  };

  return (
    <div className="flex h-screen min-h-0 w-full bg-background text-foreground">
      <div className="relative z-20 flex h-screen w-[72px] flex-shrink-0 flex-col items-center border-r border-border bg-sidebar py-4 pt-10 drag-region">
        <Link
          href="/"
          aria-label="Personal Workspace"
          title="Personal Workspace"
          className="no-drag mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-surface-hover text-foreground transition-colors hover:bg-surface-active"
        >
          <User className="h-5 w-5" />
        </Link>
        <div className="my-2 h-px w-8 bg-surface-hover no-drag" />
        <div
          className="no-drag flex flex-col items-center gap-3"
          aria-label="Teams"
        >
          {snapshot.teams.map((team, index) => {
            const selected = activeTeam?.id === team.id;
            return (
              <button
                key={team.id}
                type="button"
                aria-label={team.name}
                aria-current={selected ? "page" : undefined}
                onClick={() => chooseTeam(team)}
                title={team.name}
                className={`relative flex h-10 w-10 items-center justify-center rounded-[20px] border text-sm font-semibold transition-all hover:rounded-xl ${selected ? "rounded-xl border-accent/50 bg-surface-hover text-foreground ring-2 ring-accent ring-offset-2 ring-offset-sidebar" : "border-border bg-surface text-muted hover:bg-surface-hover hover:text-foreground"}`}
              >
                {team.name.trim().slice(0, 1).toUpperCase() || index + 1}
                {team.unreadCount > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-sidebar">
                    {team.unreadCount > 9 ? "9+" : team.unreadCount}
                  </span>
                )}
              </button>
            );
          })}
          {snapshot.teams.length === 0 && (
            <span
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-surface text-subtle"
              aria-hidden="true"
            >
              <Users className="h-4 w-4" />
            </span>
          )}
        </div>
        <div className="mt-auto flex flex-col items-center gap-3 no-drag">
          <div
            className={`h-2 w-2 rounded-full ${live ? "bg-success" : snapshot.connection.state === "reconnecting" || snapshot.connection.state === "connecting" ? "bg-warning" : "bg-faint"}`}
            title={connectionLabel[snapshot.connection.state]}
          />
          <Link
            href="/settings"
            aria-label="Settings"
            title="Settings"
            className="flex h-10 w-10 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <Settings className="h-5 w-5" />
          </Link>
        </div>
      </div>

      {activeTeam ? (
        <>
          <aside className="flex h-screen w-[288px] flex-shrink-0 flex-col border-r border-border bg-surface pt-6 drag-region">
            <div className="px-3 py-2 no-drag">
              <p className="px-2 text-[11px] font-semibold uppercase tracking-wider text-subtle">
                Team
              </p>
              <div className="mt-1 flex items-center gap-2 px-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {activeTeam.name}
                </span>
                <span className="rounded bg-surface-hover px-1.5 py-0.5 text-[10px] capitalize text-muted">
                  {activeTeam.role}
                </span>
              </div>
            </div>

            <nav className="mt-5 px-3 no-drag" aria-label="Team navigation">
              <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-subtle">
                Navigation
              </p>
              <SidebarItem
                label="Overview"
                selected={section === "overview"}
                onClick={() => setSection("overview")}
              />
              <SidebarItem
                label="People"
                count={activeTeam.people.length}
                selected={section === "people"}
                onClick={() => setSection("people")}
              />
              <SidebarItem
                label="Workspaces"
                count={activeTeam.workspaces.length}
                selected={section === "workspaces"}
                onClick={() => setSection("workspaces")}
              />
            </nav>

            <div className="mt-auto border-t border-border px-4 py-4 no-drag">
              <div className="flex items-start gap-2.5">
                <Radio
                  className={`mt-0.5 h-4 w-4 flex-shrink-0 ${live ? "text-success" : "text-muted"}`}
                />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground-secondary">
                    {connectionLabel[snapshot.connection.state]}
                  </p>
                  <p className="mt-0.5 break-all text-[10px] leading-relaxed text-subtle">
                    {snapshot.connection.backendId
                      ? `Backend ${snapshot.connection.backendId}`
                      : "No backend selected"}
                  </p>
                </div>
              </div>
            </div>
          </aside>

          <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="z-10 flex h-14 shrink-0 items-center justify-between bg-background/80 px-4 pt-4 backdrop-blur-sm drag-region">
              <div className="flex min-w-0 items-center gap-2 no-drag">
                <span className="truncate text-sm text-foreground">
                  {activeTeam.name}
                </span>
                <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-faint" />
                <span className="text-sm text-muted">
                  {sectionLabel(section)}
                </span>
              </div>
              <button
                type="button"
                onClick={onRetry}
                aria-label="Refresh Team connection"
                title="Refresh Team connection"
                className="rounded-md p-1.5 text-subtle transition-colors hover:bg-surface-hover hover:text-foreground-secondary no-drag"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-7">
              {section === "overview" && <TeamOverview team={activeTeam} />}
              {section === "people" && <PeopleList team={activeTeam} />}
              {section === "workspaces" && <WorkspaceList team={activeTeam} />}
            </div>
          </main>
        </>
      ) : (
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="z-10 flex h-14 shrink-0 items-center justify-between bg-background/80 px-4 pt-4 backdrop-blur-sm drag-region">
            <p className="text-sm text-foreground">Teams</p>
            <button
              type="button"
              onClick={onRetry}
              aria-label="Refresh Team connection"
              className="rounded-md p-1.5 text-subtle hover:bg-surface-hover hover:text-foreground-secondary no-drag"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </header>
          <div className="m-auto max-w-md px-6 text-center">
            {snapshot.connection.state === "access_revoked" ? (
              <AlertCircle className="mx-auto mb-4 h-6 w-6 text-warning" />
            ) : (
              <CircleHelp className="mx-auto mb-4 h-6 w-6 text-subtle" />
            )}
            <h1 className="text-lg font-medium text-foreground">
              {noTeamTitle[snapshot.connection.state]}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-subtle">
              {noTeamMessage[snapshot.connection.state]}
            </p>
          </div>
        </main>
      )}
    </div>
  );
}

export function DesktopCollaborationRecoveryRail() {
  return (
    <nav
      aria-label="Workspace navigation"
      className="flex h-screen w-[72px] shrink-0 flex-col items-center border-r border-border bg-sidebar py-4 pt-10"
    >
      <Link
        href="/"
        aria-label="Personal Workspace"
        title="Personal Workspace"
        className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-hover text-foreground transition-colors hover:bg-surface-active"
      >
        <User className="h-5 w-5" />
      </Link>
      <div className="my-6 h-px w-8 bg-surface-hover" />
      <div className="mt-auto">
        <Link
          href="/settings"
          aria-label="Settings"
          title="Settings"
          className="flex h-10 w-10 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <Settings className="h-5 w-5" />
        </Link>
      </div>
    </nav>
  );
}

function SidebarItem({
  label,
  count,
  selected,
  onClick
}: {
  label: string;
  count?: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? "page" : undefined}
      className={`flex w-full items-center justify-between rounded-md px-3 py-1.5 text-left text-sm transition-colors ${selected ? "bg-surface-hover font-medium text-foreground" : "text-muted hover:bg-surface-hover/50 hover:text-foreground-secondary"}`}
    >
      <span>{label}</span>
      {count !== undefined && (
        <span className="text-[11px] text-subtle">{count}</span>
      )}
    </button>
  );
}

function TeamOverview({ team }: { team: DesktopCollaborationTeam }) {
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-subtle">
            Authorized Team
          </p>
          <h1 className="text-2xl font-medium tracking-tight text-foreground">
            {team.name}
          </h1>
        </div>
        <span className="rounded-full border border-border bg-surface px-3 py-1 text-xs capitalize text-muted">
          {team.role}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <SummaryCard
          icon={<Users className="h-4 w-4" />}
          label="People"
          count={team.people.length}
        />
        <SummaryCard
          icon={<Building2 className="h-4 w-4" />}
          label="Workspaces"
          count={team.workspaces.length}
        />
      </div>
      <p className="mt-7 max-w-2xl text-sm leading-relaxed text-subtle">
        This view is connected to the selected Team backend. Studio is showing
        the Team navigation currently authorized for this User.
      </p>
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  count
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface/60 px-4 py-4">
      <div className="flex items-center gap-2 text-subtle">
        {icon}
        <span className="text-xs font-medium">{label}</span>
      </div>
      <p className="mt-4 text-2xl font-medium tracking-tight text-foreground">
        {count}
      </p>
    </div>
  );
}

function PeopleList({ team }: { team: DesktopCollaborationTeam }) {
  return (
    <SectionContent
      title="People"
      description={`People listed for ${team.name}.`}
      icon={<Users className="h-4 w-4" />}
    >
      {team.people.length === 0 ? (
        <EmptyList message="No people are available in this Team snapshot." />
      ) : (
        team.people.map((person) => (
          <div
            key={person.id}
            className="flex items-center gap-3 border-b border-border px-3 py-3 last:border-0"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-hover text-[11px] font-medium text-foreground-secondary">
              {person.displayName.trim().slice(0, 1).toUpperCase() || "?"}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-foreground-secondary">
              {person.displayName}
            </span>
          </div>
        ))
      )}
    </SectionContent>
  );
}

function WorkspaceList({ team }: { team: DesktopCollaborationTeam }) {
  return (
    <SectionContent
      title="Workspaces"
      description={`Workspaces available through ${team.name}.`}
      icon={<Building2 className="h-4 w-4" />}
    >
      {team.workspaces.length === 0 ? (
        <EmptyList message="No workspaces are available in this Team snapshot." />
      ) : (
        team.workspaces.map((workspace) => (
          <div
            key={workspace.id}
            className="flex items-center gap-3 border-b border-border px-3 py-3 last:border-0"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface text-subtle">
              <Building2 className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-foreground-secondary">
              {workspace.name}
            </span>
          </div>
        ))
      )}
    </SectionContent>
  );
}

function SectionContent({
  title,
  description,
  icon,
  children
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mx-auto max-w-4xl">
      <div className="mb-5 flex items-start gap-3">
        <span className="mt-0.5 text-subtle">{icon}</span>
        <div>
          <h1 className="text-xl font-medium tracking-tight text-foreground">
            {title}
          </h1>
          <p className="mt-1 text-sm text-subtle">{description}</p>
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-surface/50">
        {children}
      </div>
    </section>
  );
}

function EmptyList({ message }: { message: string }) {
  return <p className="px-4 py-6 text-sm text-subtle">{message}</p>;
}

function sectionLabel(section: Section) {
  switch (section) {
    case "people":
      return "People";
    case "workspaces":
      return "Workspaces";
    default:
      return "Overview";
  }
}
