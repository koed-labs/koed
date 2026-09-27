"use client";

import { useState } from "react";
import { ArrowLeft, Plus, Search, X } from "lucide-react";
import {
  AGENT_EFFORTS,
  AGENT_MODELS,
  CURRENT_USER_ID,
  TOKEN_BUDGETS,
  TOKEN_BUDGET_LABEL,
  type TokenBudget
} from "@/lib/collab";
import { CreateAgentModal } from "./CreateAgentModal";
import { AgentAvatarView } from "./AgentAvatarView";
import { useWorkspace } from "./WorkspaceProvider";

// Shown from a project's Agents section. Lets you unleash an agent you
// already own into this project, or create a brand new one and unleash it
// in the same step. This is the Collaborative-side half of "agents live on
// the Personal side, projects add them" - it never creates an identity
// itself, only an engagement, and every engagement gets its own model,
// effort and token budget: the same agent can run Codex Astra at Medium
// here and Sonnet 5 at High somewhere else.
export function AddAgentModal({
  projectId,
  projectName,
  onClose,
  onAdded
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
  onAdded: (agentId: string) => void;
}) {
  const { workspace, unleashAgent } = useWorkspace();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [model, setModel] = useState<string>(AGENT_MODELS[0]);
  const [effort, setEffort] = useState<string>(AGENT_EFFORTS[1]);
  const [tokenBudget, setTokenBudget] = useState<TokenBudget>("standard");

  const myDefinitions = workspace.agentDefinitions.filter(
    (item) => item.ownerId === CURRENT_USER_ID
  );
  const trimmedQuery = query.trim().toLowerCase();
  const filteredDefinitions = trimmedQuery
    ? myDefinitions.filter(
        (item) =>
          item.name.toLowerCase().includes(trimmedQuery) ||
          item.role.toLowerCase().includes(trimmedQuery)
      )
    : myDefinitions;
  const unleashedHere = new Set(
    workspace.projectAgents
      .filter((item) => item.projectId === projectId)
      .map((item) => item.definitionId)
  );
  const selected = selectedId
    ? myDefinitions.find((item) => item.id === selectedId)
    : undefined;

  const confirm = () => {
    if (!selectedId) return;
    const agent = unleashAgent({
      definitionId: selectedId,
      projectId,
      model,
      effort,
      tokenBudget
    });
    onAdded(agent.id);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm no-drag"
      onClick={onClose}
    >
      <div
        className="flex max-h-[calc(100vh-2rem)] w-[420px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-2">
            {selected && (
              <button
                type="button"
                className="rounded-md p-1 text-subtle hover:bg-surface-hover hover:text-foreground-secondary"
                onClick={() => setSelectedId(null)}
                aria-label="Back"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <h2 className="text-base font-semibold text-foreground">
              {selected
                ? `Configure ${selected.name}`
                : `Add an agent to ${projectName}`}
            </h2>
          </div>
          <button
            type="button"
            className="rounded-md p-1 text-subtle hover:bg-surface-hover hover:text-foreground-secondary"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {selected ? (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-2">
            <div className="flex items-center gap-3">
              <AgentAvatarView
                image={selected.avatar?.image}
                spec={selected.avatar?.spec}
                name={selected.name}
                size="md"
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {selected.name}
                </p>
                <p className="truncate text-xs text-subtle">{selected.role}</p>
              </div>
            </div>
            <p className="text-xs text-subtle">
              Choose how {selected.name} should run in {projectName}. This is
              just for this project — the same agent can run differently
              anywhere else it&rsquo;s unleashed.
            </p>
            <label className="block">
              <span className="mb-2 block text-sm text-muted">Model</span>
              <select
                value={model}
                onChange={(event) => setModel(event.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
              >
                {AGENT_MODELS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <span className="mb-2 block text-sm text-muted">Effort</span>
              <div className="flex flex-wrap gap-1">
                {AGENT_EFFORTS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                      effort === item
                        ? "bg-chip text-chip-foreground"
                        : "bg-surface-hover text-muted hover:text-foreground-secondary"
                    }`}
                    onClick={() => setEffort(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="mb-2 block text-sm text-muted">
                Token budget
              </span>
              <div className="flex flex-wrap gap-1">
                {TOKEN_BUDGETS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                      tokenBudget === item
                        ? "bg-chip text-chip-foreground"
                        : "bg-surface-hover text-muted hover:text-foreground-secondary"
                    }`}
                    onClick={() => setTokenBudget(item)}
                  >
                    {TOKEN_BUDGET_LABEL[item]}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {myDefinitions.length > 0 && (
              <div className="flex items-center gap-2 border-b border-border px-5 py-2.5">
                <Search className="h-3.5 w-3.5 flex-shrink-0 text-subtle" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search your agents"
                  className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-subtle"
                />
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {myDefinitions.length === 0 ? (
                <p className="px-3 py-6 text-sm text-subtle">
                  You don&rsquo;t have any agents yet. Create one below —
                  it&rsquo;s yours to reuse across any project, not just this
                  one.
                </p>
              ) : filteredDefinitions.length === 0 ? (
                <p className="px-3 py-6 text-sm text-subtle">
                  No agents match your search.
                </p>
              ) : (
                filteredDefinitions.map((definition) => {
                  const already = unleashedHere.has(definition.id);
                  return (
                    <button
                      key={definition.id}
                      type="button"
                      disabled={already}
                      onClick={() => setSelectedId(definition.id)}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                        already
                          ? "cursor-not-allowed opacity-40"
                          : "hover:bg-surface-hover"
                      }`}
                    >
                      <AgentAvatarView
                        image={definition.avatar?.image}
                        name={definition.name}
                        size="sm"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {definition.name}
                        </span>
                        <span className="block truncate text-xs text-subtle">
                          {definition.role}
                        </span>
                      </span>
                      {already && (
                        <span className="whitespace-nowrap text-[11px] text-subtle">
                          Already here
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}

        <div className="flex justify-end border-t border-border bg-background/40 px-5 py-3">
          {selected ? (
            <button
              type="button"
              className="rounded-lg bg-chip px-4 py-2 text-sm font-medium text-chip-foreground hover:bg-chip-hover"
              onClick={confirm}
            >
              Add to project
            </button>
          ) : (
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-lg bg-surface-hover px-3 py-2 text-sm font-medium text-foreground-secondary hover:bg-surface-active"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              Create new agent
            </button>
          )}
        </div>
      </div>

      {createOpen && (
        <CreateAgentModal
          onClose={() => setCreateOpen(false)}
          onCreated={(definitionId) => {
            setCreateOpen(false);
            setSelectedId(definitionId);
          }}
        />
      )}
    </div>
  );
}
