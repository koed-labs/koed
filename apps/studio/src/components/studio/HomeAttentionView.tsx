"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  RotateCcw
} from "lucide-react";
import type { HomeItem, HomeSource } from "@koed/shared/home";
import type { HomeFeedState } from "@/lib/use-home-feed";

export function HomeAttentionView({
  state,
  snapshot,
  refreshing,
  mutationError,
  pendingItemIds,
  loadingSources,
  canMutate,
  showRefresh = true,
  onRefresh,
  onOpen,
  onSetCleared,
  onLoadMore
}: {
  state: HomeFeedState;
  snapshot: {
    generatedAt: string;
    coverage: Array<{
      source: HomeSource;
      complete: boolean;
      nextCursor: string | null;
    }>;
    needsYou: HomeItem[];
    ongoing: HomeItem[];
    recent: HomeItem[];
    cleared: HomeItem[];
    badgeCount: number;
  } | null;
  refreshing: boolean;
  mutationError: string | null;
  pendingItemIds: ReadonlySet<string>;
  loadingSources: ReadonlySet<HomeSource>;
  canMutate: boolean;
  showRefresh?: boolean;
  onRefresh: () => void;
  onOpen: (item: HomeItem) => void;
  onSetCleared: (item: HomeItem, cleared: boolean) => void;
  onLoadMore: (source: HomeSource) => void;
}) {
  const [needsOpen, setNeedsOpen] = useState(true);
  const [ongoingOpen, setOngoingOpen] = useState(true);
  const [clearedOpen, setClearedOpen] = useState(false);
  const offline = state === "offline";
  return (
    <section
      className="space-y-5 border-t border-border pt-5"
      aria-label="Home activity"
    >
      {offline && snapshot && (
        <p
          className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
          role="status"
        >
          Offline · may be out of date
        </p>
      )}
      {state === "unauthorized" && (
        <div
          className="flex items-center gap-2 text-sm text-danger"
          role="alert"
        >
          <AlertTriangle size={16} /> Home is not authorized for this session.
          <button type="button" onClick={onRefresh} className="underline">
            Retry
          </button>
        </div>
      )}
      {state === "offline" && !snapshot && (
        <div
          className="flex items-center gap-2 text-sm text-danger"
          role="alert"
        >
          <AlertTriangle size={16} /> Home could not be reached.
          <button type="button" onClick={onRefresh} className="underline">
            Retry
          </button>
        </div>
      )}
      {state === "loading" && !snapshot && (
        <p className="text-sm text-subtle" role="status">
          Loading Home activity…
        </p>
      )}
      {snapshot && (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted" aria-live="polite">
              {snapshot.badgeCount === 0
                ? "Nothing here needs you. Start something, or pick up where you left off."
                : snapshot.badgeCount === 1
                  ? "1 thing needs you."
                  : `${snapshot.badgeCount} things need you.`}
            </p>
            {showRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                disabled={refreshing}
                className="shrink-0 rounded-md px-2 py-1 text-xs text-subtle hover:bg-surface-hover disabled:opacity-50"
              >
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
            )}
          </div>
          {snapshot.coverage.some(
            (source) => !source.complete && !source.nextCursor
          ) && (
            <p className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              <AlertTriangle size={14} /> Some Home sources have incomplete
              coverage.
            </p>
          )}
          {mutationError && (
            <p className="text-xs text-danger" role="alert">
              {mutationError}
            </p>
          )}
          <FeedSection
            title="Needs you"
            count={snapshot.badgeCount}
            open={needsOpen}
            onToggle={() => setNeedsOpen((value) => !value)}
          >
            {snapshot.needsYou.length ? (
              <FeedList
                label="Needs you"
                items={snapshot.needsYou}
                offline={offline}
                pendingItemIds={pendingItemIds}
                canMutate={canMutate}
                onOpen={onOpen}
                onSetCleared={onSetCleared}
              />
            ) : snapshot.badgeCount > 0 ? (
              <p className="px-1 text-sm text-subtle">
                More items need you. Load another Home page to see them.
              </p>
            ) : (
              <p className="flex items-center gap-2 px-1 text-sm text-subtle">
                <CheckCircle2 className="h-4 w-4 text-success" /> Nothing here
                needs you.
              </p>
            )}
          </FeedSection>
          <FeedSection
            title="Ongoing work"
            count={snapshot.ongoing.length}
            open={ongoingOpen}
            onToggle={() => setOngoingOpen((value) => !value)}
          >
            {snapshot.ongoing.length ? (
              <FeedList
                label="Ongoing work"
                items={snapshot.ongoing}
                offline={offline}
                pendingItemIds={pendingItemIds}
                canMutate={canMutate}
                onOpen={onOpen}
                onSetCleared={onSetCleared}
              />
            ) : (
              <p className="px-1 text-sm text-subtle">No ongoing work.</p>
            )}
          </FeedSection>
          <FeedSection
            title="Cleared"
            count={snapshot.cleared.length}
            open={clearedOpen}
            onToggle={() => setClearedOpen((value) => !value)}
          >
            {snapshot.cleared.length ? (
              <FeedList
                label="Cleared"
                items={snapshot.cleared}
                offline={offline}
                pendingItemIds={pendingItemIds}
                canMutate={canMutate}
                onOpen={onOpen}
                onSetCleared={onSetCleared}
                cleared
              />
            ) : (
              <p className="px-1 text-sm text-subtle">No cleared items.</p>
            )}
          </FeedSection>
          {snapshot.coverage.filter((entry) => entry.nextCursor).length > 0 && (
            <div className="flex flex-wrap gap-2 border-t border-border pt-3">
              {snapshot.coverage
                .filter((entry) => entry.nextCursor)
                .map((entry) => (
                  <button
                    key={entry.source}
                    type="button"
                    disabled={
                      !canMutate || offline || loadingSources.has(entry.source)
                    }
                    onClick={() => onLoadMore(entry.source)}
                    className="rounded-md px-2.5 py-1.5 text-xs text-subtle hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {loadingSources.has(entry.source)
                      ? "Loading…"
                      : `Load more ${sourceLabel(entry.source)}`}
                  </button>
                ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function sourceLabel(source: string) {
  if (source === "managed_runtime_item" || source === "managed_execution")
    return "chats";
  if (source === "personal_agent_job") return "Agent jobs";
  return "pull requests";
}

function FeedSection({
  title,
  count,
  open,
  onToggle,
  children
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="mb-3 flex items-center gap-1.5 rounded-md py-0.5 pr-1.5 text-left text-sm font-medium text-foreground"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 text-subtle transition-transform ${open ? "rotate-90" : ""}`}
        />
        {title}
        {count > 0 && (
          <span className="rounded-full px-1.5 text-[11px] text-faint">
            {count}
          </span>
        )}
      </button>
      {open && children}
    </div>
  );
}

const HOME_SECTION_PAGE_SIZE = 5;

function FeedList({
  label,
  items,
  offline,
  pendingItemIds,
  canMutate,
  onOpen,
  onSetCleared,
  cleared = false
}: {
  label: string;
  items: HomeItem[];
  offline: boolean;
  pendingItemIds: ReadonlySet<string>;
  canMutate: boolean;
  onOpen: (item: HomeItem) => void;
  onSetCleared: (item: HomeItem, cleared: boolean) => void;
  cleared?: boolean;
}) {
  const [requestedPage, setRequestedPage] = useState(0);
  const pageCount = Math.ceil(items.length / HOME_SECTION_PAGE_SIZE);
  const page = Math.min(requestedPage, Math.max(0, pageCount - 1));
  const start = page * HOME_SECTION_PAGE_SIZE;
  const visibleItems = items.slice(start, start + HOME_SECTION_PAGE_SIZE);
  return (
    <div>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface/30">
        {visibleItems.map((item) => (
          <li
            key={`${item.sourceEventId}:${item.sourceRevision}`}
            className="flex min-w-0 items-center gap-2 px-3 py-2.5"
          >
            <button
              type="button"
              onClick={() => onOpen(item)}
              disabled={offline}
              className="group flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-not-allowed disabled:opacity-70"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {item.title}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted">
                  <span className="shrink-0 text-subtle">
                    {item.kind.replaceAll("_", " ")}
                  </span>
                  {item.summary && (
                    <>
                      <span aria-hidden="true" className="text-faint">
                        ·
                      </span>
                      <span className="min-w-0 truncate">{item.summary}</span>
                    </>
                  )}
                  <time
                    dateTime={item.updatedAt}
                    className="inline-flex shrink-0 items-center gap-1 text-faint"
                  >
                    <Clock3 className="h-3 w-3" />
                    {formatTime(item.updatedAt)}
                  </time>
                </span>
              </span>
              <span className="shrink-0 text-xs text-subtle">
                {item.destination.kind === "pull_request_review"
                  ? `#${item.destination.number}`
                  : "Open"}
              </span>
            </button>
            {(cleared ||
              item.state === "blocked" ||
              item.state === "review") && (
              <button
                type="button"
                disabled={
                  !canMutate ||
                  offline ||
                  pendingItemIds.has(item.sourceEventId)
                }
                onClick={() => onSetCleared(item, !cleared)}
                title={
                  cleared ? "Restore reminder" : "Clear until this item changes"
                }
                aria-label={`${cleared ? "Restore" : "Clear"} ${item.title}`}
                className="inline-flex shrink-0 items-center gap-1 rounded-md p-1 text-faint hover:bg-surface-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                {cleared ? (
                  <>
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span className="sr-only">Restore</span>
                  </>
                ) : (
                  <span className="text-xs">Clear</span>
                )}
              </button>
            )}
          </li>
        ))}
      </ul>
      {pageCount > 1 && (
        <div
          className="mt-2 flex items-center justify-between gap-3 px-1 text-xs text-subtle"
          aria-label={`${label} pagination`}
        >
          <span aria-live="polite">
            {start + 1}–{Math.min(start + HOME_SECTION_PAGE_SIZE, items.length)}{" "}
            of {items.length}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              aria-label={`Previous ${label} items`}
              disabled={page === 0}
              onClick={() => setRequestedPage(page - 1)}
              className="rounded-md border border-border px-2.5 py-1 hover:bg-surface-hover disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              aria-label={`Next ${label} items`}
              disabled={page + 1 >= pageCount}
              onClick={() => setRequestedPage(page + 1)}
              className="rounded-md border border-border px-2.5 py-1 hover:bg-surface-hover disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}
