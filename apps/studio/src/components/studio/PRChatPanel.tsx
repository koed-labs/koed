"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import type { AgentModelCapability } from "@/lib/agentIdentityEditor";
import { AgentChatMessage, SharedChatUI } from "../SharedChatUI";
import { ChatComposer, type ChatMentionAgent } from "../ChatComposer";

export type PRChatScope = Readonly<{
  accountId: string;
  accountLogin: string;
  repositoryId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  headSha: string;
  baseSha: string;
  reviewId: string;
  executionId: string;
  executionGeneration: number;
  agentId: string;
  agentVersion: number;
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

type PRChatPanelProps = {
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
  demo?: boolean;
  availabilityMessage?: string | null;
  agents?: readonly ChatMentionAgent[];
  activeAgentId?: string | null;
  modelOptions?: readonly AgentModelCapability[];
  initialModel?: string;
  initialEffort?: string;
  initialPermissionMode?: "full" | "ask" | "read";
};

const SUGGESTED_PROMPTS = [
  "Summarize this PR",
  "Find potential bugs",
  "What risks should I check?"
];

/** Synthetic preview only. Real PR chats reuse HostedManagedChats and its runtime. */
export function PRChatPanel({
  pullRequest,
  scope,
  messages,
  draft,
  onDraftChange,
  availabilityMessage,
  agents = [],
  activeAgentId,
  modelOptions = [],
  initialModel,
  initialEffort,
  initialPermissionMode = "read"
}: PRChatPanelProps) {
  const [pendingSuggestion, setPendingSuggestion] = useState<string | null>(
    null
  );
  const selectSuggestion = (value: string) => {
    if (draft.trim() && draft !== value) setPendingSuggestion(value);
    else onDraftChange(value);
  };
  return (
    <SharedChatUI
      mode={{ kind: "agent", controls: "execution" }}
      scopeKey={`${scope.reviewId}:${scope.agentId}`}
      messages={messages}
      viewportClassName="px-6 py-5"
      listClassName="space-y-5"
      renderMessage={(message) => <AgentChatMessage message={message} />}
      composer={
        <div className="px-4 pb-4">
          {pendingSuggestion && (
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted">
              <span>Replace the current draft with “{pendingSuggestion}”?</span>
              <span className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPendingSuggestion(null)}
                >
                  Keep draft
                </button>
                <button
                  type="button"
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
          <ChatComposer
            placeholder="Ask about this pull request..."
            projectName={pullRequest.repositoryFullName}
            branch={pullRequest.headBranch}
            footer="Synthetic demo · no API calls"
            value={draft}
            onChange={onDraftChange}
            onSend={() => undefined}
            environmentSwitchDisabled
            agents={agents}
            activeAgentId={activeAgentId}
            modelOptions={modelOptions}
            showExecutionControls={false}
            initialPermissionMode={initialPermissionMode}
            initialModel={initialModel}
            initialEffort={initialEffort}
            sendEnabled={false}
            sendDisabledReason="Agent reviews are unavailable in this synthetic preview."
          />
        </div>
      }
    >
      <div className="mb-6">
        <p className="text-xs uppercase tracking-wide text-subtle">
          PR chat · Synthetic demo
        </p>
        <h2 className="mt-1 text-lg font-medium leading-snug text-foreground">
          {pullRequest.title}
        </h2>
        <p className="mt-1 text-xs text-subtle">
          {pullRequest.repositoryFullName} · {pullRequest.baseBranch} ›{" "}
          {pullRequest.headBranch} · #{pullRequest.number}
        </p>
        {availabilityMessage && (
          <p className="mt-3 text-xs text-warning">{availabilityMessage}</p>
        )}
      </div>
      {messages.length === 0 && (
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted">
            Suggestions fill the composer and never send on their own.
          </p>
          <div className="flex flex-wrap gap-2">
            {SUGGESTED_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-foreground-secondary hover:text-foreground"
                onClick={() => selectSuggestion(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}
    </SharedChatUI>
  );
}
