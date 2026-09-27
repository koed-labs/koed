"use client";

import { useEffect, useMemo, useState } from "react";
import {
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Share2,
  Trash2,
  Users,
  X
} from "lucide-react";
import { CURRENT_USER_ID, relativeTime } from "@/lib/collab";
import {
  MEMORY_ITEM_TYPE_LABEL,
  isLinkType,
  type MemoryItem,
  type MemoryItemStatus,
  type MemoryItemType
} from "@/lib/memoryInbox";
import { AddMemoryItemModal } from "@/components/AddMemoryItemModal";
import { MemoryItemIcon } from "@/components/MemoryItemIcon";
import { StudioSidebar } from "@/components/studio/StudioSidebar";
import { Tooltip } from "@/components/Tooltip";
import { useResizableAside } from "@/components/useResizableAside";
import { useWorkspace } from "@/components/WorkspaceProvider";

type TypeFilter = "all" | "repo" | "video" | "link" | "file";
type MemoryInboxMode = "live" | "demo";

const FILTERS: { id: TypeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "repo", label: "Repos" },
  { id: "video", label: "Videos" },
  { id: "link", label: "Links" },
  { id: "file", label: "Files" }
];

function matchesFilter(type: MemoryItemType, filter: TypeFilter) {
  if (filter === "all") return true;
  if (filter === "repo") return type === "github-repo";
  if (filter === "video") return type === "youtube";
  if (filter === "link") return type === "web-link";
  return !isLinkType(type);
}

export function MemoryInboxView({
  mode,
  onHome,
  onNewChat,
  onPullRequests,
  onPlugins,
  onPreview
}: {
  mode: MemoryInboxMode;
  onHome: () => void;
  onNewChat: () => void;
  onPullRequests: () => void;
  onPlugins: () => void;
  onPreview: () => void;
}) {
  const { workspace, deleteMemoryItem } = useWorkspace();
  const [collapsed, setCollapsed] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<MemoryItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MemoryItem | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const isDemo = mode === "demo";

  const myItems = useMemo(
    () =>
      workspace.memoryItems.filter((item) => item.ownerId === CURRENT_USER_ID),
    [workspace.memoryItems]
  );
  const selected = selectedId
    ? (myItems.find((item) => item.id === selectedId) ?? null)
    : null;
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return myItems.filter((item) => {
      if (!matchesFilter(item.type, typeFilter)) return false;
      if (!normalizedQuery) return true;
      return (
        item.title.toLowerCase().includes(normalizedQuery) ||
        item.source.toLowerCase().includes(normalizedQuery) ||
        item.tags.some((tag) => tag.toLowerCase().includes(normalizedQuery))
      );
    });
  }, [myItems, query, typeFilter]);

  const getSharedTeamsText = (sharedWith: string[]) => {
    const names = sharedWith
      .map((id) => workspace.teams.find((team) => team.id === id)?.name)
      .filter((name): name is string => Boolean(name));
    return names.length ? `Preview sharing with: ${names.join(", ")}` : "";
  };

  return (
    <div className="flex h-full min-h-0 w-full bg-background text-foreground">
      <StudioSidebar
        projects={[]}
        collapsed={collapsed}
        selectedProject={null}
        onProjectSelect={() => undefined}
        onToggle={() => setCollapsed((value) => !value)}
        onHome={onHome}
        onNewChat={onNewChat}
        onPullRequests={onPullRequests}
        onPlugins={onPlugins}
        activeSection="memory-inbox"
      />

      <main className="flex min-h-0 min-w-0 flex-1">
        {isDemo ? (
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto no-drag">
            <div className="mx-auto w-full max-w-5xl px-5 py-6 sm:px-8 sm:py-8">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="text-2xl font-semibold">Memory Inbox</h1>
                    <span className="rounded-md border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
                      Local preview
                    </span>
                  </div>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
                    Preview-only records for links and file names. Koed does not
                    fetch, upload, index, or share their contents from this
                    screen.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setAddOpen(true)}
                  className="flex min-h-9 shrink-0 items-center gap-2 rounded-md border border-border bg-surface-hover px-3 text-sm font-medium text-foreground-secondary transition-colors hover:bg-surface-active hover:text-foreground"
                >
                  <Plus aria-hidden="true" className="h-4 w-4" />
                  Add to Memory Inbox
                </button>
              </div>

              <div
                className="mt-5 rounded-md border border-warning/30 bg-warning/10 px-4 py-3 text-xs leading-5 text-foreground-secondary"
                role="note"
              >
                Demo only. Changes below affect local preview metadata in this
                browser. Statuses are simulated; “Ready” does not mean content
                was processed. Sharing and removal do not change real Team
                access or stored Memory.
              </div>

              <div className="mt-5 flex flex-col gap-3 lg:flex-row lg:items-center">
                <label className="relative min-w-0 flex-1">
                  <span className="sr-only">Search preview items</span>
                  <Search
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle"
                  />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search by title, tag, or source"
                    className="h-10 w-full rounded-md border border-border bg-surface py-2 pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-faint focus:border-border-strong"
                  />
                </label>
                <div
                  className="flex flex-wrap gap-1"
                  role="group"
                  aria-label="Filter preview items by type"
                >
                  {FILTERS.map((filter) => (
                    <button
                      key={filter.id}
                      type="button"
                      aria-pressed={typeFilter === filter.id}
                      onClick={() => setTypeFilter(filter.id)}
                      className={`min-h-9 rounded-md px-3 text-xs font-medium transition-colors ${
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
                <div className="mt-6 border-y border-border px-5 py-12 text-center">
                  <FileText
                    aria-hidden="true"
                    className="mx-auto h-6 w-6 text-subtle"
                  />
                  <p className="mt-3 text-sm font-medium text-foreground-secondary">
                    No local preview items
                  </p>
                  <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-subtle">
                    Add a preview record to explore search, detail, simulated
                    status, and local-only sharing controls. No content is
                    ingested.
                  </p>
                  <button
                    type="button"
                    onClick={() => setAddOpen(true)}
                    className="mt-4 inline-flex min-h-9 items-center gap-2 rounded-md bg-chip px-3 text-sm font-medium text-chip-foreground hover:bg-chip-hover"
                  >
                    <Plus aria-hidden="true" className="h-4 w-4" />
                    Add to Memory Inbox
                  </button>
                </div>
              ) : filtered.length === 0 ? (
                <p className="mt-6 text-sm text-subtle">
                  No preview items match those filters.
                </p>
              ) : (
                <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                  {filtered.map((item) => (
                    <PreviewMemoryItemCard
                      key={item.id}
                      item={item}
                      selected={item.id === selectedId}
                      sharedText={getSharedTeamsText(item.sharedWith)}
                      onSelect={() => setSelectedId(item.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <LiveUnavailable onPreview={onPreview} />
        )}

        {isDemo && selected && (
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
      </main>

      {isDemo && addOpen && (
        <AddMemoryItemModal
          onClose={() => setAddOpen(false)}
          onAdded={(itemId) => {
            setAddOpen(false);
            setSelectedId(itemId);
          }}
        />
      )}
      {isDemo && shareTarget && (
        <SharePreviewModal
          item={shareTarget}
          teams={workspace.teams}
          onClose={() => setShareTarget(null)}
        />
      )}
      {isDemo && deleteTarget && (
        <DeletePreviewDialog
          item={deleteTarget}
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

function LiveUnavailable({ onPreview }: { onPreview: () => void }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto no-drag">
      <div className="mx-auto w-full max-w-3xl px-5 py-8 sm:px-8 sm:py-10">
        <h1 className="text-2xl font-semibold">Memory Inbox</h1>
        <p className="mt-2 text-sm text-muted">
          Add and manage external content for future recall.
        </p>
        <section
          className="mt-8 border-y border-border py-6"
          aria-labelledby="inbox-unavailable-heading"
        >
          <h2
            id="inbox-unavailable-heading"
            className="text-sm font-semibold text-foreground-secondary"
          >
            Not connected yet
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
            This deployment does not yet connect Memory Inbox to a content
            ingestion service. Adding links or files, processing and retrying
            jobs, sharing items with a Team, and removing stored content are
            unavailable here. Nothing will be uploaded, indexed, stored, or
            shared from this page.
          </p>
          <button
            type="button"
            onClick={onPreview}
            className="mt-5 inline-flex min-h-9 items-center gap-2 rounded-md border border-border bg-surface-hover px-3 text-sm font-medium text-foreground-secondary hover:text-foreground"
          >
            <FileText aria-hidden="true" className="h-4 w-4" />
            Open local preview
          </button>
        </section>
      </div>
    </div>
  );
}

function PreviewMemoryItemCard({
  item,
  selected,
  sharedText,
  onSelect
}: {
  item: MemoryItem;
  selected: boolean;
  sharedText: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`min-w-0 rounded-md border p-3 text-left transition-colors ${
        selected
          ? "border-border-strong bg-surface-hover"
          : "border-border bg-surface hover:border-border-strong hover:bg-surface-hover/60"
      }`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-background">
          <MemoryItemIcon
            type={item.type}
            className="h-4 w-4 text-foreground-secondary"
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-foreground">
              {item.title}
            </span>
            {item.sharedWith.length > 0 && (
              <Tooltip content={sharedText}>
                <Users
                  aria-label={sharedText}
                  className="h-3.5 w-3.5 shrink-0 text-subtle"
                />
              </Tooltip>
            )}
          </span>
          <span className="mt-0.5 block text-xs text-subtle">
            {MEMORY_ITEM_TYPE_LABEL[item.type]}
          </span>
        </span>
      </div>
      <span className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-2 text-[11px]">
        <span className="text-muted">Local preview metadata</span>
        <DemoStatusBadge status={item.status} />
      </span>
      {item.tags.length > 0 && (
        <span className="mt-2 flex flex-wrap gap-1">
          {item.tags.map((tag) => (
            <span
              key={tag}
              className="rounded bg-surface-hover px-1.5 py-0.5 text-[10px] text-muted"
            >
              {tag}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

function DemoStatusBadge({ status }: { status: MemoryItemStatus }) {
  if (status === "indexing") {
    return (
      <span className="inline-flex items-center gap-1 text-accent">
        <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" /> Demo
        processing
      </span>
    );
  }
  if (status === "ready")
    return <span className="text-success">Demo ready</span>;
  if (status === "failed")
    return <span className="text-danger">Demo failed</span>;
  return <span className="text-muted">Demo queued</span>;
}

function MemoryItemDetailPanel({
  item,
  teamNames,
  onClose,
  onShare,
  onDelete
}: {
  item: MemoryItem;
  teamNames: string[];
  onClose: () => void;
  onShare: () => void;
  onDelete: () => void;
}) {
  const { retryMemoryItem } = useWorkspace();
  const { width, isResizing, startResizing, resizeBy } = useResizableAside(380);

  return (
    <aside
      className="fixed inset-y-0 right-0 z-30 flex w-[min(90vw,380px)] shrink-0 border-l border-border bg-background shadow-xl md:relative md:z-auto md:w-[var(--aside-width)] md:shadow-none"
      style={{ "--aside-width": `${width}px` } as React.CSSProperties}
      aria-label="Preview item details"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize details panel"
        aria-valuemin={280}
        aria-valuemax={640}
        aria-valuenow={width}
        tabIndex={0}
        className={`absolute inset-y-0 left-0 z-10 hidden w-1 cursor-col-resize touch-none transition-colors hover:bg-surface-active md:block ${isResizing ? "bg-surface-active" : ""}`}
        onMouseDown={(event) => {
          event.preventDefault();
          startResizing();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") resizeBy(16);
          else if (event.key === "ArrowRight") resizeBy(-16);
          else if (event.key === "Home") resizeBy(280 - width);
          else if (event.key === "End") resizeBy(640 - width);
          else return;
          event.preventDefault();
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-border bg-surface-hover">
            <MemoryItemIcon
              type={item.type}
              className="h-5 w-5 text-foreground-secondary"
            />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-base font-semibold text-foreground">
              {item.title}
            </h2>
            <p className="mt-0.5 text-xs text-subtle">
              {MEMORY_ITEM_TYPE_LABEL[item.type]} · local preview
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Tooltip content="Update preview sharing">
              <button
                type="button"
                onClick={onShare}
                aria-label="Update preview sharing"
                className="rounded-md p-2 text-subtle hover:bg-surface-hover hover:text-foreground-secondary"
              >
                <Share2 aria-hidden="true" className="h-4 w-4" />
              </button>
            </Tooltip>
            <Tooltip content="Remove preview item">
              <button
                type="button"
                onClick={onDelete}
                aria-label="Remove preview item"
                className="rounded-md p-2 text-subtle hover:bg-danger/10 hover:text-danger"
              >
                <Trash2 aria-hidden="true" className="h-4 w-4" />
              </button>
            </Tooltip>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close details"
              className="rounded-md p-2 text-subtle hover:bg-surface-hover hover:text-foreground-secondary"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="mt-5 rounded-md border border-warning/30 bg-warning/10 p-3 text-xs leading-5 text-foreground-secondary">
          Preview state only. No extraction, indexing, or Team authorization was
          performed.
        </div>
        {item.status === "failed" && (
          <div className="mt-3 rounded-md border border-border bg-surface p-3">
            <p className="text-xs text-muted">
              This is a simulated failure state.
            </p>
            <button
              type="button"
              className="mt-2 inline-flex min-h-8 items-center gap-1.5 text-xs font-medium text-foreground-secondary hover:text-foreground"
              onClick={() => retryMemoryItem(item.id)}
            >
              <RefreshCw aria-hidden="true" className="h-3 w-3" />
              Retry demo state
            </button>
          </div>
        )}

        <dl className="mt-5 space-y-2 text-xs">
          <div>
            <dt className="text-subtle">Source metadata</dt>
            <dd className="mt-1 break-all text-foreground-secondary">
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
                item.source
              )}
            </dd>
          </div>
          <div>
            <dt className="text-subtle">Added</dt>
            <dd className="mt-1 text-foreground-secondary">
              {relativeTime(item.addedAt)}
            </dd>
          </div>
        </dl>

        {item.tags.length > 0 && (
          <section className="mt-5" aria-labelledby="preview-tags-heading">
            <h3
              id="preview-tags-heading"
              className="text-xs font-semibold text-subtle"
            >
              Tags
            </h3>
            <div className="mt-2 flex flex-wrap gap-1">
              {item.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded bg-surface-hover px-2 py-1 text-[11px] text-muted"
                >
                  {tag}
                </span>
              ))}
            </div>
          </section>
        )}

        <section
          className="mt-5 border-t border-border pt-4"
          aria-labelledby="preview-shared-with-heading"
        >
          <h3
            id="preview-shared-with-heading"
            className="text-xs font-semibold text-subtle"
          >
            Preview sharing
          </h3>
          {teamNames.length === 0 ? (
            <p className="mt-2 text-sm text-muted">
              No Teams selected in this local preview.
            </p>
          ) : (
            <p className="mt-2 text-sm text-foreground-secondary">
              {teamNames.join(", ")}
            </p>
          )}
        </section>
      </div>
    </aside>
  );
}

function SharePreviewModal({
  item,
  teams,
  onClose
}: {
  item: MemoryItem;
  teams: { id: string; name: string }[];
  onClose: () => void;
}) {
  const { shareMemoryItem } = useWorkspace();
  const [draft, setDraft] = useState<string[]>(item.sharedWith);

  return (
    <ModalFrame title={`Preview sharing · ${item.title}`} onClose={onClose}>
      <p className="border-b border-border px-4 py-3 text-xs leading-5 text-muted">
        Demo only. Saving changes local preview labels; it does not grant Teams
        access to content.
      </p>
      <div className="max-h-64 overflow-y-auto p-2">
        {teams.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted">
            No Teams are available in this preview.
          </p>
        ) : (
          teams.map((team) => {
            const checked = draft.includes(team.id);
            return (
              <label
                key={team.id}
                className="flex min-h-10 cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-sm text-foreground-secondary hover:bg-surface-hover"
              >
                <span className="min-w-0 truncate">{team.name}</span>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    setDraft((current) =>
                      checked
                        ? current.filter((id) => id !== team.id)
                        : [...current, team.id]
                    )
                  }
                  className="h-4 w-4 shrink-0 accent-accent"
                />
              </label>
            );
          })
        )}
      </div>
      <div className="flex justify-end border-t border-border p-3">
        <button
          type="button"
          className="min-h-9 rounded-md bg-chip px-4 text-sm font-medium text-chip-foreground hover:bg-chip-hover"
          onClick={() => {
            shareMemoryItem(item.id, draft);
            onClose();
          }}
        >
          Save preview
        </button>
      </div>
    </ModalFrame>
  );
}

function DeletePreviewDialog({
  item,
  onCancel,
  onConfirm
}: {
  item: MemoryItem;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ModalFrame title={`Remove ${item.title}?`} onClose={onCancel}>
      <p className="px-4 py-4 text-sm leading-6 text-muted">
        This removes only its local preview metadata from this browser. No
        source file or stored Memory is affected.
      </p>
      <div className="flex justify-end gap-2 border-t border-border p-3">
        <button
          type="button"
          onClick={onCancel}
          className="min-h-9 rounded-md bg-surface-hover px-3 text-sm text-foreground-secondary hover:bg-surface-active"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="min-h-9 rounded-md border border-danger/30 bg-danger/10 px-3 text-sm font-medium text-danger hover:bg-danger/20"
        >
          Remove preview
        </button>
      </div>
    </ModalFrame>
  );
}

function ModalFrame({
  title,
  onClose,
  children
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm no-drag"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-sm overflow-hidden rounded-lg border border-border bg-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="min-w-0 break-words text-sm font-semibold text-foreground">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="shrink-0 rounded-md p-1 text-subtle hover:bg-surface-hover hover:text-foreground-secondary"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
