"use client";

import { useEffect, useState } from "react";
import { Award, Pencil, Plus, Sparkles, StickyNote, Trash2, X } from "lucide-react";
import {
  CURRENT_USER_ID,
  TOKEN_BUDGET_LABEL,
  relativeTime,
  statusLabel,
  type AgentDefinition,
  type AgentStatus,
  type ChannelJobThread,
  type TokenBudget,
} from "@/lib/collab";
import { AgentAvatarView } from "@/components/AgentAvatarView";
import { CreateAgentModal } from "@/components/CreateAgentModal";
import { Tooltip } from "@/components/Tooltip";
import { useWorkspace } from "@/components/WorkspaceProvider";
import {
  milestonesFor,
  moodExpression,
  relationshipNarrative,
  tenureTitle,
  withMoodExpression,
} from "@/lib/agentRelationship";

type ModalState = { type: "create" } | { type: "edit"; definition: AgentDefinition } | null;

type Assignment = {
  agentId: string;
  projectId: string;
  projectName: string;
  status: AgentStatus;
  focus: string;
  model: string;
  effort: string;
  tokenBudget: TokenBudget;
};

export default function AgentsPage() {
  const { workspace, deleteAgentDefinition } = useWorkspace();
  const [modal, setModal] = useState<ModalState>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentDefinition | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const myAgents = workspace.agentDefinitions.filter(
    (definition) => definition.ownerId === CURRENT_USER_ID
  );
  const selected = selectedId ? myAgents.find((item) => item.id === selectedId) ?? null : null;

  // Every project this definition is currently unleashed into, each with
  // its OWN runtime config - the same agent can be running a different
  // model, effort and token budget on each one.
  const assignmentsFor = (definitionId: string): Assignment[] =>
    workspace.projectAgents
      .filter((agent) => agent.definitionId === definitionId)
      .map((agent) => {
        const project = workspace.projects.find((item) => item.id === agent.projectId);
        if (!project) return null;
        return {
          agentId: agent.id,
          projectId: project.id,
          projectName: project.name,
          status: agent.status,
          focus: agent.focus,
          model: agent.model,
          effort: agent.effort,
          tokenBudget: agent.tokenBudget,
        };
      })
      .filter((item): item is Assignment => item !== null);

  return (
    <div className="flex h-full bg-background text-foreground drag-region">
      <div className="min-h-0 flex-1 overflow-y-auto no-drag">
        <div className="mx-auto w-full max-w-3xl px-8 py-10">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl font-semibold">Agents</h1>
              <p className="mt-2 text-sm text-muted">
                Create an agent once here, then unleash it into any project you&rsquo;re working
                on. The same agent can work in more than one project at a time — its identity
                stays put, and each project just adds its own live context.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setModal({ type: "create" })}
              className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-chip px-4 py-2 text-sm font-medium text-chip-foreground hover:bg-white transition-colors"
            >
              <Plus className="h-4 w-4" />
              Create agent
            </button>
          </div>

          {myAgents.length === 0 ? (
            <div className="mt-10 rounded-xl border border-border bg-surface/50 px-6 py-16 text-center">
              <p className="text-sm text-subtle">
                No agents yet. Create one and it&rsquo;s yours to reuse across every project.
              </p>
            </div>
          ) : (
            <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {myAgents.map((definition) => {
                const assignments = assignmentsFor(definition.id);
                const isSelected = definition.id === selectedId;
                return (
                  <button
                    key={definition.id}
                    type="button"
                    onClick={() => setSelectedId(definition.id)}
                    className={`rounded-xl border p-4 text-left transition-colors ${
                      isSelected
                        ? "border-border-strong bg-surface-hover"
                        : "border-border bg-surface hover:border-border-strong hover:bg-surface-hover/60"
                    }`}
                  >
                    <div className="flex items-center gap-4">
                      <AgentAvatarView
                        image={definition.avatar?.image}
                        spec={definition.avatar?.spec}
                        name={definition.name}
                        size="xl"
                        className="ring-1 ring-border-strong"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-lg font-semibold text-foreground">{definition.name}</p>
                        <p className="mt-0.5 truncate text-sm text-subtle">{definition.role}</p>
                      </div>
                    </div>
                    <div className="mt-3 border-t border-border pt-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
                        Active in
                      </p>
                      {assignments.length === 0 ? (
                        <p className="mt-1.5 text-xs text-subtle">
                          Not unleashed anywhere yet. Add it from a project&rsquo;s Agents section.
                        </p>
                      ) : (
                        <div className="mt-1.5 space-y-1.5">
                          {assignments.map((assignment) => (
                            <div
                              key={assignment.projectId}
                              className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-hover/50 px-2.5 py-1.5"
                            >
                              <span className="truncate text-xs font-medium text-foreground-secondary">
                                {assignment.projectName}
                              </span>
                              <span className="flex-shrink-0 truncate text-[11px] text-subtle">
                                {assignment.model} · {assignment.effort} ·{" "}
                                {TOKEN_BUDGET_LABEL[assignment.tokenBudget]}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {selected && (
        <AgentDetailPanel
          definition={selected}
          assignments={assignmentsFor(selected.id)}
          onClose={() => setSelectedId(null)}
          onEdit={() => setModal({ type: "edit", definition: selected })}
          onDelete={() => setDeleteTarget(selected)}
        />
      )}

      {modal && (
        <CreateAgentModal
          onClose={() => setModal(null)}
          onCreated={() => setModal(null)}
          editDefinition={modal.type === "edit" ? modal.definition : undefined}
        />
      )}

      {deleteTarget && (
        <DeleteAgentDialog
          definition={deleteTarget}
          activeIn={assignmentsFor(deleteTarget.id).map((assignment) => assignment.projectName)}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            deleteAgentDefinition(deleteTarget.id);
            if (selectedId === deleteTarget.id) setSelectedId(null);
            setDeleteTarget(null);
          }}
        />
      )}
    </div>
  );
}

function AgentDetailPanel({
  definition,
  assignments,
  onClose,
  onEdit,
  onDelete,
}: {
  definition: AgentDefinition;
  assignments: Assignment[];
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { workspace, setJobThreadNote } = useWorkspace();
  const [soulOpen, setSoulOpen] = useState(false);

  const assignmentByAgentId = new Map(assignments.map((assignment) => [assignment.agentId, assignment]));

  // This agent's full job history, across every project it's ever been
  // unleashed into - not just the ones it's still in. Every status change
  // (started work, paused, waiting on owner, unleashed) already gets logged
  // as an AgentEvent, so this is real history, not a stand-in.
  const history = workspace.agentEvents
    .filter((event) => assignmentByAgentId.has(event.agentId))
    .sort((left, right) => right.at - left.at);

  // Private pings this agent has sent that are still waiting on you,
  // gathered across all of its projects - so you can see at a glance
  // whether it's blocked anywhere, without having to open every project.
  const blockers = workspace.whispers
    .filter(
      (whisper) =>
        whisper.recipientId === CURRENT_USER_ID && !whisper.read && assignmentByAgentId.has(whisper.agentId)
    )
    .sort((left, right) => right.createdAt - left.createdAt);

  const runningNow = assignments.filter((assignment) => assignment.status === "running").length;

  // The actual finished work, not the status-change chatter - real jobs
  // this agent has seen through to done, across every project, newest
  // first. This is the substance behind the relationship stats below and
  // the highlights strip.
  const completedJobs = workspace.channelJobThreads
    .filter((thread) => assignmentByAgentId.has(thread.agentId) && thread.status === "done")
    .map((thread) => ({
      thread,
      project: assignmentByAgentId.get(thread.agentId) ?? null,
      at: thread.messages.length > 0 ? thread.messages[thread.messages.length - 1].createdAt : 0,
    }))
    .sort((left, right) => right.at - left.at);

  const highlights = completedJobs.slice(0, 3);
  const shippedCount = completedJobs.length;
  const mood = moodExpression(assignments);
  const avatarSpec = withMoodExpression(definition.avatar?.spec, mood);
  const relationshipTitle = tenureTitle(shippedCount, definition.createdAt);
  const narrative = relationshipNarrative(definition.name, shippedCount, assignments.length, definition.createdAt);
  const milestones = milestonesFor({
    shippedCount,
    projectCount: assignments.length,
    createdAt: definition.createdAt,
  });

  return (
    <aside className="flex w-[380px] flex-shrink-0 flex-col overflow-y-auto border-l border-border bg-background no-drag">
      <div className="flex items-start justify-between gap-2 px-5 pt-5">
        <div className="flex min-w-0 items-center gap-3">
          <AgentAvatarView
            image={definition.avatar?.image}
            spec={avatarSpec}
            name={definition.name}
            size="xl"
            className="ring-1 ring-border-strong"
          />
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold text-foreground">{definition.name}</p>
            <p className="truncate text-sm text-subtle">{definition.role}</p>
            <p className="mt-0.5 truncate text-[11px] text-faint">
              Created {relativeTime(definition.createdAt)}
            </p>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-0.5">
          <Tooltip content="Edit agent">
            <button
              type="button"
              className="rounded-md p-1.5 text-subtle hover:bg-surface-hover hover:text-foreground-secondary"
              onClick={onEdit}
              aria-label="Edit agent"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="Delete agent">
            <button
              type="button"
              className="rounded-md p-1.5 text-subtle hover:bg-danger/10 hover:text-danger"
              onClick={onDelete}
              aria-label="Delete agent"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="Close">
            <button
              type="button"
              className="rounded-md p-1.5 text-subtle hover:bg-surface-hover hover:text-foreground-secondary"
              onClick={onClose}
              aria-label="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="mt-4 px-5">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-chip px-2.5 py-1 text-[11px] font-medium text-chip-foreground">
            {relationshipTitle}
          </span>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-foreground-secondary">{narrative}</p>
        {milestones.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {milestones.map((milestone) => (
              <span
                key={milestone}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-1 text-[11px] font-medium text-foreground-secondary"
              >
                <Award className="h-3 w-3 text-subtle" />
                {milestone}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 px-5">
        <StatTile label="Projects" value={assignments.length} />
        <StatTile label="Running now" value={runningNow} />
        <StatTile label="Jobs logged" value={history.length} />
      </div>

      {blockers.length > 0 && (
        <div className="mt-4 px-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-warning">
            Needs your attention
          </p>
          <div className="mt-2 space-y-2">
            {blockers.map((blocker) => {
              const project = assignmentByAgentId.get(blocker.agentId);
              return (
                <div
                  key={blocker.id}
                  className="rounded-lg border border-warning/30 bg-warning/10 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium text-foreground">{blocker.title}</p>
                    <span className="flex-shrink-0 text-[11px] text-subtle">
                      {relativeTime(blocker.createdAt)}
                    </span>
                  </div>
                  {project && <p className="mt-0.5 text-[11px] text-subtle">{project.projectName}</p>}
                  <p className="mt-1 text-xs text-foreground-secondary">{blocker.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-6 px-5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
          Active in {assignments.length > 0 && `(${assignments.length})`}
        </p>
        {assignments.length === 0 ? (
          <p className="mt-2 text-sm text-subtle">
            Not unleashed anywhere yet. Add {definition.name} from a project&rsquo;s Agents
            section.
          </p>
        ) : (
          <div className="mt-2 space-y-2">
            {assignments.map((assignment) => (
              <div
                key={assignment.projectId}
                className="rounded-lg border border-border bg-surface p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-medium text-foreground">
                    {assignment.projectName}
                  </p>
                  <span className="flex-shrink-0 rounded-full bg-surface-hover px-2 py-0.5 text-[11px] font-medium text-muted">
                    {statusLabel(assignment.status)}
                  </span>
                </div>
                <p className="mt-1 truncate text-xs text-subtle">{assignment.focus}</p>
                <p className="mt-2 text-[11px] text-subtle">
                  {assignment.model} · {assignment.effort} ·{" "}
                  {TOKEN_BUDGET_LABEL[assignment.tokenBudget]}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-6 px-5">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">
          <Sparkles className="h-3 w-3" />
          Highlights
        </p>
        {highlights.length === 0 ? (
          <p className="mt-2 text-sm text-subtle">
            No finished jobs yet - the standout ones will show up here once {definition.name} ships
            something.
          </p>
        ) : (
          <div className="mt-2 space-y-2">
            {highlights.map(({ thread, project, at }) => (
              <HighlightCard
                key={thread.id}
                thread={thread}
                projectName={project?.projectName}
                at={at}
                onSaveNote={(note) => setJobThreadNote(thread.id, note)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="mt-6 px-5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
          Job history
        </p>
        {history.length === 0 ? (
          <p className="mt-2 text-sm text-subtle">
            No activity yet. It&rsquo;ll show up here once {definition.name} starts working
            somewhere.
          </p>
        ) : (
          <div className="mt-2 max-h-72 space-y-2 overflow-y-auto pr-1">
            {history.map((event) => {
              const project = assignmentByAgentId.get(event.agentId);
              return (
                <div key={event.id} className="flex gap-2 text-xs">
                  <span className="mt-0.5 flex-shrink-0 text-[11px] text-faint">
                    {relativeTime(event.at)}
                  </span>
                  <p className="min-w-0 text-foreground-secondary">
                    {project && (
                      <span className="mr-1 text-subtle">{project.projectName} ·</span>
                    )}
                    {event.label}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-6 px-5 pb-5">
        <button
          type="button"
          aria-expanded={soulOpen}
          aria-controls="agent-soul-preview"
          className="flex w-full items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-subtle hover:text-foreground-secondary"
          onClick={() => setSoulOpen((open) => !open)}
        >
          soul.md · identity
          <span className="text-foreground-secondary">{soulOpen ? "Hide" : "Show"}</span>
        </button>
        {soulOpen && (
          <pre
            id="agent-soul-preview"
            className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface p-3 text-[11px] leading-relaxed text-muted"
          >
            {definition.identity}
          </pre>
        )}
      </div>
    </aside>
  );
}

function HighlightCard({
  thread,
  projectName,
  at,
  onSaveNote,
}: {
  thread: ChannelJobThread;
  projectName?: string;
  at: number;
  onSaveNote: (note: string) => void;
}) {
  const [note, setNote] = useState(thread.note ?? "");

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium text-foreground">{thread.title}</p>
        <span className="flex-shrink-0 text-[11px] text-subtle">{relativeTime(at)}</span>
      </div>
      {projectName && <p className="mt-0.5 text-[11px] text-subtle">{projectName}</p>}
      <div className="mt-2 flex items-start gap-1.5">
        <StickyNote className="mt-1 h-3 w-3 flex-shrink-0 text-subtle" />
        <input
          type="text"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          onBlur={() => {
            if (note !== (thread.note ?? "")) onSaveNote(note);
          }}
          placeholder="Add a private note for yourself\u2026"
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-xs text-foreground-secondary outline-none placeholder:text-faint hover:border-border focus:border-border-strong focus:bg-background"
        />
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-2 py-2 text-center">
      <p className="text-lg font-semibold text-foreground">{value}</p>
      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-subtle">{label}</p>
    </div>
  );
}

function DeleteAgentDialog({
  definition,
  activeIn,
  onCancel,
  onConfirm,
}: {
  definition: AgentDefinition;
  activeIn: string[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm no-drag"
      onClick={onCancel}
    >
      <div
        className="w-[400px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-surface p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-foreground">Delete {definition.name}?</h2>
        <p className="mt-2 text-sm text-muted">
          This can&rsquo;t be undone.{" "}
          {activeIn.length === 0
            ? "It isn't unleashed in any project right now."
            : `It's currently unleashed in ${activeIn.join(", ")} — deleting it will remove it from ${
                activeIn.length === 1 ? "that project" : "all of them"
              } too.`}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg bg-surface-hover px-3.5 py-2 text-sm font-medium text-foreground-secondary hover:bg-surface-active"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-lg border border-danger/30 bg-danger/15 px-3.5 py-2 text-sm font-medium text-danger hover:bg-danger/25"
            onClick={onConfirm}
          >
            Delete agent
          </button>
        </div>
      </div>
    </div>
  );
}
