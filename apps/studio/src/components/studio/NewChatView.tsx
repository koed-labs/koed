"use client";

import {
  CircleAlert,
  Folder,
  MessageSquare,
  Pencil,
  ScanSearch,
  X
} from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Tooltip } from "../Tooltip";
import {
  DEMO_STANDALONE_BUILD_ACTIVITY,
  type BuildActivity
} from "@/lib/studio-build-activity";
import { BuildActivityPanel, type BuildPanelMode } from "../BuildActivityPanel";
import { readBuildPanelMode } from "@/lib/buildView";
import {
  ChatComposer,
  type ChatComposerRestoreSelection,
  type ChatComposerSelection,
  type ChatMentionAgent
} from "../ChatComposer";
import type { AgentChatProgress } from "@/lib/agent-chat-progress";
import type { AgentModelCapability } from "@/lib/agentIdentityEditor";
import type { ManagedChatMemoryAttribution } from "@/lib/managed-agent-chat";
import type { RecallFeedbackAccess } from "./RecallFeedbackControls";
import { MemoryAttributionNote } from "./MemoryAttributionNote";
import { PrepareTeamQuestionAction } from "../PrepareTeamQuestionAction";
import type { ManagedAgentJobMarker } from "@/lib/managed-agent-job-markers";
import {
  AgentChatMessage,
  SharedChatUI,
  type SharedChatMessage
} from "../SharedChatUI";

export type NewChatMode = "demo" | "live";

export type NewChatSuggestion = {
  id: string;
  label: string;
  prompt: string;
};

export type NewChatRuntimeMessage = Readonly<{
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  sequence?: number;
  memory?: ManagedChatMemoryAttribution;
  author?: Readonly<{
    agentId: string;
    name: string;
    avatar?: { image?: string; spec?: Record<string, unknown> };
  }> | null;
}>;

export type NewChatPendingRequest = Readonly<{
  id: string;
  kind:
    | "command_approval"
    | "file_approval"
    | "permissions_approval"
    | "user_input";
  description: string;
  details?: readonly Readonly<{ label: string; text: string }>[];
  questions?: readonly Readonly<{
    id: string;
    header?: string;
    question: string;
    required?: boolean;
    isSecret?: boolean;
    isOther?: boolean;
    options?: readonly Readonly<{ label: string }>[];
  }>[];
}>;

export type NewChatRuntimeResponse =
  | Readonly<{ decision: "accept" | "decline" }>
  | Readonly<{ answers: Record<string, string[]> }>;

export type NewChatRuntime = Readonly<{
  enabled: boolean;
  status?: string;
  messages: readonly NewChatRuntimeMessage[];
  jobMarkers?: readonly ManagedAgentJobMarker[];
  isSending: boolean;
  progress?: AgentChatProgress | null;
  progressHistory?: readonly AgentChatProgress[];
  error?: string | null;
  feedbackAccess?: RecallFeedbackAccess;
  onSend: (text: string, selection: ChatComposerSelection) => Promise<void>;
  onSelectTeamQuestion?: (text: string) => void;
  onInterrupt?: () => void;
  canInterrupt?: boolean;
  canCancelPendingPrompt?: boolean;
  onCancelPendingPrompt?: () => void;
  onEndSession?: () => void;
  restoreSelection?: ChatComposerRestoreSelection;
  restoreAgentSelections?: Readonly<
    Record<string, ChatComposerRestoreSelection>
  >;
  personalConversation?: Readonly<{
    status: string;
    retryAvailable: boolean;
    deliveries: readonly Readonly<{
      id: string;
      ordinal: number;
      name: string;
      status: string;
      progress: string | null;
      error: string | null;
      contextSummary: string | null;
      canContinue: boolean;
      diffAvailable: boolean;
      diffLoading: boolean;
      messageId: string;
    }>[];
    hasOlderMessages: boolean;
    uncertain: boolean;
    onStopBatch?: () => void;
    onRetry?: () => void;
    onShowDiff?: (deliveryId: string) => void;
    onContinueDelivery?: (messageId: string, deliveryId: string) => void;
    onLoadOlder?: () => void;
  }>;
  onRenameConversation?: (title: string | null) => Promise<void>;
  pendingRequests?: readonly NewChatPendingRequest[];
  onRespond?: (
    requestId: string,
    response: NewChatRuntimeResponse
  ) => Promise<void>;
}>;

export type NewChatViewProps = {
  mode: NewChatMode;
  onBack?: () => void;
  conversationTitle?: string;
  conversationProjectName?: string | null;
  projectName?: string;
  projectSelector?: ReactNode;
  branch?: string;
  initialDraft?: string;
  recoveredDraft?: string | null;
  onDraftChange?: (draft: string) => void;
  initialSelection?: ChatComposerSelection;
  suggestions?: NewChatSuggestion[];
  activity?: BuildActivity | null;
  onBuildJobSelect?: (jobId: string) => void;
  onBuildAttention?: (runtimeItemId: string) => void;
  clientResourceScope?: {
    projectId: string | null;
    hostedInstanceId?: string;
    instanceId?: string;
    provider?: string;
  };
  onDemoMessage?: (text: string) => void;
  agents?: readonly ChatMentionAgent[];
  activeAgentId?: string | null;
  conversationScopeKey?: string;
  onActiveAgentChange?: (agentId: string | null) => void;
  onAgentMention?: (agentId: string) => void;
  allowMultipleAgentMentions?: boolean;
  modelOptions?: readonly AgentModelCapability[];
  runtime?: NewChatRuntime;
};

const DEFAULT_SUGGESTIONS: NewChatSuggestion[] = [
  {
    id: "plan",
    label: "Plan the next change",
    prompt: "Help me plan the next change in this project."
  },
  {
    id: "review",
    label: "Review the current work",
    prompt: "Review the current work and call out what needs attention."
  },
  {
    id: "context",
    label: "Ask about project context",
    prompt: "What project context should I know before I start?"
  }
];

function PersonalConversationRunPanel({
  run
}: {
  run: NonNullable<NewChatRuntime["personalConversation"]>;
}) {
  const [showCompleted, setShowCompleted] = useState(false);
  const completed = run.deliveries.filter(
    (delivery) => delivery.status === "completed"
  );
  const visible = run.deliveries.filter(
    (delivery) =>
      delivery.status !== "completed" || showCompleted || completed.length === 1
  );
  const active = run.deliveries.some((delivery) =>
    ["queued", "starting", "running"].includes(delivery.status)
  );
  const stateLabel = (status: string) =>
    status === "starting"
      ? "Starting"
      : status === "running"
        ? "Working"
        : status === "queued"
          ? "Queued"
          : status === "uncertain"
            ? "Outcome uncertain"
            : status === "failed"
              ? "Failed"
              : status === "canceled"
                ? "Stopped"
                : status === "skipped"
                  ? "Skipped"
                  : "Completed";
  return (
    <section
      aria-label="Agent delivery progress"
      className="mx-4 mb-2 rounded-lg border border-border bg-surface/70 px-3 py-2 text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-medium text-foreground">
            {run.uncertain ? "Delivery needs review" : "Agent run"}
          </span>
          <span className="text-muted">{run.status}</span>
          {completed.length ? (
            <button
              type="button"
              className="text-muted underline-offset-2 hover:text-foreground hover:underline"
              aria-expanded={showCompleted}
              onClick={() => setShowCompleted((value) => !value)}
            >
              {showCompleted
                ? "Hide completed"
                : `${completed.length} completed`}
            </button>
          ) : null}
        </div>
        {active && run.onStopBatch ? (
          <button
            type="button"
            onClick={run.onStopBatch}
            className="rounded border border-border px-2 py-1 font-medium text-foreground-secondary hover:bg-surface-hover"
          >
            Stop this batch
          </button>
        ) : null}
        {run.retryAvailable && run.onRetry ? (
          <button
            type="button"
            onClick={run.onRetry}
            className="rounded border border-border px-2 py-1 font-medium text-foreground-secondary hover:bg-surface-hover"
          >
            Retry saved send
          </button>
        ) : null}
        {run.hasOlderMessages && run.onLoadOlder ? (
          <button
            type="button"
            onClick={run.onLoadOlder}
            className="rounded border border-border px-2 py-1 text-muted hover:bg-surface-hover hover:text-foreground"
          >
            Load older messages
          </button>
        ) : null}
      </div>
      {run.uncertain ? (
        <p role="alert" className="mt-2 text-amber-700 dark:text-amber-300">
          Studio is checking the existing delivery. New messages are paused to
          avoid sending twice.
        </p>
      ) : null}
      {run.retryAvailable ? (
        <p className="mt-2 text-amber-700 dark:text-amber-300">
          Studio saved the original request and ordered Agent settings. Retry
          sends that same request ID to safely reconcile its outcome.
        </p>
      ) : null}
      <ol className="mt-2 space-y-1.5">
        {visible.map((delivery) => (
          <li
            key={delivery.id}
            className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-muted"
          >
            <span className="min-w-0">
              <span className="font-medium text-foreground-secondary">
                {delivery.name}
              </span>
              <span className="ml-2">{stateLabel(delivery.status)}</span>
              {delivery.progress ? (
                <span className="ml-2">{delivery.progress}</span>
              ) : null}
              {delivery.error ? (
                <span className="ml-2 text-red-700 dark:text-red-300">
                  {delivery.error}
                </span>
              ) : null}
              {delivery.contextSummary ? (
                <span className="ml-2 text-subtle">
                  · {delivery.contextSummary}
                </span>
              ) : null}
            </span>
            {delivery.canContinue && run.onContinueDelivery ? (
              <button
                type="button"
                onClick={() =>
                  run.onContinueDelivery?.(delivery.messageId, delivery.id)
                }
                className="rounded border border-border px-2 py-1 font-medium text-foreground-secondary hover:bg-surface-hover"
              >
                Skip failed Agent and continue
              </button>
            ) : null}
            {delivery.diffAvailable && run.onShowDiff ? (
              <button
                type="button"
                onClick={() => run.onShowDiff?.(delivery.id)}
                disabled={delivery.diffLoading}
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 font-medium text-foreground-secondary hover:bg-surface-hover disabled:opacity-50"
              >
                <ScanSearch className="h-3 w-3" />
                {delivery.diffLoading ? "Loading changes…" : "Show changes"}
              </button>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

type ChatMessage = { id: string; role: "user" | "assistant"; text: string };

export function NewChatView({
  conversationTitle,
  conversationProjectName,
  mode,
  projectName = "Standalone chat",
  projectSelector,
  branch = "No project branch",
  initialDraft = "",
  recoveredDraft,
  onDraftChange,
  initialSelection,
  suggestions = DEFAULT_SUGGESTIONS,
  activity,
  onBuildJobSelect,
  onBuildAttention,
  clientResourceScope,
  onDemoMessage,
  agents,
  activeAgentId,
  conversationScopeKey,
  onActiveAgentChange,
  onAgentMention,
  allowMultipleAgentMentions = true,
  modelOptions,
  runtime
}: NewChatViewProps) {
  const [editedDraft, setEditedDraft] = useState<string | null>(null);
  const [titleOverride, setTitleOverride] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(conversationTitle ?? "");
  const [titleRenameError, setTitleRenameError] = useState<string | null>(null);
  const draft = editedDraft ?? recoveredDraft ?? initialDraft;
  const [pendingSuggestion, setPendingSuggestion] =
    useState<NewChatSuggestion | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [approvalAnswers, setApprovalAnswers] = useState<
    Record<string, Record<string, string[]>>
  >({});
  const [respondingTo, setRespondingTo] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [buildPanelMode, setBuildPanelMode] = useState<BuildPanelMode>(() =>
    readBuildPanelMode()
  );
  const visibleMessages = runtime?.messages ?? messages;
  const displayedTitle = titleOverride ?? conversationTitle ?? "New chat";
  const saveConversationTitle = async (event: FormEvent) => {
    event.preventDefault();
    if (!runtime?.onRenameConversation) return;
    try {
      const title = titleDraft.trim() || null;
      await runtime.onRenameConversation(title);
      setTitleOverride(title ?? "New chat");
      setRenamingTitle(false);
      setTitleRenameError(null);
    } catch (cause) {
      setTitleRenameError(
        cause instanceof Error ? cause.message : "The title could not be saved."
      );
    }
  };
  const activeAgent = agents?.find((agent) => agent.id === activeAgentId);
  const activeAgentAvailable = Boolean(
    !activeAgentId || !agents || activeAgent?.lifecycle === "active"
  );
  const agentGateMessage =
    mode === "live" && !activeAgentAvailable
      ? activeAgent?.lifecycle === "retired"
        ? "The active agent is retired. Select an available agent with @ before sending."
        : "Select an available agent with @ or remove the unavailable Agent selection."
      : null;
  const resolvedActivity =
    activity ?? (mode === "demo" ? DEMO_STANDALONE_BUILD_ACTIVITY : null);

  const chooseSuggestion = (suggestion: NewChatSuggestion) => {
    if (draft.trim() && draft.trim() !== suggestion.prompt) {
      setPendingSuggestion(suggestion);
      return;
    }
    setEditedDraft(suggestion.prompt);
    onDraftChange?.(suggestion.prompt);
  };

  const replaceDraft = () => {
    if (!pendingSuggestion) return;
    setEditedDraft(pendingSuggestion.prompt);
    onDraftChange?.(pendingSuggestion.prompt);
    setPendingSuggestion(null);
  };

  const respondToRequest = async (
    requestId: string,
    response: NewChatRuntimeResponse
  ) => {
    if (!runtime?.onRespond || respondingTo) return;
    setRespondingTo(requestId);
    setApprovalError(null);
    try {
      await runtime.onRespond(requestId, response);
    } catch (cause) {
      setApprovalError(
        cause instanceof Error
          ? cause.message
          : "The runtime did not confirm this response."
      );
    } finally {
      setRespondingTo(null);
    }
  };

  const setAnswer = (
    requestId: string,
    questionId: string,
    values: string[]
  ) => {
    setApprovalAnswers((current) => ({
      ...current,
      [requestId]: { ...current[requestId], [questionId]: values }
    }));
  };

  const sendDemoMessage = (text: string) => {
    if (mode !== "demo") return;
    setMessages((current) => [
      ...current,
      { id: `${Date.now()}-user`, role: "user", text },
      {
        id: `${Date.now()}-assistant`,
        role: "assistant",
        text: "Local simulation only. No AI Client was contacted and no backend write was made."
      }
    ]);
    onDemoMessage?.(text);
  };

  const sharedMessages: (SharedChatMessage & {
    memory?: ManagedChatMemoryAttribution;
  })[] = visibleMessages.map((message) => ({
    id: message.id,
    role: message.role,
    content: "content" in message ? message.content : message.text,
    authoredByViewer: message.role === "user",
    author: "author" in message ? message.author : null,
    memory: "memory" in message ? message.memory : undefined
  }));

  return (
    <div className="relative flex h-full min-h-0 w-full">
      <main className="flex min-w-0 flex-1 flex-col">
        <header
          className={`z-10 flex h-14 shrink-0 items-center gap-3 bg-background/80 px-4 pt-4 backdrop-blur-sm drag-region ${buildPanelMode === "compact" ? "pr-16 xl:pr-[320px]" : buildPanelMode === "hidden" ? "pr-16" : "pr-4"}`}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 text-sm text-foreground no-drag">
            {conversationProjectName ? (
              <Tooltip content={conversationProjectName} side="bottom">
                <span
                  tabIndex={0}
                  aria-label={`Project: ${conversationProjectName}`}
                  className="inline-flex shrink-0 rounded text-muted outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <Folder className="h-4 w-4" aria-hidden="true" />
                </span>
              </Tooltip>
            ) : null}
            {renamingTitle ? (
              <form
                className="flex min-w-0 flex-1 items-center gap-1"
                onSubmit={(event) => void saveConversationTitle(event)}
              >
                <input
                  autoFocus
                  aria-label="Conversation title"
                  value={titleDraft}
                  maxLength={120}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm"
                />
                <button
                  type="submit"
                  className="rounded border border-border px-2 py-1 text-xs text-foreground-secondary hover:bg-surface-hover"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRenamingTitle(false);
                    setTitleRenameError(null);
                  }}
                  className="rounded border border-border px-2 py-1 text-xs text-muted hover:bg-surface-hover"
                >
                  Cancel
                </button>
              </form>
            ) : (
              <span className="min-w-0 truncate">{displayedTitle}</span>
            )}
            {!renamingTitle && runtime?.onRenameConversation ? (
              <button
                type="button"
                aria-label="Rename chat"
                title="Rename chat"
                onClick={() => {
                  setTitleDraft(titleOverride ?? conversationTitle ?? "");
                  setRenamingTitle(true);
                }}
                className="rounded p-1 text-subtle hover:bg-surface-hover hover:text-foreground"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <span className="sr-only">
            <MessageSquare className="h-3 w-3" />
            {mode === "demo" ? "Demo data" : "Live"}
          </span>
        </header>
        {mode === "live" && runtime?.personalConversation ? (
          <PersonalConversationRunPanel run={runtime.personalConversation} />
        ) : null}
        {titleRenameError ? (
          <p role="alert" className="mx-4 mb-2 text-xs text-danger">
            {titleRenameError}
          </p>
        ) : null}
        <SharedChatUI
          mode={{ kind: "agent", controls: "execution" }}
          scopeKey={
            conversationScopeKey ?? runtime?.restoreSelection?.key ?? "new-chat"
          }
          messages={sharedMessages}
          progress={mode === "live" ? runtime?.progress : null}
          progressHistory={
            mode === "live" ? runtime?.progressHistory : undefined
          }
          progressClassName="ml-0 w-full max-w-3xl lg:ml-10 lg:w-[calc(100%-2.5rem)]"
          className="min-h-0 flex-1"
          viewportClassName="px-4"
          listClassName="ml-0 mb-8 mt-8 flex w-full max-w-3xl flex-col space-y-6 lg:ml-10 lg:w-[calc(100%-2.5rem)]"
          composer={
            <div className="px-4 pb-3">
              <div className="ml-0 w-full max-w-3xl lg:ml-10 lg:w-[calc(100%-2.5rem)]">
                <ChatComposer
                  placeholder={
                    mode === "demo"
                      ? "Write a simulated message"
                      : "Describe what you need"
                  }
                  projectName={projectName}
                  projectSelector={projectSelector}
                  branch={branch}
                  clientResourceScope={
                    mode === "live" ? clientResourceScope : undefined
                  }
                  value={draft}
                  onChange={(value) => {
                    setEditedDraft(value);
                    onDraftChange?.(value);
                  }}
                  onSend={
                    mode === "demo"
                      ? sendDemoMessage
                      : runtime?.enabled
                        ? runtime.onSend
                        : undefined
                  }
                  sendEnabled={
                    mode === "demo" ||
                    Boolean(
                      runtime?.enabled &&
                      !runtime.isSending &&
                      activeAgentAvailable
                    )
                  }
                  sendDisabledReason={
                    agentGateMessage ??
                    runtime?.status ??
                    "Live execution is not connected yet"
                  }
                  showExecutionControls
                  environmentSwitchDisabled
                  agents={agents}
                  allowMultipleAgentMentions={
                    mode === "live" && allowMultipleAgentMentions
                  }
                  activeAgentId={activeAgentId}
                  onAgentMention={onAgentMention}
                  onActiveAgentChange={onActiveAgentChange}
                  modelOptions={modelOptions}
                  restoreSelection={runtime?.restoreSelection}
                  persistedAgentSelections={runtime?.restoreAgentSelections}
                  initialPermissionMode={initialSelection?.permissionMode}
                  initialModel={
                    initialSelection?.provider && initialSelection.model
                      ? `${initialSelection.provider}:${initialSelection.model}${initialSelection.hostedInstanceId || initialSelection.instanceId ? `:${initialSelection.hostedInstanceId ?? initialSelection.instanceId}` : ""}`
                      : initialSelection?.model
                  }
                  initialEffort={initialSelection?.effort}
                  key={runtime?.restoreSelection?.key ?? "new-chat"}
                  footer={
                    mode === "demo"
                      ? "Demo only. Messages stay in this tab and never reach an AI Client."
                      : runtime?.enabled
                        ? ""
                        : runtime?.status ||
                          "Live Send is disabled until a verified execution path is connected."
                  }
                />
              </div>
            </div>
          }
          renderMessage={(message) => (
            <AgentChatMessage message={message} maxWidthClass="max-w-[80%]">
              {runtime?.onSelectTeamQuestion &&
              message.role === "assistant" &&
              message.content.trim() ? (
                <PrepareTeamQuestionAction
                  text={message.content}
                  onPrepare={(text) => runtime.onSelectTeamQuestion?.(text)}
                />
              ) : null}
              {message.memory ? (
                <MemoryAttributionNote
                  key={`memory:${runtime?.feedbackAccess?.backendId ?? "no-backend"}:${runtime?.feedbackAccess?.ownerId ?? "no-owner"}:${runtime?.feedbackAccess?.executionId ?? "no-execution"}:${message.id}`}
                  memory={message.memory}
                  messageId={message.id}
                  feedbackAccess={runtime?.feedbackAccess}
                />
              ) : null}
            </AgentChatMessage>
          )}
          emptyState={
            <div className="ml-0 w-full max-w-3xl pt-20 lg:ml-10 lg:w-[calc(100%-2.5rem)]">
              <p className="mb-4 text-sm text-subtle">
                Suggested by Koed{mode === "demo" ? " · Demo" : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion.id}
                    type="button"
                    onClick={() => chooseSuggestion(suggestion)}
                    className="rounded-full border border-border bg-surface px-3 py-1.5 text-left text-xs text-foreground-secondary transition-colors hover:border-border-strong hover:text-foreground"
                  >
                    {suggestion.label}
                  </button>
                ))}
              </div>
            </div>
          }
          childrenAfter={
            <div className="ml-0 w-full max-w-3xl lg:ml-10 lg:w-[calc(100%-2.5rem)]">
              {runtime?.jobMarkers?.map((marker) => (
                <article
                  key={`job-marker:${marker.id}`}
                  aria-label="Assigned Agent Job"
                  className="my-4 rounded-lg border border-accent/25 bg-accent/5 px-3 py-2.5"
                >
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-accent">
                    {marker.state === "queued"
                      ? "Job queued"
                      : marker.state === "running"
                        ? "Job started"
                        : marker.state === "succeeded"
                          ? "Job completed"
                          : marker.state === "failed"
                            ? "Job failed"
                            : marker.state === "canceled"
                              ? "Job canceled"
                              : marker.state === "waiting"
                                ? "Job waiting for you"
                                : marker.state === "interrupted"
                                  ? "Job interrupted"
                                  : "Job status"}
                  </p>
                  <p className="mt-1 text-xs font-medium text-foreground">
                    {marker.agentName} · {marker.projectName}
                  </p>
                  <p className="mt-0.5 text-xs text-foreground-secondary">
                    {marker.goal || "Assigned work"}
                  </p>
                </article>
              ))}

              <div className="mt-auto pb-8 pt-8">
                {pendingSuggestion && (
                  <div
                    className="mb-3 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
                    role="alert"
                  >
                    <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p>Replace the current draft with this suggestion?</p>
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          onClick={replaceDraft}
                          className="rounded-md bg-chip px-2 py-1 text-[11px] font-medium text-chip-foreground"
                        >
                          Replace draft
                        </button>
                        <button
                          type="button"
                          onClick={() => setPendingSuggestion(null)}
                          className="rounded-md border border-border-strong px-2 py-1 text-[11px] text-foreground-secondary"
                        >
                          Keep draft
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {((runtime?.status && !runtime.progress) ||
                  runtime?.error ||
                  (runtime?.isSending && !runtime.progress) ||
                  (runtime?.progress &&
                    (runtime.canInterrupt || runtime.canCancelPendingPrompt)) ||
                  agentGateMessage) && (
                  <div
                    className="mb-2 flex items-center justify-between gap-3 text-xs text-warning"
                    role="status"
                  >
                    <span>
                      {runtime?.progress && !runtime.error && !agentGateMessage
                        ? null
                        : (runtime?.error ??
                          (runtime?.isSending
                            ? "Waiting for the chat runtime…"
                            : (agentGateMessage ?? runtime?.status)))}
                    </span>
                    {runtime?.canCancelPendingPrompt &&
                    runtime.onCancelPendingPrompt ? (
                      <button
                        type="button"
                        className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-muted hover:bg-surface-hover hover:text-foreground"
                        onClick={runtime.onCancelPendingPrompt}
                        aria-label="Cancel pending continuation"
                      >
                        <X className="h-3.5 w-3.5" /> Cancel pending
                      </button>
                    ) : runtime?.canInterrupt && runtime.onInterrupt ? (
                      <button
                        type="button"
                        className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-muted hover:bg-surface-hover hover:text-foreground"
                        onClick={runtime.onInterrupt}
                        aria-label="Stop active turn"
                      >
                        <X className="h-3.5 w-3.5" /> Stop
                      </button>
                    ) : null}
                  </div>
                )}
                {approvalError && (
                  <p className="mb-2 text-xs text-danger" role="alert">
                    {approvalError}
                  </p>
                )}
                {runtime?.pendingRequests?.map((request) => (
                  <section
                    key={request.id}
                    id={`runtime-item-${request.id}`}
                    className="mb-3 rounded-md border border-warning/30 bg-surface px-3 py-3"
                    aria-label={`${request.kind.replaceAll("_", " ")} request`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-foreground">
                          {request.kind === "user_input"
                            ? "Input needed"
                            : request.kind.replaceAll("_", " ")}
                        </p>
                        <p className="mt-1 break-words text-xs leading-relaxed text-muted">
                          {request.description.slice(0, 1200)}
                          {request.description.length > 1200 ? "…" : ""}
                        </p>
                      </div>
                    </div>
                    {request.details?.slice(0, 8).map((detail, index) => (
                      <div
                        key={`${request.id}-detail-${index}`}
                        className="mt-2"
                      >
                        <p className="mb-1 text-[10px] font-medium uppercase text-subtle">
                          {detail.label.slice(0, 80)}
                        </p>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-background px-2 py-1.5 text-[11px] leading-relaxed text-foreground-secondary">
                          {detail.text.slice(0, 4000)}
                          {detail.text.length > 4000 ? "\n…" : ""}
                        </pre>
                      </div>
                    ))}
                    {request.kind === "user_input" ? (
                      <div className="mt-3 space-y-3">
                        {(request.questions ?? []).map((question) => {
                          const selected =
                            approvalAnswers[request.id]?.[question.id] ?? [];
                          const answer = selected[0] ?? "";
                          const optionLabels = (question.options ?? [])
                            .slice(0, 12)
                            .map((option) => option.label);
                          const isFreeform =
                            question.isOther === true ||
                            optionLabels.length === 0;
                          return (
                            <fieldset key={question.id}>
                              <legend className="text-xs font-medium text-foreground-secondary">
                                {(
                                  question.header?.trim() || question.question
                                ).slice(0, 160)}
                              </legend>
                              {question.header && (
                                <p className="mt-1 text-xs text-muted">
                                  {question.question.slice(0, 1200)}
                                </p>
                              )}
                              {isFreeform ? (
                                <input
                                  type={question.isSecret ? "password" : "text"}
                                  list={
                                    question.options?.length
                                      ? `agent-question-${question.id}`
                                      : undefined
                                  }
                                  required={question.required !== false}
                                  className="mt-2 w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-accent"
                                  value={answer}
                                  onChange={(event) =>
                                    setAnswer(
                                      request.id,
                                      question.id,
                                      event.target.value
                                        ? [event.target.value]
                                        : []
                                    )
                                  }
                                  aria-label={question.question}
                                />
                              ) : (
                                <select
                                  required={question.required !== false}
                                  value={answer}
                                  className="mt-2 w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-accent"
                                  onChange={(event) =>
                                    setAnswer(
                                      request.id,
                                      question.id,
                                      event.target.value
                                        ? [event.target.value]
                                        : []
                                    )
                                  }
                                  aria-label={question.question}
                                >
                                  <option value="" disabled>
                                    Select an answer
                                  </option>
                                  {optionLabels.map((label) => (
                                    <option key={label} value={label}>
                                      {label.slice(0, 300)}
                                    </option>
                                  ))}
                                </select>
                              )}
                              {isFreeform && question.options?.length ? (
                                <datalist id={`agent-question-${question.id}`}>
                                  {question.options
                                    .slice(0, 12)
                                    .map((option) => (
                                      <option
                                        key={option.label}
                                        value={option.label}
                                      />
                                    ))}
                                </datalist>
                              ) : null}
                            </fieldset>
                          );
                        })}
                        <button
                          type="button"
                          className="rounded bg-chip px-3 py-1.5 text-xs font-medium text-chip-foreground disabled:opacity-40"
                          disabled={
                            respondingTo !== null ||
                            !runtime.onRespond ||
                            !request.questions?.length ||
                            request.questions.some((question) => {
                              const values =
                                approvalAnswers[request.id]?.[question.id] ??
                                [];
                              return (
                                question.required !== false &&
                                (!values.length || !values[0]?.trim())
                              );
                            })
                          }
                          onClick={() =>
                            void respondToRequest(request.id, {
                              answers: Object.fromEntries(
                                (request.questions ?? []).map((question) => {
                                  const value =
                                    approvalAnswers[request.id]?.[
                                      question.id
                                    ]?.[0] ?? "";
                                  const optionLabels = (
                                    question.options ?? []
                                  ).map((option) => option.label);
                                  return [
                                    question.id,
                                    [
                                      question.isOther &&
                                      value &&
                                      !optionLabels.includes(value)
                                        ? `user_note: ${value}`
                                        : value
                                    ]
                                  ];
                                })
                              )
                            })
                          }
                        >
                          Submit answers
                        </button>
                      </div>
                    ) : (
                      <div className="mt-3 flex justify-end gap-2">
                        <button
                          type="button"
                          className="rounded border border-border px-3 py-1.5 text-xs text-foreground-secondary disabled:opacity-40"
                          disabled={respondingTo !== null || !runtime.onRespond}
                          onClick={() =>
                            void respondToRequest(request.id, {
                              decision: "decline"
                            })
                          }
                        >
                          Decline
                        </button>
                        <button
                          type="button"
                          className="rounded bg-chip px-3 py-1.5 text-xs font-medium text-chip-foreground disabled:opacity-40"
                          disabled={respondingTo !== null || !runtime.onRespond}
                          onClick={() =>
                            void respondToRequest(request.id, {
                              decision: "accept"
                            })
                          }
                        >
                          Allow once
                        </button>
                      </div>
                    )}
                  </section>
                ))}
              </div>
            </div>
          }
        ></SharedChatUI>
      </main>

      <BuildActivityPanel
        activity={resolvedActivity}
        onJobSelect={onBuildJobSelect}
        onAttention={onBuildAttention}
        onModeChange={setBuildPanelMode}
        className="max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-20 max-lg:shadow-2xl"
      />
    </div>
  );
}
