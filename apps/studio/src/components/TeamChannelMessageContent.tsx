import { useState } from "react";
import { MessageSquare, Pencil, SmilePlus } from "lucide-react";
import type { CollaborationMessage } from "@koed/shared/collaboration";
import type { TeamAgentRequest } from "@koed/shared/team-agent-requests";
import { teamAgentRequestForwardLabel } from "@/lib/team-agent-channel-sharing";

type TeamChannelMessageContentProps = {
  message: CollaborationMessage;
  principalUserId: string;
  variant: "desktop" | "hosted";
  onReply?: () => void;
  onEditMessage?: (message: CollaborationMessage) => void;
  onToggleReaction?: (
    message: CollaborationMessage,
    emoji: string
  ) => void | Promise<void>;
  forwardRequests: TeamAgentRequest[];
  forwardRequestTextById: Record<string, string>;
  onForwardAnswer?: (request: TeamAgentRequest) => void;
};

export function TeamChannelMessageContent({
  message,
  principalUserId,
  variant,
  onReply,
  onEditMessage,
  onToggleReaction,
  forwardRequests,
  forwardRequestTextById,
  onForwardAnswer
}: TeamChannelMessageContentProps) {
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const name = message.sender.displayName ?? "Team member";

  const forwardedRequests = forwardRequests.map((request) => {
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
        onClick={() => onForwardAnswer?.(request)}
        className="mt-2 mr-2 rounded-md border border-border px-2 py-1 text-[10px] text-subtle hover:bg-surface-hover"
      >
        {label.text}
      </button>
    );
  });

  const reactions = message.reactions.length > 0 && (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {message.reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          disabled={!onToggleReaction}
          aria-pressed={reaction.reacted}
          onClick={() => void onToggleReaction?.(message, reaction.emoji)}
          className={`rounded-full border px-2 py-0.5 text-xs disabled:opacity-50 ${reaction.reacted ? "border-accent/50 bg-accent/10 text-accent" : "border-border bg-surface-hover text-foreground-secondary hover:bg-surface-active"}`}
        >
          {reaction.emoji} {reaction.count}
        </button>
      ))}
    </div>
  );

  const editAction = onEditMessage && message.sender.id === principalUserId && (
    <button
      type="button"
      aria-label="Edit message"
      onClick={() => onEditMessage(message)}
      className={
        variant === "desktop"
          ? "inline-flex items-center gap-1 text-[11px] text-subtle hover:text-foreground"
          : "text-[11px] text-subtle hover:text-foreground"
      }
    >
      {variant === "desktop" && <Pencil className="h-3 w-3" />}
      Edit
    </button>
  );

  const reactionAction = onToggleReaction && (
    <button
      type="button"
      aria-label="Add reaction"
      onClick={() => setReactionPickerOpen((open) => !open)}
      className={
        variant === "desktop"
          ? "inline-flex items-center gap-1 text-[11px] text-subtle hover:text-foreground"
          : "text-[11px] text-subtle hover:text-foreground"
      }
    >
      {variant === "desktop" && <SmilePlus className="h-3.5 w-3.5" />}
      React
    </button>
  );

  const reactionPicker = reactionPickerOpen && onToggleReaction && (
    <div
      className={`absolute left-0 z-10 flex gap-1 rounded-md border border-border bg-surface p-1 shadow-lg ${variant === "desktop" ? "top-6" : "top-5"}`}
    >
      {["👍", "❤️", "😂", "🎉", "👀"].map((emoji) => (
        <button
          key={emoji}
          type="button"
          aria-label={`React ${emoji}`}
          onClick={() => {
            setReactionPickerOpen(false);
            void onToggleReaction(message, emoji);
          }}
          className="rounded px-1.5 py-1 hover:bg-surface-hover"
        >
          {emoji}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-hover text-xs font-semibold">
        {name.slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium">{name}</span>
          <time className="text-[10px] text-subtle">
            {new Date(message.createdAt).toLocaleString()}
          </time>
          {variant === "desktop" && message.editedAt && (
            <span className="text-[10px] text-subtle">Edited</span>
          )}
        </div>
        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground-secondary">
          {message.body}
        </p>
        {variant === "desktop" && message.delivery === "failed" && (
          <p className="text-xs text-warning">Not sent</p>
        )}
        {variant === "hosted" && message.editedAt && (
          <span className="ml-1 text-[10px] text-subtle">Edited</span>
        )}
        {variant === "hosted" && onReply && (
          <button
            type="button"
            onClick={onReply}
            aria-label="Reply in thread"
            className="mt-2 mr-2 rounded-md border border-border px-2 py-1 text-[10px] text-subtle hover:bg-surface-hover"
          >
            Reply in thread
            {message.replyCount > 0 ? ` · ${message.replyCount}` : ""}
            {message.unreadReplyCount > 0
              ? ` · ${message.unreadReplyCount} unread`
              : ""}
          </button>
        )}
        {variant === "desktop" && forwardedRequests}
        {variant === "desktop" && reactions}
        <div
          className={`relative mt-1 flex items-center ${variant === "desktop" ? "gap-3" : "flex-wrap gap-2"}`}
        >
          {variant === "desktop" && onReply && (
            <button
              type="button"
              aria-label={`Reply in thread to ${name}`}
              onClick={onReply}
              className="inline-flex items-center gap-1 text-[11px] text-subtle hover:text-foreground"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              {message.replyCount > 0
                ? `${message.replyCount} ${message.replyCount === 1 ? "reply" : "replies"}`
                : "Reply in thread"}
            </button>
          )}
          {editAction}
          {reactionAction}
          {reactionPicker}
        </div>
        {variant === "hosted" && reactions}
        {variant === "hosted" && forwardedRequests}
      </div>
    </>
  );
}
