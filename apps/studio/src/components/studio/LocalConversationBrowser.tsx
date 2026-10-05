"use client";

import {
  ChevronDown,
  ChevronRight,
  Folder,
  MessageSquare,
  Pencil,
  Plus,
  RotateCw,
  Search,
  Share2
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadStudioCsrfToken } from "@/lib/studio-csrf";
import type { HomeExecution } from "@/lib/studio-contract";
import {
  isSyntheticIndependentProject,
  managedConversationActivityLabel,
  normalizeConversationProvider
} from "./LocalConversationBrowser.match";
import {
  deriveProjectBrowserView,
  hasExplainableProjectAssociation
} from "./LocalConversationBrowser.projects";
import { PersonalRemovalControl } from "./PersonalRemovalControl";
import type { PersonalRemovalTarget } from "@/lib/personal-removals-client";
import {
  hasConversationRemoval,
  hasProjectRemoval,
  managedConversationRemovalTarget
} from "./personal-removals-view";
import {
  createPersonalCatalogCacheStore,
  personalCatalogOwnerId,
  persistPersonalCatalogSnapshot,
  type PersonalCatalogCacheSnapshot
} from "./personal-catalog-cache";

type Provider = "codex" | "claude-code" | "pi";
type LocalSource = {
  sourceId: string;
  provider: Provider;
  title: string;
  activityAt: string;
  projectId?: string;
  projectName?: string;
};
type RegisteredProject = {
  id: string;
  name: string;
  lastSeenAt?: string | null;
};
type ProviderStatus = {
  status:
    | "available"
    | "unavailable"
    | "invalid"
    | "limited"
    | "partial"
    | "not_requested";
  code?: string;
};
export type LocalSourceSelection =
  | { type: "managed"; executionId: string }
  | { type: "unavailable"; message: string };
type CatalogPage = {
  items: LocalSource[];
  nextCursor: string | null;
  providers: Partial<Record<Provider, ProviderStatus>>;
  truncated: boolean;
};

const PROVIDERS: Provider[] = ["codex", "claude-code", "pi"];
const LOCAL_SOURCE_DRAG_TYPE = "application/x-koed-local-source";
const MANAGED_EXECUTION_DRAG_TYPE = "application/x-koed-managed-execution";
type ManagedConversation = Pick<
  HomeExecution,
  | "id"
  | "title"
  | "projectId"
  | "provider"
  | "state"
  | "updatedAt"
  | "sessionId"
  | "activity"
>;
const PROJECT_CONVERSATION_PAGE_SIZE = 5;
const MAX_CATALOG_PAGES_PER_PROJECT_LOAD = 3;
const PROVIDER_LABEL: Record<Provider, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  pi: "Pi"
};

function isProvider(value: unknown): value is Provider {
  return PROVIDERS.includes(value as Provider);
}

function parsePage(value: unknown): CatalogPage {
  if (!value || typeof value !== "object")
    throw new Error("Invalid catalog response");
  const page = value as Partial<CatalogPage>;
  if (
    !Array.isArray(page.items) ||
    !(page.nextCursor === null || typeof page.nextCursor === "string") ||
    !page.providers ||
    typeof page.providers !== "object" ||
    typeof page.truncated !== "boolean"
  )
    throw new Error("Invalid catalog response");
  const items = page.items.filter((item): item is LocalSource =>
    Boolean(
      item &&
      typeof item === "object" &&
      typeof item.sourceId === "string" &&
      isProvider(item.provider) &&
      typeof item.title === "string" &&
      typeof item.activityAt === "string" &&
      (item.projectId === undefined || typeof item.projectId === "string") &&
      (item.projectName === undefined || typeof item.projectName === "string")
    )
  );
  const providers: Partial<Record<Provider, ProviderStatus>> = {};
  for (const provider of PROVIDERS) {
    const candidate = page.providers[provider];
    if (
      candidate &&
      typeof candidate === "object" &&
      typeof candidate.status === "string"
    ) {
      providers[provider] = candidate as ProviderStatus;
    }
  }
  return {
    items,
    nextCursor: page.nextCursor,
    providers,
    truncated: page.truncated
  };
}

function parseRegisteredProjects(value: unknown): RegisteredProject[] {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid project catalog response");
  }
  const projects = (value as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) {
    throw new Error("Invalid project catalog response");
  }
  if (
    !projects.every((project) =>
      Boolean(
        project &&
        typeof project === "object" &&
        typeof project.id === "string" &&
        typeof project.name === "string" &&
        (project.lastSeenAt === undefined ||
          project.lastSeenAt === null ||
          typeof project.lastSeenAt === "string")
      )
    )
  ) {
    throw new Error("Invalid project catalog response");
  }
  return projects as RegisteredProject[];
}

function activityLabel(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    time
  );
}

function connectionErrorMessage(reason: unknown): string {
  if (reason instanceof TypeError) {
    return "Koed Studio could not be reached. Check that the local Studio gateway is running, then retry.";
  }
  return reason instanceof Error
    ? reason.message
    : "The local conversation list could not be loaded.";
}

function projectCatalogErrorMessage(reason: unknown): string {
  if (reason instanceof TypeError) {
    return "Koed Studio could not be reached. Check that the local Studio gateway is running, then retry.";
  }
  return "The local Project list is unavailable. Retry to check again.";
}

function SourceRow({
  item,
  pending,
  disabled,
  unavailableMessage,
  onSelect,
  canShare,
  onShare,
  onRemove,
  onDragStart
}: {
  item: LocalSource;
  pending: boolean;
  disabled: boolean;
  unavailableMessage?: string;
  onSelect: () => void;
  canShare: boolean;
  onShare: () => void;
  onRemove?: () => Promise<void>;
  onDragStart: (event: React.DragEvent<HTMLButtonElement>) => void;
}) {
  const providerName = PROVIDER_LABEL[item.provider];
  const providerMark =
    item.provider === "claude-code"
      ? "CC"
      : item.provider === "codex"
        ? "C"
        : "Pi";
  const normalizedTitle = item.title.trim().toLocaleLowerCase();
  const normalizedProvider = providerName.toLocaleLowerCase();
  const titleNamesProvider =
    normalizedTitle.startsWith(`${normalizedProvider} `) ||
    normalizedTitle.startsWith(`${normalizedProvider}:`);
  const rowDescription = [
    item.title,
    titleNamesProvider ? "" : providerName,
    activityLabel(item.activityAt)
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div>
      <div className="group flex items-center gap-0.5">
        <button
          type="button"
          disabled={disabled}
          draggable={item.provider === "codex" && !disabled}
          onDragStart={onDragStart}
          aria-busy={pending}
          aria-label={rowDescription}
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-center rounded-md px-2 py-1.5 text-left text-sm text-muted hover:bg-surface-hover/50 hover:text-foreground-secondary disabled:opacity-60"
          title={rowDescription}
        >
          <span
            aria-hidden="true"
            title={providerName}
            className="mr-2 inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded border border-border px-0.5 text-[9px] font-semibold leading-none text-subtle"
          >
            {providerMark}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {pending ? "Checking source…" : item.title}
          </span>
        </button>
        {onRemove ? (
          <PersonalRemovalControl
            kind="conversation"
            name={item.title}
            onRemove={onRemove}
          />
        ) : null}
        <button
          type="button"
          disabled={!canShare}
          onClick={(event) => {
            event.stopPropagation();
            onShare();
          }}
          aria-label={`Share ${item.title} with a Team`}
          title={
            canShare
              ? "Share processed Personal Memory"
              : "This conversation has no verified Personal Memory source yet"
          }
          className="shrink-0 rounded-md p-1.5 text-faint opacity-0 transition-opacity hover:bg-surface-hover hover:text-foreground-secondary focus:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Share2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {unavailableMessage ? (
        <div
          role="status"
          className="mx-1 mb-2 rounded-md border border-border bg-background px-2.5 py-2 text-xs text-muted"
        >
          <p className="font-medium text-foreground">{item.title}</p>
          <p className="mt-1">{unavailableMessage}</p>
        </div>
      ) : null}
    </div>
  );
}

function ManagedExecutionRow({
  conversation,
  onSelect,
  canShare,
  onShare,
  onRemove,
  selected = false
}: {
  selected?: boolean;
  conversation: ManagedConversation;
  onSelect: () => void;
  canShare: boolean;
  onShare: () => void;
  onRemove?: () => Promise<void>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(conversation.title);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const rename = async () => {
    const title = name.trim();
    if (!title || title.length > 120 || !conversation.sessionId || saving)
      return;
    setSaving(true);
    setRenameError(null);
    try {
      const csrfToken = await loadStudioCsrfToken();
      const response = await fetch(
        `/studio-api/conversation-titles/${encodeURIComponent(conversation.sessionId)}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "x-studio-csrf": csrfToken
          },
          body: JSON.stringify({ title }),
          credentials: "include",
          redirect: "error"
        }
      );
      if (!response.ok)
        throw new Error("The conversation could not be renamed. Retry.");
      setSavedName(title);
      setRenaming(false);
      window.dispatchEvent(new Event("koed:conversation-titles-changed"));
    } catch (error) {
      setRenameError(
        error instanceof Error
          ? error.message
          : "Unable to rename the conversation."
      );
    } finally {
      setSaving(false);
    }
  };
  if (renaming)
    return (
      <form
        className="px-2 py-1"
        onSubmit={(event) => {
          event.preventDefault();
          void rename();
        }}
      >
        <input
          aria-label="Conversation name"
          autoFocus
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="w-full rounded border border-border bg-surface px-2 py-1 text-xs"
        />
        <div className="flex gap-2 text-xs">
          <button type="submit" disabled={saving || !name.trim()}>
            Save
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => setRenaming(false)}
          >
            Cancel
          </button>
        </div>
        {renameError ? (
          <p role="alert" className="text-xs text-danger">
            {renameError}
          </p>
        ) : null}
      </form>
    );
  const activityLabel = managedConversationActivityLabel(
    conversation.activity,
    conversation.state
  );
  const draggable =
    conversation.provider === "codex" &&
    conversation.state.toLowerCase() === "running";
  return (
    <div className="group @container flex items-center gap-0.5">
      <button
        type="button"
        draggable={draggable}
        onDragStart={(event) => {
          if (!draggable) return;
          event.dataTransfer.setData(
            MANAGED_EXECUTION_DRAG_TYPE,
            conversation.id
          );
          event.dataTransfer.effectAllowed = "move";
        }}
        onClick={onSelect}
        aria-current={selected ? "page" : undefined}
        aria-label={`${conversation.title} · ${conversation.provider} · ${activityLabel}`}
        title={`${conversation.title} · ${conversation.provider} · ${activityLabel}`}
        className={`flex min-w-0 flex-1 items-center rounded-md px-2 py-1.5 text-left text-xs ${selected ? "bg-surface-hover text-foreground" : "text-muted hover:bg-surface-hover/50 hover:text-foreground-secondary"}`}
      >
        <MessageSquare className="mr-2 h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {savedName ?? conversation.title}
        </span>
        <span className="ml-2 hidden max-w-24 shrink-0 truncate text-[10px] text-subtle @[260px]:inline">
          {activityLabel}
        </span>
      </button>
      {conversation.sessionId ? (
        <button
          type="button"
          aria-label={`Rename ${savedName ?? conversation.title}`}
          onClick={() => {
            setName(savedName ?? conversation.title);
            setRenaming(true);
          }}
          className="rounded-md p-1 text-faint opacity-0 hover:bg-surface-hover focus:opacity-100 group-hover:opacity-100"
        >
          <Pencil className="h-3 w-3" />
        </button>
      ) : null}
      {onRemove ? (
        <PersonalRemovalControl
          kind="conversation"
          name={conversation.title}
          onRemove={onRemove}
        />
      ) : null}
      <button
        type="button"
        disabled={!canShare}
        onClick={(event) => {
          event.stopPropagation();
          onShare();
        }}
        aria-label={`Share ${conversation.title} with a Team`}
        title={
          canShare
            ? "Share processed Personal Memory"
            : "This conversation has no verified Personal Memory source yet"
        }
        className="shrink-0 rounded-md p-1.5 text-faint opacity-0 transition-opacity hover:bg-surface-hover hover:text-foreground-secondary focus:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
      >
        <Share2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function LocalConversationBrowser({
  onNavigateAway,
  onProjectSelect,
  onSourceSelect,
  canShareSource,
  onShareSource,
  onMoveManagedExecution,
  onSelectManagedExecution,
  canShareManagedExecution,
  onShareManagedExecution,
  managedConversations = [],
  selectedExecutionId,
  managedSourceIds = [],
  onNewProject,
  canCreateProject = false,
  personalRemovals = [],
  personalRemovalsReady = true,
  personalRemovalError = null,
  onRetryPersonalRemovals,
  onRemovePersonalItem,
  lastRemovedPersonalItem,
  onUndoPersonalRemoval,
  managedProviderSourceIds = {},
  personalScopeKey = null
}: {
  onNavigateAway?: () => void;
  onProjectSelect?: (projectId: string) => void;
  canCreateProject?: boolean;
  personalRemovals?: PersonalRemovalTarget[];
  personalRemovalsReady?: boolean;
  personalRemovalError?: string | null;
  onRetryPersonalRemovals?: () => void;
  onRemovePersonalItem?: (target: PersonalRemovalTarget) => Promise<void>;
  lastRemovedPersonalItem?: PersonalRemovalTarget | null;
  onUndoPersonalRemoval?: () => Promise<void>;
  managedProviderSourceIds?: Readonly<Record<string, readonly string[]>>;
  personalScopeKey?: string | null;
  onNewProject?: () => void;
  onSourceSelect?: (
    sourceId: string,
    provider: Provider,
    signal: AbortSignal
  ) => Promise<LocalSourceSelection>;
  canShareSource?: (sourceId: string, provider: Provider) => boolean;
  onShareSource?: (sourceId: string, provider: Provider) => void;
  onMoveManagedExecution?: (
    executionId: string,
    destinationProjectId: string
  ) => void;
  onSelectManagedExecution?: (executionId: string) => void;
  canShareManagedExecution?: (executionId: string) => boolean;
  onShareManagedExecution?: (executionId: string) => void;
  selectedExecutionId?: string;
  managedConversations?: ManagedConversation[];
  managedSourceIds?: readonly string[];
}) {
  const [items, setItems] = useState<LocalSource[]>([]);
  const [registeredProjects, setRegisteredProjects] = useState<
    RegisteredProject[]
  >([]);
  const [loadingRegisteredProjects, setLoadingRegisteredProjects] =
    useState(true);
  const [dropTargetProjectId, setDropTargetProjectId] = useState<string | null>(
    null
  );
  const [moveDropMessage, setMoveDropMessage] = useState<string | null>(null);
  const [registeredProjectsError, setRegisteredProjectsError] = useState<
    string | null
  >(null);
  const [providerStatuses, setProviderStatuses] = useState<
    CatalogPage["providers"]
  >({});
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [provider, setProvider] = useState<Provider | "all">("all");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [expandedProjects, setExpandedProjects] = useState(true);
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [expandedChats, setExpandedChats] = useState(true);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set()
  );
  const [
    visibleProjectConversationCounts,
    setVisibleProjectConversationCounts
  ] = useState<Record<string, number>>({});
  const selectedProjectId = managedConversations.find(
    (item) => item.id === selectedExecutionId
  )?.projectId;
  /* eslint-disable react-hooks/set-state-in-effect -- Reveal a conversation selected by the parent. */
  useEffect(() => {
    if (!selectedExecutionId) return;
    // Reveal the selected row without closing projects the user opened.
    if (selectedProjectId) {
      setExpandedProjects(true);
      setExpandedProjectIds(
        (current) => new Set([...current, selectedProjectId])
      );
    } else {
      setExpandedChats(true);
    }
  }, [selectedExecutionId, selectedProjectId]);
  /* eslint-enable react-hooks/set-state-in-effect */
  const [selectedUnavailable, setSelectedUnavailable] = useState<{
    source: LocalSource;
    message: string;
  } | null>(null);
  const [pendingSourceId, setPendingSourceId] = useState<string | null>(null);
  const [undoPending, setUndoPending] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const undoRemoval = async () => {
    if (!onUndoPersonalRemoval || undoPending) return;
    setUndoPending(true);
    setUndoError(null);
    try {
      await onUndoPersonalRemoval();
    } catch (reason) {
      setUndoError(
        reason instanceof Error
          ? reason.message
          : "Undo could not be saved. Try again."
      );
    } finally {
      setUndoPending(false);
    }
  };
  const catalogControllerRef = useRef<AbortController | null>(null);
  const paginationInFlightRef = useRef(false);
  const catalogSequenceRef = useRef(0);
  const selectionControllerRef = useRef<AbortController | null>(null);
  const selectionSequenceRef = useRef(0);
  const projectsControllerRef = useRef<AbortController | null>(null);
  const projectsSequenceRef = useRef(0);
  const projectSearchRef = useRef<HTMLInputElement>(null);
  const cacheStore = useMemo(() => {
    const ownerId = personalCatalogOwnerId(personalScopeKey);
    return ownerId && personalScopeKey
      ? createPersonalCatalogCacheStore({ ownerId, scopeKey: personalScopeKey })
      : null;
  }, [personalScopeKey]);
  const catalogCacheStateRef = useRef({
    items,
    registeredProjects,
    personalRemovals,
    provider,
    providerStatuses,
    truncated
  });
  catalogCacheStateRef.current = {
    items,
    registeredProjects,
    personalRemovals,
    provider,
    providerStatuses,
    truncated
  };
  const writeCatalogCache = useCallback(
    async (page?: CatalogPage) => {
      if (!cacheStore || !personalScopeKey) return;
      const current = catalogCacheStateRef.current;
      if (current.provider !== "all") {
        const cached = await cacheStore.read();
        if (
          cached?.scopeKey === personalScopeKey &&
          cached.provider === "all"
        ) {
          await persistPersonalCatalogSnapshot(cacheStore, {
            ...cached,
            projects: current.registeredProjects,
            removals: current.personalRemovals
          });
        }
        return;
      }
      const snapshot: PersonalCatalogCacheSnapshot = {
        schemaVersion: 1,
        scopeKey: personalScopeKey,
        cachedAt: Date.now(),
        provider: current.provider,
        catalog: {
          items: page?.items ?? current.items,
          providers: page?.providers ?? current.providerStatuses,
          truncated: page?.truncated ?? current.truncated
        },
        projects: current.registeredProjects,
        removals: current.personalRemovals
      };
      await persistPersonalCatalogSnapshot(cacheStore, snapshot);
    },
    [cacheStore, personalScopeKey]
  );

  useEffect(() => {
    if (projectSearchOpen) projectSearchRef.current?.focus();
  }, [projectSearchOpen]);

  const fetchPage = useCallback(
    async (cursor?: string, append = false): Promise<CatalogPage | null> => {
      catalogSequenceRef.current += 1;
      const sequence = catalogSequenceRef.current;
      catalogControllerRef.current?.abort();
      const controller = new AbortController();
      catalogControllerRef.current = controller;
      selectionSequenceRef.current += 1;
      selectionControllerRef.current?.abort();
      selectionControllerRef.current = null;
      setPendingSourceId(null);
      setSelectedUnavailable(null);
      if (append) setLoadingMore(true);
      else setLoading(true);
      if (append) setLoadMoreError(null);
      else setError(null);
      try {
        const query = new URLSearchParams({ limit: "50" });
        if (cursor) query.set("cursor", cursor);
        if (provider !== "all") query.set("provider", provider);
        if (!append) query.set("refresh", "1");
        const response = await fetch(
          `/studio-api/local-conversations?${query}`,
          {
            headers: { Accept: "application/json" },
            cache: "no-store",
            signal: controller.signal
          }
        );
        if (!response.ok)
          throw new Error(
            response.status === 503
              ? "Local conversation discovery is unavailable."
              : "The local conversation list could not be loaded."
          );
        const page = parsePage(await response.json());
        if (
          sequence !== catalogSequenceRef.current ||
          controller.signal.aborted
        )
          return null;
        setItems((current) =>
          append ? [...current, ...page.items] : page.items
        );
        setProviderStatuses(page.providers);
        setNextCursor(page.nextCursor);
        setTruncated(page.truncated);
        if (!append) void writeCatalogCache(page);
        return page;
      } catch (reason) {
        if (
          sequence !== catalogSequenceRef.current ||
          controller.signal.aborted
        )
          return null;
        const message = connectionErrorMessage(reason);
        if (append) setLoadMoreError(message);
        else setError(message);
        return null;
      } finally {
        if (sequence === catalogSequenceRef.current) {
          catalogControllerRef.current = null;
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [provider, writeCatalogCache]
  );

  const loadMoreProjectConversations = useCallback(
    async (projectId: string, currentlyVisible: number) => {
      if (paginationInFlightRef.current) return;
      paginationInFlightRef.current = true;
      const retryingFailedPage = Boolean(loadMoreError);
      const targetVisible = retryingFailedPage
        ? currentlyVisible
        : currentlyVisible + PROJECT_CONVERSATION_PAGE_SIZE;
      setVisibleProjectConversationCounts((current) => ({
        ...current,
        [projectId]: targetVisible
      }));

      try {
        let projectConversationCount = items.filter(
          (item) => item.projectId === projectId
        ).length;
        let cursor = nextCursor;
        let pagesLoaded = 0;
        while (
          (projectConversationCount < targetVisible ||
            (retryingFailedPage && pagesLoaded === 0)) &&
          cursor &&
          pagesLoaded < MAX_CATALOG_PAGES_PER_PROJECT_LOAD
        ) {
          const page = await fetchPage(cursor, true);
          if (!page) break;
          pagesLoaded += 1;
          projectConversationCount += page.items.filter(
            (item) => item.projectId === projectId
          ).length;
          cursor = page.nextCursor;
        }
      } finally {
        paginationInFlightRef.current = false;
      }
    },
    [fetchPage, items, loadMoreError, nextCursor]
  );

  const loadMoreCatalog = useCallback(async () => {
    if (paginationInFlightRef.current || !nextCursor) return;
    paginationInFlightRef.current = true;
    try {
      await fetchPage(nextCursor, true);
    } finally {
      paginationInFlightRef.current = false;
    }
  }, [fetchPage, nextCursor]);

  const fetchRegisteredProjects = useCallback(async () => {
    projectsSequenceRef.current += 1;
    const sequence = projectsSequenceRef.current;
    projectsControllerRef.current?.abort();
    const controller = new AbortController();
    projectsControllerRef.current = controller;
    setLoadingRegisteredProjects(true);
    setRegisteredProjectsError(null);
    try {
      const response = await fetch("/studio-api/projects", {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error("The local Project list is unavailable.");
      }
      const projects = parseRegisteredProjects(await response.json());
      if (
        sequence === projectsSequenceRef.current &&
        !controller.signal.aborted
      ) {
        setRegisteredProjects(projects);
        const cached = await cacheStore?.read();
        if (cacheStore && cached?.scopeKey === personalScopeKey) {
          await persistPersonalCatalogSnapshot(cacheStore, {
            ...cached,
            projects,
            removals: catalogCacheStateRef.current.personalRemovals
          });
        }
      }
    } catch (reason) {
      if (
        sequence === projectsSequenceRef.current &&
        !controller.signal.aborted
      ) {
        setRegisteredProjectsError(projectCatalogErrorMessage(reason));
      }
    } finally {
      if (sequence === projectsSequenceRef.current) {
        projectsControllerRef.current = null;
        setLoadingRegisteredProjects(false);
      }
    }
  }, [cacheStore, personalScopeKey, provider]);

  const selectSource = useCallback(
    async (source: LocalSource) => {
      selectionSequenceRef.current += 1;
      const sequence = selectionSequenceRef.current;
      selectionControllerRef.current?.abort();
      const controller = new AbortController();
      selectionControllerRef.current = controller;
      setPendingSourceId(source.sourceId);
      setSelectedUnavailable(null);
      try {
        const selection = onSourceSelect
          ? await onSourceSelect(
              source.sourceId,
              source.provider,
              controller.signal
            )
          : {
              type: "unavailable" as const,
              message: `This local ${PROVIDER_LABEL[source.provider]} conversation has no writable Koed-managed execution. Continue it in ${PROVIDER_LABEL[source.provider]}; Studio cannot show its transcript or send messages.`
            };
        if (
          sequence === selectionSequenceRef.current &&
          selection.type === "unavailable"
        ) {
          setSelectedUnavailable({ source, message: selection.message });
        }
        return sequence === selectionSequenceRef.current ? selection : null;
      } catch (reason) {
        if (
          sequence === selectionSequenceRef.current &&
          !controller.signal.aborted
        ) {
          setSelectedUnavailable({
            source,
            message:
              reason instanceof Error
                ? reason.message
                : "Koed could not verify this source. Studio cannot show its transcript or send messages."
          });
        }
        return null;
      } finally {
        if (sequence === selectionSequenceRef.current) {
          selectionControllerRef.current = null;
          setPendingSourceId(null);
          onNavigateAway?.();
        }
      }
    },
    [onNavigateAway, onSourceSelect]
  );

  const acceptSourceDrop = useCallback(
    async (event: React.DragEvent, destinationProjectId: string) => {
      event.preventDefault();
      setDropTargetProjectId(null);
      setMoveDropMessage(null);
      if (!/^lp_[0-9a-f]{32}$/iu.test(destinationProjectId)) return;
      const managedExecutionId = event.dataTransfer.getData(
        MANAGED_EXECUTION_DRAG_TYPE
      );
      if (managedExecutionId) {
        const execution = managedConversations.find(
          (item) => item.id === managedExecutionId
        );
        if (!execution || execution.provider !== "codex") {
          setMoveDropMessage(
            "Only a verified Codex managed Conversation can be moved."
          );
          return;
        }
        if (execution.state.toLowerCase() !== "running") {
          setMoveDropMessage(
            "This Conversation is not running. No Move was started."
          );
          return;
        }
        if (execution.projectId === destinationProjectId) {
          setMoveDropMessage("This Conversation is already in that Project.");
          return;
        }
        if (
          !hasProjectRemoval(personalRemovals, destinationProjectId) &&
          !registeredProjects.some(
            (project) => project.id === destinationProjectId
          )
        ) {
          setMoveDropMessage("The destination is not a registered Project.");
          return;
        }
        onMoveManagedExecution?.(execution.id, destinationProjectId);
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(
          event.dataTransfer.getData(LOCAL_SOURCE_DRAG_TYPE)
        );
      } catch {
        return;
      }
      if (
        !payload ||
        typeof payload !== "object" ||
        typeof (payload as { sourceId?: unknown }).sourceId !== "string" ||
        (payload as { provider?: unknown }).provider !== "codex"
      )
        return;
      const source = items.find(
        (item) =>
          item.sourceId === (payload as { sourceId: string }).sourceId &&
          item.provider === "codex"
      );
      if (!source || source.projectId === destinationProjectId) return;
      if (
        hasProjectRemoval(personalRemovals, destinationProjectId) ||
        !registeredProjects.some(
          (project) => project.id === destinationProjectId
        )
      )
        return;
      const selection = await selectSource(source);
      if (selection?.type === "managed") {
        onMoveManagedExecution?.(selection.executionId, destinationProjectId);
      }
    },
    [
      items,
      managedConversations,
      onMoveManagedExecution,
      registeredProjects,
      selectSource,
      personalRemovals
    ]
  );

  useEffect(
    () => () => {
      catalogSequenceRef.current += 1;
      catalogControllerRef.current?.abort();
      projectsSequenceRef.current += 1;
      projectsControllerRef.current?.abort();
      selectionSequenceRef.current += 1;
      selectionControllerRef.current?.abort();
    },
    []
  );

  useEffect(() => {
    const sequence = ++catalogSequenceRef.current;
    const projectSequence = projectsSequenceRef.current;
    let active = true;
    // Scope and provider changes must not leave the previous cache visible.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setItems([]);
    setProviderStatuses({});
    setNextCursor(null);
    setTruncated(false);
    setError(null);
    setLoadMoreError(null);
    setLoading(true);
    const loadCachedThenRefresh = async () => {
      if (cacheStore && personalScopeKey) {
        const cached = await cacheStore.read();
        if (
          active &&
          sequence === catalogSequenceRef.current &&
          cached?.scopeKey === personalScopeKey &&
          cached.provider === provider
        ) {
          try {
            const page = parsePage({
              ...cached.catalog,
              nextCursor: null
            });
            const projects = parseRegisteredProjects({
              projects: cached.projects
            });
            if (active && sequence === catalogSequenceRef.current) {
              setItems(page.items);
              setProviderStatuses(page.providers);
              setNextCursor(null);
              setTruncated(page.truncated);
              if (projectsSequenceRef.current === projectSequence) {
                setRegisteredProjects(projects);
              }
              setLoading(false);
            }
          } catch {
            await cacheStore.clear();
          }
        }
      }
      if (active && sequence === catalogSequenceRef.current) {
        // Refresh first-page discovery after cached rows are already usable.
        void fetchPage();
      }
    };
    void loadCachedThenRefresh();
    return () => {
      active = false;
      catalogSequenceRef.current += 1;
    };
  }, [cacheStore, fetchPage, personalScopeKey, provider]);

  useEffect(() => {
    const refreshProjects = () => void fetchRegisteredProjects();
    refreshProjects();
    window.addEventListener("koed:projects-changed", refreshProjects);
    return () => {
      window.removeEventListener("koed:projects-changed", refreshProjects);
      projectsSequenceRef.current += 1;
      projectsControllerRef.current?.abort();
      projectsControllerRef.current = null;
    };
  }, [fetchRegisteredProjects]);

  useEffect(() => {
    if (!cacheStore || !personalScopeKey) return;
    let active = true;
    void cacheStore.read().then((cached) => {
      if (!active || cached?.scopeKey !== personalScopeKey) return;
      void persistPersonalCatalogSnapshot(cacheStore, {
        ...cached,
        removals: personalRemovals
      });
    });
    return () => {
      active = false;
    };
  }, [cacheStore, personalRemovals, personalScopeKey, provider]);

  const removedProjectIds = useMemo(
    () =>
      new Set(
        personalRemovals.flatMap((target) =>
          target.kind === "project" ? [target.projectId] : []
        )
      ),
    [personalRemovals]
  );
  const visibleRegisteredProjects = useMemo(
    () =>
      personalRemovalsReady
        ? registeredProjects.filter(
            (project) => !removedProjectIds.has(project.id)
          )
        : [],
    [registeredProjects, removedProjectIds, personalRemovalsReady]
  );
  const registeredProjectIds = useMemo(
    () => new Set(visibleRegisteredProjects.map((project) => project.id)),
    [visibleRegisteredProjects]
  );
  const managedSourceIdSet = useMemo(
    () => new Set(managedSourceIds),
    [managedSourceIds]
  );
  const projectSources = useMemo(
    () =>
      items.filter((item) => {
        return (
          hasExplainableProjectAssociation(item, registeredProjectIds) &&
          !managedSourceIdSet.has(item.sourceId)
        );
      }),
    [items, managedSourceIdSet, registeredProjectIds]
  );
  const visibleProjectSources = useMemo(
    () =>
      personalRemovalsReady
        ? projectSources.filter(
            (item) =>
              !removedProjectIds.has(item.projectId ?? "") &&
              !hasConversationRemoval(personalRemovals, [item.sourceId])
          )
        : [],
    [projectSources, removedProjectIds, personalRemovals, personalRemovalsReady]
  );
  const visibleManagedConversations = useMemo(
    () =>
      personalRemovalsReady
        ? managedConversations.filter(
            (conversation) =>
              !removedProjectIds.has(conversation.projectId ?? "") &&
              !hasConversationRemoval(personalRemovals, [
                `managed:${conversation.id}`
              ])
          )
        : [],
    [
      managedConversations,
      removedProjectIds,
      personalRemovals,
      personalRemovalsReady
    ]
  );
  const { projects, activeManagedConversations } = useMemo(
    () =>
      deriveProjectBrowserView({
        items: visibleProjectSources,
        registeredProjects: visibleRegisteredProjects,
        managedConversations: visibleManagedConversations,
        provider,
        normalizeProvider: normalizeConversationProvider
      }),
    [
      visibleProjectSources,
      visibleRegisteredProjects,
      visibleManagedConversations,
      provider
    ]
  );
  const projectItems = useMemo(() => {
    const grouped = new Map<string, LocalSource[]>();
    for (const item of visibleProjectSources) {
      if (!item.projectId) continue;
      const group = grouped.get(item.projectId) ?? [];
      group.push(item);
      grouped.set(item.projectId, group);
    }
    return grouped;
  }, [visibleProjectSources]);
  const managedByProject = useMemo(() => {
    const grouped = new Map<string, ManagedConversation[]>();
    for (const item of activeManagedConversations) {
      if (!item.projectId || !registeredProjectIds.has(item.projectId))
        continue;
      const group = grouped.get(item.projectId) ?? [];
      group.push(item);
      grouped.set(item.projectId, group);
    }
    return grouped;
  }, [activeManagedConversations, registeredProjectIds]);
  const standaloneManaged = activeManagedConversations.filter(
    (item) =>
      !item.projectId ||
      isSyntheticIndependentProject(item.projectId) ||
      !registeredProjectIds.has(item.projectId)
  );
  const standaloneItems = items.filter(
    (item) =>
      personalRemovalsReady &&
      (!item.projectId ||
        isSyntheticIndependentProject(item.projectId, item.projectName) ||
        (!registeredProjectIds.has(item.projectId) &&
          !item.projectName?.trim())) &&
      !managedSourceIdSet.has(item.sourceId) &&
      !hasProjectRemoval(personalRemovals, item.projectId ?? "") &&
      !hasConversationRemoval(personalRemovals, [item.sourceId])
  );
  const normalizedProjectSearch = projectSearch.trim().toLocaleLowerCase();
  const filteredProjects = projects.filter((project) =>
    project.name.toLocaleLowerCase().includes(normalizedProjectSearch)
  );
  const hasProviderProblem = Object.values(providerStatuses).some(
    (status) =>
      status?.status === "unavailable" ||
      status?.status === "invalid" ||
      status?.status === "limited" ||
      status?.status === "partial"
  );

  return (
    <div className="px-2 pb-2 text-sm no-drag">
      {lastRemovedPersonalItem ? (
        <div
          role="status"
          aria-live="polite"
          className="mb-2 flex items-center justify-between gap-2 rounded-md border border-border bg-background px-2 py-2 text-xs text-muted"
        >
          <span>
            Removed from Studio. Files and history are still available.
          </span>
          <button
            type="button"
            onClick={() => void undoRemoval()}
            disabled={undoPending}
            className="shrink-0 rounded px-1.5 py-1 font-medium text-foreground-secondary hover:bg-surface-hover hover:text-foreground"
          >
            {undoPending ? "Restoring…" : "Undo"}
          </button>
        </div>
      ) : null}
      {lastRemovedPersonalItem && undoError ? (
        <p role="alert" className="mb-2 px-2 text-xs text-danger">
          {undoError}
        </p>
      ) : null}
      <div className="flex items-center justify-between px-2 py-1.5">
        <button
          type="button"
          onClick={() => setExpandedProjects((value) => !value)}
          className="flex items-center font-medium text-foreground-secondary hover:text-foreground"
        >
          Projects{" "}
          {expandedProjects ? (
            <ChevronDown className="ml-1 h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="ml-1 h-3.5 w-3.5" />
          )}
        </button>
        <div className="flex items-center gap-1">
          <select
            aria-label="Filter source conversations by AI Client"
            value={provider}
            onChange={(event) => {
              catalogSequenceRef.current += 1;
              catalogControllerRef.current?.abort();
              catalogControllerRef.current = null;
              selectionSequenceRef.current += 1;
              selectionControllerRef.current?.abort();
              selectionControllerRef.current = null;
              setPendingSourceId(null);
              setSelectedUnavailable(null);
              setItems([]);
              setProviderStatuses({});
              setNextCursor(null);
              setTruncated(false);
              setLoading(true);
              setLoadingMore(false);
              setError(null);
              setLoadMoreError(null);
              setVisibleProjectConversationCounts({});
              setProvider(event.target.value as Provider | "all");
            }}
            className="max-w-28 rounded bg-background px-1 py-0.5 text-[11px] text-muted"
          >
            <option value="all">All clients</option>
            {PROVIDERS.map((value) => (
              <option key={value} value={value}>
                {PROVIDER_LABEL[value]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              setProjectSearchOpen((open) => !open);
              if (projectSearchOpen) setProjectSearch("");
            }}
            aria-label={
              projectSearchOpen ? "Close project search" : "Search Projects"
            }
            aria-expanded={projectSearchOpen}
            title={
              projectSearchOpen ? "Close project search" : "Search Projects"
            }
            className="rounded-md p-1 text-muted hover:bg-surface-hover hover:text-foreground"
          >
            <Search className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onNewProject}
            disabled={!canCreateProject || !onNewProject}
            aria-label="New Project"
            title={
              canCreateProject
                ? "New Project"
                : "New projects are available in Koed Studio for Electron."
            }
            className="rounded-md p-1 text-muted hover:bg-surface-hover hover:text-foreground disabled:cursor-not-allowed disabled:text-faint"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {!personalRemovalsReady ? (
        <div
          role={personalRemovalError ? "alert" : "status"}
          className="mx-1 mb-2 rounded-md border border-border bg-background px-2.5 py-2 text-xs text-muted"
        >
          <p>
            {personalRemovalError
              ? "Your Personal Studio list is unavailable, so saved removals cannot be applied."
              : "Loading your Personal Studio list…"}
          </p>
          {personalRemovalError && onRetryPersonalRemovals ? (
            <button
              type="button"
              onClick={onRetryPersonalRemovals}
              className="mt-2 font-medium text-foreground-secondary hover:text-foreground"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {projectSearchOpen && (
        <div className="px-2 pb-1">
          <input
            ref={projectSearchRef}
            type="search"
            value={projectSearch}
            onChange={(event) => setProjectSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setProjectSearch("");
                setProjectSearchOpen(false);
              }
            }}
            placeholder="Search projects"
            aria-label="Search projects by name"
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-accent"
          />
        </div>
      )}
      {expandedProjects && (
        <div className="mb-2">
          {(loading || loadingRegisteredProjects) &&
          items.length === 0 &&
          projects.length === 0 ? (
            <p className="px-3 py-2 text-xs text-subtle">
              Loading local projects…
            </p>
          ) : null}
          {registeredProjectsError ? (
            <div role="status" className="px-3 py-2 text-xs text-subtle">
              <p>{registeredProjectsError}</p>
              <button
                type="button"
                disabled={loadingRegisteredProjects}
                onClick={() => void fetchRegisteredProjects()}
                className="mt-2 inline-flex items-center gap-1 text-foreground-secondary hover:text-foreground disabled:opacity-60"
              >
                <RotateCw className="h-3 w-3" />
                {loadingRegisteredProjects ? "Retrying…" : "Retry Projects"}
              </button>
            </div>
          ) : null}
          {!loading &&
          !loadingRegisteredProjects &&
          !error &&
          personalRemovalsReady &&
          projects.length === 0 ? (
            <p className="px-3 py-2 text-xs text-subtle">
              No local projects found.
            </p>
          ) : null}
          {!loading &&
          !error &&
          projects.length > 0 &&
          filteredProjects.length === 0 ? (
            <p className="px-3 py-2 text-xs text-subtle">
              No projects match your search.
            </p>
          ) : null}
          {filteredProjects.map((project) => {
            const projectExpanded = expandedProjectIds.has(project.id);
            const sources = projectItems.get(project.id) ?? [];
            const visibleCatalogSources = sources.filter(
              (item) => !managedSourceIdSet.has(item.sourceId)
            );
            const managedSources = managedByProject.get(project.id) ?? [];
            const visibleCount =
              visibleProjectConversationCounts[project.id] ??
              PROJECT_CONVERSATION_PAGE_SIZE;
            const visibleSources = visibleCatalogSources.slice(0, visibleCount);
            const canLoadMoreProjectSources =
              visibleCatalogSources.length > visibleSources.length ||
              Boolean(nextCursor);
            return (
              <div key={project.id} className="group">
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onDragOver={(event) => {
                      if (
                        registeredProjects.some(
                          (candidate) => candidate.id === project.id
                        ) &&
                        !hasProjectRemoval(personalRemovals, project.id) &&
                        /^lp_[0-9a-f]{32}$/iu.test(project.id) &&
                        (Array.from(event.dataTransfer.types).includes(
                          LOCAL_SOURCE_DRAG_TYPE
                        ) ||
                          Array.from(event.dataTransfer.types).includes(
                            MANAGED_EXECUTION_DRAG_TYPE
                          ))
                      ) {
                        event.preventDefault();
                        setDropTargetProjectId(project.id);
                      }
                    }}
                    onDragLeave={(event) => {
                      if (
                        !event.currentTarget.contains(
                          event.relatedTarget as Node
                        )
                      ) {
                        if (dropTargetProjectId === project.id)
                          setDropTargetProjectId(null);
                      }
                    }}
                    onDrop={(event) => void acceptSourceDrop(event, project.id)}
                    aria-expanded={projectExpanded}
                    title={project.name}
                    onClick={() => {
                      setExpandedProjectIds((current) => {
                        const next = new Set(current);
                        if (next.has(project.id)) next.delete(project.id);
                        else next.add(project.id);
                        return next;
                      });
                      if (!projectExpanded) {
                        onProjectSelect?.(project.id);
                        if (
                          sources.length < PROJECT_CONVERSATION_PAGE_SIZE &&
                          nextCursor
                        ) {
                          void loadMoreProjectConversations(project.id, 0);
                        }
                      }
                    }}
                    className={`flex min-w-0 flex-1 items-center rounded-md px-2 py-1.5 text-left text-sm text-muted hover:bg-surface-hover/50 hover:text-foreground-secondary ${dropTargetProjectId === project.id ? "bg-surface-hover ring-1 ring-accent" : ""}`}
                  >
                    {projectExpanded ? (
                      <ChevronDown className="mr-1 h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <ChevronRight className="mr-1 h-3.5 w-3.5 shrink-0" />
                    )}
                    <Folder className="mr-2 h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{project.name}</span>
                  </button>
                  {onRemovePersonalItem ? (
                    <PersonalRemovalControl
                      kind="project"
                      name={project.name}
                      onRemove={() =>
                        onRemovePersonalItem({
                          kind: "project",
                          projectId: project.id
                        })
                      }
                    />
                  ) : null}
                </div>
                {projectExpanded && (
                  <div className="ml-3 border-l border-border pl-2">
                    {managedSources.map((conversation) => (
                      <ManagedExecutionRow
                        key={conversation.id}
                        conversation={conversation}
                        selected={conversation.id === selectedExecutionId}
                        onSelect={() =>
                          onSelectManagedExecution?.(conversation.id)
                        }
                        canShare={
                          canShareManagedExecution?.(conversation.id) ?? false
                        }
                        onShare={() =>
                          onShareManagedExecution?.(conversation.id)
                        }
                        onRemove={
                          onRemovePersonalItem
                            ? () =>
                                onRemovePersonalItem({
                                  ...managedConversationRemovalTarget({
                                    executionId: conversation.id,
                                    providerSourceIds:
                                      managedProviderSourceIds[conversation.id]
                                  })
                                })
                            : undefined
                        }
                      />
                    ))}
                    {visibleCatalogSources.length === 0 &&
                    managedSources.length === 0 ? (
                      <p className="px-2 py-1.5 text-xs text-subtle">
                        {nextCursor
                          ? "No local conversations loaded for this project yet."
                          : "No local conversations found in this project."}
                      </p>
                    ) : (
                      visibleSources.map((item) => (
                        <SourceRow
                          key={item.sourceId}
                          item={item}
                          pending={pendingSourceId === item.sourceId}
                          disabled={pendingSourceId !== null}
                          unavailableMessage={
                            selectedUnavailable?.source.sourceId ===
                            item.sourceId
                              ? selectedUnavailable.message
                              : undefined
                          }
                          onSelect={() => void selectSource(item)}
                          canShare={
                            canShareSource?.(item.sourceId, item.provider) ??
                            false
                          }
                          onShare={() =>
                            onShareSource?.(item.sourceId, item.provider)
                          }
                          onRemove={
                            onRemovePersonalItem
                              ? () =>
                                  onRemovePersonalItem({
                                    kind: "conversation",
                                    sourceId: item.sourceId
                                  })
                              : undefined
                          }
                          onDragStart={(event) => {
                            if (item.provider !== "codex") return;
                            event.dataTransfer.setData(
                              LOCAL_SOURCE_DRAG_TYPE,
                              JSON.stringify({
                                sourceId: item.sourceId,
                                provider: item.provider
                              })
                            );
                            event.dataTransfer.effectAllowed = "move";
                          }}
                        />
                      ))
                    )}
                    {canLoadMoreProjectSources ? (
                      <button
                        type="button"
                        disabled={loadingMore}
                        onClick={() =>
                          void loadMoreProjectConversations(
                            project.id,
                            visibleCount
                          )
                        }
                        className="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted hover:bg-surface-hover/50 hover:text-foreground disabled:opacity-60"
                      >
                        {loadingMore
                          ? "Loading…"
                          : loadMoreError
                            ? "Retry loading more"
                            : "Load more conversations"}
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-2 flex items-center justify-between px-2 py-1.5">
        <button
          type="button"
          onClick={() => setExpandedChats((value) => !value)}
          className="flex items-center font-medium text-foreground-secondary hover:text-foreground"
        >
          Conversations{" "}
          {expandedChats ? (
            <ChevronDown className="ml-1 h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="ml-1 h-3.5 w-3.5" />
          )}
        </button>
        <button
          type="button"
          aria-label="Refresh local conversations"
          title="Refresh local conversations"
          disabled={loading}
          onClick={() => void fetchPage()}
          className="rounded-md p-1 text-muted hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
        >
          <RotateCw
            className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
        </button>
      </div>
      {expandedChats && (
        <div>
          {error ? (
            <div role="status" className="px-2 py-2 text-xs text-subtle">
              <p>{error}</p>
              <button
                type="button"
                onClick={() => void fetchPage()}
                className="mt-2 inline-flex items-center gap-1 text-foreground-secondary hover:text-foreground"
              >
                <RotateCw className="h-3 w-3" /> Retry
              </button>
            </div>
          ) : null}
          {loading && items.length === 0 && !error ? (
            <p className="px-2 py-2 text-xs text-subtle">
              Checking local conversations…
            </p>
          ) : null}
          {!loading &&
          personalRemovalsReady &&
          !error &&
          standaloneItems.length === 0 ? (
            standaloneManaged.length === 0 ? (
              <p className="px-2 py-2 text-xs text-subtle">
                No projectless local conversations found.
              </p>
            ) : null
          ) : null}
          {moveDropMessage ? (
            <p role="status" className="px-2 py-1 text-xs text-subtle">
              {moveDropMessage}
            </p>
          ) : null}
          {standaloneManaged.map((conversation) => (
            <ManagedExecutionRow
              key={conversation.id}
              conversation={conversation}
              selected={conversation.id === selectedExecutionId}
              onSelect={() => onSelectManagedExecution?.(conversation.id)}
              canShare={canShareManagedExecution?.(conversation.id) ?? false}
              onShare={() => onShareManagedExecution?.(conversation.id)}
              onRemove={
                onRemovePersonalItem
                  ? () =>
                      onRemovePersonalItem({
                        ...managedConversationRemovalTarget({
                          executionId: conversation.id,
                          providerSourceIds:
                            managedProviderSourceIds[conversation.id]
                        })
                      })
                  : undefined
              }
            />
          ))}
          {standaloneItems.map((item) => (
            <SourceRow
              key={item.sourceId}
              item={item}
              pending={pendingSourceId === item.sourceId}
              disabled={pendingSourceId !== null}
              unavailableMessage={
                selectedUnavailable?.source.sourceId === item.sourceId
                  ? selectedUnavailable.message
                  : undefined
              }
              onSelect={() => void selectSource(item)}
              canShare={canShareSource?.(item.sourceId, item.provider) ?? false}
              onShare={() => onShareSource?.(item.sourceId, item.provider)}
              onRemove={
                onRemovePersonalItem
                  ? () =>
                      onRemovePersonalItem({
                        kind: "conversation",
                        sourceId: item.sourceId
                      })
                  : undefined
              }
              onDragStart={(event) => {
                if (item.provider !== "codex") return;
                event.dataTransfer.setData(
                  LOCAL_SOURCE_DRAG_TYPE,
                  JSON.stringify({
                    sourceId: item.sourceId,
                    provider: item.provider
                  })
                );
                event.dataTransfer.effectAllowed = "move";
              }}
            />
          ))}
          {hasProviderProblem ? (
            <p className="px-2 py-2 text-[11px] text-subtle">
              Some AI Client sources are unavailable or only partly scanned.
              Available results are shown.
            </p>
          ) : null}
        </div>
      )}
      {truncated ? (
        <p className="px-2 py-1 text-[11px] text-subtle">
          Discovery reached its scan limit. Some sources may be missing.
        </p>
      ) : null}
      {loadMoreError ? (
        <p role="status" className="px-2 pt-1 text-xs text-subtle">
          {loadMoreError}
        </p>
      ) : null}
      {nextCursor ? (
        <button
          type="button"
          disabled={loadingMore}
          onClick={() => void loadMoreCatalog()}
          className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-xs text-muted hover:bg-surface-hover/50 hover:text-foreground disabled:opacity-60"
        >
          {loadingMore
            ? "Loading…"
            : loadMoreError
              ? "Retry loading more"
              : "Load more"}
        </button>
      ) : null}
    </div>
  );
}
