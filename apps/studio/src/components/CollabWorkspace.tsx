"use client";

import { ArrowRight, CheckCircle2, Plus } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  CURRENT_USER_ID,
  relativeTime,
  dmLabel,
  generateProjectContextBrief,
  resolveAgent,
  resolveAgents,
  statusLabel,
  type AgentStatus,
  type ResolvedAgent
} from "@/lib/collab";
import {
  milestonesFor,
  moodExpression,
  relationshipNarrative,
  tenureTitle,
  withMoodExpression
} from "@/lib/agentRelationship";
import { initialsFor, teamTone } from "@/lib/identity";
import { badgeCount, catchUpFor } from "@/lib/attention";
import { projectsForTeam, type Team } from "@/lib/workspace";
import { ChatComposer } from "./ChatComposer";
import { SharedChatUI } from "./SharedChatUI";
import { ChannelView } from "./ChannelView";
import { AddAgentModal } from "./AddAgentModal";
import { AgentAvatarView } from "./AgentAvatarView";
import { useCollabSession } from "./CollabSessionContext";
import { TeamShell } from "./TeamShell";
import { PublicSquarePreview } from "./PublicSquarePreview";
import { ActionGroups, ClearedItems, useOpenTarget } from "./ActionCard";
import { useActionItems } from "./useActionItems";
import { useWorkspace } from "./WorkspaceProvider";

export function CollabWorkspace() {
  const { activeTeam, workspace } = useWorkspace();
  const { view } = useCollabSession();

  if (!activeTeam) return null;

  if (view.type === "square") return <PublicSquarePreview />;
  if (view.type === "inbox") return <ForYouView />;
  if (view.type === "channel") {
    const exists = workspace.channels.some(
      (channel) => channel.id === view.id && channel.teamId === activeTeam.id
    );
    return exists ? (
      <ChannelView channelId={view.id} />
    ) : (
      <PublicSquarePreview />
    );
  }
  if (view.type === "dm") return <DirectView dmId={view.id} />;
  if (view.type === "agent") return <AgentWorkshop agentId={view.id} />;
  return <PublicSquarePreview />;
}

// The Public Square: one per team, aggregating every agent - yours and your
// colleagues' - grinding on any of this team's shared projects into a
// single live view. Grouped by project (not flattened) so "what's everyone
// doing" reads project-by-project rather than as one undifferentiated
// list, with a team-wide pulse up top for the at-a-glance read.
// Kept for comparison with the previous prototype.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function SquareView() {
  const { activeTeam, workspace } = useWorkspace();
  const { openAgent } = useCollabSession();
  if (!activeTeam) return null;
  const sharedProjects = projectsForTeam(workspace, activeTeam.id);
  const sharedProjectIds = new Set(sharedProjects.map((project) => project.id));
  const agents = resolveAgents(
    workspace.projectAgents,
    workspace.agentDefinitions
  ).filter((agent) => sharedProjectIds.has(agent.projectId));
  const running = agents.filter((agent) => agent.status === "running").length;
  const waiting = agents.filter((agent) => agent.status === "waiting").length;
  const idle = agents.filter((agent) => agent.status === "idle").length;

  const order: Record<AgentStatus, number> = {
    running: 0,
    waiting: 1,
    idle: 2
  };
  const groups = sharedProjects
    .map((project) => ({
      project,
      agents: agents
        .filter((agent) => agent.projectId === project.id)
        .sort(
          (left, right) =>
            order[left.status] - order[right.status] ||
            left.name.localeCompare(right.name)
        )
    }))
    .filter((group) => group.agents.length > 0);

  return (
    <TeamShell heading="Public Square">
      <div className="mx-auto max-w-4xl space-y-8 pt-6">
        <section className="rounded-2xl border border-border/80 bg-surface/40 px-6 py-6">
          {agents.length === 0 ? (
            <p className="text-sm text-subtle">
              Peek in on every agent grinding across {activeTeam.name}&rsquo;s
              projects here, as soon as one is unleashed.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-8">
                <div>
                  <p className="text-3xl font-medium tracking-tight text-foreground">
                    {running}
                  </p>
                  <p className="mt-1 text-[11px] uppercase tracking-wide text-subtle">
                    working
                  </p>
                </div>
                <div>
                  <p className="text-3xl font-medium tracking-tight text-foreground">
                    {waiting}
                  </p>
                  <p className="mt-1 text-[11px] uppercase tracking-wide text-subtle">
                    waiting on someone
                  </p>
                </div>
                <div>
                  <p className="text-3xl font-medium tracking-tight text-foreground">
                    {idle}
                  </p>
                  <p className="mt-1 text-[11px] uppercase tracking-wide text-subtle">
                    idle
                  </p>
                </div>
                <p className="ml-auto self-center text-[11px] text-faint">
                  {agents.length} {agents.length === 1 ? "agent" : "agents"}{" "}
                  across {sharedProjects.length}{" "}
                  {sharedProjects.length === 1 ? "project" : "projects"}
                </p>
              </div>
              <AgentMix running={running} waiting={waiting} idle={idle} />
            </>
          )}
        </section>

        {groups.map(({ project, agents: projectAgents }) => {
          const tone = teamTone(project.id);
          return (
            <section key={project.id}>
              <div className="mb-3 flex items-center gap-2.5 px-1">
                <span
                  className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white ${tone.solid}`}
                >
                  {initialsFor(project.name)}
                </span>
                <p className="text-sm font-medium text-foreground">
                  {project.name}
                </p>
                <span className="text-[11px] text-faint">
                  {projectAgents.length}{" "}
                  {projectAgents.length === 1 ? "agent" : "agents"}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {projectAgents.map((agent) => (
                  <AgentSquareCard
                    key={agent.id}
                    agent={agent}
                    team={activeTeam}
                    agentEvents={workspace.agentEvents}
                    onOpen={() => openAgent(agent.id)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </TeamShell>
  );
}

// One agent, one card: a live mood-driven avatar (the same face-swap the
// Agent Workshop uses, just derived from this one engagement's status
// rather than blended across every project it's in), a colored owner tag
// so "whose agent is this" reads at a glance in a five-person team, the
// task itself front and center since that's the actual point of the
// Square, and a live pulse on the status dot while it's actually running.
function AgentSquareCard({
  agent,
  team,
  agentEvents,
  onOpen
}: {
  agent: ResolvedAgent;
  team: Team;
  agentEvents: { agentId: string; at: number }[];
  onOpen: () => void;
}) {
  const owner =
    team.members.find((member) => member.id === agent.ownerId)?.name ??
    "Unknown";
  const ownerTone = teamTone(agent.ownerId);
  const mood = moodExpression([{ status: agent.status }]);
  const avatarSpec = withMoodExpression(agent.avatar?.spec, mood);
  const latestEvent = agentEvents
    .filter((event) => event.agentId === agent.id)
    .sort((left, right) => right.at - left.at)[0];
  const statusStyle =
    agent.status === "running"
      ? {
          border: "border-accent/20 hover:border-accent/35",
          glow: "bg-gradient-to-br from-accent/10 via-accent/5 to-transparent",
          dot: "bg-accent",
          text: "text-accent"
        }
      : agent.status === "waiting"
        ? {
            border: "border-danger/25 hover:border-danger/40",
            glow: "bg-gradient-to-br from-danger/10 via-danger/5 to-transparent",
            dot: "bg-danger",
            text: "text-danger"
          }
        : {
            border: "border-border/80 hover:border-border-strong",
            glow: "",
            dot: "bg-faint",
            text: "text-subtle"
          };

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group relative overflow-hidden rounded-xl border p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/5 ${statusStyle.border} ${statusStyle.glow}`}
    >
      <div className="flex items-start gap-3">
        <AgentAvatarView
          image={agent.avatar?.image}
          spec={avatarSpec}
          name={agent.name}
          size="lg"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">
              {agent.name}
            </span>
            {agent.status === "running" && (
              <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-accent" />
            )}
          </div>
          <p className="truncate text-[11px] text-faint">{agent.role}</p>
          <span
            className={`mt-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${ownerTone.chip}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${ownerTone.solid}`} />
            {owner}
          </span>
        </div>
      </div>
      <p className="mt-3 line-clamp-2 text-sm leading-snug text-subtle">
        {agent.focus}
      </p>
      <div className="mt-3 flex items-center justify-between">
        <span
          className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${statusStyle.text}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${statusStyle.dot}`} />
          {statusLabel(agent.status)}
        </span>
        {latestEvent && (
          <span className="text-[11px] text-faint">
            {relativeTime(latestEvent.at)}
          </span>
        )}
      </div>
    </button>
  );
}

function AgentMix({
  running,
  waiting,
  idle
}: {
  running: number;
  waiting: number;
  idle: number;
}) {
  const total = running + waiting + idle;
  const segments = [
    { key: "waiting", count: waiting, className: "bg-chip", label: "waiting" },
    {
      key: "running",
      count: running,
      className: "bg-accent",
      label: "working"
    },
    { key: "idle", count: idle, className: "bg-surface-active", label: "idle" }
  ].filter((segment) => segment.count > 0);
  return (
    <div className="mt-4">
      <div className="flex h-2 gap-0.5">
        {total === 0 ? (
          <span className="w-full rounded-full bg-surface-hover" />
        ) : (
          segments.map((segment) => (
            <span
              key={segment.key}
              className={`rounded-full ${segment.className}`}
              style={{ flexGrow: segment.count, flexBasis: 0 }}
            />
          ))
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-subtle">
        {total === 0 && <span>No agents yet</span>}
        {segments.map((segment) => (
          <span key={segment.key} className="inline-flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${segment.className}`} />
            {segment.count} {segment.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function DirectView({ dmId }: { dmId: string }) {
  const { workspace, activeTeam, postDmMessage } = useWorkspace();
  const [draft, setDraft] = useState("");
  const dm = workspace.dms.find((item) => item.id === dmId);
  if (!dm || !activeTeam) return null;
  const title = dmLabel(dm.memberIds, activeTeam.members);
  const messages = workspace.dmMessages
    .filter((message) => message.dmId === dmId)
    .sort((left, right) => left.createdAt - right.createdAt);
  const sharedMessages = messages.map((message) => ({
    id: message.id,
    role:
      message.authorId === CURRENT_USER_ID
        ? ("user" as const)
        : ("assistant" as const),
    content: message.content,
    authoredByViewer: message.authorId === CURRENT_USER_ID,
    author: {
      name:
        activeTeam.members.find((member) => member.id === message.authorId)
          ?.name ?? "Unknown"
    },
    source: message
  }));

  return (
    <TeamShell crumbs={[activeTeam.name, title]} chatLayout>
      <SharedChatUI
        mode={{ kind: "human", controls: "formatting" }}
        scopeKey={`preview-dm:${activeTeam.id}:${CURRENT_USER_ID}:${dmId}`}
        messages={sharedMessages}
        className="h-full"
        viewportClassName="mx-auto w-full max-w-3xl space-y-4 pt-4"
        emptyState={
          <p className="mx-auto w-full max-w-3xl pt-4 text-sm text-subtle">
            Direct message preview with {title}. Agents are not part of this
            local thread.
          </p>
        }
        composer={
          <div className="border-t border-border bg-background p-4">
            <div className="mx-auto max-w-3xl no-drag">
              <ChatComposer
                placeholder={`Message ${title}`}
                projectName={activeTeam.name}
                branch="shared"
                footer="Local preview only. Messages are stored in this browser; Team access is not enforced here."
                value={draft}
                onChange={setDraft}
                showExecutionControls={false}
                showFormattingToolbar
                onSend={(text) => {
                  postDmMessage(dmId, text);
                  setDraft("");
                }}
              />
            </div>
          </div>
        }
        renderMessage={({ source: message }) => {
          const author =
            activeTeam.members.find((member) => member.id === message.authorId)
              ?.name ?? "Unknown";
          const isYou = message.authorId === CURRENT_USER_ID;
          return (
            <div className={isYou ? "flex justify-end" : "flex justify-start"}>
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-3 text-[15px] leading-relaxed ${
                  isYou
                    ? "rounded-tr-sm bg-surface-hover text-foreground"
                    : "rounded-tl-sm bg-surface text-foreground-secondary"
                }`}
              >
                <p className="mb-1 text-[11px] text-subtle">{author}</p>
                {message.content}
              </div>
            </div>
          );
        }}
      />
    </TeamShell>
  );
}

function AgentWorkshop({ agentId }: { agentId: string }) {
  const { workspace, activeTeam, setAgentStatus } = useWorkspace();
  const { openInbox, openAgent } = useCollabSession();
  const [createOpen, setCreateOpen] = useState(false);
  const [job, setJob] = useState("");
  const assignment = workspace.projectAgents.find(
    (item) => item.id === agentId
  );
  const agent = assignment
    ? resolveAgent(assignment, workspace.agentDefinitions)
    : null;
  if (!agent || !assignment || !activeTeam) return null;
  const project = workspace.projects.find(
    (item) => item.id === agent.projectId
  );
  const projectName = project?.name ?? "this workshop";
  const owner = activeTeam.members.find(
    (member) => member.id === agent.ownerId
  );
  const isOwner = agent.ownerId === CURRENT_USER_ID;
  const events = workspace.agentEvents
    .filter((event) => event.agentId === agent.id)
    .sort((left, right) => right.at - left.at);
  const contextBrief = generateProjectContextBrief({
    name: agent.name,
    projectName,
    model: agent.model,
    effort: agent.effort
  });

  // Same identity, but possibly unleashed into several of this team's
  // projects at once - the relationship stats (and the mood on its face)
  // look across all of that identity's engagements, not just this one,
  // exactly like the Personal side's own agent detail page. This is what
  // makes an agent you don't own worth watching here: you get the same
  // relationship read the owner does (title, narrative, milestones), just
  // without the private highlights or any controls.
  const definition = workspace.agentDefinitions.find(
    (item) => item.id === assignment.definitionId
  );
  const definitionAssignments = workspace.projectAgents.filter(
    (item) => item.definitionId === assignment.definitionId
  );
  const shippedCount = workspace.channelJobThreads.filter(
    (thread) =>
      definitionAssignments.some((item) => item.id === thread.agentId) &&
      thread.status === "done"
  ).length;
  const createdAt = definition?.createdAt ?? assignment.createdAt;
  const mood = moodExpression(definitionAssignments);
  const avatarSpec = withMoodExpression(agent.avatar?.spec, mood);
  const relationshipTitle = tenureTitle(shippedCount, createdAt);
  const narrative = relationshipNarrative(
    agent.name,
    shippedCount,
    definitionAssignments.length,
    createdAt
  );
  const milestones = milestonesFor({
    shippedCount,
    projectCount: definitionAssignments.length,
    createdAt
  });

  return (
    <TeamShell crumbs={[activeTeam.name, projectName, agent.name]}>
      <div className="mx-auto grid max-w-5xl gap-8 pt-4 lg:grid-cols-[1fr_280px]">
        <div>
          <div className="flex items-start gap-3">
            <AgentAvatarView
              image={agent.avatar?.image}
              spec={avatarSpec}
              name={agent.name}
              size="lg"
            />
            <div className="min-w-0">
              <p className="text-sm text-foreground-secondary">{agent.name}</p>
              <p className="mt-1 text-xs text-subtle">
                {agent.role} · {owner?.name ?? "Unknown"} ·{" "}
                {statusLabel(agent.status)} · {agent.model} · {agent.effort}
              </p>
            </div>
          </div>
          <p className="mt-3 text-sm text-muted">{agent.focus}</p>

          <div className="mt-5 rounded-lg border border-border bg-surface/60 px-3 py-2.5">
            <p className="text-sm font-medium text-foreground">
              {relationshipTitle}
            </p>
            <p className="mt-1 text-xs text-subtle">{narrative}</p>
            {milestones.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {milestones.map((badge) => (
                  <span
                    key={badge}
                    className="rounded-full bg-surface-hover px-2 py-0.5 text-[10px] font-medium text-muted"
                  >
                    {badge}
                  </span>
                ))}
              </div>
            )}
          </div>

          {isOwner ? (
            <div className="mt-6 space-y-3">
              <input
                value={job}
                onChange={(event) => setJob(event.target.value)}
                placeholder={`What should ${agent.name} work on?`}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-faint"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-md bg-chip px-3 py-1.5 text-xs font-medium text-chip-foreground"
                  onClick={() =>
                    setAgentStatus(agent.id, "running", job || agent.focus)
                  }
                >
                  Start work
                </button>
                <button
                  type="button"
                  className="rounded-md bg-surface-hover px-3 py-1.5 text-xs text-foreground-secondary"
                  onClick={() => setAgentStatus(agent.id, "idle", "Paused")}
                >
                  Pause
                </button>
                <button
                  type="button"
                  className="rounded-md bg-surface-hover px-3 py-1.5 text-xs text-foreground-secondary"
                  onClick={() => {
                    setAgentStatus(
                      agent.id,
                      "waiting",
                      job || "Need a decision"
                    );
                    openInbox();
                  }}
                >
                  Need you
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-6 text-sm text-subtle">
              You&rsquo;re watching this workshop. Steering, private pings, and
              highlights belong to {owner?.name ?? "its owner"}.
            </p>
          )}

          <div className="mt-8 space-y-3">
            {events.map((event) => (
              <p key={event.id} className="text-xs leading-relaxed text-subtle">
                {event.label}
              </p>
            ))}
            {events.length === 0 && (
              <p className="text-xs text-subtle">No workshop activity yet.</p>
            )}
          </div>
        </div>
        <aside className="no-drag">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-subtle">
            soul.md · identity
          </p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-3 text-[11px] leading-relaxed text-muted">
            {agent.identity}
          </pre>
          <div className="mb-2 mt-4 flex items-center gap-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
              This project
            </p>
            <span className="rounded-full border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
              Live
            </span>
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-3 text-[11px] leading-relaxed text-muted">
            {contextBrief}
          </pre>
          {isOwner && (
            <button
              type="button"
              className="mt-4 flex items-center text-xs text-muted hover:text-foreground-secondary"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Unleash another agent
            </button>
          )}
        </aside>
      </div>
      {createOpen && project && (
        <AddAgentModal
          projectId={agent.projectId}
          projectName={project.name}
          onClose={() => setCreateOpen(false)}
          onAdded={(id) => {
            setCreateOpen(false);
            openAgent(id);
          }}
        />
      )}
    </TeamShell>
  );
}

// For you is the collaborative action inbox across every team the current
// user belongs to. Activity stays grouped by the action it needs.
function ForYouView() {
  const router = useRouter();
  const { workspace, activeTeam, previousTeamVisitAt } = useWorkspace();
  const {
    team: actions,
    personalBadge,
    clearAction,
    restoreAction
  } = useActionItems();
  const openTarget = useOpenTarget();
  const [teamFilter, setTeamFilter] = useState("all");
  if (!activeTeam) return null;

  const teams = workspace.teams
    .filter((team) =>
      team.members.some((member) => member.id === CURRENT_USER_ID)
    )
    .sort(
      (left, right) =>
        Number(right.id === activeTeam.id) - Number(left.id === activeTeam.id)
    );
  const inTeam = (teamId: string) => (item: (typeof actions.visible)[number]) =>
    item.source.side === "team" && item.source.teamId === teamId;
  const visible =
    teamFilter === "all"
      ? actions.visible
      : actions.visible.filter(inTeam(teamFilter));
  const cleared =
    teamFilter === "all"
      ? actions.cleared
      : actions.cleared.filter(inTeam(teamFilter));
  const blocking = visible.filter((item) => item.tier === "blocking").length;
  const waiting = visible.filter((item) => item.tier === "waiting").length;
  const catchUp = previousTeamVisitAt
    ? catchUpFor(workspace, activeTeam, previousTeamVisitAt)
    : [];
  const subline =
    blocking + waiting === 0
      ? "Nothing is waiting on you."
      : [
          blocking > 0 ? `${blocking} blocking work` : null,
          waiting > 0 ? `${waiting} waiting on your reply` : null
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <TeamShell>
      <div className="mx-auto max-w-3xl space-y-7 pb-16 pt-6">
        <div>
          <h1 className="text-[22px] font-medium tracking-tight text-foreground">
            For you
          </h1>
          <p className="mt-1 text-sm text-subtle">
            Everything across your{" "}
            {teams.length === 1 ? "team" : `${teams.length} teams`} that needs
            you. {subline}
          </p>
          <p className="mt-1 text-[11px] text-faint">
            This is a browser-local Studio preview; action changes stay in this
            browser.
          </p>
        </div>

        {teams.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <FilterChip
              active={teamFilter === "all"}
              onClick={() => setTeamFilter("all")}
            >
              All teams{" "}
              <span className="text-faint">{badgeCount(actions.visible)}</span>
            </FilterChip>
            {teams.map((team) => (
              <FilterChip
                key={team.id}
                active={teamFilter === team.id}
                onClick={() => setTeamFilter(team.id)}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${teamTone(team.id).solid}`}
                />
                {team.name}
                <span className="text-faint">
                  {badgeCount(actions.visible.filter(inTeam(team.id)))}
                </span>
              </FilterChip>
            ))}
          </div>
        )}

        {previousTeamVisitAt && (
          <div className="rounded-xl border border-border bg-surface/30 px-4 py-3">
            <p className="text-xs text-subtle">
              Since you were last in{" "}
              <span className="text-foreground-secondary">
                {activeTeam.name}
              </span>{" "}
              {relativeTime(previousTeamVisitAt)}
              {catchUp.length === 0 ? ": nothing new." : ":"}
            </p>
            {catchUp.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {catchUp.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => openTarget(entry.target)}
                    className="rounded-full border border-border px-2.5 py-1 text-xs text-foreground-secondary transition-colors hover:border-border-strong hover:text-foreground"
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {visible.length === 0 ? (
          <div className="flex items-center gap-2.5 rounded-xl border border-dashed border-border px-4 py-6 text-sm text-subtle">
            <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-success" />
            You&rsquo;re all caught up
            {teamFilter === "all" ? " across your teams" : ""}.
          </div>
        ) : (
          <ActionGroups
            items={visible}
            idPrefix="studio-foryou"
            clearAction={clearAction}
          />
        )}

        <ClearedItems items={cleared} restoreAction={restoreAction} />

        {personalBadge > 0 && (
          <button
            type="button"
            onClick={() => {
              router.push("/personal-preview");
            }}
            className="flex w-full items-center justify-between gap-3 rounded-xl border border-border px-4 py-3 text-left text-sm text-muted transition-colors hover:border-border-strong hover:text-foreground"
          >
            <span>
              {personalBadge === 1
                ? "1 personal item is"
                : `${personalBadge} personal items are`}{" "}
              waiting on Home
            </span>
            <ArrowRight className="h-4 w-4 flex-shrink-0" />
          </button>
        )}
      </div>
    </TeamShell>
  );
}

function FilterChip({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-border-strong bg-surface-hover text-foreground"
          : "border-border text-muted hover:text-foreground-secondary"
      }`}
    >
      {children}
    </button>
  );
}
