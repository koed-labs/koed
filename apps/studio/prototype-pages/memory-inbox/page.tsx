"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, Plus, RefreshCw, Search, Share2, Trash2, Users, X } from "lucide-react";
import { CURRENT_USER_ID, relativeTime } from "@/lib/collab";
import {
  MEMORY_ITEM_TYPE_LABEL,
  isLinkType,
  type MemoryItem,
  type MemoryItemStatus,
  type MemoryItemType,
} from "@/lib/memoryInbox";
import { AddMemoryItemModal } from "@/components/AddMemoryItemModal";
import { MemoryItemIcon } from "@/components/MemoryItemIcon";
import { Tooltip } from "@/components/Tooltip";
import { useWorkspace } from "@/components/WorkspaceProvider";

type TypeFilter = "all" | "repo" | "video" | "link" | "file";

const FILTERS: { id: TypeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "repo", label: "Repos" },
  { id: "video", label: "Videos" },
  { id: "link", label: "Links" },
  { id: "file", label: "Files" },
];

function matchesFilter(type: MemoryItemType, filter: TypeFilter) {
  if (filter === "all") return true;
  if (filter === "repo") return type === "github-repo";
  if (filter === "video") return type === "youtube";
  if (filter === "link") return type === "web-link";
  return !isLinkType(type);
}

export default function MemoryInboxPage() {
  const { workspace, deleteMemoryItem } = useWorkspace();
  const [addOpen, setAddOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<MemoryItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MemoryItem | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");

  const myItems = workspace.memoryItems.filter((item) => item.ownerId === CURRENT_USER_ID);
  const selected = selectedId ? myItems.find((item) => item.id === selectedId) ?? null : null;

  const filtered = myItems.filter((item) => {
    if (!matchesFilter(item.type, typeFilter)) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      item.title.toLowerCase().includes(q) ||
      item.source.toLowerCase().includes(q) ||
      item.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  });

  const getSharedTeamsText = (sharedWith: string[]) => {
    if (sharedWith.length === 0) return "";
    const names = sharedWith
      .map((id) => workspace.teams.find((team) => team.id === id)?.name)
      .filter((name): name is string => Boolean(name));
    return `Shared with: ${names.join(", ")}`;
  };

  return (
    <div className="flex h-full bg-background text-foreground drag-region">
      <div className="min-h-0 flex-1 overflow-y-auto no-drag">
        <div className="mx-auto w-full max-w-3xl px-8 py-10">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl font-semibold">Memory Inbox</h1>
              <p className="mt-2 text-sm text-muted">
                Drop in a repo, a video, a PDF, or any other document and it gets ingested and
                indexed into your memory layer. Share an item with a team and everyone on it can
                draw on it too.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-chip px-4 py-2 text-sm font-medium text-chip-foreground hover:bg-white transition-colors"
            >
              <Plus className="h-4 w-4" />
              Add to Memory Inbox
            </button>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by title, tag, or source…"
                className="w-full rounded-lg border border-border bg-surface py-2 pl-8 pr-3 text-sm text-foreground outline-none placeholder:text-faint focus:border-border-strong"
              />
            </div>
            <div className="flex flex-wrap gap-1">
              {FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  onClick={() => setTypeFilter(filter.id)}
                  className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    typeFilter === filter.id
                      ? "bg-chip text-chip-foreground"
                      : "bg-surface text-muted hover:text-foreground-secondary"
                  }`}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>

          {myItems.length === 0 ? (
            <div className="mt-10 rounded-xl border border-border bg-surface/50 px-6 py-16 text-center">
              <p className="text-sm text-subtle">
                Your Memory Inbox is empty. Drop in a repo, a video, or a document and it&rsquo;ll
                become part of your memory layer.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <p className="mt-8 text-sm text-subtle">Nothing matches that search.</p>
          ) : (
            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {filtered.map((item) => {
                const isSelected = item.id === selectedId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedId(item.id)}
                    className={`rounded-xl border p-4 text-left transition-colors ${
                      isSelected
                        ? "border-border-strong bg-surface-hover"
                        : "border-border bg-surface hover:border-border-strong hover:bg-surface-hover/60"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg border border-border-strong bg-surface-hover">
                        <MemoryItemIcon type={item.type} className="h-5 w-5 text-foreground-secondary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className="truncate text-sm font-semibold text-foreground">{item.title}</p>
                          {item.sharedWith.length > 0 && (
                            <Tooltip content={getSharedTeamsText(item.sharedWith)}>
                              <Users className="h-3.5 w-3.5 flex-shrink-0 text-subtle" />
                            </Tooltip>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-xs text-subtle">
                          {MEMORY_ITEM_TYPE_LABEL[item.type]}
                        </p>
                      </div>
                      <MemoryStatusBadge status={item.status} />
                    </div>
                    <p className="mt-3 truncate text-xs text-subtle">
                      {item.status === "ready" && item.meta}
                      {item.status === "failed" && (
                        <span className="text-danger">{item.failureReason}</span>
                      )}
                      {item.status === "queued" && "Waiting to start…"}
                      {item.status === "indexing" && "Extracting and indexing…"}
                    </p>
                    {item.tags.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {item.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-surface-hover px-2 py-0.5 text-[10px] text-muted"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {selected && (
        <MemoryItemDetailPanel
          item={selected}
          teamNames={selected.sharedWith
            .map((id) => workspace.teams.find((team) => team.id === id)?.name)
            .filter((name): name is string => Boolean(name))}
          onClose={() => setSelectedId(null)}
          onShare={() => setShareTarget(selected)}
          onDelete={() => setDeleteTarget(selected)}
        />
      )}

      {addOpen && (
        <AddMemoryItemModal
          onClose={() => setAddOpen(false)}
          onAdded={(itemId) => {
            setAddOpen(false);
            setSelectedId(itemId);
          }}
        />
      )}

      {shareTarget && (
        <ShareMemoryItemModal
          item={shareTarget}
          teams={workspace.teams}
          onClose={() => setShareTarget(null)}
        />
      )}

      {deleteTarget && (
        <DeleteMemoryItemDialog
          item={deleteTarget}
          teamNames={deleteTarget.sharedWith
            .map((id) => workspace.teams.find((team) => team.id === id)?.name)
            .filter((name): name is string => Boolean(name))}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            deleteMemoryItem(deleteTarget.id);
            if (selectedId === deleteTarget.id) setSelectedId(null);
            setDeleteTarget(null);
          }}
        />
      )}
    </div>
  );
}

function MemoryStatusBadge({ status }: { status: MemoryItemStatus }) {
  if (status === "indexing") {
    return (
      <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
        <Loader2 className="h-3 w-3 animate-spin" />
        Indexing
      </span>
    );
  }
  if (status === "ready") {
    return (
      <span className="flex-shrink-0 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
        Ready
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex-shrink-0 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger">
        Failed
      </span>
    );
  }
  return (
    <span className="flex-shrink-0 rounded-full bg-surface-hover px-2 py-0.5 text-[11px] font-medium text-muted">
      Queued
    </span>
  );
}

function MemoryItemDetailPanel({
  item,
  teamNames,
  onClose,
  onShare,
  onDelete,
}: {
  item: MemoryItem;
  teamNames: string[];
  onClose: () => void;
  onShare: () => void;
  onDelete: () => void;
}) {
  const { retryMemoryItem } = useWorkspace();

  return (
    <aside className="flex w-[380px] flex-shrink-0 flex-col overflow-y-auto border-l border-border bg-background no-drag">
      <div className="flex items-start justify-between gap-2 px-5 pt-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-xl border border-border-strong bg-surface-hover">
            <MemoryItemIcon type={item.type} className="h-7 w-7 text-foreground-secondary" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold text-foreground">{item.title}</p>
            <p className="truncate text-sm text-subtle">{MEMORY_ITEM_TYPE_LABEL[item.type]}</p>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-0.5">
          <Tooltip content="Share">
            <button
              type="button"
              className="rounded-md p-1.5 text-subtle hover:bg-surface-hover hover:text-foreground-secondary"
              onClick={onShare}
              aria-label="Share"
            >
              <Share2 className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="Delete">
            <button
              type="button"
              className="rounded-md p-1.5 text-subtle hover:bg-danger/10 hover:text-danger"
              onClick={onDelete}
              aria-label="Delete"
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
        <MemoryStatusBadge status={item.status} />
        {item.status === "failed" && (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 p-3">
            <p className="text-xs text-danger">{item.failureReason}</p>
            <button
              type="button"
              className="mt-2 flex items-center gap-1.5 text-xs font-medium text-foreground-secondary hover:text-foreground"
              onClick={() => retryMemoryItem(item.id)}
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </button>
          </div>
        )}
      </div>

      <div className="mt-4 space-y-1 px-5 text-xs text-subtle">
        <p className="truncate">
          Source:{" "}
          {isLinkType(item.type) ? (
            <a
              href={item.source}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              {item.source}
            </a>
          ) : (
            <span className="text-foreground-secondary">{item.source}</span>
          )}
        </p>
        <p>Added {relativeTime(item.addedAt)}</p>
      </div>

      {item.tags.length > 0 && (
        <div className="mt-4 px-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">Tags</p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {item.tags.map((tag) => (
              <span key={tag} className="rounded-full bg-surface-hover px-2 py-0.5 text-[11px] text-muted">
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {item.status === "ready" && item.summary && (
        <div className="mt-4 px-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
            What Koed extracted
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-foreground-secondary">{item.summary}</p>
          {item.meta && <p className="mt-1.5 text-xs text-subtle">{item.meta}</p>}
        </div>
      )}

      <div className="mt-4 px-5 pb-5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">Shared with</p>
        {teamNames.length === 0 ? (
          <p className="mt-1.5 text-sm text-subtle">Only visible to you right now.</p>
        ) : (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {teamNames.map((name) => (
              <span
                key={name}
                className="rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-foreground-secondary"
              >
                {name}
              </span>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function ShareMemoryItemModal({
  item,
  teams,
  onClose,
}: {
  item: MemoryItem;
  teams: { id: string; name: string }[];
  onClose: () => void;
}) {
  const { shareMemoryItem } = useWorkspace();
  const [draft, setDraft] = useState<string[]>(item.sharedWith);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm no-drag"
      onClick={onClose}
    >
      <div
        className="w-80 overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border bg-background/50 px-4 py-3">
          <h3 className="truncate pr-4 text-sm font-medium text-foreground">
            Share <span className="text-muted">&ldquo;{item.title}&rdquo;</span>
          </h3>
          <button
            type="button"
            className="text-subtle transition-colors hover:text-foreground-secondary"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-64 overflow-y-auto p-2">
          <div className="mb-1 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">
            Select Teams
          </div>
          {teams.map((team) => {
            const isShared = draft.includes(team.id);
            return (
              <div
                key={team.id}
                className="group flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 transition-colors hover:bg-surface-hover"
                onClick={() =>
                  setDraft((current) =>
                    isShared ? current.filter((id) => id !== team.id) : [...current, team.id]
                  )
                }
              >
                <span className="text-sm text-foreground-secondary">{team.name}</span>
                <div
                  className={`flex h-4 w-4 items-center justify-center rounded-sm border transition-colors ${
                    isShared
                      ? "border-chip bg-chip text-chip-foreground"
                      : "border-border-strong text-transparent group-hover:border-border-strong"
                  }`}
                >
                  <Check className="h-3 w-3" strokeWidth={3} />
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex justify-end border-t border-border bg-background/50 p-3">
          <button
            type="button"
            className="rounded-lg bg-chip px-4 py-2 text-xs font-medium text-chip-foreground transition-colors hover:bg-white"
            onClick={() => {
              shareMemoryItem(item.id, draft);
              onClose();
            }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteMemoryItemDialog({
  item,
  teamNames,
  onCancel,
  onConfirm,
}: {
  item: MemoryItem;
  teamNames: string[];
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
        <h2 className="text-base font-semibold text-foreground">Delete {item.title}?</h2>
        <p className="mt-2 text-sm text-muted">
          This can&rsquo;t be undone.{" "}
          {teamNames.length === 0
            ? "It isn't shared with anyone right now."
            : `It's currently shared with ${teamNames.join(", ")} — deleting it will remove it from ${
                teamNames.length === 1 ? "that team's" : "their"
              } memory too.`}
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
            Delete item
          </button>
        </div>
      </div>
    </div>
  );
}
