"use client";

import { CircleAlert, LoaderCircle, X } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";
import type { AgentModelCapability } from "@/lib/agentIdentityEditor";
import { AgentChatMessage, SharedChatUI } from "../SharedChatUI";
import {
  ChatComposer,
  type ChatComposerSelection,
  type ChatMentionAgent
} from "../ChatComposer";

export type PRChatScope = Readonly<{
  accountId: string;
  accountLogin: string;
  repositoryId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  headSha: string;
  baseSha: string;
}>;

export type PRChatMessage = Readonly<{
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  author?: Readonly<{
    agentId: string;
    name: string;
    avatar?: { image?: string; spec?: Record<string, unknown> };
  }> | null;
}>;

export type PRChatResponse = Readonly<{
  message: PRChatMessage;
}>;

export type PRChatConversation = Readonly<{
  messages: PRChatMessage[];
}>;

/**
 * The renderer does not decide how a PR conversation is executed. The
 * runtime owns authorization, persistence, and model execution and receives
 * the complete frozen scope with every message.
 */
export type PRChatAdapter = Readonly<{
  load?: (input: {
    scope: PRChatScope;
    signal: AbortSignal;
  }) => Promise<PRChatConversation>;
  send: (input: {
    scope: PRChatScope;
    text: string;
    requestId: string;
    selection: ChatComposerSelection;
    signal: AbortSignal;
  }) => Promise<PRChatResponse>;
  getApproval?: (input: {
    scope: PRChatScope;
    requestId: string;
    signal: AbortSignal;
  }) => Promise<{ approvalId: string; title: string; detail: string } | null>;
  resolveApproval?: (input: {
    scope: PRChatScope;
    requestId: string;
    approvalId: string;
    decision: "accept" | "decline";
    signal: AbortSignal;
  }) => Promise<void>;
}>;

export type PRChatPanelProps = {
  pullRequest: {
    number: number;
    title: string;
    repositoryFullName: string;
    baseBranch: string;
    headBranch: string;
  };
  scope: PRChatScope;
  messages: PRChatMessage[];
  draft: string;
  onDraftChange: (value: string) => void;
  onMessagesChange: Dispatch<SetStateAction<PRChatMessage[]>>;
  adapter?: PRChatAdapter | null;
  demo?: boolean;
  availabilityMessage?: string | null;
  agents?: readonly ChatMentionAgent[];
  activeAgentId?: string | null;
  onActiveAgentChange?: (agentId: string | null) => void;
  onAgentMention?: (agentId: string) => void;
  modelOptions?: readonly AgentModelCapability[];
  initialModel?: string;
  initialEffort?: string;
};

const SUGGESTED_PROMPTS = [
  "Summarize this PR",
  "Find potential bugs",
  "What risks should I check?"
];

function messageId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function PRChatPanel({
  pullRequest,
  scope,
  messages,
  draft,
  onDraftChange,
  onMessagesChange,
  adapter,
  demo = false,
  availabilityMessage = null,
  agents = [],
  activeAgentId,
  onActiveAgentChange,
  onAgentMention,
  modelOptions = [],
  initialModel,
  initialEffort
}: PRChatPanelProps) {
  const [localActiveAgentId, setLocalActiveAgentId] = useState<string | null>(
    activeAgentId ?? null
  );
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingSuggestion, setPendingSuggestion] = useState<string | null>(
    null
  );
  const [failedRequest, setFailedRequest] = useState<{
    text: string;
    requestId: string;
    selection: ChatComposerSelection;
  } | null>(null);
  const [historyLoadError, setHistoryLoadError] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<{
    approvalId: string;
    title: string;
    detail: string;
    requestId: string;
  } | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [resolvingApproval, setResolvingApproval] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(
    Boolean(adapter?.load && !demo)
  );
  const controllerRef = useRef<AbortController | null>(null);
  const selectedAgentId =
    activeAgentId === undefined ? localActiveAgentId : activeAgentId;

  useEffect(() => {
    const load = adapter?.load;
    if (!load || demo) return;
    const controller = new AbortController();
    // The loading flag mirrors the lifecycle of the external conversation request.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoadingHistory(true);
    void load({ scope, signal: controller.signal })
      .then((conversation) => {
        if (
          !controller.signal.aborted &&
          Array.isArray(conversation?.messages)
        ) {
          onMessagesChange(conversation.messages);
        }
        if (!controller.signal.aborted) setHistoryLoadError(null);
      })
      .catch((reason) => {
        if ((reason as { name?: string })?.name !== "AbortError") {
          const message =
            reason instanceof Error
              ? reason.message
              : "The pull request conversation could not be loaded.";
          setHistoryLoadError(message);
          setError(message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoadingHistory(false);
      });
    return () => controller.abort();
  }, [adapter, demo, onMessagesChange, scope]);

  useEffect(() => {
    return () => controllerRef.current?.abort();
  }, [scope]);

  const liveUnavailable = !demo && !adapter;
  const unavailable =
    historyLoadError ||
    availabilityMessage ||
    (liveUnavailable
      ? "PR chat is not connected to the Studio runtime yet. Send is unavailable until the chat capability is available."
      : null);

  const appendUserMessage = (text: string) => {
    onMessagesChange((current) => [
      ...current,
      {
        id: messageId("pr-chat-user"),
        role: "user",
        content: text,
        createdAt: Date.now()
      }
    ]);
  };

  const sendText = async (
    value: string,
    selection: ChatComposerSelection,
    existingRequestId?: string
  ) => {
    const text = value.trim();
    if (!text || isSending || isLoadingHistory) return;

    const requestId = existingRequestId ?? messageId("pr-chat-request");
    setActiveRequestId(requestId);
    setPendingApproval(null);
    setError(null);
    setFailedRequest(null);
    if (!existingRequestId) {
      appendUserMessage(text);
      onDraftChange("");
    }

    if (demo) {
      onMessagesChange((current) => [
        ...current,
        {
          id: messageId("pr-chat-demo"),
          role: "assistant",
          content:
            "Synthetic demo response: this message was generated locally. No API or assistant runtime was called.",
          createdAt: Date.now()
        }
      ]);
      return;
    }
    if (!adapter) {
      setError(unavailable ?? "PR chat is unavailable.");
      setFailedRequest(null);
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    setIsSending(true);
    try {
      const response = await adapter.send({
        scope,
        text,
        requestId,
        selection,
        signal: controller.signal
      });
      if (!response?.message?.content?.trim()) {
        throw new Error("The chat runtime returned an empty response.");
      }
      onMessagesChange((current) => [...current, response.message]);
      setFailedRequest(null);
    } catch (reason) {
      if ((reason as { name?: string })?.name === "AbortError") {
        setError(
          "Stopped waiting. The runtime may still be processing this request. Retry uses the same request ID."
        );
        setFailedRequest({ text, requestId, selection });
        return;
      }
      setError(
        reason instanceof Error
          ? reason.message
          : "The chat runtime could not answer this message."
      );
      const code = (reason as { code?: string })?.code;
      if (
        !(
          (reason as { status?: number })?.status === 409 &&
          (code === "pr_chat_stale_head" || code === "pr_chat_stale_base")
        )
      ) {
        setFailedRequest({ text, requestId, selection });
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setIsSending(false);
        setActiveRequestId(null);
      }
    }
  };

  const handleActiveAgentChange = (agentId: string | null) => {
    if (activeAgentId === undefined) setLocalActiveAgentId(agentId);
    onActiveAgentChange?.(agentId);
  };

  const selectSuggestion = (prompt: string) => {
    if (draft.trim() && draft.trim() !== prompt) {
      setPendingSuggestion(prompt);
      return;
    }
    onDraftChange(prompt);
  };

  const cancel = () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setIsSending(false);
    setActiveRequestId(null);
    setPendingApproval(null);
  };

  const decideApproval = async (decision: "accept" | "decline") => {
    if (!pendingApproval || !adapter?.resolveApproval) return;
    const controller = controllerRef.current;
    if (!controller) return;
    setResolvingApproval(true);
    try {
      await adapter.resolveApproval({
        scope,
        requestId: pendingApproval.requestId,
        approvalId: pendingApproval.approvalId,
        decision,
        signal: controller.signal
      });
      setPendingApproval(null);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The permission decision could not be recorded."
      );
    } finally {
      setResolvingApproval(false);
    }
  };

  useEffect(() => {
    if (!isSending || !activeRequestId || !adapter?.getApproval) return;
    const controller = new AbortController();
    let active = true;
    const poll = async () => {
      try {
        const approval = await adapter.getApproval?.({
          scope,
          requestId: activeRequestId,
          signal: controller.signal
        });
        if (active && approval) {
          setPendingApproval({ ...approval, requestId: activeRequestId });
        }
      } catch {
        // The running request remains authoritative; transient polling errors are retried.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 500);
    return () => {
      active = false;
      clearInterval(timer);
      controller.abort();
    };
  }, [activeRequestId, adapter, isSending, scope]);

  const composer = (
    <div className="shrink-0 bg-gradient-to-t from-background via-background to-transparent p-4 pt-3">
      {pendingSuggestion && (
        <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground-secondary">
          <span>Replace the current draft with “{pendingSuggestion}”?</span>
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="rounded px-2 py-1 text-muted hover:bg-surface-hover hover:text-foreground"
              onClick={() => setPendingSuggestion(null)}
            >
              Keep draft
            </button>
            <button
              type="button"
              className="rounded bg-surface-hover px-2 py-1 font-medium text-foreground hover:bg-surface-active"
              onClick={() => {
                onDraftChange(pendingSuggestion);
                setPendingSuggestion(null);
              }}
            >
              Replace
            </button>
          </span>
        </div>
      )}

      {error && (
        <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          <span>{error}</span>
          {failedRequest && !isSending && adapter && !isLoadingHistory && (
            <button
              type="button"
              className="shrink-0 rounded px-2 py-1 font-medium hover:bg-danger/10"
              onClick={() =>
                void sendText(
                  failedRequest.text,
                  failedRequest.selection,
                  failedRequest.requestId
                )
              }
            >
              Retry
            </button>
          )}
        </div>
      )}

      {isSending && (
        <div className="mb-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted">
          {pendingApproval ? (
            <div className="space-y-2">
              <div className="font-medium text-foreground-secondary">
                Permission requested: {pendingApproval.title}
              </div>
              {pendingApproval.detail && (
                <div className="break-all text-subtle">
                  {pendingApproval.detail}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={resolvingApproval}
                  className="rounded-md px-3 py-1.5 hover:bg-surface-hover disabled:opacity-50"
                  onClick={() => void decideApproval("decline")}
                >
                  Decline
                </button>
                <button
                  type="button"
                  disabled={resolvingApproval}
                  className="rounded-md bg-surface-hover px-3 py-1.5 text-foreground hover:bg-surface-active disabled:opacity-50"
                  onClick={() => void decideApproval("accept")}
                >
                  Allow once
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Waiting
                for the chat runtime…
              </span>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-muted hover:bg-surface-hover hover:text-foreground"
                onClick={cancel}
              >
                <X className="h-3.5 w-3.5" /> Stop waiting
              </button>
            </div>
          )}
        </div>
      )}

      <ChatComposer
        placeholder="Ask about this pull request..."
        projectName={pullRequest.repositoryFullName}
        branch={pullRequest.headBranch}
        footer={
          demo
            ? "Synthetic demo · no API calls"
            : "Access modes apply only to a temporary local PR checkout. GitHub comments, approvals, pushes, and merges stay separate."
        }
        value={draft}
        onChange={onDraftChange}
        onSend={(text, selection) => void sendText(text, selection)}
        environmentSwitchDisabled
        agents={agents}
        activeAgentId={selectedAgentId}
        onAgentMention={onAgentMention}
        onActiveAgentChange={handleActiveAgentChange}
        modelOptions={modelOptions}
        initialPermissionMode="read"
        initialModel={initialModel}
        initialEffort={initialEffort}
        sendEnabled={
          !isSending &&
          !isLoadingHistory &&
          !historyLoadError &&
          (demo || Boolean(adapter))
        }
        sendDisabledReason={unavailable ?? "Waiting for the chat runtime."}
      />
    </div>
  );

  return (
    <SharedChatUI
      mode={{ kind: "agent", controls: "execution" }}
      scopeKey={`${scope.accountId}:${scope.repositoryId}:${scope.pullRequestNumber}:${scope.baseSha}:${scope.headSha}`}
      messages={messages}
      composer={composer}
      viewportClassName="px-6 py-5"
      listClassName="space-y-5"
      renderMessage={(message) => <AgentChatMessage message={message} />}
      childrenAfter={
        demo && messages.length > 0 ? (
          <p className="mt-5 text-xs text-faint">
            Synthetic demo messages stay in this browser view. No live assistant
            response is generated.
          </p>
        ) : null
      }
    >
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs uppercase tracking-wide text-subtle">PR chat</p>
          {demo && (
            <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
              Synthetic demo · no API
            </span>
          )}
        </div>
        <h2 className="mt-1 text-lg font-medium leading-snug text-foreground">
          {pullRequest.title}
        </h2>
        <p className="mt-1 text-xs text-subtle">
          {pullRequest.repositoryFullName} · {pullRequest.baseBranch} ›{" "}
          {pullRequest.headBranch} · #{pullRequest.number}
        </p>
        <p className="mt-2 text-[11px] text-faint">
          Scoped to {scope.accountLogin || scope.accountId} and head{" "}
          {scope.headSha || "unknown"}.
        </p>
      </div>

      {unavailable && (
        <div className="mb-5 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm text-warning">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{unavailable}</span>
        </div>
      )}

      {isLoadingHistory ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted">
          <LoaderCircle className="h-4 w-4 animate-spin" /> Loading this PR
          conversation…
        </div>
      ) : messages.length === 0 ? (
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted">
            Ask about this pull request. Suggestions fill the composer and never
            send on their own.
          </p>
          <div className="flex flex-wrap gap-2">
            {SUGGESTED_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-foreground-secondary transition-colors hover:border-border-strong hover:text-foreground"
                onClick={() => selectSuggestion(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </SharedChatUI>
  );
}
