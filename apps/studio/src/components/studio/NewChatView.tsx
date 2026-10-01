"use client";

import { CircleAlert, MessageSquare, MoreHorizontal, X } from "lucide-react";
import { useState } from "react";
import Link from "next/link";
import {
  DEMO_STANDALONE_BUILD_ACTIVITY,
  type BuildActivity
} from "@/lib/studio-build-activity";
import { BuildActivityPanel, type BuildPanelMode } from "../BuildActivityPanel";
import { AgentAvatarView } from "../AgentAvatarView";
import {
  ChatComposer,
  type ChatComposerRestoreSelection,
  type ChatComposerSelection,
  type ChatMentionAgent
} from "../ChatComposer";
import type { AgentModelCapability } from "@/lib/agentIdentityEditor";
import type { ManagedChatMemoryAttribution } from "@/lib/managed-agent-chat";
import type { RecallFeedbackAccess } from "./RecallFeedbackControls";
import { MemoryAttributionNote } from "./MemoryAttributionNote";
import type { ManagedAgentJobMarker } from "@/lib/managed-agent-job-markers";

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
  error?: string | null;
  memoryRecallFailure?: string | null;
  feedbackAccess?: RecallFeedbackAccess;
  onSend: (
    text: string,
    selection: ChatComposerSelection,
    continueWithoutMemory?: true
  ) => Promise<void>;
  onSelectTeamQuestion?: (text: string) => void;
  onInterrupt?: () => void;
  canInterrupt?: boolean;
  canCancelPendingPrompt?: boolean;
  onCancelPendingPrompt?: () => void;
  onEndSession?: () => void;
  restoreSelection?: ChatComposerRestoreSelection;
  pendingRequests?: readonly NewChatPendingRequest[];
  onRespond?: (
    requestId: string,
    response: NewChatRuntimeResponse
  ) => Promise<void>;
}>;

export type NewChatViewProps = {
  mode: NewChatMode;
  onBack?: () => void;
  projectName?: string;
  branch?: string;
  initialDraft?: string;
  recoveredDraft?: string | null;
  onDraftChange?: (draft: string) => void;
  initialSelection?: ChatComposerSelection;
  suggestions?: NewChatSuggestion[];
  activity?: BuildActivity | null;
  onDemoMessage?: (text: string) => void;
  agents?: readonly ChatMentionAgent[];
  activeAgentId?: string | null;
  onActiveAgentChange?: (agentId: string | null) => void;
  onAgentMention?: (agentId: string) => void;
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

type ChatMessage = { id: string; role: "user" | "assistant"; text: string };

export function NewChatView({
  mode,
  projectName = "Standalone chat",
  branch = "No project branch",
  initialDraft = "",
  recoveredDraft,
  onDraftChange,
  initialSelection,
  suggestions = DEFAULT_SUGGESTIONS,
  activity,
  onDemoMessage,
  agents,
  activeAgentId,
  onActiveAgentChange,
  onAgentMention,
  modelOptions,
  runtime
}: NewChatViewProps) {
  const [editedDraft, setEditedDraft] = useState<string | null>(null);
  const draft = editedDraft ?? recoveredDraft ?? initialDraft;
  const [pendingSuggestion, setPendingSuggestion] =
    useState<NewChatSuggestion | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [approvalAnswers, setApprovalAnswers] = useState<
    Record<string, Record<string, string[]>>
  >({});
  const [respondingTo, setRespondingTo] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [endSessionConfirmOpen, setEndSessionConfirmOpen] = useState(false);
  const [buildPanelMode, setBuildPanelMode] =
    useState<BuildPanelMode>("compact");
  const visibleMessages = runtime?.messages ?? messages;
  const activeAgent = agents?.find((agent) => agent.id === activeAgentId);
  const activeAgentAvailable = Boolean(
    activeAgentId && (!agents || activeAgent?.lifecycle === "active")
  );
  const agentGateMessage =
    mode === "live" && !activeAgentAvailable
      ? activeAgent?.lifecycle === "retired"
        ? "The active agent is retired. Select an available agent with @ before sending."
        : "Select an available agent with @ before sending."
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

  return (
    <div className="relative flex h-full min-h-0 w-full">
      <main className="flex min-w-0 flex-1 flex-col">
        <header
          className={`z-10 flex h-14 shrink-0 items-center gap-3 bg-background/80 px-4 pt-4 backdrop-blur-sm drag-region ${buildPanelMode === "compact" ? "pr-16 sm:pr-[320px]" : buildPanelMode === "hidden" ? "pr-16" : "pr-4"}`}
        >
          <p className="flex-1 text-sm text-foreground no-drag">
            Personal / New chat
          </p>
          {runtime?.onEndSession ? (
            <div className="relative no-drag">
              <button
                type="button"
                aria-label="Chat menu"
                aria-haspopup="menu"
                aria-expanded={chatMenuOpen}
                onClick={() => setChatMenuOpen((open) => !open)}
                className="rounded-md p-1.5 text-muted hover:bg-surface-hover hover:text-foreground"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {chatMenuOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-30 mt-1 min-w-44 rounded-md border border-border bg-surface p-1 shadow-xl"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setChatMenuOpen(false);
                      setEndSessionConfirmOpen(true);
                    }}
                    className="w-full rounded px-2.5 py-2 text-left text-xs text-danger hover:bg-surface-hover"
                  >
                    End session…
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          <span className="sr-only">
            <MessageSquare className="h-3 w-3" />
            {mode === "demo" ? "Demo data" : "Live"}
          </span>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4">
          <div className="ml-0 flex min-h-full w-full max-w-3xl flex-col lg:ml-10 lg:w-[calc(100%-2.5rem)]">
            {visibleMessages.length === 0 && (
              <div className="pt-20">
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
            )}

            {visibleMessages.length > 0 && (
              <div className="mb-8 mt-8 space-y-6" aria-live="polite">
                {visibleMessages.map((message) => {
                  const role = message.role;
                  const content =
                    "content" in message ? message.content : message.text;
                  const author = "author" in message ? message.author : null;
                  if (role === "user") {
                    return (
                      <div key={message.id} className="flex justify-end">
                        <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm bg-surface-hover px-4 py-3 text-[15px] leading-relaxed text-foreground">
                          {content}
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div key={message.id} className="flex justify-start">
                      <div className="flex max-w-[80%] items-start gap-3">
                        {author ? (
                          <AgentAvatarView
                            image={author.avatar?.image}
                            spec={author.avatar?.spec}
                            name={author.name}
                            size="md"
                          />
                        ) : (
                          <span className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-hover text-subtle">
                            <MessageSquare className="h-4 w-4" />
                          </span>
                        )}
                        <div className="min-w-0 pt-1">
                          {author && (
                            <p className="mb-1 text-xs font-medium text-foreground">
                              {author.name}
                            </p>
                          )}
                          <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-foreground-secondary">
                            {content}
                          </p>
                          {runtime?.onSelectTeamQuestion &&
                            typeof content === "string" &&
                            content.trim() && (
                              <button
                                type="button"
                                onClick={() =>
                                  runtime.onSelectTeamQuestion?.(content)
                                }
                                className="mt-2 rounded-md border border-border px-2 py-1 text-[10px] text-subtle hover:bg-surface-hover"
                              >
                                Prepare Team question
                              </button>
                            )}
                          {"memory" in message && message.memory ? (
                            <MemoryAttributionNote
                              memory={message.memory}
                              messageId={message.id}
                              feedbackAccess={runtime?.feedbackAccess}
                              key={`memory:${runtime?.feedbackAccess?.backendId ?? "no-backend"}:${runtime?.feedbackAccess?.ownerId ?? "no-owner"}:${runtime?.feedbackAccess?.executionId ?? "no-execution"}:${message.id}`}
                            />
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

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
              {mode === "live" ? (
                <div className="mb-3 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface px-3 py-2.5">
                  <label className="min-w-52 flex-1 text-xs font-medium text-foreground-secondary">
                    Personal Agent
                    <select
                      aria-label="Personal Agent"
                      value={activeAgentId ?? ""}
                      disabled={Boolean(runtime?.isSending)}
                      onChange={(event) =>
                        onActiveAgentChange?.(event.target.value || null)
                      }
                      className="mt-1 block w-full rounded-md border border-border bg-background px-2 py-2 text-xs text-foreground"
                    >
                      <option value="">Choose an active agent…</option>
                      {agents
                        ?.filter(
                          (agent) =>
                            agent.lifecycle === "active" ||
                            agent.id === activeAgentId
                        )
                        .map((agent) => (
                          <option
                            key={agent.id}
                            value={agent.id}
                            disabled={agent.lifecycle !== "active"}
                          >
                            {agent.name}
                            {agent.lifecycle === "active"
                              ? ""
                              : " (retired; unavailable)"}
                          </option>
                        ))}
                    </select>
                  </label>
                  <p className="max-w-md text-[11px] leading-4 text-muted">
                    Choose who will handle this chat. You can also select an
                    agent by typing @ in the message.
                    {agents?.some(
                      (agent) => agent.lifecycle === "active"
                    ) ? null : (
                      <>
                        {" "}
                        No active agents are available.{" "}
                        <Link
                          href="/agents"
                          className="text-foreground-secondary underline underline-offset-2"
                        >
                          Create or activate an agent
                        </Link>
                        .
                      </>
                    )}
                  </p>
                </div>
              ) : null}
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

              {(runtime?.status ||
                runtime?.error ||
                runtime?.isSending ||
                agentGateMessage) && (
                <div
                  className="mb-2 flex items-center justify-between gap-3 text-xs text-warning"
                  role="status"
                >
                  <span>
                    {runtime?.error ??
                      (runtime?.isSending
                        ? "Waiting for the chat runtime…"
                        : (agentGateMessage ?? runtime?.status))}
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
                    <div key={`${request.id}-detail-${index}`} className="mt-2">
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
                                {question.options.slice(0, 12).map((option) => (
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
                              approvalAnswers[request.id]?.[question.id] ?? [];
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
              <ChatComposer
                placeholder={
                  mode === "demo"
                    ? "Write a simulated message"
                    : "Describe what you need"
                }
                projectName={projectName}
                branch={branch}
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
                memoryRecallFailure={
                  mode === "live" ? runtime?.memoryRecallFailure : null
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
                environmentSwitchDisabled={mode === "live"}
                agents={agents}
                activeAgentId={activeAgentId}
                onAgentMention={onAgentMention}
                onActiveAgentChange={onActiveAgentChange}
                modelOptions={modelOptions}
                restoreSelection={runtime?.restoreSelection}
                initialPermissionMode={initialSelection?.permissionMode}
                initialModel={
                  initialSelection?.provider
                    ? `${initialSelection.provider}:${initialSelection.model}`
                    : initialSelection?.model
                }
                initialEffort={initialSelection?.effort}
                key={`${runtime?.restoreSelection?.key ?? "new-chat"}:${activeAgentId ?? "no-active-agent"}`}
                footer={
                  mode === "demo"
                    ? "Demo only. Messages stay in this tab and never reach an AI Client."
                    : runtime?.enabled
                      ? ""
                      : "Live Send is disabled until a verified execution path is connected."
                }
              />
            </div>
          </div>
        </div>
      </main>

      <BuildActivityPanel
        activity={resolvedActivity}
        onModeChange={setBuildPanelMode}
        className="max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-20 max-lg:shadow-2xl"
      />
      {endSessionConfirmOpen && runtime?.onEndSession ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 no-drag"
          role="presentation"
        >
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="end-session-title"
            className="w-full max-w-sm rounded-lg border border-border bg-background p-5 shadow-2xl"
          >
            <h2
              id="end-session-title"
              className="text-sm font-semibold text-foreground"
            >
              End this session?
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              This stops the managed session. You can still review its
              conversation afterward.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEndSessionConfirmOpen(false)}
                className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground-secondary"
              >
                Keep session
              </button>
              <button
                type="button"
                onClick={() => {
                  setEndSessionConfirmOpen(false);
                  runtime.onEndSession?.();
                }}
                className="rounded-md bg-danger px-3 py-1.5 text-xs font-medium text-white"
              >
                End session
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
