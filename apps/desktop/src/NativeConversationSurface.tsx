import { VirtualizedTimeline, threadSelectionKey } from "@koed/memory-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  conversationEventsUrl,
  conversationEventText,
  mergeConversationEvents,
  type DesktopConversationEvent
} from "./desktop-conversation.js";
import type { DesktopThreadGroup } from "./project-memory-ui.js";

const initialEventLimit = 50;
const olderEventLimit = 500;

function eventActorLabel(event: DesktopConversationEvent): string {
  if (event.actor === "user") return "You";
  if (event.actor === "assistant") return "AI Client";
  if (event.actor === "tool") {
    const toolName = event.metadata.toolName;
    return typeof toolName === "string" ? toolName : "Tool";
  }
  return event.actor || event.eventType || "Memory Event";
}

function eventTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function ConversationEventRow({ event }: { event: DesktopConversationEvent }) {
  const text = conversationEventText(event);
  if (!text && event.actor !== "tool") return null;
  const actor = eventActorLabel(event);
  const tone =
    event.actor === "user" ? "user" : event.actor === "tool" ? "tool" : "agent";
  if (event.actor === "tool") {
    return (
      <div className="native-event-wrap">
        <details className="native-tool-event">
          <summary>
            <span className={`native-event-avatar ${tone}`} aria-hidden="true">
              T
            </span>
            <span className="native-event-heading">
              <strong>{actor}</strong>
              <small>{eventTime(event.timestamp)}</small>
            </span>
            <span className="native-tool-preview">
              {text.split("\n")[0] || "Tool activity"}
            </span>
          </summary>
          <pre>
            {text || "Tool activity captured without displayable content."}
          </pre>
        </details>
      </div>
    );
  }
  return (
    <div className="native-event-wrap">
      <article className={`native-conversation-event ${tone}`}>
        <span className={`native-event-avatar ${tone}`} aria-hidden="true">
          {event.actor === "user" ? "Y" : "K"}
        </span>
        <div className="native-event-body">
          <header>
            <strong>{actor}</strong>
            <time dateTime={event.timestamp}>{eventTime(event.timestamp)}</time>
          </header>
          <div className="native-event-content">{text}</div>
        </div>
      </article>
    </div>
  );
}

async function requestEvents({
  apiBaseUrl,
  apiToken,
  cursor,
  limit,
  signal,
  thread
}: {
  apiBaseUrl: string;
  apiToken: string;
  cursor?: DesktopConversationEvent;
  limit: number;
  signal?: AbortSignal;
  thread: DesktopThreadGroup;
}): Promise<DesktopConversationEvent[]> {
  const response = await fetch(
    conversationEventsUrl({ apiBaseUrl, cursor, limit, thread }),
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiToken}`
      },
      signal
    }
  );
  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    events?: DesktopConversationEvent[];
  };
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : `Conversation request failed with HTTP ${response.status}`
    );
  }
  return Array.isArray(payload.events) ? payload.events : [];
}

export function NativeConversationSurface({
  apiBaseUrl,
  apiToken,
  thread
}: {
  apiBaseUrl: string | null;
  apiToken: string | null;
  thread: DesktopThreadGroup;
}) {
  const [events, setEvents] = useState<DesktopConversationEvent[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlderEvents, setHasOlderEvents] = useState(false);
  const [requestRevision, setRequestRevision] = useState(0);
  const eventsRef = useRef(events);
  const olderControllerRef = useRef<AbortController | null>(null);
  const requestGenerationRef = useRef(0);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  useEffect(() => {
    requestGenerationRef.current += 1;
    olderControllerRef.current?.abort();
    olderControllerRef.current = null;
    const controller = new AbortController();
    const cleanup = () => {
      controller.abort();
      olderControllerRef.current?.abort();
      olderControllerRef.current = null;
    };
    setEvents([]);
    setError("");
    setHasOlderEvents(false);
    setLoadingOlder(false);
    if (!apiBaseUrl || !apiToken) {
      setLoading(false);
      setError(
        "Local Personal Memory is not ready. Refresh status, then reopen this Captured Session."
      );
      return cleanup;
    }
    setLoading(true);
    void requestEvents({
      apiBaseUrl,
      apiToken,
      limit: initialEventLimit,
      signal: controller.signal,
      thread
    })
      .then((nextEvents) => {
        const merged = mergeConversationEvents([], nextEvents);
        setEvents(merged);
        setHasOlderEvents(merged.length < thread.eventCount);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return cleanup;
  }, [
    apiBaseUrl,
    apiToken,
    requestRevision,
    thread.eventCount,
    thread.id,
    thread.projectId
  ]);

  const loadOlder = useCallback(async () => {
    if (
      !apiBaseUrl ||
      !apiToken ||
      loadingOlder ||
      !hasOlderEvents ||
      eventsRef.current.length === 0
    ) {
      return;
    }
    setLoadingOlder(true);
    setError("");
    const cursor = eventsRef.current[0];
    if (!cursor) return;
    const generation = requestGenerationRef.current;
    const controller = new AbortController();
    olderControllerRef.current = controller;
    const currentEvents = eventsRef.current;
    try {
      const older = await requestEvents({
        apiBaseUrl,
        apiToken,
        cursor,
        limit: olderEventLimit,
        signal: controller.signal,
        thread
      });
      if (
        controller.signal.aborted ||
        generation !== requestGenerationRef.current
      ) {
        return;
      }
      const repeatedCursor = older.some(
        (event) =>
          event.id === cursor.id && event.timestamp === cursor.timestamp
      );
      const merged = mergeConversationEvents(currentEvents, older);
      const madeProgress = merged.length > currentEvents.length;
      eventsRef.current = merged;
      setEvents(merged);
      setHasOlderEvents(
        !repeatedCursor &&
          madeProgress &&
          older.length > 0 &&
          merged.length < thread.eventCount
      );
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (olderControllerRef.current === controller) {
        olderControllerRef.current = null;
        setLoadingOlder(false);
      }
    }
  }, [apiBaseUrl, apiToken, hasOlderEvents, loadingOlder, thread]);

  const visibleEvents = useMemo(
    () =>
      events.filter(
        (event) =>
          event.actor === "tool" || conversationEventText(event).length > 0
      ),
    [events]
  );
  const renderEvent = useCallback(
    (event: DesktopConversationEvent) => <ConversationEventRow event={event} />,
    []
  );

  if (loading) {
    return (
      <div className="native-conversation-state" role="status">
        Loading raw Conversation…
      </div>
    );
  }
  if (error && visibleEvents.length === 0) {
    return (
      <div className="native-conversation-state error" role="alert">
        <strong>Conversation could not be loaded</strong>
        <p>{error}</p>
        <button
          type="button"
          onClick={() => setRequestRevision((revision) => revision + 1)}
        >
          Retry loading
        </button>
      </div>
    );
  }
  if (visibleEvents.length === 0) {
    return (
      <div className="native-conversation-state" role="status">
        <strong>No visible Memory Events</strong>
        <p>
          This Captured Session exists, but it has no displayable Conversation
          content.
        </p>
      </div>
    );
  }
  return (
    <div className="native-conversation-content">
      {loadingOlder ? (
        <div className="native-older-status">
          Loading earlier Memory Events…
        </div>
      ) : null}
      {error ? (
        <div className="native-older-status error" role="alert">
          {error}
        </div>
      ) : null}
      <VirtualizedTimeline
        className="native-timeline-scroll"
        events={visibleEvents}
        hasOlderEvents={hasOlderEvents}
        onLoadOlder={loadOlder}
        renderEvent={renderEvent}
        threadKey={threadSelectionKey(thread)}
      />
    </div>
  );
}
