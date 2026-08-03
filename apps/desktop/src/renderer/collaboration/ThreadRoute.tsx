import {
  ChatTimeline,
  SecureMarkdown,
  type ChatDayDividerRow,
  type ChatMessageRow,
  type ChatTimelineVisibleRange,
  type MarkdownPlatformAdapters
} from "@koed/memory-ui";
import type {
  CollaborationMessage,
  CollaborationMessagePage,
  CollaborationSnapshot,
  CollaborationThread
} from "@koed/shared/collaboration";
import {
  Check,
  CheckCheck,
  Clipboard,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  Send
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";

import {
  CollaborationClientError,
  collaborationThreadReference,
  type CollaborationRendererClient
} from "../../collaboration/renderer-client.js";
import type { DraftAuthority } from "../state/drafts.js";
import { utf8ByteLength } from "../state/drafts.js";
import { ReadReceiptController } from "../state/read-receipt.js";

type MessageSendInput = Parameters<
  CollaborationRendererClient["sendMessage"]
>[0];

export type CollaborationDrafts = {
  get: (authority: DraftAuthority) => string;
  purge: (authority: DraftAuthority) => void;
  set: (authority: DraftAuthority, value: string) => void;
};

export type ThreadRouteProps = {
  client: CollaborationRendererClient;
  drafts: CollaborationDrafts;
  markdownAdapters: MarkdownPlatformAdapters;
  onEditChannel?: (threadId: string) => void;
  page: CollaborationMessagePage;
  snapshot: CollaborationSnapshot;
  thread: CollaborationThread;
};

type TimelineMessage = CollaborationMessage & {
  senderId: string;
  timestamp: string;
};

const normalizedText = (value: string): string => value.normalize("NFC").trim();

const failureMessage = (cause: unknown, fallback: string): string =>
  cause instanceof CollaborationClientError ? cause.userMessage : fallback;

const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts.at(-1)?.[0] ?? ""}`.toUpperCase();
};

const formatTime = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
};

export const collaborationThreadTitle = (
  thread: CollaborationThread,
  currentUserId: string
): string => {
  if (thread.kind === "notes_to_self") return "Notes to self";
  if (thread.name) return thread.name;
  if (thread.kind === "dm" || thread.kind === "group_dm") {
    const names = thread.participants
      .filter((person) => person.id !== currentUserId)
      .map((person) => person.displayName);
    return names.join(", ") || "Direct message";
  }
  return "Discussion";
};

const principalIdForThread = (
  snapshot: CollaborationSnapshot,
  thread: CollaborationThread
): string =>
  thread.scope === "personal"
    ? snapshot.navigation.personalOwner.id
    : (snapshot.navigation.teamPrincipal?.id ?? "");

export const draftAuthorityForThread = (
  snapshot: CollaborationSnapshot,
  thread: CollaborationThread
): DraftAuthority | null => {
  if (thread.scope === "personal") {
    return {
      scope: "personal",
      principalId: snapshot.navigation.personalOwner.id,
      threadId: thread.id
    };
  }
  const backendId = snapshot.connection.backendId;
  const principalId = snapshot.navigation.teamPrincipal?.id;
  if (!backendId || !principalId) return null;
  return {
    scope: "team",
    backendId,
    principalId,
    teamId: thread.teamId,
    workspaceId:
      thread.kind === "workspace_channel" ||
      thread.kind === "shared_session_discussion"
        ? thread.workspaceId
        : null,
    threadId: thread.id
  };
};

const toTimelineMessage = (message: CollaborationMessage): TimelineMessage => ({
  ...message,
  senderId: message.sender.id,
  timestamp: message.createdAt
});

function MessageRow({
  adapters,
  message,
  compact,
  outgoing
}: {
  adapters: MarkdownPlatformAdapters;
  compact: boolean;
  message: CollaborationMessage;
  outgoing: boolean;
}) {
  const actionsRef = useRef<HTMLDetailsElement | null>(null);
  return (
    <div
      role="listitem"
      className={`collab-message ${message.delivery}${compact ? " compact" : ""}`}
      data-message-id={message.id}
    >
      <span className="collab-avatar" aria-hidden="true">
        {compact ? "" : initials(message.sender.displayName).slice(0, 1)}
      </span>
      <div className="collab-message-content">
        {!compact ? (
          <header>
            <strong>{message.sender.displayName}</strong>
            <time dateTime={message.createdAt}>
              {formatTime(message.createdAt)}
            </time>
          </header>
        ) : null}
        <SecureMarkdown
          adapters={adapters}
          className="chat-markdown"
          source={message.body}
          oversizedFallback={
            <p role="alert">This message is too large to display safely.</p>
          }
        />
        <details className="collab-message-actions" ref={actionsRef}>
          <summary
            aria-label={`Actions for message from ${message.sender.displayName}`}
            tabIndex={0}
            title="Message actions"
          >
            <MoreHorizontal aria-hidden="true" />
          </summary>
          <div role="menu" aria-label="Message actions">
            <button
              onClick={() => {
                void adapters.writeClipboard(message.body);
                actionsRef.current?.removeAttribute("open");
              }}
              role="menuitem"
              type="button"
            >
              <Clipboard aria-hidden="true" />
              Copy message
            </button>
          </div>
        </details>
        <footer>
          {message.delivery === "queued" ? <span>Sending...</span> : null}
          {message.delivery === "sent" && outgoing ? (
            <span
              className="collab-recipient-status"
              data-status={message.recipientStatus ?? "sent"}
              title={
                message.recipientStatus === "read"
                  ? "Read by everyone"
                  : message.recipientStatus === "delivered"
                    ? "Delivered to everyone"
                    : "Sent"
              }
              aria-label={
                message.recipientStatus === "read"
                  ? "Read by everyone"
                  : message.recipientStatus === "delivered"
                    ? "Delivered to everyone"
                    : "Sent"
              }
            >
              {message.recipientStatus === "sent" ||
              message.recipientStatus === null ? (
                <Check aria-hidden="true" />
              ) : (
                <CheckCheck aria-hidden="true" />
              )}
            </span>
          ) : null}
          {message.delivery === "failed" ? (
            <>
              <span className="collab-inline-error">
                {message.failure?.userMessage ?? "Message not sent."}
              </span>
              <span>Send the draft again from the composer.</span>
            </>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

function TimelineDivider({
  children,
  className
}: {
  children: ReactNode;
  className: string;
}) {
  return (
    <div className={className} role="separator">
      {children}
    </div>
  );
}

export function ThreadTimeline({
  client,
  currentUserId,
  label,
  markdownAdapters,
  page,
  readEligible = true,
  thread
}: {
  client: CollaborationRendererClient;
  currentUserId: string;
  label: string;
  markdownAdapters: MarkdownPlatformAdapters;
  page: CollaborationMessagePage;
  readEligible?: boolean;
  thread: CollaborationThread;
}) {
  const [historyError, setHistoryError] = useState("");
  const [atEnd, setAtEnd] = useState(false);
  const [visibleRange, setVisibleRange] =
    useState<ChatTimelineVisibleRange | null>(null);
  const [focusRevision, setFocusRevision] = useState(0);
  const timelineMessages = useMemo(
    () => page.items.map(toTimelineMessage),
    [page.items]
  );
  const unreadMessages = page.items.filter(
    (message) =>
      message.sequence > thread.lastReadSequence &&
      message.sender.id !== currentUserId
  );
  const firstUnreadMessageId =
    thread.unreadCount > 0 ? (unreadMessages[0]?.id ?? null) : null;
  const finalUnreadMessageId =
    thread.unreadCount > 0 && !page.hasNewer
      ? (unreadMessages.at(-1)?.id ?? null)
      : null;
  const controller = useMemo(
    () =>
      new ReadReceiptController({
        markRead: async (messageId) => {
          await client.markRead({
            thread: collaborationThreadReference(thread),
            messageId
          });
        }
      }),
    [client, thread.id]
  );

  const latestDeliveredCandidate =
    !page.hasNewer && page.items.length > 0
      ? (page.items.at(-1)?.id ?? null)
      : null;

  useEffect(() => {
    if (!latestDeliveredCandidate) return;
    void client
      .markDelivered({
        thread: collaborationThreadReference(thread),
        messageId: latestDeliveredCandidate
      })
      .catch(() => undefined);
  }, [client, latestDeliveredCandidate, thread.id]);

  useEffect(() => {
    const updateFocus = () => setFocusRevision((value) => value + 1);
    window.addEventListener("focus", updateFocus);
    window.addEventListener("blur", updateFocus);
    document.addEventListener("visibilitychange", updateFocus);
    return () => {
      window.removeEventListener("focus", updateFocus);
      window.removeEventListener("blur", updateFocus);
      document.removeEventListener("visibilitychange", updateFocus);
    };
  }, []);

  useEffect(() => {
    controller.update({
      atEnd,
      documentVisible: document.visibilityState === "visible",
      finalUnreadId: finalUnreadMessageId,
      hasNewer: page.hasNewer,
      lastVisibleId: visibleRange?.lastVisibleMessageId ?? null,
      windowFocused: readEligible && document.hasFocus()
    });
  }, [
    atEnd,
    controller,
    finalUnreadMessageId,
    focusRevision,
    page.hasNewer,
    readEligible,
    visibleRange
  ]);

  useEffect(() => () => controller.dispose(), [controller]);

  const loadPage = useCallback(
    async (direction: "older" | "newer") => {
      setHistoryError("");
      try {
        await client.loadMessagePage({
          thread: collaborationThreadReference(thread),
          direction,
          cursor: direction === "older" ? page.olderCursor : page.newerCursor
        });
      } catch (cause) {
        setHistoryError(
          failureMessage(cause, "Message history is unavailable.")
        );
        throw cause;
      }
    },
    [client, page.newerCursor, page.olderCursor, thread]
  );

  return (
    <div
      className="collab-message-history"
      data-rendered-count={page.items.length}
    >
      {page.hasOlder ? (
        <div className="collab-history-control">
          <button
            type="button"
            className="collab-text-button"
            onClick={() => void loadPage("older").catch(() => undefined)}
          >
            Load older messages
          </button>
        </div>
      ) : page.items.length > 0 ? (
        <div className="collab-history-control">
          <span>Beginning of history</span>
        </div>
      ) : null}
      {page.items.length === 0 ? (
        <div className="collab-empty-inline">No messages yet.</div>
      ) : (
        <ChatTimeline<TimelineMessage>
          ariaLabel={`${label} messages`}
          className="collab-message-list collab-virtual-list"
          estimatedItemHeight={72}
          firstUnreadMessageId={firstUnreadMessageId}
          hasNewerMessages={page.hasNewer}
          hasOlderMessages={page.hasOlder}
          messages={timelineMessages}
          onAtEndChange={setAtEnd}
          onLoadNewer={() => loadPage("newer")}
          onLoadOlder={() => loadPage("older")}
          onPageLoadError={(cause) =>
            setHistoryError(
              failureMessage(cause, "Message history is unavailable.")
            )
          }
          onVisibleRangeChange={setVisibleRange}
          renderDayDivider={(row: ChatDayDividerRow) => (
            <TimelineDivider className="collab-day-divider">
              <time dateTime={row.timestamp}>{formatTime(row.timestamp)}</time>
            </TimelineDivider>
          )}
          renderFirstUnread={() => (
            <TimelineDivider className="collab-new-divider">
              New
            </TimelineDivider>
          )}
          renderGroup={() => null}
          renderMessage={(row: ChatMessageRow<TimelineMessage>) => (
            <MessageRow
              adapters={markdownAdapters}
              compact={row.position !== "first" && row.position !== "only"}
              message={row.message}
              outgoing={row.message.sender.id === currentUserId}
            />
          )}
          threadKey={thread.id}
        />
      )}
      {historyError ? (
        <div className="collab-history-control">
          <span className="collab-inline-error">{historyError}</span>
        </div>
      ) : null}
      {page.hasNewer ? (
        <div className="collab-history-control collab-newer-control">
          <button
            type="button"
            className="collab-text-button"
            onClick={() => void loadPage("newer").catch(() => undefined)}
          >
            <RefreshCw aria-hidden="true" />
            Return to recent messages
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function MessageComposer({
  client,
  drafts,
  snapshot,
  thread
}: {
  client: CollaborationRendererClient;
  drafts: CollaborationDrafts;
  snapshot: CollaborationSnapshot;
  thread: CollaborationThread;
}) {
  const authority = draftAuthorityForThread(snapshot, thread);
  const authorityKey = authority ? JSON.stringify(authority) : "";
  const [draft, setDraft] = useState(() =>
    authority ? drafts.get(authority) : ""
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [failedSend, setFailedSend] = useState<MessageSendInput | null>(null);
  const [sendBlocked, setSendBlocked] = useState(false);
  const operationGeneration = useRef(0);
  const composing = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const title = collaborationThreadTitle(
    thread,
    principalIdForThread(snapshot, thread)
  );
  const draftBytes = utf8ByteLength(draft);
  const byteLimit = snapshot.limits.messageMaxUtf8Bytes;

  useEffect(() => {
    operationGeneration.current += 1;
    setDraft(authority ? drafts.get(authority) : "");
    setSending(false);
    setError("");
    setFailedSend(null);
    setSendBlocked(false);
  }, [authorityKey, drafts]);

  useEffect(() => {
    if (thread.canPost) return;
    if (authority) drafts.purge(authority);
    setDraft("");
    operationGeneration.current += 1;
    setSending(false);
    setFailedSend(null);
    setSendBlocked(false);
  }, [authorityKey, drafts, thread.canPost]);

  const updateDraft = (value: string) => {
    setDraft(value);
    if (authority) drafts.set(authority, value);
    setError("");
    setFailedSend(null);
    setSendBlocked(false);
  };

  const send = async () => {
    const body = normalizedText(draft);
    if (!body || sending || sendBlocked || !thread.canPost || !authority)
      return;
    if (utf8ByteLength(body) > snapshot.limits.messageMaxUtf8Bytes) {
      setError(
        `Messages can be at most ${snapshot.limits.messageMaxUtf8Bytes.toLocaleString()} UTF-8 bytes.`
      );
      return;
    }
    const retryInput =
      failedSend?.thread.threadId === thread.id && failedSend.body === body
        ? failedSend
        : null;
    const input: MessageSendInput =
      retryInput ??
      Object.freeze({
        thread: collaborationThreadReference(thread),
        clientMessageId: crypto.randomUUID(),
        body
      });
    const generation = ++operationGeneration.current;
    setSending(true);
    setError("");
    try {
      if (retryInput) await client.retryMessage(input);
      else await client.sendMessage(input);
      if (generation !== operationGeneration.current) return;
      setFailedSend(null);
      setSendBlocked(false);
      drafts.purge(authority);
      setDraft("");
      textareaRef.current?.focus();
    } catch (cause) {
      if (generation !== operationGeneration.current) return;
      setError(failureMessage(cause, "Message not sent. Try again."));
      const retryable =
        cause instanceof CollaborationClientError && cause.retryable;
      setFailedSend(retryable ? input : null);
      setSendBlocked(!retryable);
    } finally {
      if (generation === operationGeneration.current) setSending(false);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = event.nativeEvent as KeyboardEvent;
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !nativeEvent.isComposing &&
      !composing.current
    ) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="collab-compose-region">
      {error ? (
        <div className="collab-compose-error" role="alert">
          <span>{error}</span>
          {failedSend ? (
            <button
              type="button"
              className="collab-text-button"
              disabled={sending}
              onClick={() => void send()}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="collab-composer-scope">
        <span>
          {thread.scope === "personal"
            ? "Personal · Private to you"
            : thread.kind === "workspace_channel" ||
                thread.kind === "shared_session_discussion"
              ? "Team · Workspace"
              : "Team · Direct message"}
        </span>
        <span
          aria-label={`${draftBytes.toLocaleString()} of ${byteLimit.toLocaleString()} UTF-8 bytes`}
          data-over-limit={draftBytes > byteLimit || undefined}
        >
          {draftBytes.toLocaleString()} / {byteLimit.toLocaleString()} bytes
        </span>
      </div>
      <div className="collab-composer">
        <textarea
          name="message"
          ref={textareaRef}
          rows={1}
          value={draft}
          aria-label={`Message ${title}`}
          placeholder={
            thread.canPost ? `Message ${title}` : "Read-only conversation"
          }
          disabled={!thread.canPost || sending || !authority}
          onChange={(event) => updateDraft(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="collab-icon-button collab-send-button"
          aria-label={failedSend ? "Retry message" : "Send message"}
          title={failedSend ? "Retry message" : "Send message"}
          disabled={
            !draft.trim() ||
            sending ||
            sendBlocked ||
            !thread.canPost ||
            !authority
          }
          onClick={() => void send()}
        >
          {sending ? (
            <LoaderCircle className="collab-spin" aria-hidden="true" />
          ) : (
            <Send aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}

export function ThreadRoute({
  client,
  drafts,
  markdownAdapters,
  onEditChannel,
  page,
  snapshot,
  thread
}: ThreadRouteProps) {
  const title = collaborationThreadTitle(
    thread,
    principalIdForThread(snapshot, thread)
  );
  return (
    <section className="collab-conversation" aria-label={title}>
      <header className="collab-content-header">
        <div>
          <h1>
            {thread.kind === "workspace_channel" ||
            thread.kind === "personal_channel"
              ? "# "
              : ""}
            {title}
          </h1>
          {thread.topic ? <p>{thread.topic}</p> : null}
        </div>
        {(thread.kind === "personal_channel" ||
          thread.kind === "workspace_channel") &&
        onEditChannel ? (
          <button
            type="button"
            className="collab-icon-button"
            aria-label={`Edit ${title}`}
            title="Channel actions"
            onClick={() => onEditChannel(thread.id)}
          >
            <MoreHorizontal aria-hidden="true" />
          </button>
        ) : null}
      </header>
      <ThreadTimeline
        client={client}
        currentUserId={principalIdForThread(snapshot, thread)}
        label={title}
        markdownAdapters={markdownAdapters}
        page={page}
        thread={thread}
      />
      <MessageComposer
        client={client}
        drafts={drafts}
        snapshot={snapshot}
        thread={thread}
      />
    </section>
  );
}
