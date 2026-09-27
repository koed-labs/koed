"use client";

import {
  AlertCircle,
  Code,
  ChevronDown,
  ExternalLink,
  Filter,
  GitBranch,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  MessageSquare,
  Search,
  Send,
  Users,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  personalAgentsHttpAdapter,
  type PersonalAgent
} from "@/lib/personal-agents-client";
import type { AgentModelCapability } from "@/lib/agentIdentityEditor";
import type { ChatMentionAgent } from "../ChatComposer";
import {
  PRChatPanel,
  type PRChatAdapter,
  type PRChatMessage,
  type PRChatScope
} from "./PRChatPanel";
import { PRMarkdown } from "./PRMarkdown";
import { StudioSidebar } from "./StudioSidebar";
import { RepositoryPicker } from "./RepositoryPicker";
import {
  boundPullRequestListWidth,
  matchesPullRequestFilter,
  MAX_LIST_WIDTH,
  MIN_LIST_WIDTH,
  type PullRequestFilter
} from "./PullRequestsView.helpers";
import {
  getSessionStorage,
  readRepositoryPreference,
  repositoryPreferenceKey,
  writeRepositoryPreference
} from "./PullRequestsView.storage";
export {
  boundPullRequestListWidth,
  matchesPullRequestFilter
} from "./PullRequestsView.helpers";

type PullRequestsMode = "live" | "demo";
type PullRequestTab = "all" | "reviewing" | "authored";

const LIST_WIDTH_STEP = 24;
const DEFAULT_PR_MODEL: AgentModelCapability = {
  provider: "codex",
  id: "gpt-5.6-luna",
  displayName: "GPT-5.6 Luna",
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh"]
};
const PULL_REQUEST_FILTERS: Array<{ id: PullRequestFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "draft", label: "Draft" },
  { id: "merged", label: "Merged" },
  { id: "closed", label: "Closed" }
];

type GitHubStatus = {
  state: "disconnected" | "connected" | "error";
  login: string | null;
  message: string | null;
  capabilities: { readPullRequests: boolean; publishReviews: false };
};

type Repository = { id: string; fullName: string; private: boolean };

type PullRequest = {
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  merged?: boolean;
  author: string;
  requestedReviewers: string[];
  headSha: string;
  baseSha: string;
  headBranch: string;
  baseBranch: string;
  updatedAt: string;
  url: string;
  body?: string;
  bodyTruncated?: boolean;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
};

const DEMO_REPOSITORIES: Repository[] = [
  { id: "demo-koed-studio", fullName: "koed/studio", private: false },
  { id: "demo-koed-server", fullName: "koed/server", private: true }
];

const DEMO_PULL_REQUESTS: Record<string, PullRequest[]> = {
  "koed/studio": [
    {
      number: 42,
      title: "Add the personal workspace navigation",
      state: "open",
      draft: false,
      author: "alex",
      requestedReviewers: ["demo-operator"],
      headSha: "a3e84c1",
      baseSha: "9f4d5ab",
      headBranch: "feat/personal-nav",
      baseBranch: "main",
      updatedAt: "2026-09-21T12:20:00.000Z",
      url: "https://github.com/koed/studio/pull/42",
      body: "This keeps the personal workspace focused on the next useful action.\n\nThe navigation is intentionally read-only in the demo.",
      additions: 186,
      deletions: 24,
      changedFiles: 8
    },
    {
      number: 39,
      title: "Tighten the local connector error states",
      state: "closed",
      draft: false,
      merged: true,
      author: "demo-operator",
      requestedReviewers: ["alex"],
      headSha: "d12a0ff",
      baseSha: "1be904a",
      headBranch: "fix/connector-errors",
      baseBranch: "main",
      updatedAt: "2026-09-15T09:10:00.000Z",
      url: "https://github.com/koed/studio/pull/39",
      body: "Make connector failures explicit without exposing credentials.",
      additions: 74,
      deletions: 19,
      changedFiles: 4
    }
  ],
  "koed/server": [
    {
      number: 17,
      title: "Expose bounded GitHub repository reads",
      state: "open",
      draft: true,
      author: "maya",
      requestedReviewers: ["alex"],
      headSha: "4d2a991",
      baseSha: "0c0ff12",
      headBranch: "feat/github-reads",
      baseBranch: "main",
      updatedAt: "2026-09-20T16:35:00.000Z",
      url: "https://github.com/koed/server/pull/17",
      body: "The Studio integration consumes these endpoints with GET-only access.",
      additions: 112,
      deletions: 8,
      changedFiles: 5
    }
  ]
};

const DEMO_STATUS: GitHubStatus = {
  state: "connected",
  login: "demo-operator",
  message: null,
  capabilities: { readPullRequests: true, publishReviews: false }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asAuthor(value: unknown) {
  if (typeof value === "string") return value;
  return isRecord(value)
    ? asString(value.login, asString(value.name))
    : "unknown";
}

function asReviewers(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map(asAuthor).filter(Boolean);
}

function parseStatus(value: unknown): GitHubStatus | null {
  if (!isRecord(value)) return null;
  const capabilities = value.capabilities;
  if (!isRecord(capabilities)) return null;
  if (
    !["disconnected", "connected", "error"].includes(asString(value.state)) ||
    (value.login !== null && typeof value.login !== "string") ||
    typeof capabilities.readPullRequests !== "boolean"
  ) {
    return null;
  }
  return {
    state: value.state as GitHubStatus["state"],
    login: value.login as string | null,
    message: typeof value.message === "string" ? value.message : null,
    capabilities: {
      readPullRequests: capabilities.readPullRequests,
      publishReviews: false
    }
  };
}

function parseRepository(value: unknown): Repository | null {
  if (!isRecord(value)) return null;
  const id =
    typeof value.id === "number" ? String(value.id) : asString(value.id);
  const fullName = asString(value.fullName);
  return id && fullName && typeof value.private === "boolean"
    ? { id, fullName, private: value.private }
    : null;
}

function parsePullRequest(value: unknown): PullRequest | null {
  if (!isRecord(value) || typeof value.number !== "number") return null;
  const state =
    value.state === "closed"
      ? "closed"
      : value.state === "open"
        ? "open"
        : null;
  if (!state) return null;
  const request: PullRequest = {
    number: value.number,
    title: asString(value.title, "Untitled pull request"),
    state,
    draft: value.draft === true,
    merged: value.merged === true,
    author: asAuthor(value.author),
    requestedReviewers: asReviewers(value.requestedReviewers),
    headSha: asString(value.headSha),
    baseSha: asString(value.baseSha),
    headBranch: asString(value.headBranch),
    baseBranch: asString(value.baseBranch),
    updatedAt: asString(value.updatedAt),
    url: asString(value.url)
  };
  if (typeof value.body === "string") request.body = value.body;
  if (value.bodyTruncated === true) request.bodyTruncated = true;
  for (const key of ["additions", "deletions", "changedFiles"] as const) {
    if (typeof value[key] === "number") request[key] = value[key];
  }
  return request;
}

function sanitizeMessage(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim()
    ? value.replace(/[\r\n]+/g, " ").slice(0, 240)
    : fallback;
}

function mergePullRequests(current: PullRequest[], next: PullRequest[]) {
  const merged = new Map(current.map((item) => [item.number, item]));
  for (const item of next) merged.set(item.number, item);
  return [...merged.values()];
}

function isAccessInvalidation(status: number | undefined) {
  return status === 401 || status === 403 || status === 409;
}

function formatUpdatedAt(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value || "Unknown update";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    timestamp
  );
}

function safeGitHubUrl(value: string) {
  try {
    const url = new URL(value);
    if (
      url.origin !== "https://github.com" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

async function readJson(response: Response) {
  return response.json().catch(() => null) as Promise<unknown>;
}

function PullRequestRow({
  pullRequest,
  selected,
  onClick
}: {
  pullRequest: PullRequest;
  selected: boolean;
  onClick: () => void;
}) {
  const closed = pullRequest.state === "closed";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors ${selected ? "border-accent/30 bg-accent/10" : "border-transparent hover:bg-surface/50"}`}
    >
      <span className="relative mt-1 shrink-0">
        {pullRequest.merged ? (
          <GitMerge className="h-5 w-5 text-merged" />
        ) : (
          <GitPullRequest
            className={`h-5 w-5 ${closed ? "text-danger" : "text-success"}`}
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`flex items-start justify-between gap-3 text-sm font-medium ${selected ? "text-accent" : "text-foreground-secondary group-hover:text-accent"}`}
        >
          <span className="truncate">{pullRequest.title}</span>
          <span className="shrink-0 text-xs font-normal text-subtle">
            #{pullRequest.number}
          </span>
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-subtle">
          <span>{pullRequest.author}</span>
          <span>·</span>
          <span>{formatUpdatedAt(pullRequest.updatedAt)}</span>
          {pullRequest.draft && (
            <span className="rounded border border-border px-1.5 py-0.5">
              Draft
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

function PullRequestDetail({
  pullRequest,
  onClose,
  chatOpen,
  onSummary,
  onChat,
  chatAvailable,
  chatScope,
  chatMessages,
  chatDraft,
  onChatDraftChange,
  onChatMessagesChange,
  chatAdapter,
  chatAgents,
  chatModelOptions,
  chatInitialModel,
  chatInitialEffort,
  demo,
  chatAvailabilityMessage
}: {
  pullRequest: PullRequest;
  onClose: () => void;
  chatOpen: boolean;
  onSummary: () => void;
  onChat: () => void;
  chatAvailable: boolean;
  chatScope: PRChatScope | null;
  chatMessages: PRChatMessage[];
  chatDraft: string;
  onChatDraftChange: (value: string) => void;
  onChatMessagesChange: React.Dispatch<React.SetStateAction<PRChatMessage[]>>;
  chatAdapter?: PRChatAdapter | null;
  chatAgents: readonly ChatMentionAgent[];
  chatModelOptions: readonly AgentModelCapability[];
  chatInitialModel: string;
  chatInitialEffort: string;
  demo: boolean;
  chatAvailabilityMessage: string | null;
}) {
  const link = safeGitHubUrl(pullRequest.url);
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-background/90 px-6 py-4 backdrop-blur-sm">
        <div className="flex items-center gap-1 rounded-md bg-surface p-1">
          <button
            type="button"
            onClick={onSummary}
            className={`rounded px-3 py-1 text-xs font-medium ${chatOpen ? "text-muted hover:bg-surface-hover hover:text-foreground-secondary" : "bg-surface-hover text-foreground-secondary"}`}
          >
            Summary
          </button>
          <button
            type="button"
            disabled
            title="Code view is unavailable in the read-only integration"
            className="inline-flex items-center gap-1 rounded px-3 py-1 text-xs font-medium text-faint"
          >
            <Code className="h-3.5 w-3.5" /> Code
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted hover:bg-surface-hover hover:text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Open on GitHub
            </a>
          )}
          <button
            type="button"
            disabled={!chatAvailable}
            title={
              chatAvailable
                ? "Open PR chat"
                : (chatAvailabilityMessage ?? "PR chat is unavailable")
            }
            onClick={onChat}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${chatOpen ? "bg-chip text-chip-foreground" : chatAvailable ? "bg-surface-hover text-foreground hover:bg-surface-active" : "bg-surface-hover text-faint"}`}
          >
            <MessageSquare className="h-3.5 w-3.5" /> Chat
          </button>
          <button
            type="button"
            disabled
            title="Review submission is unavailable in the read-only integration"
            className="inline-flex items-center gap-1.5 rounded-md bg-surface-hover px-3 py-1.5 text-xs font-medium text-faint"
          >
            <Send className="h-3.5 w-3.5" /> Submit review
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close pull request"
            title="Close pull request"
            className="rounded-md p-1.5 text-subtle hover:bg-surface-hover hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>
      {chatOpen && chatScope ? (
        <PRChatPanel
          key={`${chatScope.repositoryId}:${chatScope.pullRequestNumber}:${chatScope.headSha}:${chatScope.accountId}`}
          pullRequest={{
            number: pullRequest.number,
            title: pullRequest.title,
            repositoryFullName: chatScope.repositoryFullName,
            baseBranch: pullRequest.baseBranch,
            headBranch: pullRequest.headBranch
          }}
          scope={chatScope}
          messages={chatMessages}
          draft={chatDraft}
          onDraftChange={onChatDraftChange}
          onMessagesChange={onChatMessagesChange}
          adapter={chatAdapter}
          agents={chatAgents}
          modelOptions={chatModelOptions}
          initialModel={chatInitialModel}
          initialEffort={chatInitialEffort}
          demo={demo}
          availabilityMessage={chatAvailabilityMessage}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <h1 className="text-2xl font-semibold leading-tight text-foreground">
            {pullRequest.title}
          </h1>
          <p className="mt-3 text-sm text-muted">
            {pullRequest.author} · updated{" "}
            {formatUpdatedAt(pullRequest.updatedAt)} · #{pullRequest.number}
          </p>
          <div className="mt-8 grid grid-cols-[110px_1fr] gap-y-4 text-sm">
            <div className="flex items-center gap-2 text-subtle">
              <GitBranch className="h-4 w-4" /> Branch
            </div>
            <div className="flex flex-wrap items-center gap-2 text-foreground-secondary">
              <span>{pullRequest.baseBranch || "—"}</span>
              <span className="text-faint">›</span>
              <span>{pullRequest.headBranch || "—"}</span>
              {typeof pullRequest.additions === "number" && (
                <span className="ml-2 text-success">
                  +{pullRequest.additions}
                </span>
              )}
              {typeof pullRequest.deletions === "number" && (
                <span className="text-danger">-{pullRequest.deletions}</span>
              )}
            </div>
            <div className="flex items-center gap-2 text-subtle">
              <Users className="h-4 w-4" /> Reviewers
            </div>
            <div className="text-foreground-secondary">
              {pullRequest.requestedReviewers.length
                ? pullRequest.requestedReviewers.join(", ")
                : "No reviewers requested"}
            </div>
            <div className="flex items-center gap-2 text-subtle">
              <GitPullRequest className="h-4 w-4" /> Status
            </div>
            <div className="text-foreground-secondary">
              {pullRequest.merged
                ? "Merged"
                : pullRequest.draft
                  ? "Draft"
                  : pullRequest.state === "open"
                    ? "Open"
                    : "Closed"}
            </div>
            {typeof pullRequest.changedFiles === "number" && (
              <>
                <div className="text-subtle">Files changed</div>
                <div className="text-foreground-secondary">
                  {pullRequest.changedFiles}
                </div>
              </>
            )}
          </div>
          <div className="mt-10 border-t border-border/60 pt-6">
            <h2 className="flex items-center gap-2 font-medium text-foreground-secondary">
              Description <ChevronDown className="h-4 w-4 text-subtle" />
            </h2>
            <div className="mt-4 min-w-0">
              <PRMarkdown
                source={pullRequest.body || "No description provided."}
              />
            </div>
            {pullRequest.bodyTruncated && (
              <p className="mt-3 text-xs text-warning">
                Only the first 32 KiB of this description is available.
              </p>
            )}
          </div>
          <div className="mt-8 border-t border-border/60 pt-5 text-xs text-subtle">
            Review submission and code review remain unavailable in this
            read-only GitHub integration.
          </div>
        </div>
      )}
    </section>
  );
}

export function PullRequestsView({
  mode,
  onHome,
  onNewChat,
  onPlugins,
  onUseRealGitHub,
  chatAdapter
}: {
  mode: PullRequestsMode;
  onHome: () => void;
  onNewChat: () => void;
  onPlugins: () => void;
  onUseRealGitHub?: () => void;
  chatAdapter?: PRChatAdapter | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [chatAgents, setChatAgents] = useState<ChatMentionAgent[]>([]);
  const [chatModelOptions, setChatModelOptions] = useState<
    AgentModelCapability[]
  >([DEFAULT_PR_MODEL]);
  const [status, setStatus] = useState<GitHubStatus | null>(
    mode === "demo" ? DEMO_STATUS : null
  );
  const [repositories, setRepositories] = useState<Repository[]>(
    mode === "demo" ? DEMO_REPOSITORIES : []
  );
  const [repository, setRepository] = useState<Repository | null>(
    mode === "demo" ? DEMO_REPOSITORIES[0] : null
  );
  const [pullRequests, setPullRequests] = useState<PullRequest[]>(
    mode === "demo" ? DEMO_PULL_REQUESTS[DEMO_REPOSITORIES[0].fullName] : []
  );
  const [pullRequestsMore, setPullRequestsMore] = useState(false);
  const [pullRequestPage, setPullRequestPage] = useState(1);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<PullRequest | null>(
    null
  );
  const [detailView, setDetailView] = useState<"summary" | "chat">("summary");
  const [chatMessagesByScope, setChatMessagesByScope] = useState<
    Record<string, PRChatMessage[]>
  >({});
  const [chatDraftsByScope, setChatDraftsByScope] = useState<
    Record<string, string>
  >({});
  const [tab, setTab] = useState<PullRequestTab>("all");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<PullRequestFilter>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [listWidth, setListWidth] = useState(420);
  const [isResizing, setIsResizing] = useState(false);
  const [loading, setLoading] = useState(mode === "live");
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [demoPreferenceResolved, setDemoPreferenceResolved] = useState(false);
  const sequenceRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (mode === "demo") return;
    const controller = new AbortController();
    Promise.all([
      personalAgentsHttpAdapter.list(controller.signal),
      personalAgentsHttpAdapter.capabilities(controller.signal)
    ])
      .then(([agents, capabilities]) => {
        if (controller.signal.aborted) return;
        setChatAgents(
          agents
            .filter((agent: PersonalAgent) => agent.lifecycle === "active")
            .map((agent) => ({
              id: agent.id,
              currentVersion: agent.currentVersion,
              name: agent.name,
              role: agent.role,
              avatar: agent.avatar
                ? { image: agent.avatar.image, spec: agent.avatar.spec }
                : undefined,
              lifecycle: agent.lifecycle,
              defaultProvider: agent.defaultProvider,
              defaultModel: agent.defaultModel,
              defaultReasoningEffort: agent.defaultReasoningEffort
            }))
        );
        const codexCapabilities = capabilities.filter(
          (capability) => capability.provider === "codex"
        );
        setChatModelOptions(
          codexCapabilities.length ? codexCapabilities : [DEFAULT_PR_MODEL]
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setChatAgents([]);
          setChatModelOptions([DEFAULT_PR_MODEL]);
        }
      });
    return () => controller.abort();
  }, [mode]);
  const statusRef = useRef<GitHubStatus | null>(status);
  const loadedRepositoryRef = useRef<string | null>(null);
  const detailSequenceRef = useRef(0);
  const detailControllerRef = useRef<AbortController | null>(null);
  const repositoryPaginationControllerRef = useRef<AbortController | null>(
    null
  );
  const repositoryPaginationRunRef = useRef(0);
  const repositorySelectionIntentRef = useRef(false);
  const demoPreferenceAppliedRef = useRef(false);
  const detailLayoutRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);

  const resetChatState = useCallback(() => {
    setDetailView("summary");
    setChatMessagesByScope({});
    setChatDraftsByScope({});
  }, []);

  const clearAccessData = useCallback(() => {
    sequenceRef.current += 1;
    detailSequenceRef.current += 1;
    controllerRef.current?.abort();
    detailControllerRef.current?.abort();
    repositoryPaginationRunRef.current += 1;
    repositoryPaginationControllerRef.current?.abort();
    statusRef.current = null;
    loadedRepositoryRef.current = null;
    setStatus(null);
    setRepositories([]);
    setRepository(null);
    setPullRequests([]);
    setSelectedNumber(null);
    setSelectedDetail(null);
    resetChatState();
    setPullRequestsMore(false);
    setStale(false);
    setLoading(false);
    setLoadingMore(false);
    repositorySelectionIntentRef.current = false;
    demoPreferenceAppliedRef.current = false;
    setDemoPreferenceResolved(false);
  }, [resetChatState]);

  const run = useCallback(
    async <T,>(url: string, signal: AbortSignal): Promise<T> => {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal
      });
      const payload = await readJson(response);
      if (
        !response.ok ||
        (isRecord(payload) && typeof payload.error === "string")
      ) {
        const error = new Error(
          sanitizeMessage(
            isRecord(payload) ? payload.error : null,
            "GitHub data is unavailable."
          )
        ) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }
      return payload as T;
    },
    []
  );

  const cancelRepositoryPagination = useCallback(() => {
    repositoryPaginationRunRef.current += 1;
    repositoryPaginationControllerRef.current?.abort();
    repositoryPaginationControllerRef.current = null;
  }, []);

  const startRepositoryPagination = useCallback(
    (
      startPage: number,
      hasMore: boolean,
      initialRepositories: Repository[],
      preferredFullName: string | null
    ) => {
      if (mode === "demo" || !hasMore) return;
      cancelRepositoryPagination();
      const runId = repositoryPaginationRunRef.current;
      const controller = new AbortController();
      repositoryPaginationControllerRef.current = controller;
      void (async () => {
        let page = startPage;
        let more: boolean = hasMore;
        let pagesLoaded = 0;
        let knownRepositories = initialRepositories;
        let preferredFound = knownRepositories.some(
          (item) => item.fullName === preferredFullName
        );
        try {
          while (more && pagesLoaded < 8) {
            const payload = await run<unknown>(
              `/studio-api/github/repositories?page=${page}`,
              controller.signal
            );
            if (
              runId !== repositoryPaginationRunRef.current ||
              controller.signal.aborted
            )
              return;
            const next =
              isRecord(payload) && Array.isArray(payload.repositories)
                ? payload.repositories
                    .map(parseRepository)
                    .filter((value): value is Repository => Boolean(value))
                : [];
            const merged = new Map(
              knownRepositories.map((item) => [item.id, item])
            );
            for (const item of next) merged.set(item.id, item);
            knownRepositories = [...merged.values()];
            setRepositories(knownRepositories);
            if (!preferredFound && preferredFullName) {
              const preferred = knownRepositories.find(
                (item) => item.fullName === preferredFullName
              );
              if (preferred && !repositorySelectionIntentRef.current) {
                preferredFound = true;
                setRepository(preferred);
              }
            }
            more = isRecord(payload) && payload.hasMore === true;
            page += 1;
            pagesLoaded += 1;
          }
          if (
            runId === repositoryPaginationRunRef.current &&
            !repositorySelectionIntentRef.current &&
            !preferredFound
          ) {
            setRepository((current) => current ?? knownRepositories[0] ?? null);
          }
        } catch (reason) {
          if (
            runId !== repositoryPaginationRunRef.current ||
            controller.signal.aborted ||
            (reason as { name?: string })?.name === "AbortError"
          )
            return;
          const statusCode = (reason as { status?: number }).status;
          if (isAccessInvalidation(statusCode)) {
            clearAccessData();
          } else {
            setStale(true);
            setError(
              sanitizeMessage(
                reason instanceof Error ? reason.message : null,
                "More repositories are unavailable."
              )
            );
          }
        } finally {
          if (repositoryPaginationControllerRef.current === controller) {
            repositoryPaginationControllerRef.current = null;
          }
        }
      })();
    },
    [cancelRepositoryPagination, clearAccessData, mode, run]
  );

  const loadStatusAndRepositories = useCallback(async () => {
    if (mode === "demo") return;
    cancelRepositoryPagination();
    const sequence = ++sequenceRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    try {
      const payload = await run<unknown>(
        "/studio-api/github/status",
        controller.signal
      );
      const nextStatus = parseStatus(payload);
      if (!nextStatus)
        throw new Error("GitHub connection status is unavailable.");
      if (sequence !== sequenceRef.current) return;
      const previousStatus = statusRef.current;
      const identityChanged = previousStatus?.login !== nextStatus.login;
      const accessLost =
        nextStatus.state !== "connected" ||
        !nextStatus.capabilities.readPullRequests;
      if (identityChanged || accessLost) {
        repositorySelectionIntentRef.current = false;
        setRepositories([]);
        setRepository(null);
        setPullRequests([]);
        setSelectedNumber(null);
        setSelectedDetail(null);
        resetChatState();
        loadedRepositoryRef.current = null;
      }
      statusRef.current = nextStatus;
      setStatus(nextStatus);
      if (accessLost) {
        setLoading(false);
        return;
      }
      const repositoriesPayload = await run<unknown>(
        "/studio-api/github/repositories?page=1",
        controller.signal
      );
      if (sequence !== sequenceRef.current) return;
      const nextRepositories =
        isRecord(repositoriesPayload) &&
        Array.isArray(repositoriesPayload.repositories)
          ? repositoriesPayload.repositories
              .map(parseRepository)
              .filter((value): value is Repository => Boolean(value))
          : [];
      const savedPreference = readRepositoryPreference(
        getSessionStorage(),
        repositoryPreferenceKey("live", nextStatus.login ?? "unknown")
      );
      const preferredRepository = savedPreference
        ? nextRepositories.find(
            (item) => item.fullName === savedPreference.fullName
          )
        : null;
      const repositoriesHaveMore =
        isRecord(repositoriesPayload) && repositoriesPayload.hasMore === true;
      setStale(false);
      setRepositories(nextRepositories);
      setRepository((current) => {
        if (repositorySelectionIntentRef.current) return current;
        if (preferredRepository) return preferredRepository;
        if (savedPreference && repositoriesHaveMore) return null;
        return (
          nextRepositories.find(
            (item) => item.fullName === current?.fullName
          ) ??
          nextRepositories[0] ??
          null
        );
      });
      startRepositoryPagination(
        2,
        repositoriesHaveMore,
        nextRepositories,
        savedPreference?.fullName ?? null
      );
    } catch (reason) {
      if (
        sequence !== sequenceRef.current ||
        (reason as { name?: string })?.name === "AbortError"
      )
        return;
      const statusCode = (reason as { status?: number }).status;
      if (isAccessInvalidation(statusCode)) clearAccessData();
      else setStale(true);
      setError(
        sanitizeMessage(
          reason instanceof Error ? reason.message : null,
          "GitHub pull requests are unavailable."
        )
      );
    } finally {
      if (sequence === sequenceRef.current) {
        setLoading(false);
        controllerRef.current = null;
      }
    }
  }, [
    cancelRepositoryPagination,
    clearAccessData,
    mode,
    resetChatState,
    run,
    startRepositoryPagination
  ]);

  // The effect owns the lifetime of the live gateway request.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadStatusAndRepositories();
    return () => {
      sequenceRef.current += 1;
      controllerRef.current?.abort();
      cancelRepositoryPagination();
    };
  }, [cancelRepositoryPagination, loadStatusAndRepositories]);

  useEffect(() => {
    if (
      mode !== "demo" ||
      demoPreferenceAppliedRef.current ||
      repositories.length === 0
    )
      return;
    demoPreferenceAppliedRef.current = true;
    setDemoPreferenceResolved(true);
    if (repositorySelectionIntentRef.current) return;
    const savedPreference = readRepositoryPreference(
      getSessionStorage(),
      repositoryPreferenceKey("demo", DEMO_STATUS.login ?? "unknown")
    );
    const preferredRepository = savedPreference
      ? repositories.find((item) => item.fullName === savedPreference.fullName)
      : null;
    if (preferredRepository) {
      // Apply the validated session preference after the demo list mounts.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRepository(preferredRepository);
    }
  }, [mode, repositories]);

  useEffect(() => {
    if (!repository || !status?.login) return;
    if (mode === "demo" && !demoPreferenceResolved) return;
    if (status.state !== "connected" || !status.capabilities.readPullRequests)
      return;
    writeRepositoryPreference(
      getSessionStorage(),
      repositoryPreferenceKey(mode, status.login),
      { id: repository.id, fullName: repository.fullName }
    );
  }, [demoPreferenceResolved, mode, repository, status]);

  const loadPullRequests = useCallback(
    async (nextRepository: Repository | null) => {
      if (!nextRepository) {
        sequenceRef.current += 1;
        controllerRef.current?.abort();
        setPullRequests([]);
        setPullRequestsMore(false);
        setSelectedNumber(null);
        setSelectedDetail(null);
        setLoading(false);
        setLoadingMore(false);
        return;
      }
      if (mode === "demo") {
        setPullRequests(DEMO_PULL_REQUESTS[nextRepository.fullName] ?? []);
        setPullRequestPage(1);
        setPullRequestsMore(false);
        return;
      }
      const sequence = ++sequenceRef.current;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setLoading(true);
      setLoadingMore(false);
      setError(null);
      setPullRequestPage(1);
      if (loadedRepositoryRef.current !== nextRepository.fullName) {
        setPullRequests([]);
        setSelectedNumber(null);
        setSelectedDetail(null);
      }
      loadedRepositoryRef.current = nextRepository.fullName;
      try {
        const payload = await run<unknown>(
          `/studio-api/github/pulls?repo=${encodeURIComponent(nextRepository.fullName)}&page=1`,
          controller.signal
        );
        if (sequence !== sequenceRef.current) return;
        const nextPulls =
          isRecord(payload) && Array.isArray(payload.pullRequests)
            ? payload.pullRequests
                .map(parsePullRequest)
                .filter((value): value is PullRequest => Boolean(value))
            : [];
        setStale(false);
        setPullRequests(nextPulls);
        setPullRequestsMore(isRecord(payload) && payload.hasMore === true);
      } catch (reason) {
        if (
          sequence !== sequenceRef.current ||
          (reason as { name?: string })?.name === "AbortError"
        )
          return;
        const statusCode = (reason as { status?: number }).status;
        if (isAccessInvalidation(statusCode)) clearAccessData();
        else setStale(true);
        setError(
          sanitizeMessage(
            reason instanceof Error ? reason.message : null,
            "Pull requests are unavailable."
          )
        );
      } finally {
        if (sequence === sequenceRef.current) {
          setLoading(false);
          controllerRef.current = null;
        }
      }
    },
    [clearAccessData, mode, run]
  );

  // Repository changes are synchronized with the live gateway.
  useEffect(() => {
    if (repository || loadedRepositoryRef.current) {
      void loadPullRequests(repository);
    }
  }, [loadPullRequests, repository]);

  const loadMorePullRequests = async () => {
    if (mode === "demo" || !repository || !pullRequestsMore || loadingMore)
      return;
    const nextPage = pullRequestPage + 1;
    const sequence = ++sequenceRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoadingMore(true);
    try {
      const payload = await run<unknown>(
        `/studio-api/github/pulls?repo=${encodeURIComponent(repository.fullName)}&page=${nextPage}`,
        controller.signal
      );
      if (sequence !== sequenceRef.current) return;
      const next =
        isRecord(payload) && Array.isArray(payload.pullRequests)
          ? payload.pullRequests
              .map(parsePullRequest)
              .filter((value): value is PullRequest => Boolean(value))
          : [];
      setStale(false);
      setPullRequests((current) => mergePullRequests(current, next));
      setPullRequestPage(nextPage);
      setPullRequestsMore(isRecord(payload) && payload.hasMore === true);
    } catch (reason) {
      if (
        sequence === sequenceRef.current &&
        (reason as { name?: string })?.name !== "AbortError"
      ) {
        const statusCode = (reason as { status?: number }).status;
        if (isAccessInvalidation(statusCode)) clearAccessData();
        else setStale(true);
        setError(
          sanitizeMessage(
            reason instanceof Error ? reason.message : null,
            "More pull requests are unavailable."
          )
        );
      }
    } finally {
      if (sequence === sequenceRef.current) setLoadingMore(false);
    }
  };

  useEffect(() => {
    if (selectedNumber === null || !repository) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedDetail(null);
      return;
    }
    const summary = pullRequests.find((item) => item.number === selectedNumber);
    if (mode === "demo") {
      setSelectedDetail(summary ?? null);
      return;
    }
    setSelectedDetail(null);
    const sequence = ++detailSequenceRef.current;
    detailControllerRef.current?.abort();
    const controller = new AbortController();
    detailControllerRef.current = controller;
    void run<unknown>(
      `/studio-api/github/pull?repo=${encodeURIComponent(repository.fullName)}&number=${selectedNumber}`,
      controller.signal
    )
      .then((payload) => {
        if (sequence !== detailSequenceRef.current) return;
        const detail = isRecord(payload)
          ? parsePullRequest(payload.pullRequest)
          : null;
        if (!detail || detail.number !== selectedNumber) {
          throw new Error("Pull request details are unavailable.");
        }
        setSelectedDetail(detail);
      })
      .catch((reason) => {
        if (
          sequence !== detailSequenceRef.current ||
          (reason as { name?: string })?.name === "AbortError"
        )
          return;
        const statusCode = (reason as { status?: number }).status;
        if (isAccessInvalidation(statusCode)) clearAccessData();
        else setStale(true);
        setError(
          sanitizeMessage(
            reason instanceof Error ? reason.message : null,
            "Pull request details are unavailable."
          )
        );
      })
      .finally(() => {
        if (sequence === detailSequenceRef.current)
          detailControllerRef.current = null;
      });
    return () => {
      detailSequenceRef.current += 1;
      controller.abort();
    };
  }, [clearAccessData, mode, pullRequests, repository, run, selectedNumber]);

  const filteredPullRequests = useMemo(() => {
    const login = status?.login?.toLocaleLowerCase("en-US") ?? "";
    const query = search.trim().toLocaleLowerCase("en-US");
    return pullRequests.filter((item) => {
      const authored =
        login !== "" && item.author.toLocaleLowerCase("en-US") === login;
      const reviewing =
        login !== "" &&
        item.requestedReviewers.some(
          (reviewer) => reviewer.toLocaleLowerCase("en-US") === login
        );
      const tabMatches =
        tab === "all" || (tab === "authored" ? authored : reviewing);
      const filterMatches = matchesPullRequestFilter(item, filter);
      return (
        tabMatches &&
        filterMatches &&
        (!query ||
          `${item.title} ${item.author} #${item.number}`
            .toLocaleLowerCase("en-US")
            .includes(query))
      );
    });
  }, [filter, pullRequests, search, status?.login, tab]);

  useEffect(() => {
    if (!filterOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!filterRef.current?.contains(event.target as Node)) {
        setFilterOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFilterOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [filterOpen]);

  const resizeStartRef = useRef<{ pointerX: number; width: number } | null>(
    null
  );
  const listPaneRef = useRef<HTMLDivElement>(null);
  const boundedListWidth = useCallback((value: number) => {
    const availableWidth = detailLayoutRef.current?.clientWidth ?? Infinity;
    return boundPullRequestListWidth(value, availableWidth);
  }, []);
  const onDividerPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeStartRef.current = {
        pointerX: event.clientX,
        width: listPaneRef.current?.getBoundingClientRect().width ?? listWidth
      };
      setIsResizing(true);
    },
    [listWidth]
  );
  const onDividerPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isResizing || !resizeStartRef.current) return;
      setListWidth(
        boundedListWidth(
          resizeStartRef.current.width +
            event.clientX -
            resizeStartRef.current.pointerX
        )
      );
    },
    [boundedListWidth, isResizing]
  );
  const stopDividerResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      resizeStartRef.current = null;
      setIsResizing(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    []
  );
  const onDividerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        setListWidth((current) =>
          boundedListWidth(current + direction * LIST_WIDTH_STEP)
        );
      } else if (event.key === "Home") {
        event.preventDefault();
        setListWidth(boundedListWidth(MIN_LIST_WIDTH));
      } else if (event.key === "End") {
        event.preventDefault();
        setListWidth(boundedListWidth(MAX_LIST_WIDTH));
      }
    },
    [boundedListWidth]
  );

  const chatAccountLogin = status?.login ?? null;
  const chatRepositoryId = repository?.id ?? null;
  const chatRepositoryFullName = repository?.fullName ?? null;
  const chatPullRequestNumber = selectedDetail?.number ?? null;
  const chatHeadSha = selectedDetail?.headSha ?? null;
  const chatBaseSha = selectedDetail?.baseSha ?? null;
  const chatScope = useMemo<PRChatScope | null>(() => {
    if (
      !chatAccountLogin ||
      !chatRepositoryId ||
      !chatRepositoryFullName ||
      chatPullRequestNumber === null ||
      chatHeadSha === null ||
      chatBaseSha === null
    )
      return null;
    return {
      accountId: chatAccountLogin,
      accountLogin: chatAccountLogin,
      repositoryId: chatRepositoryId,
      repositoryFullName: chatRepositoryFullName,
      pullRequestNumber: chatPullRequestNumber,
      headSha: chatHeadSha,
      baseSha: chatBaseSha
    };
  }, [
    chatAccountLogin,
    chatBaseSha,
    chatHeadSha,
    chatPullRequestNumber,
    chatRepositoryFullName,
    chatRepositoryId
  ]);

  const chatAvailabilityMessage = (() => {
    if (mode === "demo") return null;
    if (status?.state === "error") {
      return status.message || "GitHub connection status is unavailable.";
    }
    if (
      status?.state !== "connected" ||
      !status.capabilities.readPullRequests
    ) {
      return "Connect GitHub in Plugins before opening a pull request chat.";
    }
    if (!chatAdapter) {
      return "PR chat is not connected to the Studio runtime yet. Start the Koed chat runtime before sending a message.";
    }
    return null;
  })();

  // Opening Chat is useful even when its runtime prerequisite is missing: the
  // panel explains the exact prerequisite and keeps Send disabled.
  const chatAvailable = Boolean(chatScope);
  const chatScopeKey = chatScope ? JSON.stringify(chatScope) : null;
  const chatMessages = chatScopeKey
    ? (chatMessagesByScope[chatScopeKey] ?? [])
    : [];
  const chatDraft = chatScopeKey ? (chatDraftsByScope[chatScopeKey] ?? "") : "";
  const updateChatDraft = useCallback(
    (value: string) => {
      if (!chatScopeKey) return;
      setChatDraftsByScope((current) => ({
        ...current,
        [chatScopeKey]: value
      }));
    },
    [chatScopeKey]
  );
  const updateChatMessages = useCallback(
    (update: React.SetStateAction<PRChatMessage[]>) => {
      if (!chatScopeKey) return;
      setChatMessagesByScope((current) => {
        const previous = current[chatScopeKey] ?? [];
        const next = typeof update === "function" ? update(previous) : update;
        return { ...current, [chatScopeKey]: next };
      });
    },
    [chatScopeKey]
  );

  return (
    <div className="flex h-full min-h-0 w-full">
      <StudioSidebar
        projects={[]}
        collapsed={collapsed}
        selectedProject={null}
        onProjectSelect={() => {}}
        onToggle={() => setCollapsed((value) => !value)}
        onHome={onHome}
        onNewChat={onNewChat}
        onPlugins={onPlugins}
        onPullRequests={() => {}}
        activeSection="pull-requests"
      />
      <main className="flex min-w-0 flex-1 flex-col bg-background">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-6">
          {error && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>
                {error}
                {stale
                  ? " Showing the last successful data where available."
                  : ""}
              </span>
            </div>
          )}
          {(status?.state !== "connected" ||
            status?.capabilities.readPullRequests !== true) &&
          mode === "live" &&
          !loading ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-2 text-center text-sm text-subtle">
              <GitPullRequest className="h-6 w-6 text-faint" />
              <p>
                {status?.state === "error"
                  ? status.message || "GitHub connection status is unavailable."
                  : status?.state === "connected"
                    ? "GitHub pull request reads are unavailable for this connection."
                    : "Connect GitHub in Plugins to browse pull requests."}
              </p>
            </div>
          ) : (
            <div
              ref={detailLayoutRef}
              className={`flex min-h-0 flex-1 overflow-hidden ${isResizing ? "select-none" : ""}`}
            >
              <div
                ref={listPaneRef}
                className={`${selectedDetail ? "hidden lg:flex" : "flex w-full"} min-w-0 flex-col overflow-hidden transition-[width]`}
                style={
                  selectedDetail
                    ? {
                        flex: `0 1 ${listWidth}px`,
                        width: `${listWidth}px`,
                        minWidth: `${MIN_LIST_WIDTH}px`,
                        maxWidth: `${MAX_LIST_WIDTH}px`
                      }
                    : undefined
                }
              >
                <div className="shrink-0 border-b border-border/60 p-4 pb-3">
                  <div className="flex flex-wrap items-center gap-2 no-drag">
                    {(["all", "reviewing", "authored"] as const).map(
                      (value) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setTab(value)}
                          className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize ${tab === value ? "bg-surface-hover text-foreground" : "text-muted hover:bg-surface hover:text-foreground-secondary"}`}
                        >
                          {value}
                        </button>
                      )
                    )}
                    {mode === "demo" && (
                      <>
                        <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-1 text-[11px] font-medium text-warning">
                          Demo data
                        </span>
                        {onUseRealGitHub && (
                          <button
                            type="button"
                            onClick={onUseRealGitHub}
                            className="rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10"
                          >
                            Use real GitHub
                          </button>
                        )}
                      </>
                    )}
                    <RepositoryPicker
                      repositories={repositories}
                      value={repository}
                      disabled={loading || repositories.length === 0}
                      onSelect={(nextRepository) => {
                        repositorySelectionIntentRef.current = true;
                        setRepository(nextRepository);
                      }}
                    />
                  </div>
                  <div className="mt-3 flex items-center gap-2 no-drag">
                    <div className="relative min-w-0 flex-1">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
                      <input
                        type="search"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Search loaded pull requests"
                        aria-label="Search loaded pull requests"
                        className="w-full rounded-lg border border-border bg-surface py-2 pl-10 pr-4 text-sm text-foreground outline-none placeholder:text-faint focus:border-border-strong focus:ring-1 focus:ring-accent"
                      />
                    </div>
                    <div ref={filterRef} className="relative shrink-0">
                      <button
                        type="button"
                        onClick={() => setFilterOpen((current) => !current)}
                        aria-expanded={filterOpen}
                        aria-pressed={filter !== "all"}
                        aria-haspopup="menu"
                        aria-label="Filter pull requests"
                        title={
                          filter === "all"
                            ? "Filter pull requests"
                            : `Filter pull requests: ${PULL_REQUEST_FILTERS.find((option) => option.id === filter)?.label ?? "active"}`
                        }
                        className={`relative rounded-lg border p-2 transition-colors ${filter !== "all" ? "border-accent/50 bg-accent/10 text-accent hover:bg-accent/15" : "border-border bg-surface text-muted hover:bg-surface-hover hover:text-foreground"}`}
                      >
                        <Filter className="h-4 w-4" />
                        {filter !== "all" && (
                          <span
                            aria-hidden="true"
                            className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent"
                          />
                        )}
                      </button>
                      {filterOpen && (
                        <div
                          className="absolute right-0 top-full z-30 mt-2 w-44 rounded-xl border border-border-strong bg-surface p-1 shadow-xl shadow-black/50"
                          role="menu"
                        >
                          {PULL_REQUEST_FILTERS.map((option) => (
                            <button
                              key={option.id}
                              type="button"
                              role="menuitemradio"
                              aria-checked={filter === option.id}
                              onClick={() => {
                                setFilter(option.id);
                                setFilterOpen(false);
                              }}
                              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs ${filter === option.id ? "bg-surface-hover text-foreground" : "text-muted hover:bg-surface-hover/70 hover:text-foreground-secondary"}`}
                            >
                              {option.label}
                              {filter === option.id && (
                                <span className="text-accent">✓</span>
                              )}
                            </button>
                          ))}
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setFilter("all");
                              setSearch("");
                              setFilterOpen(false);
                            }}
                            className="mt-1 w-full border-t border-border px-3 py-2 text-left text-xs text-muted hover:text-foreground"
                          >
                            Clear filters
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between px-1">
                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-subtle">
                      {repository?.fullName ?? "Repository"}
                    </p>
                    <span className="text-xs text-subtle">
                      {filteredPullRequests.length} loaded
                    </span>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  {loading && (
                    <div className="flex items-center justify-center gap-2 py-12 text-sm text-subtle">
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                      Loading pull requests…
                    </div>
                  )}
                  {!loading && filteredPullRequests.length === 0 && (
                    <div className="rounded-xl border border-border bg-surface/40 px-6 py-16 text-center">
                      <GitPullRequest className="mx-auto mb-3 h-6 w-6 text-faint" />
                      <p className="text-sm font-medium text-foreground-secondary">
                        No pull requests
                      </p>
                      <p className="mt-1 text-xs text-subtle">
                        Try another tab, repository, or search.
                      </p>
                    </div>
                  )}
                  {!loading && filteredPullRequests.length > 0 && (
                    <div className="space-y-1">
                      {filteredPullRequests.map((item) => (
                        <PullRequestRow
                          key={item.number}
                          pullRequest={item}
                          selected={selectedNumber === item.number}
                          onClick={() => setSelectedNumber(item.number)}
                        />
                      ))}
                    </div>
                  )}
                  {pullRequestsMore && (
                    <button
                      type="button"
                      onClick={() => void loadMorePullRequests()}
                      disabled={loadingMore}
                      className="mt-4 w-full rounded-md border border-border px-3 py-2 text-xs text-muted hover:bg-surface-hover disabled:opacity-50"
                    >
                      {loadingMore ? "Loading…" : "Load more pull requests"}
                    </button>
                  )}
                </div>
              </div>
              {selectedDetail && (
                <div
                  role="separator"
                  tabIndex={0}
                  aria-label="Resize pull request list"
                  aria-orientation="vertical"
                  aria-valuemin={MIN_LIST_WIDTH}
                  aria-valuemax={MAX_LIST_WIDTH}
                  aria-valuenow={listWidth}
                  onKeyDown={onDividerKeyDown}
                  onPointerDown={onDividerPointerDown}
                  onPointerMove={onDividerPointerMove}
                  onPointerUp={stopDividerResize}
                  onPointerCancel={stopDividerResize}
                  onLostPointerCapture={() => {
                    resizeStartRef.current = null;
                    setIsResizing(false);
                  }}
                  className="hidden w-2 shrink-0 cursor-col-resize touch-none items-stretch justify-center lg:flex"
                >
                  <span className="w-px bg-border transition-colors hover:bg-accent" />
                </div>
              )}
              {selectedDetail && (
                <PullRequestDetail
                  pullRequest={selectedDetail}
                  chatOpen={detailView === "chat"}
                  onSummary={() => setDetailView("summary")}
                  onChat={() => setDetailView("chat")}
                  chatAvailable={chatAvailable}
                  chatScope={chatScope}
                  chatMessages={chatMessages}
                  chatDraft={chatDraft}
                  onChatDraftChange={updateChatDraft}
                  onChatMessagesChange={updateChatMessages}
                  chatAdapter={chatAdapter}
                  chatAgents={chatAgents}
                  chatModelOptions={chatModelOptions}
                  chatInitialModel={`${DEFAULT_PR_MODEL.provider}:${DEFAULT_PR_MODEL.id}`}
                  chatInitialEffort="High"
                  demo={mode === "demo"}
                  chatAvailabilityMessage={chatAvailabilityMessage}
                  onClose={() => {
                    setSelectedNumber(null);
                    setSelectedDetail(null);
                    setDetailView("summary");
                  }}
                />
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
