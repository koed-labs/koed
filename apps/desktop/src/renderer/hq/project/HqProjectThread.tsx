import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUp } from "lucide-react";
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
  const currentPeople =
    collaboration?.navigation.teams.find((team) => team.id === teamId)
      ?.people ?? [];
  const [thread, setThread] = useState<ProjectThreadV2 | null>(null);
  const [messages, setMessages] = useState<
    TeamCollaborationMessageV2Renderer[]
  >([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const threadRef = useRef<ProjectThreadV2 | null>(null);
  const pendingSendRef = useRef<{
    threadId: string;
    body: string;
    mentionsKey: string;
    clientMessageId: string;
  } | null>(null);
  const draftRef = useRef(draft);
  const mentionsRef = useRef(mentions);
  draftRef.current = draft;
  mentionsRef.current = mentions;
  const sectionRef = useRef<HTMLElement | null>(null);
  const activeRef = useRef(active);
  const refreshRef = useRef<(() => void) | null>(null);
  activeRef.current = active;

  useEffect(() => {
    if (active) refreshRef.current?.();
  }, [active]);

  useEffect(() => {
    const current = ++generation.current;
    threadRef.current = null;
    pendingSendRef.current = null;
    setThread(null);
    setMessages([]);
    setOlderCursor(null);
    setDraft("");
    setMentions([]);
    setMentionPickerOpen(false);
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
                    threadRef.current = null;
                    setThread(null);
                    setMessages([]);
                    setOlderCursor(null);
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
    const prior = pendingSendRef.current;
    const clientMessageId =
      prior?.threadId === selected.id &&
      prior.body === body &&
      prior.mentionsKey === mentionsKey
        ? prior.clientMessageId
        : crypto.randomUUID();
    pendingSendRef.current = {
      threadId: selected.id,
      body,
      mentionsKey,
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
        replyToMessageId: null,
        mentionsUserIds
      });
      if (generation.current === current) {
        if (pendingSendRef.current?.clientMessageId === clientMessageId) {
          pendingSendRef.current = null;
          if (
            draftRef.current.trim() === body &&
            JSON.stringify(mentionsRef.current) === mentionsKey
          ) {
            setDraft("");
            setMentions([]);
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
        <span>Visible to people in this Project</span>
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
                return (
                  <div key={message.id}>
                    {day !== previousDay ? (
                      <div className="hq-project-thread__day">{day}</div>
                    ) : null}
                    <article className="hq-project-thread__message">
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
                        </div>
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
            <label
              className="hq-project-thread__composer-label"
              htmlFor="hq-project-thread-message"
            >
              Message your team
            </label>
            <textarea
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
