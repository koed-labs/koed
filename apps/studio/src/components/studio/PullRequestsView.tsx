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
import type { ChatMentionAgent, ChatComposerSelection } from "../ChatComposer";
import type {
  PullRequestReviewRecord,
  PullRequestReviewDraft,
  PullRequestFrozenReview,
  PullRequestOperationRecord
} from "@koed/shared/pull-requests";
import {
  pullRequestOperationData,
  pullRequestsClient,
  type PullRequestActionGrantStatus,
  type PullRequestRunner
} from "@/lib/pull-requests-client";
import {
  hostedLaunchInstancesForDevice,
  loadHostedManagedConversation,
  loadHostedLaunchOptions,
  queueHostedConversationPrompt,
  startHostedManagedConversation,
  type HostedLaunchOptions
} from "@/lib/hosted-managed-chats";
import {
  PRChatPanel,
  type PRChatMessage,
  type PRChatScope
} from "./PRChatPanel";
import { PRMarkdown } from "./PRMarkdown";
import { PullRequestReviewPanel } from "./PullRequestReviewPanel";
import {
  PullRequestPushPanel,
  type PullRequestPushProposal
} from "./PullRequestPushPanel";
import { StudioSidebar } from "./StudioSidebar";
import { HostedManagedChats } from "../hosted/HostedManagedChats";
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
  accountId?: string | null;
  connectionGeneration?: number;
  message: string | null;
  capabilities: { readPullRequests: boolean; publishReviews: boolean };
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
  repositoryFullName?: string;
  inboxOrigin?:
    | "requested_review"
    | "authored"
    | "authored_and_requested_review";
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
    accountId: typeof value.accountId === "string" ? value.accountId : null,
    connectionGeneration: Number.isSafeInteger(value.connectionGeneration)
      ? Number(value.connectionGeneration)
      : undefined,
    message: typeof value.message === "string" ? value.message : null,
    capabilities: {
      readPullRequests: capabilities.readPullRequests,
      publishReviews: capabilities.publishReviews === true
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

function parsePushProposal(
  operation: PullRequestOperationRecord
): PullRequestPushProposal | null {
  if (operation.state !== "completed" || !operation.result) return null;
  const value = isRecord(operation.result.proposal)
    ? operation.result.proposal
    : operation.result;
  const headRepository = isRecord(value.headRepository)
    ? value.headRepository
    : null;
  const fields = [
    "headBranch",
    "remoteSha",
    "checkoutHead",
    "treeSha",
    "diff",
    "diffDigest",
    "commitSha"
  ] as const;
  if (
    !headRepository ||
    typeof headRepository.fullName !== "string" ||
    fields.some((field) => typeof value[field] !== "string")
  )
    return null;
  return {
    id: operation.id,
    headRepository: { fullName: headRepository.fullName },
    headBranch: value.headBranch as string,
    remoteSha: value.remoteSha as string,
    checkoutHead: value.checkoutHead as string,
    treeSha: value.treeSha as string,
    diff: value.diff as string,
    diffDigest: value.diffDigest as string,
    commitSha: value.commitSha as string
  };
}

function parseInboxItem(value: unknown): PullRequest | null {
  if (!isRecord(value)) return null;
  const pullRequestValue = isRecord(value.pullRequest)
    ? value.pullRequest
    : value;
  const number =
    typeof value.number === "number"
      ? value.number
      : isRecord(pullRequestValue) &&
          typeof pullRequestValue.number === "number"
        ? pullRequestValue.number
        : null;
  if (number === null) return null;
  const repositoryFullName =
    typeof value.repository === "string"
      ? value.repository
      : isRecord(value.repository)
        ? asString(value.repository.fullName)
        : "";
  if (!repositoryFullName.includes("/")) return null;
  const detail = parsePullRequest(pullRequestValue);
  const url = asString(value.url, detail?.url ?? "");
  const origin =
    value.origin === "authored" ||
    value.origin === "requested_review" ||
    value.origin === "authored_and_requested_review"
      ? value.origin
      : undefined;
  return {
    number,
    title: asString(value.title, detail?.title ?? "Untitled pull request"),
    state: detail?.state ?? "open",
    draft: detail?.draft ?? false,
    author: asAuthor(value.author ?? detail?.author),
    requestedReviewers: [],
    headSha: detail?.headSha ?? "",
    baseSha: detail?.baseSha ?? "",
    headBranch: detail?.headBranch ?? "",
    baseBranch: detail?.baseBranch ?? "",
    updatedAt: asString(value.updatedAt, detail?.updatedAt ?? ""),
    url,
    ...(detail ?? {}),
    repositoryFullName,
    ...(origin ? { inboxOrigin: origin } : {})
  };
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

function chatPermissionForRuntime(
  value: string
): ChatComposerSelection["permissionMode"] {
  if (value === "supervised" || value === "ask") return "ask";
  if (value === "full_access" || value === "full") return "full";
  return "read";
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
          {pullRequest.repositoryFullName && (
            <span className="font-medium text-foreground-secondary">
              {pullRequest.repositoryFullName}
            </span>
          )}
          {pullRequest.repositoryFullName && <span>·</span>}
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
  detailPayload,
  onClose,
  chatOpen,
  codeOpen,
  onSummary,
  onCode,
  onChat,
  chatAvailable,
  chatScope,
  chatMessages,
  chatDraft,
  onChatDraftChange,
  onChatMessagesChange,
  onChatAuthorizationLost,
  chatAgents,
  chatModelOptions,
  chatInitialModel,
  chatInitialEffort,
  chatInitialPermissionMode,
  demo,
  chatAvailabilityMessage,
  reviewAgentId,
  onReviewAgentChange,
  reviewAgents,
  reviewRunnerId,
  onReviewRunnerChange,
  reviewRunners,
  reviewModelKey,
  onReviewModelChange,
  reviewModels,
  reviewPermissionMode,
  onReviewPermissionModeChange,
  reviewPermissionModes,
  reviewEffort,
  onReviewEffortChange,
  matchingProjects,
  selectedProjectId,
  onSelectedProjectChange,
  onStartAgentReview,
  reviewJobBusy,
  reviewError,
  reviewRecord,
  reviewDraft,
  frozenReview,
  onSaveReviewDraft,
  onFreezeReview,
  onPublishReview,
  publishGrant,
  onApprovePublishGrant,
  onCheckPublishGrant,
  pendingPublishOperation,
  onCheckPendingPublish,
  onCancelPendingPublish,
  onReviewLatest,
  onEnableFixes,
  enablingFixes,
  publishedReviewUrl,
  reconcilePublishedReview,
  uncertainPublishOperationId,
  canApprove,
  canPublishReview,
  pushProposal,
  pendingPushOperationId,
  onCheckPendingPush,
  onCancelPendingPush,
  uncertainPushOperationId,
  pushBusy,
  pushError,
  onPreparePush,
  onPushProposal,
  onReconcilePush,
  pushGrant,
  onApprovePushGrant,
  onCheckPushGrant
}: {
  pullRequest: PullRequest;
  detailPayload: Record<string, unknown> | null;
  onClose: () => void;
  chatOpen: boolean;
  codeOpen: boolean;
  onSummary: () => void;
  onCode: () => void;
  onChat: () => void;
  chatAvailable: boolean;
  chatScope: PRChatScope | null;
  chatMessages: PRChatMessage[];
  chatDraft: string;
  onChatDraftChange: (value: string) => void;
  onChatMessagesChange: React.Dispatch<React.SetStateAction<PRChatMessage[]>>;
  onChatAuthorizationLost: () => void;
  chatAgents: readonly ChatMentionAgent[];
  chatModelOptions: readonly AgentModelCapability[];
  chatInitialModel: string;
  chatInitialEffort: string;
  chatInitialPermissionMode: ChatComposerSelection["permissionMode"];
  demo: boolean;
  chatAvailabilityMessage: string | null;
  reviewAgentId: string | null;
  onReviewAgentChange: (id: string) => void;
  reviewAgents: readonly ChatMentionAgent[];
  reviewRunnerId: string;
  onReviewRunnerChange: (id: string) => void;
  reviewRunners: readonly { deviceId: string; displayName: string }[];
  reviewModelKey: string;
  onReviewModelChange: (key: string) => void;
  reviewModels: readonly AgentModelCapability[];
  reviewPermissionMode: string;
  onReviewPermissionModeChange: (mode: string) => void;
  reviewPermissionModes: readonly string[];
  reviewEffort: string;
  onReviewEffortChange: (value: string) => void;
  matchingProjects: readonly { id: string; name: string }[];
  selectedProjectId: string;
  onSelectedProjectChange: (projectId: string) => void;
  onStartAgentReview: () => void;
  reviewJobBusy: boolean;
  reviewError: string | null;
  reviewRecord: PullRequestReviewRecord | null;
  reviewDraft: PullRequestReviewDraft | null;
  frozenReview: PullRequestFrozenReview | null;
  onSaveReviewDraft: (value: {
    event: NonNullable<PullRequestReviewDraft["event"]> | null;
    body: string;
    findings: PullRequestReviewDraft["findings"];
  }) => Promise<void>;
  onFreezeReview: () => Promise<void>;
  onPublishReview: (id: string) => Promise<void>;
  publishGrant: PullRequestActionGrantStatus | null;
  onApprovePublishGrant: () => Promise<void>;
  onCheckPublishGrant: () => Promise<void>;
  pendingPublishOperation: PullRequestOperationRecord | null;
  onCheckPendingPublish: () => Promise<void>;
  onCancelPendingPublish: () => Promise<void>;
  onReviewLatest: () => void;
  onEnableFixes: (request: string) => Promise<void>;
  enablingFixes: boolean;
  publishedReviewUrl: string | null;
  reconcilePublishedReview: () => Promise<void>;
  uncertainPublishOperationId: string | null;
  canApprove: boolean;
  canPublishReview: boolean;
  pushProposal: PullRequestPushProposal | null;
  pendingPushOperationId: string | null;
  onCheckPendingPush: () => Promise<void>;
  onCancelPendingPush: () => Promise<void>;
  uncertainPushOperationId: string | null;
  pushBusy: boolean;
  pushError: string | null;
  onPreparePush: () => Promise<void>;
  onPushProposal: (proposalId: string, diffDigest: string) => Promise<void>;
  onReconcilePush: () => Promise<void>;
  pushGrant: PullRequestActionGrantStatus | null;
  onApprovePushGrant: () => Promise<void>;
  onCheckPushGrant: () => Promise<void>;
}) {
  const embeddedReview = useMemo(
    () =>
      chatScope
        ? {
            reviewId: chatScope.reviewId,
            executionId: chatScope.executionId,
            agentId: chatScope.agentId
          }
        : undefined,
    [chatScope]
  );
  const link = safeGitHubUrl(pullRequest.url);
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-background/90 px-6 py-4 backdrop-blur-sm">
        <div className="flex items-center gap-1 rounded-md bg-surface p-1">
          <button
            type="button"
            onClick={onSummary}
            className={`rounded px-3 py-1 text-xs font-medium ${!chatOpen && !codeOpen ? "bg-surface-hover text-foreground-secondary" : "text-muted hover:bg-surface-hover hover:text-foreground-secondary"}`}
          >
            Summary
          </button>
          <button
            type="button"
            onClick={onCode}
            className={`inline-flex items-center gap-1 rounded px-3 py-1 text-xs font-medium ${codeOpen ? "bg-surface-hover text-foreground-secondary" : "text-muted hover:bg-surface-hover hover:text-foreground-secondary"}`}
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
            disabled={
              !reviewAgentId ||
              !reviewRunnerId ||
              !reviewModelKey ||
              reviewJobBusy ||
              demo
            }
            title={
              demo
                ? "Agent reviews are unavailable in demo mode"
                : "Start a review Job with the selected Agent"
            }
            onClick={onStartAgentReview}
            className="inline-flex items-center gap-1.5 rounded-md bg-chip px-3 py-1.5 text-xs font-medium text-chip-foreground disabled:opacity-50"
          >
            {reviewJobBusy ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}{" "}
            Review with Agent
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
        demo ? (
          <PRChatPanel
            key={`${chatScope.reviewId}:${chatScope.agentId}`}
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
            agents={chatAgents.filter(
              (agent) => agent.id === chatScope.agentId
            )}
            activeAgentId={chatScope.agentId}
            modelOptions={chatModelOptions}
            initialModel={chatInitialModel}
            initialEffort={chatInitialEffort}
            initialPermissionMode={chatInitialPermissionMode}
            demo
            availabilityMessage={chatAvailabilityMessage}
          />
        ) : (
          <HostedManagedChats
            key={`${chatScope.reviewId}:${chatScope.executionId}`}
            initialExecutionId={chatScope.executionId}
            initialAgentId={chatScope.agentId}
            initialDraft={chatDraft}
            onDraftChange={onChatDraftChange}
            embeddedReview={embeddedReview}
            onAuthorizationLost={onChatAuthorizationLost}
          />
        )
      ) : chatOpen ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
          <div className="max-w-md">
            <h1 className="text-lg font-semibold text-foreground">
              Start an Agent review
            </h1>
            <p className="mt-2 text-sm text-muted">
              Select an available Agent, runner, and model below. The Agent will
              create a review Job and keep its chat history with that review.
            </p>
            <button
              type="button"
              onClick={onSummary}
              className="mt-4 rounded-md border border-border px-3 py-1.5 text-sm text-foreground-secondary hover:bg-surface-hover"
            >
              Choose review settings
            </button>
          </div>
        </div>
      ) : codeOpen ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <h1 className="text-xl font-semibold text-foreground">
            Code and activity
          </h1>
          {Array.isArray(detailPayload?.files) &&
          detailPayload.files.length > 0 ? (
            <div className="mt-4 space-y-4">
              {detailPayload.files.map((value, index) => {
                const file = isRecord(value) ? value : {};
                const filename = asString(file.filename, `File ${index + 1}`);
                return (
                  <article
                    key={`${filename}:${index}`}
                    className="overflow-hidden rounded-lg border border-border"
                  >
                    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface/40 px-3 py-2 text-xs">
                      <code className="break-all text-foreground-secondary">
                        {filename}
                      </code>
                      <span className="text-subtle">
                        {asString(file.status, "changed")} · +
                        {String(file.additions ?? 0)} / -
                        {String(file.deletions ?? 0)}
                      </span>
                    </header>
                    <pre className="max-h-[32rem] overflow-auto p-3 text-xs leading-5 text-foreground-secondary">
                      {asString(
                        file.patch,
                        "Patch omitted by the bounded GitHub response."
                      )}
                    </pre>
                  </article>
                );
              })}
              {detailPayload.filesTruncated === true && (
                <p className="text-xs text-subtle">
                  GitHub truncated the file list; not all changed files are
                  shown.
                </p>
              )}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">
              Diff files are not available in this bounded response. Open the
              pull request on GitHub for the complete diff.
            </p>
          )}
          <div className="mt-8 grid gap-6 lg:grid-cols-2">
            {(["comments", "reviewComments", "reviews", "checks"] as const).map(
              (key) => {
                const pr = isRecord(detailPayload?.pullRequest)
                  ? detailPayload.pullRequest
                  : {};
                const values = Array.isArray(pr[key])
                  ? pr[key]
                  : detailPayload?.[key];
                const truncated =
                  pr[`${key}Truncated`] === true ||
                  detailPayload?.[`${key}Truncated`] === true;
                return (
                  <section
                    key={key}
                    className="rounded-lg border border-border p-3"
                  >
                    <h2 className="text-sm font-medium capitalize text-foreground-secondary">
                      {key === "reviewComments" ? "Inline comments" : key}
                    </h2>
                    {Array.isArray(values) && values.length ? (
                      <ul className="mt-3 space-y-2">
                        {values.map((entry, index) => {
                          const item = isRecord(entry) ? entry : {};
                          const user = isRecord(item.user) ? item.user : {};
                          return (
                            <li
                              key={String(item.id ?? index)}
                              className="border-t border-border/60 pt-2 text-xs text-muted"
                            >
                              <span className="font-medium text-foreground-secondary">
                                {asString(
                                  user.login,
                                  asString(item.state, "Activity")
                                )}
                              </span>
                              <p className="mt-1 whitespace-pre-wrap">
                                {asString(
                                  item.body,
                                  asString(
                                    item.conclusion,
                                    asString(item.status, "")
                                  )
                                )}
                              </p>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="mt-2 text-xs text-subtle">
                        No {key === "reviewComments" ? "inline comments" : key}{" "}
                        returned.
                      </p>
                    )}
                    {truncated && (
                      <p className="mt-2 text-xs text-subtle">
                        This section was truncated by GitHub.
                      </p>
                    )}
                  </section>
                );
              }
            )}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <h1 className="text-2xl font-semibold leading-tight text-foreground">
            {pullRequest.title}
          </h1>
          <p className="mt-3 text-sm text-muted">
            {pullRequest.author} · updated{" "}
            {formatUpdatedAt(pullRequest.updatedAt)} · #{pullRequest.number}
          </p>
          <div className="mt-8 grid grid-cols-1 gap-y-2 break-words text-sm sm:grid-cols-[110px_minmax(0,1fr)] sm:gap-y-4">
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
            <h2 className="font-medium text-foreground-secondary">
              Start an Agent review
            </h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-2">
              <label className="text-xs text-muted">
                Agent
                <select
                  value={reviewAgentId ?? ""}
                  onChange={(event) =>
                    onReviewAgentChange(event.currentTarget.value)
                  }
                  className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                >
                  <option value="">Select an available Agent…</option>
                  {reviewAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-muted">
                Runner
                <select
                  value={reviewRunnerId}
                  onChange={(event) =>
                    onReviewRunnerChange(event.currentTarget.value)
                  }
                  className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                >
                  <option value="">Select a runner…</option>
                  {reviewRunners.map((runner) => (
                    <option key={runner.deviceId} value={runner.deviceId}>
                      {runner.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-muted">
                Model
                <select
                  value={reviewModelKey}
                  onChange={(event) =>
                    onReviewModelChange(event.currentTarget.value)
                  }
                  className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                >
                  <option value="">Select a supported model…</option>
                  {reviewModels.map((model) => (
                    <option
                      key={`${model.provider}:${model.id}:${model.instanceId ?? ""}`}
                      value={`${model.provider}:${model.id}`}
                    >
                      {model.displayName} · {model.provider}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-muted">
                Reasoning effort
                <select
                  value={reviewEffort}
                  onChange={(event) =>
                    onReviewEffortChange(event.currentTarget.value)
                  }
                  className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                >
                  {(
                    reviewModels.find(
                      (model) =>
                        `${model.provider}:${model.id}` === reviewModelKey
                    )?.supportedReasoningEfforts ?? []
                  ).map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-muted">
                After explicit fixes approval
                <select
                  value={reviewPermissionMode}
                  onChange={(event) =>
                    onReviewPermissionModeChange(event.currentTarget.value)
                  }
                  className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                >
                  <option value="">Select permission…</option>
                  {reviewPermissionModes.map((permission) => (
                    <option key={permission} value={permission}>
                      {permission}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-muted">
                Project
                <select
                  value={selectedProjectId}
                  onChange={(event) =>
                    onSelectedProjectChange(event.currentTarget.value)
                  }
                  className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                >
                  <option value="">No Project (standalone Job)</option>
                  {matchingProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="mt-2 text-xs text-subtle">
              Review Jobs are forced read-only. This permission is used only
              after you separately approve a written fixes request.
            </p>
            {reviewError && (
              <p role="alert" className="mt-2 text-xs text-danger">
                {reviewError}
              </p>
            )}
          </div>
          {reviewRecord && (
            <PullRequestReviewPanel
              review={reviewRecord}
              draft={reviewDraft}
              frozenReview={frozenReview}
              latestScope={{
                baseSha: pullRequest.baseSha,
                headSha: pullRequest.headSha
              }}
              error={reviewError}
              saving={false}
              freezing={false}
              publishing={false}
              publishedUrl={publishedReviewUrl}
              onSaveDraft={onSaveReviewDraft}
              onFreeze={onFreezeReview}
              onPublish={onPublishReview}
              publishGrant={publishGrant}
              onApprovePublishGrant={onApprovePublishGrant}
              onCheckPublishGrant={onCheckPublishGrant}
              pendingOperation={
                pendingPublishOperation
                  ? {
                      id: pendingPublishOperation.id,
                      state: pendingPublishOperation.state
                    }
                  : null
              }
              onCheckPending={onCheckPendingPublish}
              onCancelPending={onCancelPendingPublish}
              onCheckOutcome={reconcilePublishedReview}
              canCheckOutcome={Boolean(uncertainPublishOperationId)}
              canApprove={canApprove}
              canPublish={canPublishReview}
              onReviewLatest={onReviewLatest}
              onEnableFixes={onEnableFixes}
              enablingFixes={enablingFixes}
            />
          )}
          {reviewRecord?.workMode === "fix" && (
            <PullRequestPushPanel
              proposal={pushProposal}
              busy={pushBusy}
              pendingOperationId={pendingPushOperationId}
              onCheckPending={onCheckPendingPush}
              onCancelPending={onCancelPendingPush}
              uncertainOperationId={uncertainPushOperationId}
              error={pushError}
              onPrepare={onPreparePush}
              onPush={onPushProposal}
              onReconcile={onReconcilePush}
              actionGrant={pushGrant}
              onApproveActionGrant={onApprovePushGrant}
              onCheckActionGrant={onCheckPushGrant}
            />
          )}
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
  initialReviewId
}: {
  mode: PullRequestsMode;
  onHome: () => void;
  onNewChat: () => void;
  onPlugins: () => void;
  onUseRealGitHub?: () => void;
  initialReviewId?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [chatAgents, setChatAgents] = useState<ChatMentionAgent[]>([]);
  const [launchOptions, setLaunchOptions] =
    useState<HostedLaunchOptions | null>(null);
  const [sourceControlRunners, setSourceControlRunners] = useState<
    PullRequestRunner[]
  >([]);
  const [reviewAgentId, setReviewAgentId] = useState<string | null>(null);
  const [reviewRunnerId, setReviewRunnerId] = useState("");
  const [reviewModelKey, setReviewModelKey] = useState("");
  const [reviewPermissionMode, setReviewPermissionMode] = useState("");
  const [reviewExecutionEffort, setReviewExecutionEffort] = useState("high");
  const [reviewJobBusy, setReviewJobBusy] = useState(false);
  const [enablingFixes, setEnablingFixes] = useState(false);
  const [reviewRecord, setReviewRecord] =
    useState<PullRequestReviewRecord | null>(null);
  const [reviewExecutionGeneration, setReviewExecutionGeneration] = useState<
    number | null
  >(null);
  const [reviewDraft, setReviewDraft] = useState<PullRequestReviewDraft | null>(
    null
  );
  const [frozenReview, setFrozenReview] =
    useState<PullRequestFrozenReview | null>(null);
  const [publishedReviewUrl, setPublishedReviewUrl] = useState<string | null>(
    null
  );
  const [uncertainPublishOperationId, setUncertainPublishOperationId] =
    useState<string | null>(null);
  const [pendingPublishOperation, setPendingPublishOperation] =
    useState<PullRequestOperationRecord | null>(null);
  const [pushProposal, setPushProposal] =
    useState<PullRequestPushProposal | null>(null);
  const [pendingPushOperation, setPendingPushOperation] =
    useState<PullRequestOperationRecord | null>(null);
  const [uncertainPushOperationId, setUncertainPushOperationId] = useState<
    string | null
  >(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushGrant, setPushGrant] = useState<{
    status: PullRequestActionGrantStatus;
    commandRequestId: string;
    operationRequestId: string;
  } | null>(null);
  const [publishGrant, setPublishGrant] = useState<{
    status: PullRequestActionGrantStatus;
    commandRequestId: string;
    operationRequestId: string;
  } | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
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
  const [selectedRepositoryFullName, setSelectedRepositoryFullName] = useState<
    string | null
  >(null);
  const [inboxCursor, setInboxCursor] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<PullRequest | null>(
    null
  );
  const [detailPayload, setDetailPayload] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [detailOperationId, setDetailOperationId] = useState<string | null>(
    null
  );
  const [matchingProjects, setMatchingProjects] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [detailView, setDetailView] = useState<"summary" | "code" | "chat">(
    "summary"
  );
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
  const homeReviewOpenedRef = useRef(false);
  const [statusLoadedRevision, setStatusLoadedRevision] = useState(0);
  const statusLoadingRef = useRef(false);
  const sequenceRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const sourceControlRunnersRef = useRef(sourceControlRunners);
  useEffect(() => {
    sourceControlRunnersRef.current = sourceControlRunners;
  }, [sourceControlRunners]);

  useEffect(() => {
    if (mode === "demo") return;
    const controller = new AbortController();
    Promise.all([
      personalAgentsHttpAdapter.list(controller.signal),
      personalAgentsHttpAdapter.capabilities(controller.signal),
      loadHostedLaunchOptions(controller.signal)
    ])
      .then(([agents, capabilities, availableLaunchOptions]) => {
        if (controller.signal.aborted) return;
        setLaunchOptions(availableLaunchOptions);
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
          setLaunchOptions(null);
        }
      });
    return () => controller.abort();
  }, [mode]);
  const statusRef = useRef<GitHubStatus | null>(status);
  const loadedRepositoryRef = useRef<string | null>(null);
  const detailSequenceRef = useRef(0);
  const detailControllerRef = useRef<AbortController | null>(null);
  const repositorySelectionIntentRef = useRef(false);
  const demoPreferenceAppliedRef = useRef(false);
  const detailLayoutRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);

  const resetChatState = useCallback(() => {
    setDetailView("summary");
    setChatMessagesByScope({});
    setChatDraftsByScope({});
  }, []);

  const targetForRunner = useCallback((deviceId: string | null | undefined) => {
    const runners = sourceControlRunnersRef.current;
    if (deviceId) {
      const selected = runners.find((runner) => runner.deviceId === deviceId);
      if (selected)
        return {
          deviceId: selected.deviceId,
          deploymentId: selected.deploymentId
        };
    }
    if (
      typeof window !== "undefined" &&
      !window.location.pathname.startsWith("/studio")
    )
      return undefined;
    const fallback = runners[0];
    return fallback
      ? { deviceId: fallback.deviceId, deploymentId: fallback.deploymentId }
      : undefined;
  }, []);

  const loadStatusAndRepositories = useCallback(async () => {
    if (mode === "demo") return;
    statusLoadingRef.current = true;
    const sequence = ++sequenceRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    try {
      const requestedReview =
        initialReviewId && !homeReviewOpenedRef.current
          ? await pullRequestsClient.getReview(
              initialReviewId,
              controller.signal
            )
          : null;
      const availableRunners = await pullRequestsClient.listRunners(
        controller.signal
      );
      if (sequence !== sequenceRef.current) return;
      const requestedRunner = requestedReview
        ? availableRunners.find(
            (runner) =>
              runner.deviceId === requestedReview.targetDeviceId &&
              runner.deploymentId === requestedReview.targetDeploymentId
          )
        : null;
      if (requestedReview && !requestedRunner)
        throw new Error(
          "The computer assigned to this review is unavailable. Reconnect it and try again."
        );
      setSourceControlRunners(availableRunners);
      setReviewRunnerId(
        (current) =>
          requestedRunner?.deviceId ??
          (availableRunners.some((runner) => runner.deviceId === current)
            ? current
            : (availableRunners[0]?.deviceId ?? ""))
      );
      const target = requestedRunner
        ? {
            deviceId: requestedRunner.deviceId,
            deploymentId: requestedRunner.deploymentId
          }
        : (targetForRunner(reviewRunnerId) ??
          (availableRunners[0]
            ? {
                deviceId: availableRunners[0].deviceId,
                deploymentId: availableRunners[0].deploymentId
              }
            : undefined));
      const statusOperation = await pullRequestsClient.runOperation(
        { kind: "connection_status" },
        { signal: controller.signal, target }
      );
      const statusValue = pullRequestOperationData(statusOperation);
      const accountValue = isRecord(statusValue.account)
        ? statusValue.account
        : null;
      const payload = {
        state:
          statusValue.state === "reauthorization_required"
            ? "error"
            : statusValue.state,
        accountId: accountValue?.id,
        login: accountValue?.login ?? null,
        connectionGeneration: statusValue.connectionGeneration,
        message:
          statusValue.state === "reauthorization_required"
            ? "Reconnect GitHub in Plugins."
            : null,
        capabilities: statusValue.capabilities ?? {
          readPullRequests: statusValue.state === "connected",
          publishReviews: statusValue.state === "connected"
        }
      };
      const nextStatus = parseStatus(payload);
      if (!nextStatus)
        throw new Error("GitHub connection status is unavailable.");
      if (sequence !== sequenceRef.current) return;
      const previousStatus = statusRef.current;
      const identityChanged =
        previousStatus?.accountId !== nextStatus.accountId ||
        previousStatus?.login !== nextStatus.login;
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
      if (
        !nextStatus.accountId ||
        !nextStatus.connectionGeneration ||
        !nextStatus.login
      ) {
        setRepositories([]);
        setRepository(null);
        setPullRequests([]);
        return;
      }
      const nextRepositories: Repository[] = [];
      let cursor: string | null = null;
      let hasMore = true;
      for (let page = 0; hasMore && page < 8; page += 1) {
        const operation = await pullRequestsClient.runOperation(
          {
            kind: "repositories",
            account: { id: nextStatus.accountId, login: nextStatus.login },
            connectionGeneration: nextStatus.connectionGeneration,
            cursor
          },
          { signal: controller.signal, target }
        );
        const result = pullRequestOperationData(operation);
        const pageItems = Array.isArray(result.repositories)
          ? result.repositories
          : [];
        nextRepositories.push(
          ...pageItems
            .map(parseRepository)
            .filter((value): value is Repository => Boolean(value))
        );
        hasMore = result.hasMore === true;
        cursor =
          typeof result.nextCursor === "string" ? result.nextCursor : null;
        if (hasMore && !cursor) break;
      }
      if (sequence !== sequenceRef.current) return;
      const savedPreference = readRepositoryPreference(
        getSessionStorage(),
        repositoryPreferenceKey("live", nextStatus.login ?? "unknown")
      );
      const preferredRepository = savedPreference
        ? nextRepositories.find(
            (item) => item.fullName === savedPreference.fullName
          )
        : null;
      setStale(false);
      setRepositories(nextRepositories);
      if (requestedReview) {
        const linkedRepository = nextRepositories.find(
          (candidate) =>
            candidate.id === requestedReview.repository.id &&
            candidate.fullName === requestedReview.repository.fullName
        );
        if (
          !linkedRepository ||
          requestedReview.account.id !== nextStatus.accountId ||
          requestedReview.account.login !== nextStatus.login
        )
          throw new Error(
            "This review is not available through the selected GitHub connection. Check its account and repository access."
          );
        homeReviewOpenedRef.current = true;
        repositorySelectionIntentRef.current = true;
        loadedRepositoryRef.current = linkedRepository.fullName;
        setRepository(linkedRepository);
        setSelectedRepositoryFullName(linkedRepository.fullName);
        setSelectedNumber(requestedReview.pullRequestNumber);
        setReviewAgentId(requestedReview.agentId);
        setDetailView("chat");
      }
      setRepository((current) => {
        if (repositorySelectionIntentRef.current) return current;
        if (preferredRepository) return preferredRepository;
        return (
          nextRepositories.find(
            (item) => item.fullName === current?.fullName
          ) ?? null
        );
      });
    } catch (reason) {
      if (
        sequence !== sequenceRef.current ||
        (reason as { name?: string })?.name === "AbortError"
      )
        return;
      setStale(true);
      setError(
        sanitizeMessage(
          reason instanceof Error ? reason.message : null,
          "GitHub pull requests are unavailable."
        )
      );
    } finally {
      if (sequence === sequenceRef.current) {
        statusLoadingRef.current = false;
        setStatusLoadedRevision((revision) => revision + 1);
        setLoading(false);
        controllerRef.current = null;
      }
    }
  }, [mode, resetChatState, reviewRunnerId, targetForRunner, initialReviewId]);

  // The effect owns the lifetime of the live gateway request.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadStatusAndRepositories();
    return () => {
      sequenceRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [loadStatusAndRepositories]);

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
      if (mode === "demo") {
        setPullRequests(
          nextRepository
            ? (DEMO_PULL_REQUESTS[nextRepository.fullName] ?? [])
            : []
        );
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
      if (loadedRepositoryRef.current !== (nextRepository?.fullName ?? "*")) {
        setPullRequests([]);
        setSelectedNumber(null);
        setSelectedRepositoryFullName(null);
        setSelectedDetail(null);
      }
      loadedRepositoryRef.current = nextRepository?.fullName ?? "*";
      try {
        if (!status?.accountId || !status.login || !status.connectionGeneration)
          throw new Error("Reconnect GitHub before loading the inbox.");
        const operation = await pullRequestsClient.runOperation(
          {
            kind: "inbox",
            account: { id: status.accountId, login: status.login },
            connectionGeneration: status.connectionGeneration,
            repository: nextRepository
              ? {
                  id: nextRepository.id,
                  owner: nextRepository.fullName.split("/")[0] ?? "",
                  name: nextRepository.fullName.split("/")[1] ?? "",
                  fullName: nextRepository.fullName
                }
              : null,
            cursor: null
          },
          { signal: controller.signal, target: targetForRunner(reviewRunnerId) }
        );
        if (sequence !== sequenceRef.current) return;
        const result = pullRequestOperationData(operation);
        if (Array.isArray(result.repositories)) {
          const verifiedRepositories = result.repositories
            .map(parseRepository)
            .filter((value): value is Repository => Boolean(value));
          setRepositories((current) => {
            const merged = new Map(
              current.map((item) => [item.fullName, item])
            );
            for (const item of verifiedRepositories)
              merged.set(item.fullName, item);
            return [...merged.values()];
          });
        }
        const inboxItems = Array.isArray(result.items)
          ? result.items
          : Array.isArray(result.pullRequests)
            ? result.pullRequests
            : [];
        const nextPulls = inboxItems
          .map(parseInboxItem)
          .filter((value): value is PullRequest => Boolean(value));
        setStale(false);
        setPullRequests(nextPulls);
        setPullRequestPage(1);
        setInboxCursor(
          result.hasMore === true
            ? typeof result.nextCursor === "string"
              ? result.nextCursor
              : "2"
            : null
        );
        setPullRequestsMore(result.hasMore === true);
      } catch (reason) {
        if (
          sequence !== sequenceRef.current ||
          (reason as { name?: string })?.name === "AbortError"
        )
          return;
        setStale(true);
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
    [mode, status, reviewRunnerId, targetForRunner]
  );

  // Repository changes are synchronized with the live gateway.
  useEffect(() => {
    if (statusLoadingRef.current) return;
    if (
      status?.state === "connected" ||
      repository ||
      loadedRepositoryRef.current
    ) {
      void loadPullRequests(repository);
    }
  }, [loadPullRequests, repository, status?.state, statusLoadedRevision]);

  const loadMorePullRequests = async () => {
    if (
      mode === "demo" ||
      !pullRequestsMore ||
      loadingMore ||
      !status?.accountId ||
      !status.login ||
      !status.connectionGeneration ||
      !inboxCursor
    )
      return;
    const nextPage = pullRequestPage + 1;
    const sequence = ++sequenceRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoadingMore(true);
    try {
      const operation = await pullRequestsClient.runOperation(
        {
          kind: "inbox",
          account: { id: status.accountId, login: status.login },
          connectionGeneration: status.connectionGeneration,
          repository: repository
            ? {
                id: repository.id,
                owner: repository.fullName.split("/")[0] ?? "",
                name: repository.fullName.split("/")[1] ?? "",
                fullName: repository.fullName
              }
            : null,
          cursor: inboxCursor
        },
        { signal: controller.signal, target: targetForRunner(reviewRunnerId) }
      );
      if (sequence !== sequenceRef.current) return;
      const result = pullRequestOperationData(operation);
      if (Array.isArray(result.repositories)) {
        const verifiedRepositories = result.repositories
          .map(parseRepository)
          .filter((value): value is Repository => Boolean(value));
        setRepositories((current) => {
          const merged = new Map(current.map((item) => [item.fullName, item]));
          for (const item of verifiedRepositories)
            merged.set(item.fullName, item);
          return [...merged.values()];
        });
      }
      const inboxItems = Array.isArray(result.items)
        ? result.items
        : Array.isArray(result.pullRequests)
          ? result.pullRequests
          : [];
      const next = inboxItems
        .map(parseInboxItem)
        .filter((value): value is PullRequest => Boolean(value));
      setStale(false);
      setPullRequests((current) => mergePullRequests(current, next));
      setPullRequestPage(nextPage);
      setInboxCursor(
        result.hasMore === true
          ? typeof result.nextCursor === "string"
            ? result.nextCursor
            : String(nextPage + 1)
          : null
      );
      setPullRequestsMore(result.hasMore === true);
    } catch (reason) {
      if (
        sequence === sequenceRef.current &&
        (reason as { name?: string })?.name !== "AbortError"
      ) {
        setStale(true);
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
    if (selectedNumber === null || !selectedRepositoryFullName) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedDetail(null);
      return;
    }
    const summary = pullRequests.find(
      (item) =>
        item.number === selectedNumber &&
        item.repositoryFullName === selectedRepositoryFullName
    );
    if (mode === "demo") {
      setSelectedDetail(summary ?? null);
      setDetailPayload(null);
      setMatchingProjects([]);
      return;
    }
    const selectedRepository = repositories.find(
      (item) => item.fullName === selectedRepositoryFullName
    );
    if (
      !selectedRepository ||
      !status?.accountId ||
      !status.login ||
      !status.connectionGeneration
    ) {
      setSelectedDetail(null);
      return;
    }
    setSelectedDetail(null);
    setDetailPayload(null);
    setDetailOperationId(null);
    setMatchingProjects([]);
    setReviewRecord(null);
    setReviewDraft(null);
    setFrozenReview(null);
    setPublishedReviewUrl(null);
    setUncertainPublishOperationId(null);
    setPublishGrant(null);
    setPendingPublishOperation(null);
    setPendingPushOperation(null);
    setUncertainPushOperationId(null);
    setPushProposal(null);
    setPushGrant(null);
    setPushError(null);
    const sequence = ++detailSequenceRef.current;
    detailControllerRef.current?.abort();
    const controller = new AbortController();
    detailControllerRef.current = controller;
    void pullRequestsClient
      .runOperation(
        {
          kind: "pull_request_details",
          account: { id: status.accountId, login: status.login },
          connectionGeneration: status.connectionGeneration,
          repository: {
            id: selectedRepository.id,
            owner: selectedRepository.fullName.split("/")[0] ?? "",
            name: selectedRepository.fullName.split("/")[1] ?? "",
            fullName: selectedRepository.fullName
          },
          pullRequestNumber: selectedNumber
        },
        { signal: controller.signal, target: targetForRunner(reviewRunnerId) }
      )
      .then(async (operation) => {
        if (sequence !== detailSequenceRef.current) return;
        const result = pullRequestOperationData(operation);
        const detail = parsePullRequest(result.pullRequest);
        if (!detail || detail.number !== selectedNumber) {
          throw new Error("Pull request details are unavailable.");
        }
        setSelectedDetail({
          ...detail,
          repositoryFullName: selectedRepository.fullName
        });
        setDetailPayload(result);
        setDetailOperationId(operation.id);
        setMatchingProjects(
          Array.isArray(result.matchingProjects)
            ? result.matchingProjects.flatMap((project) => {
                if (!project || typeof project !== "object") return [];
                const candidate = project as Record<string, unknown>;
                return typeof candidate.id === "string" &&
                  typeof candidate.name === "string"
                  ? [{ id: candidate.id, name: candidate.name }]
                  : [];
              })
            : []
        );
        setSelectedProjectId("");
        try {
          const existingReviews = await pullRequestsClient.listReviews(
            {
              repository: selectedRepository.id,
              number: selectedNumber
            },
            controller.signal
          );
          if (sequence !== detailSequenceRef.current) return;
          const matching = existingReviews
            .filter(
              (review) =>
                review.account.id === status.accountId &&
                review.repository.fullName === selectedRepository.fullName &&
                review.pullRequestNumber === selectedNumber
            )
            .sort((left, right) =>
              right.updatedAt.localeCompare(left.updatedAt)
            );
          const chosen =
            matching.find((review) => review.id === initialReviewId) ??
            matching.find((review) => review.agentId === reviewAgentId) ??
            matching[0];
          if (chosen) {
            setReviewRecord(chosen);
            setReviewAgentId(chosen.agentId);
            setSelectedProjectId(chosen.projectId ?? "");
            const operations = await pullRequestsClient.listOperations(
              { limit: 100 },
              controller.signal
            );
            const pending = operations.operations.find(
              (candidate) =>
                candidate.reviewId === chosen.id &&
                (candidate.state === "pending" ||
                  candidate.state === "claimed") &&
                (candidate.payload.kind === "publish_review" ||
                  candidate.payload.kind === "prepare_push" ||
                  candidate.payload.kind === "push")
            );
            if (pending?.payload.kind === "publish_review")
              setPendingPublishOperation(pending);
            if (
              pending?.payload.kind === "prepare_push" ||
              pending?.payload.kind === "push"
            )
              setPendingPushOperation(pending);
            const uncertain = operations.operations.find(
              (candidate) =>
                candidate.reviewId === chosen.id &&
                candidate.state === "uncertain" &&
                (candidate.payload.kind === "publish_review" ||
                  candidate.payload.kind === "push")
            );
            if (uncertain?.payload.kind === "publish_review")
              setUncertainPublishOperationId(uncertain.id);
            if (uncertain?.payload.kind === "push")
              setUncertainPushOperationId(uncertain.id);
            if (chosen.executionId) {
              const [draft, frozen, conversation] = await Promise.all([
                pullRequestsClient.getDraft(chosen.id, controller.signal),
                pullRequestsClient.getFrozenReview(
                  chosen.id,
                  controller.signal
                ),
                loadHostedManagedConversation(
                  chosen.executionId,
                  controller.signal
                )
              ]);
              if (sequence !== detailSequenceRef.current) return;
              setReviewDraft(draft);
              setFrozenReview(frozen);
              setReviewExecutionGeneration(
                conversation.runtime.execution.executionGeneration
              );
              setReviewPermissionMode(
                conversation.runtime.execution.permissionMode
              );
              setReviewModelKey(
                `${conversation.runtime.execution.provider}:${conversation.runtime.execution.model}`
              );
              setReviewExecutionEffort(
                conversation.runtime.execution.reasoningEffort ?? "high"
              );
            }
          }
        } catch (reason) {
          if (
            sequence !== detailSequenceRef.current ||
            (reason as { name?: string })?.name === "AbortError"
          )
            return;
          setReviewError(
            `Could not restore this review Conversation: ${sanitizeMessage(reason instanceof Error ? reason.message : null, "The saved Conversation is unavailable.")}`
          );
        }
      })
      .catch((reason) => {
        if (
          sequence !== detailSequenceRef.current ||
          (reason as { name?: string })?.name === "AbortError"
        )
          return;
        setStale(true);
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
  }, [
    initialReviewId,
    mode,
    pullRequests,
    repositories,
    reviewRunnerId,
    selectedNumber,
    selectedRepositoryFullName,
    reviewAgentId,
    status,
    targetForRunner
  ]);

  useEffect(() => {
    if (mode === "demo" || !reviewRecord?.executionId || reviewDraft !== null)
      return;
    let active = true;
    const timer = window.setInterval(() => {
      void Promise.all([
        pullRequestsClient.getReview(reviewRecord.id),
        pullRequestsClient.getDraft(reviewRecord.id)
      ])
        .then(([latestReview, latestDraft]) => {
          if (!active) return;
          setReviewRecord((current) =>
            current?.id === latestReview.id &&
            latestReview.revision >= current.revision
              ? latestReview
              : current
          );
          if (latestDraft) setReviewDraft(latestDraft);
        })
        .catch(() => {
          // Temporary polling failures leave the durable conversation visible.
        });
    }, 1_500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [mode, reviewDraft, reviewRecord?.executionId, reviewRecord?.id]);

  const activeReviewId = reviewRecord?.id;
  useEffect(() => {
    if (mode === "demo" || !activeReviewId) return;
    let active = true;
    void pullRequestsClient
      .listOperations({ limit: 100 })
      .then((page) => {
        if (!active) return;
        const matching = page.operations.find(
          (operation) =>
            operation.reviewId === activeReviewId &&
            operation.payload.kind === "publish_review" &&
            operation.payload.reviewId === activeReviewId &&
            (operation.state === "pending" ||
              operation.state === "claimed" ||
              operation.state === "uncertain")
        );
        if (!matching) return;
        if (matching.state === "uncertain")
          setUncertainPublishOperationId(matching.id);
        else setPendingPublishOperation(matching);
      })
      .catch(() => {
        /* The durable review remains usable when operation history is unavailable. */
      });
    return () => {
      active = false;
    };
  }, [activeReviewId, mode]);

  const filteredPullRequests = useMemo(() => {
    const login = status?.login?.toLocaleLowerCase("en-US") ?? "";
    const query = search.trim().toLocaleLowerCase("en-US");
    return pullRequests.filter((item) => {
      const authored = item.inboxOrigin
        ? item.inboxOrigin === "authored" ||
          item.inboxOrigin === "authored_and_requested_review"
        : login !== "" && item.author.toLocaleLowerCase("en-US") === login;
      const reviewing = item.inboxOrigin
        ? item.inboxOrigin === "requested_review" ||
          item.inboxOrigin === "authored_and_requested_review"
        : login !== "" &&
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
          `${item.repositoryFullName ?? ""} ${item.title} ${item.author} #${item.number}`
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

  const startAgentReview = async () => {
    const selectedRepository =
      repositories.find(
        (item) => item.fullName === selectedRepositoryFullName
      ) ?? repository;
    if (
      !selectedDetail ||
      !selectedRepository ||
      !reviewAgentId ||
      !launchOptions
    )
      return;
    const agent = chatAgents.find(
      (candidate) => candidate.id === reviewAgentId
    );
    const selectedRunner = launchOptions.runners.find(
      (runner) =>
        runner.deviceId === reviewRunnerId &&
        sourceControlRunners.some(
          (target) => target.deviceId === runner.deviceId
        )
    );
    const instances = hostedLaunchInstancesForDevice(
      launchOptions,
      reviewRunnerId
    );
    const selectedModel = instances
      .flatMap((instance) => instance.models)
      .find((model) => `${model.provider}:${model.id}` === reviewModelKey);
    const selectedInstance = instances.find(
      (instance) => instance.instanceId === selectedModel?.instanceId
    );
    if (
      !agent ||
      !selectedRunner ||
      !selectedModel ||
      !selectedInstance?.permissionModes.includes(reviewPermissionMode) ||
      !selectedModel.supportedReasoningEfforts.includes(reviewExecutionEffort)
    ) {
      setReviewError(
        "Choose an available Agent, runner, and supported model before starting a review."
      );
      return;
    }
    if (!status?.accountId || !status.connectionGeneration) {
      setReviewError("Refresh the GitHub connection before starting a review.");
      return;
    }
    setReviewJobBusy(true);
    setReviewError(null);
    try {
      if (!detailOperationId) {
        throw new Error(
          "Verified pull request details are still loading. Retry after the inbox finishes loading them."
        );
      }
      const review = await pullRequestsClient.createReview({
        requestId: crypto.randomUUID(),
        detailsOperationId: detailOperationId,
        agentId: agent.id,
        ...(selectedProjectId ? { projectId: selectedProjectId } : {})
      });
      setReviewRecord(review);
      if (review.executionId) {
        if (
          review.expectedHeadSha !== selectedDetail.headSha ||
          review.expectedBaseSha !== selectedDetail.baseSha
        ) {
          setReviewError(
            "This Agent already has a durable review for an older pull request revision. Choose Review latest changes to continue the same chat."
          );
          return;
        }
        const existing = await loadHostedManagedConversation(
          review.executionId
        );
        setReviewExecutionGeneration(
          existing.runtime.execution.executionGeneration
        );
        setReviewPermissionMode(existing.runtime.execution.permissionMode);
        setReviewModelKey(
          `${existing.runtime.execution.provider}:${existing.runtime.execution.model}`
        );
        setReviewExecutionEffort(
          existing.runtime.execution.reasoningEffort ?? "high"
        );
        setReviewDraft(await pullRequestsClient.getDraft(review.id));
        setDetailView("chat");
        return;
      }
      setReviewDraft(null);
      setFrozenReview(null);
      const initialPrompt = `Review pull request #${selectedDetail.number} (${selectedRepository.fullName}). Goal: review the current pull request changes, identify actionable bugs or risks, and produce an editable review draft with a concise summary and inline findings. Do not modify files or push changes. Return the findings through the review draft workflow.`;
      const started = await startHostedManagedConversation({
        projectId: review.projectId ?? null,
        contextKind: review.projectId ? "project" : "independent",
        provider: selectedModel.provider,
        aiClientInstanceId:
          selectedModel.instanceId ?? selectedInstance.instanceId,
        model: selectedModel.id,
        reasoningEffort: reviewExecutionEffort,
        permissionMode: reviewPermissionMode,
        targetDeviceId: selectedRunner.deviceId,
        idempotencyKey: crypto.randomUUID(),
        initialPrompt,
        initialPromptClientUserMessageId: crypto.randomUUID(),
        agentId: agent.id,
        expectedAgentVersion: agent.currentVersion,
        pullRequestReviewId: review.id
      });
      const current = await pullRequestsClient.getReview(review.id);
      if (current.executionId !== started.execution.id) {
        throw new Error(
          "The review Job did not bind to the started Conversation. Refresh the review before continuing."
        );
      }
      setReviewRecord(current);
      setReviewExecutionGeneration(started.execution.executionGeneration);
      setReviewPermissionMode(started.execution.permissionMode);
      setReviewModelKey(
        `${started.execution.provider}:${started.execution.model}`
      );
      setReviewExecutionEffort(started.execution.reasoningEffort ?? "high");
      const persistedConversation = await loadHostedManagedConversation(
        current.executionId!
      );
      setReviewExecutionGeneration(
        persistedConversation.runtime.execution.executionGeneration
      );
      setReviewDraft(await pullRequestsClient.getDraft(current.id));
      setDetailView("chat");
    } catch (reason) {
      setReviewError(
        reason instanceof Error
          ? reason.message
          : "The Agent review could not be started."
      );
    } finally {
      setReviewJobBusy(false);
    }
  };
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

  const chatAccountLogin = reviewRecord?.account.login ?? status?.login ?? null;
  const chatRepository =
    repositories.find((item) => item.fullName === selectedRepositoryFullName) ??
    repository;
  const chatRepositoryId = chatRepository?.id ?? null;
  const chatRepositoryFullName =
    selectedRepositoryFullName ?? repository?.fullName ?? null;
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
      chatBaseSha === null ||
      !reviewRecord?.executionId ||
      !reviewRecord.agentId ||
      reviewRecord.repository.fullName !== chatRepositoryFullName ||
      reviewRecord.pullRequestNumber !== chatPullRequestNumber ||
      reviewExecutionGeneration === null
    )
      return null;
    return {
      accountId: reviewRecord.account.id,
      accountLogin: chatAccountLogin,
      repositoryId: chatRepositoryId,
      repositoryFullName: chatRepositoryFullName,
      pullRequestNumber: chatPullRequestNumber,
      headSha: chatHeadSha,
      baseSha: chatBaseSha,
      reviewId: reviewRecord.id,
      executionId: reviewRecord.executionId,
      executionGeneration: reviewExecutionGeneration,
      agentId: reviewRecord.agentId,
      agentVersion:
        chatAgents.find((agent) => agent.id === reviewRecord.agentId)
          ?.currentVersion ?? reviewRecord.agentVersion
    };
  }, [
    chatAccountLogin,
    chatBaseSha,
    chatHeadSha,
    chatPullRequestNumber,
    chatRepositoryFullName,
    chatRepositoryId,
    reviewExecutionGeneration,
    reviewRecord,
    chatAgents
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
    return null;
  })();

  // Opening Chat is useful even when its runtime prerequisite is missing: the
  // panel explains the exact prerequisite and keeps Send disabled.
  const chatAvailable = Boolean(chatScope);
  const chatScopeKey = chatScope
    ? `${chatScope.reviewId}:${chatScope.agentId}`
    : null;
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

  const reviewModels = useMemo(
    () =>
      launchOptions
        ? hostedLaunchInstancesForDevice(launchOptions, reviewRunnerId).flatMap(
            (instance) => instance.models
          )
        : [],
    [launchOptions, reviewRunnerId]
  );
  const reviewRunners = useMemo(() => {
    const available = new Set(
      (launchOptions?.runners ?? []).map((runner) => runner.deviceId)
    );
    return sourceControlRunners
      .filter((runner) => available.has(runner.deviceId))
      .map((runner) => ({
        deviceId: runner.deviceId,
        displayName: runner.label
      }));
  }, [launchOptions, sourceControlRunners]);
  const reviewPermissionModes = useMemo(() => {
    const model = reviewModels.find(
      (item) => `${item.provider}:${item.id}` === reviewModelKey
    );
    return (
      launchOptions?.instances.find(
        (item) => item.instanceId === model?.instanceId
      )?.permissionModes ?? []
    );
  }, [launchOptions, reviewModelKey, reviewModels]);
  const saveReviewDraft = async (value: {
    event: NonNullable<PullRequestReviewDraft["event"]> | null;
    body: string;
    findings: PullRequestReviewDraft["findings"];
  }) => {
    if (!reviewRecord || reviewExecutionGeneration === null) return;
    setReviewError(null);
    try {
      const saved = await pullRequestsClient.saveDraft(reviewRecord.id, {
        expectedReviewRevision: reviewRecord.revision,
        expectedDraftRevision: reviewDraft?.revision ?? 0,
        executionGeneration: reviewExecutionGeneration,
        connectionGeneration: reviewRecord.connectionGeneration,
        accountId: reviewRecord.account.id,
        baseSha: reviewRecord.expectedBaseSha,
        headSha: reviewRecord.expectedHeadSha,
        ...value
      });
      setReviewDraft(saved);
      setReviewRecord(await pullRequestsClient.getReview(reviewRecord.id));
    } catch (reason) {
      setReviewError(
        reason instanceof Error
          ? reason.message
          : "The review draft could not be saved."
      );
    }
  };
  const freezeReviewDraft = async () => {
    if (!reviewRecord || !reviewDraft || reviewExecutionGeneration === null)
      return;
    setReviewError(null);
    try {
      setFrozenReview(
        await pullRequestsClient.freezeDraft(reviewRecord.id, {
          expectedReviewRevision: reviewRecord.revision,
          expectedDraftRevision: reviewDraft.revision,
          executionGeneration: reviewExecutionGeneration,
          connectionGeneration: reviewRecord.connectionGeneration,
          accountId: reviewRecord.account.id,
          baseSha: reviewRecord.expectedBaseSha,
          headSha: reviewRecord.expectedHeadSha
        })
      );
      setReviewRecord(await pullRequestsClient.getReview(reviewRecord.id));
    } catch (reason) {
      setReviewError(
        reason instanceof Error
          ? reason.message
          : "The exact review content could not be frozen."
      );
    }
  };
  const publishReview = async (frozenReviewId: string) => {
    if (!reviewRecord) return;
    setReviewError(null);
    try {
      const frozen = frozenReview?.id === frozenReviewId ? frozenReview : null;
      if (!frozen)
        throw new Error(
          "The frozen review content is unavailable. Refresh before publishing."
        );
      let grant = publishGrant;
      const nativeApprovalRequired =
        pullRequestsClient.basePath.startsWith("/studio-api");
      if (nativeApprovalRequired && !grant) {
        const commandRequestId = crypto.randomUUID();
        const operationRequestId = crypto.randomUUID();
        const status = await pullRequestsClient.requestActionGrant({
          kind: "publish_review",
          commandRequestId,
          requestId: operationRequestId,
          reviewId: reviewRecord.id,
          frozenReviewId,
          confirmationDigest: frozen.digest,
          expectedReviewRevision: reviewRecord.revision,
          targetDeviceId: reviewRecord.targetDeviceId,
          targetDeploymentId: reviewRecord.targetDeploymentId
        });
        grant = { status, commandRequestId, operationRequestId };
        setPublishGrant(grant);
        if (status.state !== "approved") return;
      }
      if (
        grant &&
        (grant.status.state === "review_required" ||
          grant.status.state === "pending")
      ) {
        setReviewError(
          "Source-control approval is required before this review can be published."
        );
        return;
      }
      if (grant && grant.status.state !== "approved") {
        throw new Error(
          `Source-control approval is ${grant.status.state}. Request a new exact-content confirmation before retrying.`
        );
      }
      const publishPayload = {
        kind: "publish_review" as const,
        reviewId: reviewRecord.id,
        frozenReviewId,
        confirmationDigest: frozen.digest,
        expectedReviewRevision: reviewRecord.revision
      };
      const publishConfirmation = {
        confirmed: true,
        frozenReviewId,
        digest: frozen.digest
      };
      const publishOperation = await pullRequestsClient.createOperation(
        publishPayload,
        undefined,
        grant?.operationRequestId,
        publishConfirmation,
        {
          target: {
            deviceId: reviewRecord.targetDeviceId,
            deploymentId: reviewRecord.targetDeploymentId
          },
          ...(grant
            ? {
                actionGrantId: grant.status.actionGrant.id,
                commandRequestId: grant.commandRequestId
              }
            : {})
        }
      );
      if (
        publishOperation.state === "pending" ||
        publishOperation.state === "claimed"
      ) {
        setPendingPublishOperation(publishOperation);
        return;
      }
      const published = await pullRequestsClient.waitForOperation(
        publishOperation,
        {
          onUpdate: (operation) => {
            if (operation.state === "pending" || operation.state === "claimed")
              setPendingPublishOperation(operation);
          }
        }
      );
      const result = pullRequestOperationData(published);
      setUncertainPublishOperationId(null);
      setPublishedReviewUrl(
        typeof result.url === "string"
          ? result.url
          : typeof result.htmlUrl === "string"
            ? result.htmlUrl
            : null
      );
      setReviewRecord(await pullRequestsClient.getReview(reviewRecord.id));
      setPublishGrant(null);
      setPendingPublishOperation(null);
    } catch (reason) {
      if (
        reason &&
        typeof reason === "object" &&
        typeof (reason as { operationId?: unknown }).operationId === "string"
      ) {
        const operationId = (reason as { operationId: string }).operationId;
        try {
          const operation = await pullRequestsClient.loadOperation(operationId);
          if (operation.state === "pending" || operation.state === "claimed")
            setPendingPublishOperation(operation);
          else if (operation.state === "uncertain")
            setUncertainPublishOperationId(operation.id);
        } catch {
          /* Preserve the operation identifier in the error for later recovery. */
        }
      }
      setReviewError(
        reason instanceof Error
          ? reason.message
          : "GitHub did not confirm publication."
      );
    }
  };
  const checkPendingPublish = async () => {
    if (!pendingPublishOperation) return;
    setReviewJobBusy(true);
    setReviewError(null);
    try {
      const operation = await pullRequestsClient.loadOperation(
        pendingPublishOperation.id
      );
      setPendingPublishOperation(
        operation.state === "pending" || operation.state === "claimed"
          ? operation
          : null
      );
      if (operation.state === "uncertain")
        setUncertainPublishOperationId(operation.id);
      if (operation.state === "completed") {
        const result = pullRequestOperationData(operation);
        setPublishedReviewUrl(
          typeof result.url === "string"
            ? result.url
            : typeof result.htmlUrl === "string"
              ? result.htmlUrl
              : null
        );
        if (reviewRecord)
          setReviewRecord(await pullRequestsClient.getReview(reviewRecord.id));
      } else if (
        operation.state === "failed" ||
        operation.state === "cancelled"
      ) {
        setReviewError(
          operation.errorCode
            ? `Publication ${operation.state}: ${operation.errorCode}`
            : `Publication ${operation.state}.`
        );
      }
    } catch (reason) {
      setReviewError(
        reason instanceof Error
          ? reason.message
          : "The publication status could not be checked."
      );
    } finally {
      setReviewJobBusy(false);
    }
  };
  const cancelPendingPublish = async () => {
    if (!pendingPublishOperation) return;
    setReviewJobBusy(true);
    try {
      const operation = await pullRequestsClient.cancelOperation(
        pendingPublishOperation.id,
        pendingPublishOperation.revision
      );
      setPendingPublishOperation(
        operation.state === "pending" || operation.state === "claimed"
          ? operation
          : null
      );
      if (operation.state === "cancelled")
        setReviewError(
          "The queued publication was cancelled before it completed."
        );
    } catch (reason) {
      setReviewError(
        reason instanceof Error
          ? reason.message
          : "The publication could not be cancelled."
      );
    } finally {
      setReviewJobBusy(false);
    }
  };
  const checkPendingPush = async () => {
    if (!pendingPushOperation) return;
    setPushBusy(true);
    try {
      const operation = await pullRequestsClient.loadOperation(
        pendingPushOperation.id
      );
      if (operation.state === "pending" || operation.state === "claimed")
        setPendingPushOperation(operation);
      else setPendingPushOperation(null);
      if (operation.state === "uncertain")
        setUncertainPushOperationId(operation.id);
      if (
        operation.state === "completed" &&
        operation.payload.kind === "prepare_push"
      ) {
        const proposal = parsePushProposal(operation);
        if (proposal) setPushProposal(proposal);
        else
          setPushError(
            "The runner returned an incomplete push proposal; no push was started."
          );
      } else if (
        operation.state === "completed" &&
        operation.payload.kind === "push"
      ) {
        setPushProposal(null);
        setReviewRecord(
          await pullRequestsClient.getReview(operation.payload.reviewId)
        );
      }
    } catch (reason) {
      setPushError(
        reason instanceof Error
          ? reason.message
          : "The push status could not be checked."
      );
    } finally {
      setPushBusy(false);
    }
  };
  const cancelPendingPush = async () => {
    if (!pendingPushOperation) return;
    setPushBusy(true);
    try {
      const operation = await pullRequestsClient.cancelOperation(
        pendingPushOperation.id,
        pendingPushOperation.revision
      );
      setPendingPushOperation(
        operation.state === "pending" || operation.state === "claimed"
          ? operation
          : null
      );
      if (operation.state === "cancelled")
        setPushError(
          "The queued push operation was cancelled before it completed."
        );
    } catch (reason) {
      setPushError(
        reason instanceof Error
          ? reason.message
          : "The queued push operation could not be cancelled."
      );
    } finally {
      setPushBusy(false);
    }
  };
  const updatePublishGrant = async (
    command: "await" | "confirm",
    decision?: "approve"
  ) => {
    if (!publishGrant) return;
    setReviewJobBusy(true);
    setReviewError(null);
    try {
      const status = await pullRequestsClient.updateActionGrant(
        publishGrant.status.actionGrant.id,
        {
          requestId: crypto.randomUUID(),
          command,
          ...(decision ? { decision } : {}),
          actionGrantId: publishGrant.status.actionGrant.id
        }
      );
      setPublishGrant({ ...publishGrant, status });
      if (
        status.state === "denied" ||
        status.state === "canceled" ||
        status.state === "expired" ||
        status.state === "revoked"
      ) {
        setReviewError(
          `Source-control approval is ${status.state}; the frozen review remains unpublished.`
        );
      }
    } catch (reason) {
      setReviewError(
        reason instanceof Error
          ? reason.message
          : "The source-control approval status could not be updated."
      );
    } finally {
      setReviewJobBusy(false);
    }
  };
  const reconcilePublishedReview = async () => {
    if (!reviewRecord || !frozenReview || !uncertainPublishOperationId) return;
    setReviewJobBusy(true);
    setReviewError(null);
    try {
      const operation = await pullRequestsClient.runOperation(
        {
          kind: "reconcile_review",
          reviewId: reviewRecord.id,
          frozenReviewId: frozenReview.id,
          uncertainOperationId: uncertainPublishOperationId
        },
        {
          target: {
            deviceId: reviewRecord.targetDeviceId,
            deploymentId: reviewRecord.targetDeploymentId
          }
        }
      );
      const result = pullRequestOperationData(operation);
      setPublishedReviewUrl(
        typeof result.url === "string"
          ? result.url
          : typeof result.htmlUrl === "string"
            ? result.htmlUrl
            : null
      );
      setReviewRecord(await pullRequestsClient.getReview(reviewRecord.id));
      setUncertainPublishOperationId(null);
    } catch (reason) {
      setReviewError(
        reason instanceof Error
          ? reason.message
          : "The GitHub publication outcome is not yet known."
      );
    } finally {
      setReviewJobBusy(false);
    }
  };
  const preparePushProposal = async () => {
    if (!reviewRecord || reviewRecord.workMode !== "fix") return;
    setPushBusy(true);
    setPushError(null);
    setPushProposal(null);
    setPushGrant(null);
    try {
      const operation = await pullRequestsClient.createOperation(
        {
          kind: "prepare_push",
          reviewId: reviewRecord.id,
          expectedRevision: reviewRecord.revision
        },
        undefined,
        undefined,
        undefined,
        {
          target: {
            deviceId: reviewRecord.targetDeviceId,
            deploymentId: reviewRecord.targetDeploymentId
          }
        }
      );
      if (operation.state === "pending" || operation.state === "claimed") {
        setPendingPushOperation(operation);
        return;
      }
      const completed = await pullRequestsClient.waitForOperation(operation, {
        onUpdate: (next) => {
          if (next.state === "pending" || next.state === "claimed")
            setPendingPushOperation(next);
        }
      });
      setPendingPushOperation(null);
      const proposal = parsePushProposal(completed);
      if (!proposal)
        throw new Error(
          "The runner returned an incomplete push proposal; no push was started."
        );
      setPushProposal(proposal);
    } catch (reason) {
      const operationId =
        reason &&
        typeof reason === "object" &&
        typeof (reason as { operationId?: unknown }).operationId === "string"
          ? (reason as { operationId: string }).operationId
          : null;
      if (operationId) {
        try {
          const operation = await pullRequestsClient.loadOperation(operationId);
          if (operation.state === "pending" || operation.state === "claimed")
            setPendingPushOperation(operation);
          if (operation.state === "uncertain")
            setUncertainPushOperationId(operation.id);
        } catch {
          /* Keep the operation id in the displayed error. */
        }
      }
      setPushError(
        reason instanceof Error
          ? reason.message
          : "A push proposal could not be prepared."
      );
    } finally {
      setPushBusy(false);
    }
  };
  const pushProposalToGitHub = async (
    proposalId: string,
    diffDigest: string
  ) => {
    if (
      !reviewRecord ||
      !pushProposal ||
      pushProposal.id !== proposalId ||
      pushProposal.diffDigest !== diffDigest
    )
      return;
    setPushBusy(true);
    setPushError(null);
    try {
      let grant = pushGrant;
      const nativeApprovalRequired =
        pullRequestsClient.basePath.startsWith("/studio-api");
      if (nativeApprovalRequired && !grant) {
        const commandRequestId = crypto.randomUUID();
        const operationRequestId = crypto.randomUUID();
        const status = await pullRequestsClient.requestActionGrant({
          kind: "push",
          commandRequestId,
          requestId: operationRequestId,
          reviewId: reviewRecord.id,
          proposalId,
          confirmationDigest: diffDigest,
          expectedReviewRevision: reviewRecord.revision,
          targetDeviceId: reviewRecord.targetDeviceId,
          targetDeploymentId: reviewRecord.targetDeploymentId
        });
        grant = { status, commandRequestId, operationRequestId };
        setPushGrant(grant);
        if (status.state !== "approved") {
          setPushError(
            "Source-control approval is required before pushing this proposal."
          );
          return;
        }
      }
      if (grant && grant.status.state !== "approved") {
        setPushError(
          "Source-control approval is not complete; the prepared diff remains unchanged."
        );
        return;
      }
      const pushOperation = await pullRequestsClient.createOperation(
        {
          kind: "push",
          reviewId: reviewRecord.id,
          pushProposalId: proposalId,
          confirmationDigest: diffDigest,
          expectedReviewRevision: reviewRecord.revision
        },
        undefined,
        grant?.operationRequestId,
        { confirmed: true, proposalId, digest: diffDigest },
        {
          target: {
            deviceId: reviewRecord.targetDeviceId,
            deploymentId: reviewRecord.targetDeploymentId
          },
          ...(grant
            ? {
                actionGrantId: grant.status.actionGrant.id,
                commandRequestId: grant.commandRequestId
              }
            : {})
        }
      );
      if (
        pushOperation.state === "pending" ||
        pushOperation.state === "claimed"
      ) {
        setPendingPushOperation(pushOperation);
        return;
      }
      const operation = await pullRequestsClient.waitForOperation(
        pushOperation,
        {
          onUpdate: (next) => {
            if (next.state === "pending" || next.state === "claimed")
              setPendingPushOperation(next);
          }
        }
      );
      setPendingPushOperation(null);
      setUncertainPushOperationId(null);
      setPushError(
        operation.state === "completed"
          ? null
          : "The push operation did not complete."
      );
      if (operation.state === "completed") {
        setPushProposal(null);
        setPushGrant(null);
        setReviewRecord(await pullRequestsClient.getReview(reviewRecord.id));
      }
    } catch (reason) {
      const operationId =
        reason &&
        typeof reason === "object" &&
        typeof (reason as { operationId?: unknown }).operationId === "string"
          ? (reason as { operationId: string }).operationId
          : null;
      if (operationId) {
        try {
          const operation = await pullRequestsClient.loadOperation(operationId);
          if (operation.state === "pending" || operation.state === "claimed")
            setPendingPushOperation(operation);
          if (operation.state === "uncertain")
            setUncertainPushOperationId(operation.id);
        } catch {
          /* Keep operation id in the error for later recovery. */
        }
      }
      setPushError(
        reason instanceof Error
          ? reason.message
          : "GitHub did not confirm the push."
      );
    } finally {
      setPushBusy(false);
    }
  };
  const reconcilePush = async () => {
    if (!reviewRecord || !pushProposal || !uncertainPushOperationId) return;
    setPushBusy(true);
    setPushError(null);
    try {
      const operation = await pullRequestsClient.runOperation(
        {
          kind: "reconcile_push",
          reviewId: reviewRecord.id,
          pushProposalId: pushProposal.id,
          uncertainOperationId: uncertainPushOperationId
        },
        {
          target: {
            deviceId: reviewRecord.targetDeviceId,
            deploymentId: reviewRecord.targetDeploymentId
          }
        }
      );
      setUncertainPushOperationId(null);
      setPendingPushOperation(null);
      setPushError(
        operation.state === "completed"
          ? "The remote outcome was reconciled. Review the pull request before preparing another proposal."
          : null
      );
      setPushProposal(null);
      setReviewRecord(await pullRequestsClient.getReview(reviewRecord.id));
    } catch (reason) {
      setPushError(
        reason instanceof Error
          ? reason.message
          : "The push outcome is not yet known."
      );
    } finally {
      setPushBusy(false);
    }
  };
  const updatePushGrant = async (
    command: "await" | "confirm",
    decision?: "approve"
  ) => {
    if (!pushGrant) return;
    setPushBusy(true);
    try {
      const status = await pullRequestsClient.updateActionGrant(
        pushGrant.status.actionGrant.id,
        {
          requestId: crypto.randomUUID(),
          command,
          ...(decision ? { decision } : {}),
          actionGrantId: pushGrant.status.actionGrant.id
        }
      );
      setPushGrant({ ...pushGrant, status });
    } catch (reason) {
      setPushError(
        reason instanceof Error
          ? reason.message
          : "The source-control approval could not be checked."
      );
    } finally {
      setPushBusy(false);
    }
  };
  const reviewLatest = async () => {
    const selectedRepository =
      repositories.find(
        (item) => item.fullName === selectedRepositoryFullName
      ) ?? repository;
    if (
      !reviewRecord ||
      !selectedRepository ||
      !status?.accountId ||
      !status.login ||
      !status.connectionGeneration
    )
      return;
    setReviewJobBusy(true);
    setReviewError(null);
    try {
      const detailOperation = await pullRequestsClient.runOperation(
        {
          kind: "pull_request_details",
          account: { id: status.accountId, login: status.login },
          connectionGeneration: status.connectionGeneration,
          repository: {
            id: selectedRepository.id,
            owner: selectedRepository.fullName.split("/")[0] ?? "",
            name: selectedRepository.fullName.split("/")[1] ?? "",
            fullName: selectedRepository.fullName
          },
          pullRequestNumber: reviewRecord.pullRequestNumber
        },
        {
          target: {
            deviceId: reviewRecord.targetDeviceId,
            deploymentId: reviewRecord.targetDeploymentId
          }
        }
      );
      const result = pullRequestOperationData(detailOperation);
      const updated = await pullRequestsClient.refreshReview(
        reviewRecord.id,
        reviewRecord.revision,
        detailOperation.id
      );
      if (!updated.executionId)
        throw new Error("The existing review Conversation is unavailable.");
      setReviewRecord(updated);
      setFrozenReview(null);
      setSelectedDetail(parsePullRequest(result.pullRequest));
      const loaded = await loadHostedManagedConversation(updated.executionId);
      setReviewExecutionGeneration(
        loaded.runtime.execution.executionGeneration
      );
      const prompt = `Review the latest changes to pull request #${updated.pullRequestNumber} (${updated.repository.fullName}). Goal: review the newly updated diff, identify actionable bugs or risks, and update the editable review draft. Do not modify files or push changes.`;
      await queueHostedConversationPrompt(loaded.runtime.execution, prompt, {
        idempotencyKey: crypto.randomUUID(),
        clientUserMessageId: crypto.randomUUID(),
        agentId: updated.agentId,
        expectedAgentVersion:
          chatAgents.find((agent) => agent.id === updated.agentId)
            ?.currentVersion ?? updated.agentVersion
      });
      setReviewDraft(await pullRequestsClient.getDraft(updated.id));
      setDetailView("chat");
    } catch (reason) {
      setReviewError(
        reason instanceof Error
          ? reason.message
          : "The latest pull request revision could not be assigned to the existing review Job."
      );
    } finally {
      setReviewJobBusy(false);
    }
  };
  const enableFixesAndSend = async (request: string) => {
    if (
      !reviewRecord?.executionId ||
      !reviewExecutionGeneration ||
      !request.trim()
    )
      return;
    setEnablingFixes(true);
    setReviewError(null);
    try {
      const enabled = await pullRequestsClient.enableFixes(
        reviewRecord.id,
        reviewRecord.revision
      );
      setReviewRecord(enabled);
      const loaded = await loadHostedManagedConversation(
        reviewRecord.executionId
      );
      if (
        loaded.runtime.execution.executionGeneration !==
        reviewExecutionGeneration
      ) {
        throw new Error(
          "The review Job changed. Refresh before sending the fixes request."
        );
      }
      await queueHostedConversationPrompt(
        loaded.runtime.execution,
        request.trim(),
        {
          idempotencyKey: crypto.randomUUID(),
          clientUserMessageId: crypto.randomUUID(),
          agentId: reviewRecord.agentId,
          expectedAgentVersion:
            chatAgents.find((agent) => agent.id === reviewRecord.agentId)
              ?.currentVersion ?? reviewRecord.agentVersion
        }
      );
      setDetailView("chat");
    } catch (reason) {
      setReviewError(
        reason instanceof Error
          ? reason.message
          : "The explicit fixes request could not be sent."
      );
    } finally {
      setEnablingFixes(false);
    }
  };

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
                          className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === value ? "bg-surface-hover text-foreground" : "text-muted hover:bg-surface hover:text-foreground-secondary"}`}
                        >
                          {value === "reviewing"
                            ? "Review requested"
                            : value === "all"
                              ? "All"
                              : "Authored"}
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
                    {repository && mode === "live" && (
                      <button
                        type="button"
                        onClick={() => {
                          repositorySelectionIntentRef.current = true;
                          setRepository(null);
                        }}
                        className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:bg-surface-hover"
                      >
                        All repositories
                      </button>
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
                      {repository?.fullName ?? "All authorized repositories"}
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
                          key={`${item.repositoryFullName ?? repository?.fullName ?? "repo"}#${item.number}`}
                          pullRequest={item}
                          selected={
                            selectedNumber === item.number &&
                            selectedRepositoryFullName ===
                              item.repositoryFullName
                          }
                          onClick={() => {
                            setSelectedRepositoryFullName(
                              item.repositoryFullName ??
                                repository?.fullName ??
                                null
                            );
                            setSelectedNumber(item.number);
                          }}
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
                  detailPayload={detailPayload}
                  chatOpen={detailView === "chat"}
                  codeOpen={detailView === "code"}
                  onSummary={() => setDetailView("summary")}
                  onCode={() => setDetailView("code")}
                  onChat={() => setDetailView("chat")}
                  chatAvailable={chatAvailable}
                  chatScope={chatScope}
                  chatMessages={chatMessages}
                  chatDraft={chatDraft}
                  onChatDraftChange={updateChatDraft}
                  onChatMessagesChange={updateChatMessages}
                  onChatAuthorizationLost={() => {
                    setReviewError(
                      "Your session expired. Reconnect to Koed before continuing this review Job."
                    );
                    void loadStatusAndRepositories();
                  }}
                  chatAgents={chatAgents}
                  chatModelOptions={chatModelOptions}
                  chatInitialModel={
                    reviewModelKey ||
                    `${DEFAULT_PR_MODEL.provider}:${DEFAULT_PR_MODEL.id}`
                  }
                  chatInitialEffort={reviewExecutionEffort}
                  chatInitialPermissionMode={chatPermissionForRuntime(
                    reviewPermissionMode
                  )}
                  demo={mode === "demo"}
                  chatAvailabilityMessage={chatAvailabilityMessage}
                  reviewAgentId={reviewAgentId}
                  onReviewAgentChange={setReviewAgentId}
                  reviewAgents={chatAgents}
                  reviewRunnerId={reviewRunnerId}
                  onReviewRunnerChange={(deviceId) => {
                    setReviewRunnerId(deviceId);
                    setReviewModelKey("");
                  }}
                  reviewRunners={reviewRunners}
                  reviewModelKey={reviewModelKey}
                  onReviewModelChange={(key) => {
                    setReviewModelKey(key);
                    const model = reviewModels.find(
                      (item) => `${item.provider}:${item.id}` === key
                    );
                    const instance = launchOptions?.instances.find(
                      (item) => item.instanceId === model?.instanceId
                    );
                    setReviewExecutionEffort((current) =>
                      model?.supportedReasoningEfforts.includes(current)
                        ? current
                        : (model?.supportedReasoningEfforts[0] ?? "")
                    );
                    setReviewPermissionMode(
                      instance?.permissionModes.includes("ask")
                        ? "ask"
                        : (instance?.permissionModes[0] ?? "")
                    );
                  }}
                  reviewModels={reviewModels}
                  reviewPermissionMode={reviewPermissionMode}
                  onReviewPermissionModeChange={setReviewPermissionMode}
                  reviewPermissionModes={reviewPermissionModes}
                  reviewEffort={reviewExecutionEffort}
                  onReviewEffortChange={setReviewExecutionEffort}
                  matchingProjects={matchingProjects}
                  selectedProjectId={selectedProjectId}
                  onSelectedProjectChange={setSelectedProjectId}
                  onStartAgentReview={() => void startAgentReview()}
                  reviewJobBusy={reviewJobBusy}
                  reviewError={reviewError}
                  reviewRecord={reviewRecord}
                  reviewDraft={reviewDraft}
                  frozenReview={frozenReview}
                  onSaveReviewDraft={saveReviewDraft}
                  onFreezeReview={freezeReviewDraft}
                  onPublishReview={publishReview}
                  publishGrant={publishGrant?.status ?? null}
                  onApprovePublishGrant={() =>
                    updatePublishGrant("confirm", "approve")
                  }
                  onCheckPublishGrant={() => updatePublishGrant("await")}
                  pendingPublishOperation={pendingPublishOperation}
                  onCheckPendingPublish={checkPendingPublish}
                  onCancelPendingPublish={cancelPendingPublish}
                  onReviewLatest={reviewLatest}
                  onEnableFixes={enableFixesAndSend}
                  enablingFixes={enablingFixes}
                  publishedReviewUrl={publishedReviewUrl}
                  reconcilePublishedReview={reconcilePublishedReview}
                  uncertainPublishOperationId={uncertainPublishOperationId}
                  canApprove={Boolean(
                    status?.login &&
                    selectedDetail.author.toLowerCase() !==
                      status.login.toLowerCase()
                  )}
                  canPublishReview={selectedDetail.state === "open"}
                  pushProposal={pushProposal}
                  pendingPushOperationId={pendingPushOperation?.id ?? null}
                  onCheckPendingPush={checkPendingPush}
                  onCancelPendingPush={cancelPendingPush}
                  uncertainPushOperationId={uncertainPushOperationId}
                  pushBusy={pushBusy}
                  pushError={pushError}
                  onPreparePush={preparePushProposal}
                  onPushProposal={pushProposalToGitHub}
                  onReconcilePush={reconcilePush}
                  pushGrant={pushGrant?.status ?? null}
                  onApprovePushGrant={() =>
                    updatePushGrant("confirm", "approve")
                  }
                  onCheckPushGrant={() => updatePushGrant("await")}
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
