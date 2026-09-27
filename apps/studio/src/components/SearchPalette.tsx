"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Folder, MessageSquare, Plus, Search, Users } from "lucide-react";

export type SearchableTeam = {
  id: string;
  name: string;
};

export type SearchableThread = {
  id: string;
  title: string;
  projectId: string | null;
  projectName: string;
};

export type SearchableProject = {
  id: string;
  name: string;
  path: string;
  branch: string;
};

type ResultKind = "project" | "thread" | "team" | "action";

type SearchResult = {
  id: string;
  kind: ResultKind;
  title: string;
  subtitle?: string;
  shortcut?: string;
  icon: ReactNode;
  onSelect: () => void;
};

function matchesQuery(query: string, ...values: Array<string | undefined>) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return values.some((value) => value?.toLowerCase().includes(normalized));
}

export function SearchPalette({
  projects,
  threads,
  teams,
  onClose,
  onNewProject,
  onSelectThread,
  onNewChat,
}: {
  projects: SearchableProject[];
  threads: SearchableThread[];
  teams: SearchableTeam[];
  onClose: () => void;
  onNewProject: () => void;
  onSelectThread: (threadId: string) => void;
  onNewChat: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const results = useMemo<SearchResult[]>(() => {
    const projectResults: SearchResult[] = projects
      .filter((project) => matchesQuery(query, project.name, project.path, project.branch))
      .map((project) => ({
        id: `project-${project.id}`,
        kind: "project",
        title: project.name,
        subtitle: `${project.branch} · ${project.path}`,
        icon: <Folder className="h-4 w-4" />,
        onSelect: onClose,
      }));

    const threadResults: SearchResult[] = threads
      .filter((thread) => matchesQuery(query, thread.title, thread.projectName))
      .map((thread, index) => ({
        id: `thread-${thread.id}`,
        kind: "thread",
        title: thread.title,
        subtitle: thread.projectName,
        shortcut: index < 9 ? `⌘${index + 1}` : undefined,
        icon: <MessageSquare className="h-4 w-4" />,
        onSelect: () => {
          onSelectThread(thread.id);
        },
      }));

    const teamResults: SearchResult[] = teams
      .filter((team) => matchesQuery(query, team.name))
      .map((team) => ({
        id: `team-${team.id}`,
        kind: "team",
        title: team.name,
        subtitle: "Team workspace",
        icon: <Users className="h-4 w-4" />,
        onSelect: onClose,
      }));

    const actions: SearchResult[] = [
      {
        id: "action-new-chat",
        kind: "action" as const,
        title: "New chat",
        shortcut: "⌘N",
        icon: <MessageSquare className="h-4 w-4" />,
        onSelect: () => {
          onNewChat();
          onClose();
        },
      },
      {
        id: "action-new-project",
        kind: "action" as const,
        title: "New project",
        shortcut: "⌘P",
        icon: <Plus className="h-4 w-4" />,
        onSelect: onNewProject,
      },
    ].filter((action) => matchesQuery(query, action.title));

    return [...projectResults, ...threadResults, ...teamResults, ...actions];
  }, [onClose, onNewChat, onNewProject, onSelectThread, projects, query, teams, threads]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((current) => Math.min(current + 1, Math.max(results.length - 1, 0)));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        results[Math.min(activeIndex, results.length - 1)]?.onSelect();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, onClose, results]);

  const grouped = [
    { key: "project" as const, label: "Projects", items: results.filter((item) => item.kind === "project") },
    { key: "thread" as const, label: "Threads", items: results.filter((item) => item.kind === "thread") },
    { key: "team" as const, label: "Teams", items: results.filter((item) => item.kind === "team") },
    { key: "action" as const, label: "Quick actions", items: results.filter((item) => item.kind === "action") },
  ].filter((group) => group.items.length > 0);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/60 backdrop-blur-sm pt-[18vh] no-drag"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Search className="h-4 w-4 flex-shrink-0 text-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            placeholder="Search projects, threads, and teams"
            className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-subtle"
          />
        </div>

        <div className="max-h-[420px] overflow-y-auto py-2">
          {grouped.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-subtle">No matches</p>
          ) : (
            grouped.map((group) => (
              <div key={group.key} className="mb-2">
                <p className="px-4 py-1.5 text-[11px] font-medium uppercase tracking-wider text-subtle">
                  {group.label}
                </p>
                {group.items.map((item) => {
                  const index = results.indexOf(item);
                  const isActive = index === Math.min(activeIndex, results.length - 1);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors ${
                        isActive ? "bg-surface-hover" : "hover:bg-surface-hover/60"
                      }`}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={item.onSelect}
                    >
                      <span className="flex-shrink-0 text-subtle">{item.icon}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground-secondary">{item.title}</span>
                      {item.subtitle && (
                        <span className="max-w-[40%] truncate text-xs text-subtle">{item.subtitle}</span>
                      )}
                      {item.shortcut && (
                        <span className="flex-shrink-0 rounded-md bg-surface-hover px-1.5 py-0.5 text-[10px] text-subtle">
                          {item.shortcut}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
