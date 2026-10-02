"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronRight,
  Folder,
  GitPullRequest,
  MessageSquare,
  PanelLeft,
  PenLine,
  Sparkles,
  Users,
  UsersRound
} from "lucide-react";
import {
  buildHomeFeed,
  HOME_VISIBLE_COUNT,
  type HomeItem,
  type HomeUrgency
} from "@/lib/home";
import { initialsFor, teamTone } from "@/lib/identity";
import { CreateProjectModal } from "./CreateProjectModal";
import { useSidebar } from "./SidebarContext";
import { Tooltip } from "./Tooltip";
import { useWorkspace } from "./WorkspaceProvider";

// One icon per destination - a quick visual anchor for what kind of thing
// this invitation leads to (a chat, a team, a review, ...). Rendered as a
// literal JSX tag per case (rather than picking a component into a
// variable) so the icon stays a stable element across renders.
function DestinationIcon({
  item,
  className
}: {
  item: HomeItem;
  className?: string;
}) {
  switch (item.destination.type) {
    case "thread":
      return <MessageSquare className={className} />;
    case "draft":
      return <PenLine className={className} />;
    case "prompt":
      return <Sparkles className={className} />;
    case "collab":
      return <Users className={className} />;
    case "team":
      return <UsersRound className={className} />;
    case "pull-requests":
      return <GitPullRequest className={className} />;
    default:
      return <Sparkles className={className} />;
  }
}

// Color-coding by urgency, not by category - "now" always reads as the
// warmest, "idle" always reads as the quietest, whatever kind of item it is.
// This is a *different* axis from the team/project tags below: urgency says
// "how much this matters right now", team/project say "whose this is".
const URGENCY_STYLE: Record<
  HomeUrgency,
  {
    iconChip: string;
    kicker: string;
    border: string;
    glow: string;
    cta: string;
    badge: string;
  }
> = {
  now: {
    iconChip: "bg-accent/15 text-accent",
    kicker: "text-accent",
    border: "border-accent/25 hover:border-accent/40",
    glow: "bg-gradient-to-br from-accent/10 via-accent/5 to-transparent",
    cta: "bg-accent text-white",
    badge: "bg-accent/10 text-accent"
  },
  soon: {
    iconChip: "bg-warning/15 text-warning",
    kicker: "text-warning",
    border: "border-warning/20 hover:border-warning/35",
    glow: "bg-gradient-to-br from-warning/10 via-warning/5 to-transparent",
    cta: "bg-chip text-chip-foreground",
    badge: "bg-warning/10 text-warning"
  },
  idle: {
    iconChip: "bg-surface-hover text-muted",
    kicker: "text-subtle",
    border: "border-border hover:border-border-strong",
    glow: "bg-surface/40",
    cta: "bg-chip text-chip-foreground",
    badge: "bg-surface-hover text-subtle"
  }
};

// The kicker already carries "{team name} · {status}" - once we show the
// team as its own colored badge, repeat the name in prose too and it just
// gets noisy. Trim it down to the status half for display only; the
// underlying item.kicker (used nowhere else) is untouched.
function kickerSuffix(item: HomeItem): string {
  if (item.team) {
    const prefix = `${item.team.name} · `;
    if (item.kicker.startsWith(prefix)) return item.kicker.slice(prefix.length);
  }
  return item.kicker;
}

function TeamBadge({
  team,
  className
}: {
  team: { id: string; name: string };
  className?: string;
}) {
  const tone = teamTone(team.id);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2.5 text-xs font-medium ${tone.chip} ${className ?? ""}`}
    >
      <span
        className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold text-white ${tone.solid}`}
      >
        {initialsFor(team.name)}
      </span>
      {team.name}
    </span>
  );
}

function ProjectTag({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-xs text-foreground-secondary ${className ?? ""}`}
    >
      <Folder className="h-3 w-3 text-subtle" />
      {name}
    </span>
  );
}

// The team/project identity row - present whenever we know who or what an
// item belongs to, absent otherwise (a bare "ask Koed anything" item has
// neither, and stays unadorned rather than showing an empty row).
function IdentityRow({
  item,
  className
}: {
  item: HomeItem;
  className?: string;
}) {
  if (!item.team && !item.project) return null;
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className ?? ""}`}>
      {item.team && <TeamBadge team={item.team} />}
      {item.project && <ProjectTag name={item.project.name} />}
    </div>
  );
}

function UrgencyBadge({ urgency }: { urgency: HomeUrgency }) {
  if (urgency === "idle") return null;
  const style = URGENCY_STYLE[urgency];
  return (
    <span
      className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${style.badge}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${urgency === "now" ? "bg-accent" : "bg-warning"}`}
      />
      {urgency === "now" ? "Now" : "Soon"}
    </span>
  );
}

// A compact reading of the agent mix - just colored dots and counts, no
// bar - so tiles can show "how much is happening" without much height.
function MixDots({
  mix
}: {
  mix: { waiting: number; running: number; idle: number };
}) {
  const total = mix.waiting + mix.running + mix.idle;
  if (total === 0) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-subtle">
      {mix.waiting > 0 && (
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-chip" />
          {mix.waiting} waiting
        </span>
      )}
      {mix.running > 0 && (
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          {mix.running} working
        </span>
      )}
      {mix.idle > 0 && (
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-surface-active" />
          {mix.idle} idle
        </span>
      )}
    </p>
  );
}

export function KoedHome() {
  const router = useRouter();
  const { isOpen, toggleSidebar } = useSidebar();
  const {
    workspace,
    previousSessionAt,
    addProject,
    startDraft,
    askKoed,
    setActiveThreadId,
    openCollaborative,
    setActiveTeamId
  } = useWorkspace();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const items = buildHomeFeed(workspace, previousSessionAt);
  const featured = items[0] ?? null;
  const support = items.slice(1, HOME_VISIBLE_COUNT);
  const more = items.slice(HOME_VISIBLE_COUNT);

  const openItem = (item: HomeItem) => {
    const destination = item.destination;
    if (destination.type === "thread") {
      setActiveThreadId(destination.threadId);
      router.push("/");
      return;
    }
    if (destination.type === "draft") {
      startDraft(destination.projectId);
      router.push("/");
      return;
    }
    if (destination.type === "prompt") {
      askKoed(destination.prompt, destination.projectId);
      router.push("/");
      return;
    }
    if (destination.type === "collab") {
      openCollaborative(destination.landing);
      router.push("/");
      return;
    }
    if (destination.type === "team") {
      setActiveTeamId(destination.teamId);
      router.push("/");
      return;
    }
    router.push("/pull-requests");
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <header className="z-10 flex h-14 items-center px-4 bg-background/80 pt-4 backdrop-blur-sm drag-region">
        <div className="flex items-center gap-3 no-drag">
          {!isOpen && (
            <Tooltip content="Open Sidebar" side="bottom">
              <button
                type="button"
                onClick={toggleSidebar}
                className="rounded-md p-1.5 text-muted hover:bg-surface-hover hover:text-foreground"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
            </Tooltip>
          )}
          <p className="text-sm text-foreground">Home</p>
        </div>
      </header>
      <main className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-4xl pt-6 pb-20">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3 px-1">
            <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-subtle">
              <Sparkles className="h-3 w-3 text-faint" />
              Suggested by Koed
            </p>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface hover:text-foreground"
                onClick={() => {
                  startDraft(null);
                  router.push("/");
                }}
              >
                New chat
              </button>
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface hover:text-foreground"
                onClick={() => setIsCreateOpen(true)}
              >
                New project
              </button>
            </div>
          </div>
          {items.length === 0 ? (
            <p className="px-1 text-sm text-subtle">
              Start a 1:1 chat or a project. Koed will invite you back here when
              there is work waiting.
            </p>
          ) : (
            <div className="space-y-8">
              {featured && (
                <FeaturedInvitation
                  item={featured}
                  onOpen={() => openItem(featured)}
                />
              )}
              {support.length > 0 && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {support.map((item) => (
                    <TileInvitation
                      key={item.id}
                      item={item}
                      onOpen={() => openItem(item)}
                    />
                  ))}
                </div>
              )}
              {more.length > 0 && (
                <div>
                  <button
                    type="button"
                    aria-expanded={moreOpen}
                    onClick={() => setMoreOpen((current) => !current)}
                    className="flex items-center gap-2 px-1 text-[11px] font-medium uppercase tracking-[0.18em] text-subtle transition-colors hover:text-foreground-secondary"
                  >
                    <ChevronRight
                      className={`h-3.5 w-3.5 transition-transform duration-200 ${moreOpen ? "rotate-90" : ""}`}
                    />
                    More from Koed
                    <span className="text-faint">{more.length}</span>
                  </button>
                  {moreOpen && (
                    <div className="mt-3 space-y-0.5">
                      {more.map((item) => (
                        <RowInvitation
                          key={item.id}
                          item={item}
                          onOpen={() => openItem(item)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </main>
      {isCreateOpen && (
        <CreateProjectModal
          teams={workspace.teams}
          onClose={() => setIsCreateOpen(false)}
          onCreate={(created) => {
            const project = addProject({
              name: created.name,
              path: created.path,
              branch: created.branch,
              sharedWith: created.sharedWith
            });
            setIsCreateOpen(false);
            const teamId = project.sharedWith[0];
            if (teamId) {
              openCollaborative({
                teamId,
                projectId: project.id,
                view: "square"
              });
              router.push("/");
              return;
            }
            startDraft(project.id);
            router.push("/");
          }}
        />
      )}
    </div>
  );
}

// Fills what would otherwise be dead space on the right of the featured
// card with the one or two things most worth a glance: who this belongs
// to (a big version of the team badge) and, when there's an agent mix,
// the headline numbers from it. Falls back to a plain watermark icon when
// an item has neither - still better than empty black.
function FeaturedSidePanel({ item }: { item: HomeItem }) {
  const tone = item.team ? teamTone(item.team.id) : null;
  return (
    <div className="hidden w-48 flex-shrink-0 flex-col items-center justify-center gap-5 border-l border-border/60 bg-background/10 px-6 py-8 sm:flex">
      {item.team && tone ? (
        <div className="flex flex-col items-center gap-2">
          <div
            className={`flex h-16 w-16 items-center justify-center rounded-full text-lg font-semibold text-white ${tone.solid}`}
          >
            {initialsFor(item.team.name)}
          </div>
          <p className="max-w-[9rem] text-center text-sm font-medium text-foreground-secondary">
            {item.team.name}
          </p>
        </div>
      ) : (
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-hover text-faint">
          <DestinationIcon item={item} className="h-7 w-7" />
        </div>
      )}
      {item.mix && (item.mix.waiting > 0 || item.mix.running > 0) && (
        <div className="flex items-center gap-5">
          {item.mix.waiting > 0 && (
            <div className="text-center">
              <p className="text-xl font-semibold text-foreground">
                {item.mix.waiting}
              </p>
              <p className="text-[10px] uppercase tracking-wide text-subtle">
                waiting
              </p>
            </div>
          )}
          {item.mix.running > 0 && (
            <div className="text-center">
              <p className="text-xl font-semibold text-foreground">
                {item.mix.running}
              </p>
              <p className="text-[10px] uppercase tracking-wide text-subtle">
                working
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type InvitationState = {
  disabled?: boolean;
  title?: string;
};

export function FeaturedInvitation({
  item,
  onOpen,
  disabled = false,
  title
}: { item: HomeItem; onOpen: () => void } & InvitationState) {
  const style = URGENCY_STYLE[item.urgency];
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      title={title}
      className={`group relative flex w-full items-stretch overflow-hidden rounded-2xl border text-left transition-all duration-200 hover:shadow-xl hover:shadow-black/5 ${style.border} ${style.glow}`}
    >
      <div className="min-w-0 flex-1 px-4 py-5 sm:px-7 sm:py-8">
        <div className="flex items-start justify-between gap-4">
          <div
            className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl ${style.iconChip}`}
          >
            <DestinationIcon item={item} className="h-5 w-5" />
          </div>
          <UrgencyBadge urgency={item.urgency} />
        </div>
        <IdentityRow item={item} className="mt-5" />
        <p
          className={`mt-3 text-[11px] font-medium uppercase tracking-[0.18em] ${style.kicker}`}
        >
          {kickerSuffix(item)}
        </p>
        <p className="mt-3 max-w-2xl text-2xl font-medium leading-[1.15] tracking-tight text-foreground sm:text-[28px]">
          {item.title}
        </p>
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted">
          {item.detail}
        </p>
        <span
          className={`mt-7 inline-flex rounded-md px-5 py-2.5 text-sm font-medium transition-all duration-200 group-hover:translate-x-0.5 group-hover:brightness-110 ${style.cta}`}
        >
          {item.actionLabel}
        </span>
      </div>
      <FeaturedSidePanel item={item} />
    </button>
  );
}

export function TileInvitation({
  item,
  onOpen,
  disabled = false,
  title
}: { item: HomeItem; onOpen: () => void } & InvitationState) {
  const style = URGENCY_STYLE[item.urgency];
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      title={title}
      className={`group relative flex min-h-[176px] flex-col rounded-xl border bg-surface/30 p-5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:bg-surface hover:shadow-lg hover:shadow-black/5 ${style.border}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div
          className={`flex h-9 w-9 items-center justify-center rounded-lg ${style.iconChip}`}
        >
          <DestinationIcon item={item} className="h-4 w-4" />
        </div>
        <UrgencyBadge urgency={item.urgency} />
      </div>
      <IdentityRow item={item} className="mt-3" />
      <p
        className={`mt-3 text-[11px] font-medium uppercase tracking-[0.16em] ${style.kicker}`}
      >
        {kickerSuffix(item)}
      </p>
      <p className="mt-2 text-[15px] leading-snug tracking-tight text-foreground">
        {item.title}
      </p>
      <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-subtle">
        {item.detail}
      </p>
      {item.mix && (
        <div className="mt-3">
          <MixDots mix={item.mix} />
        </div>
      )}
      <span className="mt-auto flex items-center gap-1 pt-5 text-sm font-medium text-foreground transition-transform duration-200 group-hover:translate-x-0.5">
        {item.actionLabel}
        <span className="text-subtle transition-colors group-hover:text-foreground-secondary">
          →
        </span>
      </span>
    </button>
  );
}

export function RowInvitation({
  item,
  onOpen,
  disabled = false,
  title
}: { item: HomeItem; onOpen: () => void } & InvitationState) {
  const style = URGENCY_STYLE[item.urgency];
  const tone = item.team ? teamTone(item.team.id) : null;
  const subtitle =
    [item.team?.name, item.project?.name].filter(Boolean).join(" · ") ||
    kickerSuffix(item);
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      title={title}
      className="group flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors duration-200 hover:bg-surface-hover/60"
    >
      <div
        className={`relative flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md ${style.iconChip}`}
      >
        <DestinationIcon item={item} className="h-3.5 w-3.5" />
        {tone && (
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-background ${tone.solid}`}
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">{item.title}</p>
        <p className="mt-0.5 truncate text-[11px] text-subtle">{subtitle}</p>
      </div>
      <span className="shrink-0 text-xs font-medium text-muted transition-colors group-hover:text-foreground">
        {item.actionLabel}
      </span>
    </button>
  );
}
