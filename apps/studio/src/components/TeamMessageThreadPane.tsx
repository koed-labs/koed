"use client";

import { MessageSquare, Pencil, SmilePlus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CollaborationMessage } from "@koed/shared/collaboration";
import type { ReactNode } from "react";
import type { TeamAgentRequest } from "@koed/shared/team-agent-requests";
import type { ChatMentionAgent } from "./ChatComposer";
import { ChatComposer, type ChatComposerSelection } from "./ChatComposer";
import { SharedChatUI } from "./SharedChatUI";
import { renderMarkdown } from "@/lib/markdown";
import { teamAgentRequestForwardLabel } from "@/lib/team-agent-channel-sharing";
import {
  threadMessagesForRoot,
  threadReplyVisibleRatio,
  visibleReplyPrefix
} from "@/lib/team-channel-state";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀"];

export type ThreadEditDraft = {
  text: string;
  expectedVersion: number;
  baseBodyText: string;
  conflict?: { latestVersion: number; latestBodyText: string };
};

export function TeamMessageThreadPane({
  root,
  replies,
  hasOlderReplies = false,
  principalUserId,
  connected,
  replyDraft,
  pendingSend,
  pendingStatus,
  editDrafts,
  agents = [],
  agentRequests,
  forwardRequestsByMessage = {},
  forwardRequestTextById = {},
  onClose,
  onReplyDraftChange,
  onSendReply,
  onRetryPending,
  onStartEdit,
  onCancelEdit,
  onEditDraftChange,
  onSaveEdit,
  onReviewEditConflict,
  onToggleReaction,
  onForwardAnswer,
  onReplyVisible,
  onLoadOlderReplies
}: {
  root: CollaborationMessage;
  replies: CollaborationMessage[];
  hasOlderReplies?: boolean;
  principalUserId: string;
  connected: boolean;
  replyDraft: string;
  pendingSend: {
    clientMessageId: string;
    body: string;
    createdAt: string;
  } | null;
  pendingStatus: "pending" | "uncertain" | "retry_failed" | null;
  editDrafts: ReadonlyMap<string, ThreadEditDraft>;
  agents?: readonly ChatMentionAgent[];
  agentRequests?: ReactNode;
  forwardRequestsByMessage?: Record<string, TeamAgentRequest[]>;
  forwardRequestTextById?: Record<string, string>;
  onClose: () => void;
  onReplyDraftChange: (text: string) => void;
  onSendReply: (
    text: string,
    selection: ChatComposerSelection
  ) => void | Promise<void>;
  onRetryPending: () => void | Promise<void>;
  onStartEdit: (message: CollaborationMessage) => void;
  onCancelEdit: (message: CollaborationMessage) => void;
  onEditDraftChange: (message: CollaborationMessage, text: string) => void;
  onSaveEdit: (
    message: CollaborationMessage,
    draft: ThreadEditDraft
  ) => void | Promise<void>;
  onReviewEditConflict: (message: CollaborationMessage) => void | Promise<void>;
  onToggleReaction: (
    message: CollaborationMessage,
    emoji: string
  ) => void | Promise<void>;
  onForwardAnswer?: (
    request: TeamAgentRequest,
    message: CollaborationMessage
  ) => void;
  onReplyVisible: (message: CollaborationMessage) => void;
  onLoadOlderReplies?: () => void;
}) {
  const messages = useMemo(
    () => threadMessagesForRoot(root, replies),
    [root, replies]
  );
  const sharedMessages = useMemo(
    () =>
      messages.map((message) => ({
        id: message.id,
        role:
          message.sender.id === principalUserId
            ? ("user" as const)
            : ("assistant" as const),
        content: message.body,
        authoredByViewer: message.sender.id === principalUserId,
        author: { name: message.sender.displayName || "Team member" },
        source: message
      })),
    [messages, principalUserId]
  );
  const [reactionPickerFor, setReactionPickerFor] = useState<string | null>(
    null
  );
  const messagesRef = useRef<HTMLDivElement>(null);
  const visibleReplyIds = useRef(new Set<string>());
  useEffect(() => {
    const container = messagesRef.current?.querySelector<HTMLElement>(
      '[aria-label="Team conversation"]'
    );
    if (!container || typeof IntersectionObserver === "undefined") return;
    const repliesInOrder = messages
      .filter((message) => message.rootMessageId === root.id)
      .slice()
      .sort((a, b) => a.sequence - b.sequence);
    const byId = new Map(
      repliesInOrder.map((message) => [message.id, message])
    );
    const reportVisible = (element: HTMLElement) => {
      const id = element.dataset.threadReplyId;
      const message = id ? byId.get(id) : undefined;
      const elementBounds = element.getBoundingClientRect();
      const containerBounds = container.getBoundingClientRect();
      const visibleRatio = threadReplyVisibleRatio({
        element: elementBounds,
        container: containerBounds,
        viewport: {
          top: 0,
          left: 0,
          right: window.innerWidth,
          bottom: window.innerHeight
        }
      });
      if (
        !message ||
        visibleRatio < 0.6 ||
        document.visibilityState !== "visible" ||
        !document.hasFocus()
      )
        return;
      visibleReplyIds.current.add(message.id);
      if (hasOlderReplies) return;
      for (const reply of visibleReplyPrefix(
        repliesInOrder,
        visibleReplyIds.current
      ))
        onReplyVisible(reply);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (
            !entry.isIntersecting ||
            document.visibilityState !== "visible" ||
            !document.hasFocus()
          )
            continue;
          reportVisible(entry.target as HTMLElement);
        }
      },
      { root: container, threshold: 0.6 }
    );
    container
      .querySelectorAll<HTMLElement>("[data-thread-reply-id]")
      .forEach((element) => observer.observe(element));
    const recheck = () =>
      container
        .querySelectorAll<HTMLElement>("[data-thread-reply-id]")
        .forEach(reportVisible);
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      observer.disconnect();
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [hasOlderReplies, messages, onReplyVisible, root.id]);

  return (
    <aside className="fixed right-0 top-14 bottom-44 z-30 flex w-[min(360px,92vw)] flex-shrink-0 flex-col border-l border-border bg-background shadow-2xl md:relative md:inset-auto md:z-auto md:w-[360px] md:shadow-none">
      <header className="flex items-start justify-between border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <MessageSquare className="h-4 w-4 text-subtle" />
            Thread
          </div>
          <p className="mt-1 text-xs text-subtle">
            {replies.length} {replies.length === 1 ? "reply" : "replies"}
            {root.unreadReplyCount > 0
              ? ` · ${root.unreadReplyCount} unread`
              : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close thread"
          className="rounded-md p-1 text-subtle hover:bg-surface-hover hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {agentRequests}

      <div ref={messagesRef} className="flex min-h-0 flex-1">
        <SharedChatUI
          mode={{ kind: "human", controls: "formatting" }}
          scopeKey={`team-thread:${root.teamId ?? ""}:${root.threadId}:${root.id}:${principalUserId}`}
          messages={sharedMessages}
          className="min-h-0 flex-1"
          viewportClassName="p-4"
          listClassName="space-y-4"
          emptyState={<p className="text-sm text-subtle">No replies yet.</p>}
          composer={
            <div className="border-t border-border p-3">
              {pendingSend && (
                <div
                  role="status"
                  className="mb-2 flex items-center justify-between gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2 text-xs"
                >
                  <span>
                    {pendingStatus === "uncertain"
                      ? "Reply delivery is being confirmed."
                      : pendingStatus === "retry_failed"
                        ? "Reply was not confirmed. Retry keeps the same message ID."
                        : "Pending · saved on this device."}
                  </span>
                  <button
                    type="button"
                    disabled={!connected}
                    onClick={() => void onRetryPending()}
                    className="shrink-0 font-medium text-foreground underline disabled:opacity-50"
                  >
                    Retry
                  </button>
                </div>
              )}
              {!connected && (
                <p className="mb-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2 text-xs text-muted">
                  Pending · saved on this device until you reconnect.
                </p>
              )}
              <fieldset className="m-0 min-w-0 border-0 p-0">
                <ChatComposer
                  placeholder="Reply in thread..."
                  projectName="Team channel"
                  branch="shared"
                  value={replyDraft}
                  onChange={onReplyDraftChange}
                  onSend={onSendReply}
                  agents={agents}
                  showExecutionControls={false}
                  switchToExecutionControlsOnMention={agents.length > 0}
                  showMetaBar={false}
                  showFormattingToolbar
                  sendEnabled={Boolean(replyDraft.trim()) && !pendingSend}
                  footer={
                    connected
                      ? "Replying to the selected channel message."
                      : "Your reply will stay pending on this device."
                  }
                />
              </fieldset>
            </div>
          }
          renderMessage={(sharedMessage) => {
            const message = sharedMessage.source as CollaborationMessage;
            const isAuthor = message.sender.id === principalUserId;
            const edit = editDrafts.get(message.id);
            const canEdit = isAuthor && message.delivery === "sent";
            return (
              <article
                key={message.id}
                data-thread-message-id={message.id}
                data-thread-reply-id={
                  message.rootMessageId == null ? undefined : message.id
                }
                className="flex gap-2.5"
              >
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-hover text-xs font-semibold text-foreground-secondary">
                  {(message.sender.displayName || "T")
                    .slice(0, 1)
                    .toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {message.sender.displayName || "Team member"}
                    </span>
                    <time className="text-[10px] text-subtle">
                      {new Date(message.createdAt).toLocaleString()}
                    </time>
                    {message.editedAt && (
                      <span className="text-[10px] text-subtle">Edited</span>
                    )}
                  </div>

                  {edit ? (
                    <div className="mt-2 space-y-2">
                      {edit.conflict && (
                        <div className="rounded-md border border-warning/40 bg-warning/5 p-2.5 text-xs">
                          <p className="font-medium text-foreground">
                            This message changed while you were editing.
                          </p>
                          <p className="mt-1 whitespace-pre-wrap text-foreground-secondary">
                            Latest saved text: {edit.conflict.latestBodyText}
                          </p>
                          <button
                            type="button"
                            disabled={!connected}
                            onClick={() => void onReviewEditConflict(message)}
                            className="mt-2 rounded-md border border-border px-2 py-1 font-medium text-foreground disabled:opacity-50"
                          >
                            Review latest text
                          </button>
                        </div>
                      )}
                      <textarea
                        value={edit.text}
                        onChange={(event) =>
                          onEditDraftChange(message, event.target.value)
                        }
                        rows={3}
                        className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 text-sm text-foreground outline-none focus:border-accent"
                        aria-label="Edit message"
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => onCancelEdit(message)}
                          className="rounded-md px-2.5 py-1.5 text-xs text-subtle hover:bg-surface-hover"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={
                            !connected ||
                            Boolean(edit.conflict) ||
                            !edit.text.trim()
                          }
                          onClick={() => void onSaveEdit(message, edit)}
                          className="rounded-md bg-chip px-3 py-1.5 text-xs font-medium text-chip-foreground disabled:opacity-50"
                        >
                          Save edit
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="mt-1 break-words text-sm leading-6 text-foreground-secondary">
                        {renderMarkdown(message.body)}
                      </div>
                      {(forwardRequestsByMessage[message.id] ?? []).map(
                        (request) => {
                          const label = teamAgentRequestForwardLabel(
                            request,
                            forwardRequestTextById[request.id]
                          );
                          return (
                            <button
                              key={request.id}
                              type="button"
                              data-team-request-id={request.id}
                              aria-label={label.accessibleName}
                              title={label.accessibleName}
                              onClick={() =>
                                onForwardAnswer?.(request, message)
                              }
                              className="mt-2 mr-2 rounded-md border border-border px-2 py-1 text-[10px] text-subtle hover:bg-surface-hover"
                            >
                              {label.text}
                            </button>
                          );
                        }
                      )}
                      {message.reactions.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {message.reactions.map((reaction) => (
                            <button
                              key={reaction.emoji}
                              type="button"
                              disabled={!connected}
                              aria-pressed={reaction.reacted}
                              onClick={() =>
                                void onToggleReaction(message, reaction.emoji)
                              }
                              className={`rounded-full border px-2 py-0.5 text-xs disabled:opacity-50 ${reaction.reacted ? "border-accent/50 bg-accent/10 text-accent" : "border-border bg-surface-hover text-foreground-secondary hover:bg-surface-active"}`}
                            >
                              {reaction.emoji} {reaction.count}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="relative mt-1 flex items-center gap-3">
                        <button
                          type="button"
                          disabled={!connected}
                          onClick={() =>
                            setReactionPickerFor(
                              reactionPickerFor === message.id
                                ? null
                                : message.id
                            )
                          }
                          className="inline-flex items-center gap-1 text-[11px] text-subtle hover:text-foreground disabled:opacity-50"
                        >
                          <SmilePlus className="h-3.5 w-3.5" /> React
                        </button>
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => onStartEdit(message)}
                            className="inline-flex items-center gap-1 text-[11px] text-subtle hover:text-foreground"
                          >
                            <Pencil className="h-3 w-3" /> Edit
                          </button>
                        )}
                        {reactionPickerFor === message.id && (
                          <div
                            className="absolute left-0 top-6 z-10 flex gap-1 rounded-md border border-border bg-surface p-1 shadow-lg"
                            aria-label="Choose a reaction"
                          >
                            {QUICK_REACTIONS.map((emoji) => (
                              <button
                                key={emoji}
                                type="button"
                                disabled={!connected}
                                onClick={() => {
                                  setReactionPickerFor(null);
                                  void onToggleReaction(message, emoji);
                                }}
                                aria-label={`React ${emoji}`}
                                className="rounded px-1.5 py-1 hover:bg-surface-hover disabled:opacity-50"
                              >
                                {emoji}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </article>
            );
          }}
          childrenAfter={
            pendingSend &&
            !replies.some(
              (message) =>
                message.clientMessageId === pendingSend.clientMessageId
            ) && (
              <article
                data-thread-message-id={`pending-${pendingSend.clientMessageId}`}
                data-thread-pending-client-message-id={
                  pendingSend.clientMessageId
                }
                className="flex gap-2.5 opacity-80"
              >
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-hover text-xs font-semibold text-foreground-secondary">
                  {(principalUserId ? "Y" : "T").toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium text-foreground">
                      You
                    </span>
                    <span className="text-[10px] text-warning">
                      {pendingStatus === "uncertain"
                        ? "Delivery unconfirmed"
                        : pendingStatus === "retry_failed"
                          ? "Retry needed"
                          : "Pending"}
                    </span>
                  </div>
                  <div className="mt-1 break-words text-sm leading-6 text-foreground-secondary">
                    {renderMarkdown(pendingSend.body)}
                  </div>
                </div>
              </article>
            )
          }
        >
          {hasOlderReplies && (
            <button
              type="button"
              onClick={onLoadOlderReplies}
              className="mx-auto block text-xs text-muted hover:text-foreground"
            >
              Load older replies
            </button>
          )}
        </SharedChatUI>
      </div>
    </aside>
  );
}
