import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUp, Reply, X } from "lucide-react";
import { createPortal } from "react-dom";
import type { ProjectThreadV2 } from "@koed/shared/project-thread-contract";
import type { TeamCollaborationMessageV2Renderer } from "@koed/shared/collaboration";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
import type { SharedProjectStore } from "../shared-project/shared-project-store.js";
import "./hq-project-thread.css";

const empty = () => null;
const noSubscribe = () => () => undefined;
const dayLabel = (iso: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(new Date(iso));
const timeLabel = (iso: string) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(iso));
const quoteText = (body: string) => {
  const singleLine = body.replace(/\s+/g, " ").trim();
  return singleLine.length > 90 ? `${singleLine.slice(0, 88)}…` : singleLine;
};

export function HqProjectThread({
  client,
  sharedProjectStore,
  identity,
  active,
  portalHost,
  onUnread,
  onPeople
}: {
  client: CollaborationRendererClient;
  sharedProjectStore: SharedProjectStore;
  identity: {
    ownerId: string;
    profileKey: string;
    personalProjectId: string;
    workspaceProjectId: string;
    teamBackendId: string;
  };
  active: boolean;
  portalHost?: HTMLElement | null;
  onUnread?: (value: {
    unreadCount: number;
    latestSequence: number;
    lastReadSequence: number;
  }) => void;
  onPeople?: (people: ProjectThreadV2["people"]) => void;
}) {
  const snapshot = useSyncExternalStore(
    sharedProjectStore.subscribe ?? noSubscribe,
    sharedProjectStore.current ?? empty
  );
  const collaboration = useSyncExternalStore(
    (listener) => client.subscribe(() => listener()),
    () => client.current(),
    () => null
  );
  const project =
    snapshot?.identity?.ownerId === identity.ownerId &&
    snapshot.identity.profileKey === identity.profileKey &&
    snapshot.identity.personalProjectId === identity.personalProjectId &&
    snapshot.identity.workspaceProjectId === identity.workspaceProjectId &&
    snapshot.identity.teamBackendId === identity.teamBackendId
      ? snapshot.state?.project
      : null;
  const teamId = project?.teamId ?? null;
  const currentTeam = collaboration?.navigation.teams.find(
    (team) => team.id === teamId
  );
  const currentPeople = currentTeam?.people ?? [];
  const teamPrincipalId = collaboration?.navigation.teamPrincipal?.id;
  const ownTeamUserId =
    teamPrincipalId &&
    currentPeople.some(
      (person) =>
        person.id === teamPrincipalId && person.membershipState === "enabled"
    )
      ? teamPrincipalId
      : null;
  const [thread, setThread] = useState<ProjectThreadV2 | null>(null);
  const [messages, setMessages] = useState<
    TeamCollaborationMessageV2Renderer[]
  >([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const [replyToMessageId, setReplyToMessageId] = useState<string | null>(null);
  const [jumpTargetId, setJumpTargetId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const threadRef = useRef<ProjectThreadV2 | null>(null);
  const pendingSendRef = useRef<{
    threadId: string;
    body: string;
    mentionsKey: string;
    replyToMessageId: string | null;
    clientMessageId: string;
  } | null>(null);
  const draftRef = useRef(draft);
  const mentionsRef = useRef(mentions);
  const replyRef = useRef(replyToMessageId);
  draftRef.current = draft;
  mentionsRef.current = mentions;
  replyRef.current = replyToMessageId;
  const sectionRef = useRef<HTMLElement | null>(null);
  const activeRef = useRef(active);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);
  const jumpGeneration = useRef(0);
  activeRef.current = active;

  useEffect(() => {
    if (active) refreshRef.current?.();
    else {
      replyRef.current = null;
      setReplyToMessageId(null);
      jumpGeneration.current++;
    }
  }, [active]);

  useEffect(() => {
    if (!replyToMessageId || !active) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      replyRef.current = null;
      setReplyToMessageId(null);
      pendingSendRef.current = null;
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [replyToMessageId, active]);

  useEffect(() => {
    if (!jumpTargetId) return;
    const target = [
      ...(sectionRef.current?.querySelectorAll<HTMLElement>(
        ".hq-project-thread__message"
      ) ?? [])
    ].find((element) => element.dataset.messageId === jumpTargetId);
    if (!target) return;
    target.scrollIntoView?.({ block: "center", behavior: "smooth" });
    target.focus({ preventScroll: true });
    setJumpTargetId(null);
  }, [jumpTargetId, messages]);

  useEffect(() => {
    const current = ++generation.current;
    jumpGeneration.current++;
    threadRef.current = null;
    pendingSendRef.current = null;
    setThread(null);
    setMessages([]);
    setOlderCursor(null);
    setDraft("");
    setMentions([]);
    setMentionPickerOpen(false);
    setReplyToMessageId(null);
    replyRef.current = null;
    setJumpTargetId(null);
    setError("");
    setBusy(false);
    onUnread?.({ unreadCount: 0, latestSequence: 0, lastReadSequence: 0 });
    onPeople?.([]);
    if (!teamId || project?.lifecycle !== "active") return;
    let inFlight = false;
    let refreshRequested = false;
    let realtimeStarted = false;
    let releaseRealtime: (() => void) | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = async () => {
      if (inFlight) {
        refreshRequested = true;
        return;
      }
      inFlight = true;
      try {
        const metadata = await client.openProjectThreadV2({
          teamId,
          workspaceProjectId: identity.workspaceProjectId
        });
        if (
          generation.current !== current ||
          metadata.workspaceProjectId !== identity.workspaceProjectId ||
          metadata.teamId !== teamId
        )
          return;
        const page = await client.loadProjectThreadMessagesV2({
          teamId,
          workspaceProjectId: identity.workspaceProjectId,
          threadId: metadata.id,
          direction: "older",
          cursor: null
        });
        if (generation.current !== current || page.threadId !== metadata.id)
          return;
        threadRef.current = metadata;
        setThread(metadata);
        onPeople?.(metadata.people);
        if (!realtimeStarted) {
          realtimeStarted = true;
          void client
            .subscribeProjectThreadV2(
              {
                teamId,
                workspaceProjectId: identity.workspaceProjectId,
                threadId: metadata.id
              },
              (event) => {
                if (
                  generation.current !== current ||
                  event.threadId !== metadata.id
                )
                  return;
                if (event.type === "project_thread_v2_control") {
                  releaseRealtime?.();
                  releaseRealtime = null;
                  realtimeStarted = false;
                  if (event.reason === "access_revoked") {
                    generation.current++;
                    threadRef.current = null;
                    setThread(null);
                    setMessages([]);
                    setOlderCursor(null);
                    jumpGeneration.current++;
                    replyRef.current = null;
                    setReplyToMessageId(null);
                    setJumpTargetId(null);
                    pendingSendRef.current = null;
                    onPeople?.([]);
                    onUnread?.({
                      unreadCount: 0,
                      latestSequence: 0,
                      lastReadSequence: 0
                    });
                    setError("Project Thread access is unavailable.");
                    return;
                  }
                  reconnectTimer ??= setTimeout(() => {
                    reconnectTimer = null;
                    if (generation.current === current) void refresh();
                  }, 1000);
                  return;
                }
                void refresh();
              }
            )
            .then((release) => {
              if (generation.current !== current) release();
              else {
                releaseRealtime = release;
                // Reconcile messages delivered between the initial page and subscription.
                void refresh();
              }
            })
            .catch(() => {
              if (generation.current === current) realtimeStarted = false;
            });
        }
        setMessages((previous) => {
          const byId = new Map(
            previous.map((message) => [message.id, message])
          );
          for (const message of page.items) byId.set(message.id, message);
          return [...byId.values()].sort(
            (left, right) => left.sequence - right.sequence
          );
        });
        setOlderCursor(
          (cursor) => cursor ?? (page.hasOlder ? page.olderCursor : null)
        );
        onUnread?.({
          unreadCount: metadata.unreadCount,
          latestSequence: metadata.latestSequence,
          lastReadSequence: metadata.lastReadSequence
        });
        setError("");
        if (
          activeRef.current &&
          document.visibilityState === "visible" &&
          !sectionRef.current?.closest(
            "[hidden], [inert], [aria-hidden='true']"
          ) &&
          page.items.length
        ) {
          const newest = page.items.at(-1)!;
          if (newest.sequence > metadata.lastReadSequence) {
            await client.markProjectThreadReadV2({
              teamId,
              workspaceProjectId: identity.workspaceProjectId,
              threadId: metadata.id,
              messageId: newest.id
            });
            if (generation.current === current)
              onUnread?.({
                unreadCount: 0,
                latestSequence: newest.sequence,
                lastReadSequence: newest.sequence
              });
          }
        }
      } catch (cause) {
        if (generation.current !== current) return;
        threadRef.current = null;
        setThread(null);
        onPeople?.([]);
        setMessages([]);
        jumpGeneration.current++;
        replyRef.current = null;
        setReplyToMessageId(null);
        setJumpTargetId(null);
        pendingSendRef.current = null;
        setError(
          cause instanceof Error
            ? cause.message
            : "Project Thread is unavailable."
        );
        onUnread?.({ unreadCount: 0, latestSequence: 0, lastReadSequence: 0 });
      } finally {
        inFlight = false;
        if (refreshRequested && generation.current === current) {
          refreshRequested = false;
          void refresh();
        }
      }
    };
    refreshRef.current = () => void refresh();
    void refresh();
    return () => {
      generation.current++;
      jumpGeneration.current++;
      refreshRef.current = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      releaseRealtime?.();
    };
  }, [
    client,
    identity.ownerId,
    identity.profileKey,
    identity.personalProjectId,
    identity.workspaceProjectId,
    identity.teamBackendId,
    teamId,
    project?.lifecycle,
    onUnread,
    onPeople
  ]);

  const send = async () => {
    const selected = threadRef.current;
    if (!selected || !teamId || !draft.trim() || busy) return;
    const current = generation.current;
    const body = draft.trim();
    const mentionsUserIds = [...mentions];
    const mentionsKey = JSON.stringify(mentionsUserIds);
    const replyTarget = replyToMessageId;
    const prior = pendingSendRef.current;
    const clientMessageId =
      prior?.threadId === selected.id &&
      prior.body === body &&
      prior.mentionsKey === mentionsKey &&
      prior.replyToMessageId === replyTarget
        ? prior.clientMessageId
        : crypto.randomUUID();
    pendingSendRef.current = {
      threadId: selected.id,
      body,
      mentionsKey,
      replyToMessageId: replyTarget,
      clientMessageId
    };
    setBusy(true);
    try {
      await client.sendProjectThreadMessageV2({
        teamId,
        workspaceProjectId: identity.workspaceProjectId,
        threadId: selected.id,
        clientMessageId,
        body,
        replyToMessageId: replyTarget,
        mentionsUserIds
      });
      if (generation.current === current) {
        if (pendingSendRef.current?.clientMessageId === clientMessageId) {
          pendingSendRef.current = null;
          if (
            draftRef.current.trim() === body &&
            JSON.stringify(mentionsRef.current) === mentionsKey &&
            replyRef.current === replyTarget
          ) {
            setDraft("");
            setMentions([]);
            replyRef.current = null;
            setReplyToMessageId(null);
          }
        }
        const page = await client.loadProjectThreadMessagesV2({
          teamId,
          workspaceProjectId: identity.workspaceProjectId,
          threadId: selected.id,
          direction: "older",
          cursor: null
        });
        if (generation.current === current && page.threadId === selected.id)
          setMessages((previous) => {
            const byId = new Map(
              previous.map((message) => [message.id, message])
            );
            for (const message of page.items) byId.set(message.id, message);
            return [...byId.values()].sort(
              (left, right) => left.sequence - right.sequence
            );
          });
      }
    } catch (cause) {
      if (generation.current === current)
        setError(
          cause instanceof Error ? cause.message : "Message was not sent."
        );
    } finally {
      if (generation.current === current) setBusy(false);
    }
  };

  const jumpToOriginal = async (messageId: string) => {
    const selected = threadRef.current;
    if (!selected || !teamId) return;
    const current = generation.current;
    const jump = ++jumpGeneration.current;
    let known = messages;
    let cursor = olderCursor;
    const seenCursors = new Set<string>();
    while (
      !known.some((message) => message.id === messageId) &&
      cursor &&
      !seenCursors.has(cursor) &&
      seenCursors.size < 200
    ) {
      seenCursors.add(cursor);
      try {
        const requestedCursor = cursor;
        const page = await client.loadProjectThreadMessagesV2({
          teamId,
          workspaceProjectId: identity.workspaceProjectId,
          threadId: selected.id,
          direction: "older",
          cursor: requestedCursor
        });
        if (
          generation.current !== current ||
          jumpGeneration.current !== jump ||
          page.threadId !== selected.id
        )
          return;
        const byId = new Map(known.map((message) => [message.id, message]));
        for (const message of page.items) byId.set(message.id, message);
        known = [...byId.values()].sort(
          (left, right) => left.sequence - right.sequence
        );
        setMessages((previous) => {
          const all = new Map(previous.map((message) => [message.id, message]));
          for (const message of page.items) all.set(message.id, message);
          return [...all.values()].sort(
            (left, right) => left.sequence - right.sequence
          );
        });
        cursor = page.hasOlder ? page.olderCursor : null;
        setOlderCursor((previous) =>
          previous === requestedCursor ? cursor : previous
        );
      } catch (cause) {
        if (generation.current === current && jumpGeneration.current === jump)
          setError(
            cause instanceof Error ? cause.message : "History is unavailable."
          );
        return;
      }
    }
    if (generation.current !== current || jumpGeneration.current !== jump)
      return;
    if (known.some((message) => message.id === messageId))
      setJumpTargetId(messageId);
    else setError("The original message is unavailable.");
  };

  const loadOlder = async () => {
    const selected = threadRef.current;
    if (!selected || !teamId || !olderCursor || busy) return;
    const current = generation.current;
    setBusy(true);
    try {
      const page = await client.loadProjectThreadMessagesV2({
        teamId,
        workspaceProjectId: identity.workspaceProjectId,
        threadId: selected.id,
        direction: "older",
        cursor: olderCursor
      });
      if (generation.current !== current || page.threadId !== selected.id)
        return;
      setMessages((previous) => {
        const byId = new Map(previous.map((message) => [message.id, message]));
        for (const message of page.items) byId.set(message.id, message);
        return [...byId.values()].sort(
          (left, right) => left.sequence - right.sequence
        );
      });
      setOlderCursor(page.hasOlder ? page.olderCursor : null);
    } catch (cause) {
      if (generation.current === current)
        setError(
          cause instanceof Error ? cause.message : "History is unavailable."
        );
    } finally {
      if (generation.current === current) setBusy(false);
    }
  };

  const content = (
    <section
      ref={sectionRef}
      className="hq-project-thread"
      aria-label="Project Team Thread"
    >
      <div className="hq-project-thread__notice">
        <span aria-hidden="true">◇</span>
        <span>
          {currentTeam?.name
            ? `Visible to ${currentTeam.name}`
            : "Visible to people in this Project"}
        </span>
      </div>
      <p className="hq-project-thread__privacy">
        Team messages stay between people. They aren't saved to memory or read
        by agents.
      </p>
      {error ? (
        <p role="status" className="hq-project-thread__error">
          {error}
        </p>
      ) : null}
      {!teamId || !thread ? (
        <p className="hq-project-thread__empty">
          {teamId
            ? "Loading Project Thread…"
            : "Project Thread is unavailable."}
        </p>
      ) : (
        <>
          <div
            className="hq-project-thread__people"
            aria-label="People in this Project"
          >
            {thread.people.map((person) => {
              const presence =
                currentPeople.find(
                  (candidate) => candidate.id === person.userId
                )?.presence ?? "offline";
              return (
                <span
                  key={person.userId}
                  title={`${person.displayName ?? "Team member"}: ${presence}`}
                >
                  <i
                    className={`hq-project-thread__presence hq-project-thread__presence--${presence}`}
                    aria-hidden="true"
                  />
                  <span
                    className="hq-project-thread__person-avatar"
                    aria-hidden="true"
                  >
                    {(person.displayName ?? "T").slice(0, 1).toUpperCase()}
                  </span>
                  {person.displayName ?? "Team member"}
                </span>
              );
            })}
          </div>
          <div
            className="hq-project-thread__messages"
            role="log"
            aria-label="Team messages"
          >
            {olderCursor ? (
              <button
                type="button"
                onClick={() => void loadOlder()}
                disabled={busy}
              >
                Earlier messages
              </button>
            ) : null}
            {messages.length ? (
              messages.map((message, index) => {
                const day = dayLabel(message.createdAt);
                const previousDay = index
                  ? dayLabel(messages[index - 1]!.createdAt)
                  : null;
                const name = message.sender.displayName ?? "Team member";
                const senderLabel =
                  message.sender.id === ownTeamUserId ? "You" : name;
                const original = messages.find(
                  (candidate) => candidate.id === message.replyToMessageId
                );
                return (
                  <div key={message.id}>
                    {day !== previousDay ? (
                      <div className="hq-project-thread__day">{day}</div>
                    ) : null}
                    <article
                      className={`hq-project-thread__message${replyToMessageId === message.id ? " hq-project-thread__message--replying" : ""}`}
                      data-message-id={message.id}
                      tabIndex={-1}
                    >
                      <span
                        className="hq-project-thread__avatar"
                        aria-hidden="true"
                      >
                        {name.slice(0, 1).toUpperCase()}
                      </span>
                      <div className="hq-project-thread__message-body">
                        <div className="hq-project-thread__message-header">
                          <strong>{name}</strong>
                          <time dateTime={message.createdAt}>
                            {timeLabel(message.createdAt)}
                          </time>
                          <button
                            type="button"
                            className="hq-project-thread__reply"
                            aria-label={`Reply to ${senderLabel === "You" ? "your message" : senderLabel}`}
                            title="Reply"
                            onClick={() => {
                              pendingSendRef.current = null;
                              replyRef.current = message.id;
                              setReplyToMessageId(message.id);
                              composerRef.current?.focus();
                            }}
                          >
                            <Reply size={14} aria-hidden="true" />
                          </button>
                        </div>
                        {message.replyToMessageId ? (
                          <button
                            type="button"
                            className="hq-project-thread__quote"
                            aria-label={`Jump to original message${original ? ` from ${original.sender.id === ownTeamUserId ? "You" : (original.sender.displayName ?? "Team member")}` : ""}`}
                            onClick={() =>
                              void jumpToOriginal(message.replyToMessageId!)
                            }
                          >
                            <strong>
                              {original
                                ? original.sender.id === ownTeamUserId
                                  ? "You"
                                  : (original.sender.displayName ??
                                    "Team member")
                                : "Earlier message"}
                            </strong>
                            {original ? (
                              <span>{quoteText(original.body)}</span>
                            ) : null}
                          </button>
                        ) : null}
                        <p>{message.body}</p>
                      </div>
                    </article>
                  </div>
                );
              })
            ) : (
              <p className="hq-project-thread__empty">
                No messages yet. Start the conversation with your team.
              </p>
            )}
          </div>
          <div className="hq-project-thread__composer">
            {replyToMessageId ? (
              <div className="hq-project-thread__reply-chip">
                <Reply size={14} aria-hidden="true" />
                <span>
                  Replying to{" "}
                  <strong>
                    {messages.find((message) => message.id === replyToMessageId)
                      ?.sender.id === ownTeamUserId
                      ? "yourself"
                      : (messages.find(
                          (message) => message.id === replyToMessageId
                        )?.sender.displayName ?? "a team member")}
                  </strong>
                  {messages.find((message) => message.id === replyToMessageId)
                    ? `: ${quoteText(messages.find((message) => message.id === replyToMessageId)!.body)}`
                    : ""}
                </span>
                <button
                  type="button"
                  aria-label="Cancel reply"
                  title="Cancel reply"
                  onClick={() => {
                    replyRef.current = null;
                    setReplyToMessageId(null);
                    pendingSendRef.current = null;
                    composerRef.current?.focus();
                  }}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            ) : null}
            <label
              className="hq-project-thread__composer-label"
              htmlFor="hq-project-thread-message"
            >
              Message your team
            </label>
            <textarea
              ref={composerRef}
              id="hq-project-thread-message"
              placeholder="Message the team"
              value={draft}
              onChange={(event) => {
                pendingSendRef.current = null;
                setDraft(event.target.value);
              }}
              maxLength={8000}
            />
            <div className="hq-project-thread__composer-actions">
              <button
                type="button"
                className="hq-project-thread__mention-trigger"
                aria-expanded={mentionPickerOpen}
                aria-label="Mention a Project member"
                onClick={() => setMentionPickerOpen((open) => !open)}
              >
                @
              </button>
              <button
                type="button"
                className="hq-project-thread__send"
                aria-label="Send message"
                onClick={() => void send()}
                disabled={busy || !draft.trim()}
              >
                <ArrowUp size={19} aria-hidden="true" />
              </button>
            </div>
            {mentionPickerOpen ? (
              <div
                className="hq-project-thread__mentions"
                aria-label="Mention a Project member"
              >
                {thread.people.map((person) => (
                  <button
                    key={person.userId}
                    type="button"
                    aria-pressed={mentions.includes(person.userId)}
                    onClick={() => {
                      pendingSendRef.current = null;
                      setMentions((current) =>
                        current.includes(person.userId)
                          ? current
                          : [...current, person.userId]
                      );
                      setDraft(
                        (current) =>
                          `${current}${current && !/\s$/.test(current) ? " " : ""}@${person.displayName ?? "Member"} `
                      );
                      setMentionPickerOpen(false);
                    }}
                  >
                    @{person.displayName ?? "Member"}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
  return portalHost ? (
    createPortal(content, portalHost)
  ) : (
    <div hidden aria-hidden="true">
      {content}
    </div>
  );
}
