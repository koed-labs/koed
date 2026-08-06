import {
  MemoryEventFrame,
  SecureMarkdown,
  SourceDiff,
  VirtualizedTimeline,
  threadSelectionKey,
  type MarkdownPlatformAdapters,
  type MemoryPresentationScope
} from "@koed/memory-ui";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import {
  conversationEventPatch,
  conversationEventText,
  conversationEventToolDisplay,
  approvalReviewSourceEventId,
  expandConversationDisplayEvents,
  groupConversationEvents,
  mergeConversationEvents,
  summarizeToolActivity,
  type ConversationCursor,
  type DesktopConversationEvent,
  type DesktopConversationTimelineItem
} from "./desktop-conversation.js";
import type { DesktopThreadGroup } from "./project-memory-ui.js";
import "./renderer/views/personal/personal-memory.css";

const initialEventLimit = 50;
const olderEventLimit = 500;

export type ConversationEventsPageLoader = (input: {
  cursor?: ConversationCursor;
  limit: 50 | 500;
  thread: DesktopThreadGroup;
}) => Promise<DesktopConversationEvent[]>;

export type ConversationSurfaceModel = {
  error: string;
  events: readonly DesktopConversationEvent[];
  hasOlderEvents: boolean;
  status: "idle" | "loading" | "ready" | "error";
};

type ConversationSurfaceCommonProps = {
  markdownAdapters?: MarkdownPlatformAdapters;
  onInspectEvent?: (event: DesktopConversationEvent) => void;
  thread: DesktopThreadGroup;
};

export type NativeConversationSurfaceProps =
  | (ConversationSurfaceCommonProps & {
      loadEventsPage: ConversationEventsPageLoader;
      model?: never;
      onLoadOlder?: never;
      onRetry?: never;
    })
  | (ConversationSurfaceCommonProps & {
      loadEventsPage?: never;
      model: ConversationSurfaceModel;
      onLoadOlder: () => Promise<void> | void;
      onRetry: () => Promise<void> | void;
    });

function eventActorLabel(event: DesktopConversationEvent): string {
  if (event.approvalDecisionDisplay) return "Auto approval";
  if (event.actor === "user") return "You";
  if (event.actor === "assistant") return "AI Client";
  if (event.actor === "tool") {
    return conversationEventToolDisplay(event).toolName ?? "Tool";
  }
  return event.actor || event.eventType || "Memory Event";
}

const approvalLevelLabel = (value: "low" | "medium" | "high"): string =>
  value.charAt(0).toLocaleUpperCase() + value.slice(1);

function eventTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function EventActions({
  event,
  onInspectEvent
}: {
  event: DesktopConversationEvent;
  onInspectEvent?: (event: DesktopConversationEvent) => void;
}) {
  if (!onInspectEvent) return null;
  return (
    <button
      aria-label={`Inspect ${eventActorLabel(event)} event`}
      className="native-inspect-event"
      onClick={() => onInspectEvent(event)}
      type="button"
    >
      Inspect
    </button>
  );
}

function InvalidationLabel({ event }: { event: DesktopConversationEvent }) {
  if (!event.invalidatedAt) return null;
  return (
    <span className="personal-event-invalidated" role="status">
      Invalidated · excluded from current recall
    </span>
  );
}

function ConversationEventRow({
  event,
  markdownAdapters,
  onInspectEvent,
  scope
}: {
  event: DesktopConversationEvent;
  markdownAdapters?: MarkdownPlatformAdapters;
  onInspectEvent?: (event: DesktopConversationEvent) => void;
  scope: MemoryPresentationScope;
}) {
  const text = conversationEventText(event);
  if (!text && event.actor !== "tool") return null;
  const actor = eventActorLabel(event);
  const tone =
    event.actor === "user" ? "user" : event.actor === "tool" ? "tool" : "agent";
  const patch = conversationEventPatch(event);
  const toolDisplay =
    event.actor === "tool" ? conversationEventToolDisplay(event) : null;
  const approvalDecision = event.approvalDecisionDisplay;
  const metadata = (
    <>
      <time dateTime={event.timestamp}>{eventTime(event.timestamp)}</time>
      <InvalidationLabel event={event} />
    </>
  );

  if (approvalDecision) {
    const allowed = approvalDecision.outcome === "allow";
    return (
      <div
        className="native-event-wrap"
        data-invalidated={event.invalidatedAt ? "true" : undefined}
      >
        <MemoryEventFrame
          actions={
            <EventActions event={event} onInspectEvent={onInspectEvent} />
          }
          className={`native-conversation-event native-approval-decision ${allowed ? "allow" : "deny"}`}
          contentType="approval_decision"
          header={
            <>
              <span
                className={`native-event-avatar approval ${allowed ? "allow" : "deny"}`}
                aria-label={allowed ? "Allowed" : "Denied"}
                role="img"
              >
                {allowed ? "✓" : "!"}
              </span>
              <span className="native-event-heading">
                <span className="native-approval-title">
                  <strong>Auto approval</strong>
                  <span
                    className="native-approval-signal"
                    data-level={approvalDecision.riskLevel}
                  >
                    Risk · {approvalLevelLabel(approvalDecision.riskLevel)}
                  </span>
                  <span className="native-approval-signal authority">
                    Authorization ·{" "}
                    {approvalLevelLabel(approvalDecision.userAuthorization)}
                  </span>
                </span>
              </span>
            </>
          }
          metadata={metadata}
          scope={scope}
        >
          <div className="native-approval-body">
            <p>{approvalDecision.rationale}</p>
          </div>
        </MemoryEventFrame>
      </div>
    );
  }

  if (event.actor === "tool") {
    return (
      <div
        className="native-event-wrap"
        data-invalidated={event.invalidatedAt ? "true" : undefined}
      >
        <details className="native-tool-event">
          <summary>
            <span className={`native-event-avatar ${tone}`} aria-hidden="true">
              T
            </span>
            <span className="native-event-heading">
              <strong>{toolDisplay?.label ?? actor}</strong>
              <small>
                {[
                  toolDisplay?.toolName,
                  eventTime(event.timestamp),
                  toolDisplay?.status
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            </span>
            <span className="native-tool-preview">
              {patch?.summary ?? toolDisplay?.preview ?? "Tool activity"}
            </span>
            <InvalidationLabel event={event} />
          </summary>
          <MemoryEventFrame
            actions={
              <EventActions event={event} onInspectEvent={onInspectEvent} />
            }
            className="native-tool-event-frame"
            contentType={patch ? "diff" : "tool"}
            header={toolDisplay?.label ?? actor}
            metadata={metadata}
            scope={scope}
          >
            {toolDisplay?.callId ? (
              <span className="native-tool-call-id" title={toolDisplay.callId}>
                Call {toolDisplay.callId}
              </span>
            ) : null}
            {patch ? (
              <SourceDiff details={patch} sourceText={patch.sourceText} />
            ) : (
              <pre>
                {text || "Tool activity captured without displayable content."}
              </pre>
            )}
          </MemoryEventFrame>
        </details>
      </div>
    );
  }
  return (
    <div
      className="native-event-wrap"
      data-invalidated={event.invalidatedAt ? "true" : undefined}
    >
      <MemoryEventFrame
        actions={<EventActions event={event} onInspectEvent={onInspectEvent} />}
        className={`native-conversation-event ${tone}`}
        contentType={event.eventType || "message"}
        header={
          <>
            <span className={`native-event-avatar ${tone}`} aria-hidden="true">
              {event.actor === "user" ? "Y" : "K"}
            </span>
            <strong>{actor}</strong>
          </>
        }
        metadata={metadata}
        scope={scope}
      >
        {markdownAdapters ? (
          <SecureMarkdown
            adapters={markdownAdapters}
            className="native-event-content"
            source={text}
          />
        ) : (
          <div className="native-event-content">{text}</div>
        )}
      </MemoryEventFrame>
    </div>
  );
}

function ToolActivityGroup({
  events,
  markdownAdapters,
  onInspectEvent,
  scope
}: {
  events: DesktopConversationEvent[];
  markdownAdapters?: MarkdownPlatformAdapters;
  onInspectEvent?: (event: DesktopConversationEvent) => void;
  scope: MemoryPresentationScope;
}) {
  const summary = summarizeToolActivity(events) || "Commands and tool calls";
  const invalidatedCount = events.filter((event) => event.invalidatedAt).length;
  return (
    <div className="native-event-wrap">
      <details className="native-tool-group">
        <summary tabIndex={0}>
          <span className="native-tool-group-icon" aria-hidden="true">
            {events.length}
          </span>
          <span>
            <strong>Agent activity</strong>
            <small>
              {events.length} activity items · {summary}
            </small>
          </span>
          {invalidatedCount ? (
            <span className="personal-event-invalidated">
              {invalidatedCount} invalidated
            </span>
          ) : null}
          <span className="native-tool-group-disclosure" aria-hidden="true">
            +
          </span>
        </summary>
        <div className="native-tool-group-events">
          {events.map((event) => (
            <ConversationEventRow
              event={event}
              key={event.id}
              markdownAdapters={markdownAdapters}
              onInspectEvent={onInspectEvent}
              scope={scope}
            />
          ))}
        </div>
      </details>
    </div>
  );
}

export function ConversationRows({
  events,
  markdownAdapters,
  scope = "personal"
}: {
  events: readonly DesktopConversationEvent[];
  markdownAdapters?: MarkdownPlatformAdapters;
  scope?: MemoryPresentationScope;
}) {
  const timelineItems = groupConversationEvents(
    expandConversationDisplayEvents(events).filter(
      (event) =>
        event.actor === "tool" || conversationEventText(event).length > 0
    )
  );
  return (
    <>
      {timelineItems.map((item) => (
        <Fragment key={item.id}>
          {item.kind === "tool-group" ? (
            <ToolActivityGroup
              events={item.events}
              markdownAdapters={markdownAdapters}
              scope={scope}
            />
          ) : (
            <ConversationEventRow
              event={item.event}
              markdownAdapters={markdownAdapters}
              scope={scope}
            />
          )}
        </Fragment>
      ))}
    </>
  );
}

export function ConversationTimeline({
  ariaLabel,
  className = "native-timeline-scroll",
  events,
  hasNewerEvents = false,
  hasOlderEvents,
  markdownAdapters,
  onInspectEvent,
  onLoadNewer,
  onLoadOlder,
  scope = "personal",
  threadKey
}: {
  ariaLabel?: string;
  className?: string;
  events: readonly DesktopConversationEvent[];
  hasNewerEvents?: boolean;
  hasOlderEvents: boolean;
  markdownAdapters?: MarkdownPlatformAdapters;
  onInspectEvent?: (event: DesktopConversationEvent) => void;
  onLoadNewer?: () => Promise<void> | void;
  onLoadOlder: () => Promise<void> | void;
  scope?: MemoryPresentationScope;
  threadKey: string;
}) {
  const visibleEvents = useMemo(
    () =>
      expandConversationDisplayEvents(events).filter(
        (event) =>
          event.actor === "tool" || conversationEventText(event).length > 0
      ),
    [events]
  );
  const sourceEventsById = useMemo(
    () => new Map(events.map((event) => [event.id, event])),
    [events]
  );
  const inspectEvent = useCallback(
    (event: DesktopConversationEvent) => {
      if (!onInspectEvent) return;
      const sourceId = approvalReviewSourceEventId(event.id);
      onInspectEvent(
        (sourceId ? sourceEventsById.get(sourceId) : undefined) ?? event
      );
    },
    [onInspectEvent, sourceEventsById]
  );
  const timelineItems = useMemo(
    () => groupConversationEvents(visibleEvents),
    [visibleEvents]
  );
  const renderEvent = useCallback(
    (item: DesktopConversationTimelineItem) => (
      <Fragment key={item.id}>
        {item.kind === "tool-group" ? (
          <ToolActivityGroup
            events={item.events}
            markdownAdapters={markdownAdapters}
            onInspectEvent={onInspectEvent ? inspectEvent : undefined}
            scope={scope}
          />
        ) : (
          <ConversationEventRow
            event={item.event}
            markdownAdapters={markdownAdapters}
            onInspectEvent={onInspectEvent ? inspectEvent : undefined}
            scope={scope}
          />
        )}
      </Fragment>
    ),
    [inspectEvent, markdownAdapters, onInspectEvent, scope]
  );

  return (
    <VirtualizedTimeline
      ariaLabel={ariaLabel}
      className={className}
      events={timelineItems}
      hasNewerEvents={hasNewerEvents}
      hasOlderEvents={hasOlderEvents}
      onLoadNewer={onLoadNewer}
      onLoadOlder={onLoadOlder}
      renderEvent={renderEvent}
      threadKey={threadKey}
    />
  );
}

function ConversationPresentation({
  model,
  markdownAdapters,
  onInspectEvent,
  onLoadOlder,
  onRetry,
  thread
}: ConversationSurfaceCommonProps & {
  model: ConversationSurfaceModel;
  onLoadOlder: () => Promise<void> | void;
  onRetry: () => Promise<void> | void;
}) {
  const visibleEvents = useMemo(
    () =>
      expandConversationDisplayEvents(model.events).filter(
        (event) =>
          event.actor === "tool" || conversationEventText(event).length > 0
      ),
    [model.events]
  );
  const sourceEventsById = useMemo(
    () => new Map(model.events.map((event) => [event.id, event])),
    [model.events]
  );
  const inspectEvent = useCallback(
    (event: DesktopConversationEvent) => {
      if (!onInspectEvent) return;
      const sourceId = approvalReviewSourceEventId(event.id);
      onInspectEvent(
        (sourceId ? sourceEventsById.get(sourceId) : undefined) ?? event
      );
    },
    [onInspectEvent, sourceEventsById]
  );
  const timelineItems = useMemo(
    () => groupConversationEvents(visibleEvents),
    [visibleEvents]
  );
  const renderEvent = useCallback(
    (item: DesktopConversationTimelineItem) =>
      item.kind === "tool-group" ? (
        <ToolActivityGroup
          events={item.events}
          markdownAdapters={markdownAdapters}
          onInspectEvent={onInspectEvent ? inspectEvent : undefined}
          scope="personal"
        />
      ) : (
        <ConversationEventRow
          event={item.event}
          markdownAdapters={markdownAdapters}
          onInspectEvent={onInspectEvent ? inspectEvent : undefined}
          scope="personal"
        />
      ),
    [inspectEvent, markdownAdapters, onInspectEvent]
  );

  if (
    (model.status === "loading" || model.status === "idle") &&
    visibleEvents.length === 0
  ) {
    return (
      <div className="native-conversation-state" role="status">
        Loading Conversation…
      </div>
    );
  }
  if (model.error && visibleEvents.length === 0) {
    return (
      <div className="native-conversation-state error" role="alert">
        <strong>Conversation could not be loaded</strong>
        <p>{model.error}</p>
        <button type="button" onClick={() => void onRetry()}>
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
      {model.status === "loading" ? (
        <div className="native-older-status">
          Loading earlier Memory Events…
        </div>
      ) : null}
      {model.error ? (
        <div className="native-older-status error" role="alert">
          {model.error}
        </div>
      ) : null}
      <VirtualizedTimeline
        className="native-timeline-scroll"
        events={timelineItems}
        hasOlderEvents={model.hasOlderEvents}
        onLoadOlder={onLoadOlder}
        renderEvent={renderEvent}
        threadKey={threadSelectionKey(thread)}
      />
    </div>
  );
}

function LegacyConversationController({
  loadEventsPage,
  markdownAdapters,
  onInspectEvent,
  thread
}: ConversationSurfaceCommonProps & {
  loadEventsPage: ConversationEventsPageLoader;
}) {
  const [events, setEvents] = useState<DesktopConversationEvent[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlderEvents, setHasOlderEvents] = useState(false);
  const [requestRevision, setRequestRevision] = useState(0);
  const eventsRef = useRef(events);
  const requestGenerationRef = useRef(0);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  useEffect(() => {
    requestGenerationRef.current += 1;
    const generation = requestGenerationRef.current;
    setEvents([]);
    setError("");
    setHasOlderEvents(false);
    setLoadingOlder(false);
    setLoading(true);
    void loadEventsPage({ limit: initialEventLimit, thread })
      .then((nextEvents) => {
        if (generation !== requestGenerationRef.current) return;
        const merged = mergeConversationEvents([], nextEvents);
        setEvents(merged);
        setHasOlderEvents(merged.length < thread.eventCount);
      })
      .catch((cause: unknown) => {
        if (generation !== requestGenerationRef.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (generation === requestGenerationRef.current) setLoading(false);
      });
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [
    loadEventsPage,
    requestRevision,
    thread.eventCount,
    thread.id,
    thread.projectId
  ]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasOlderEvents || eventsRef.current.length === 0) {
      return;
    }
    setLoadingOlder(true);
    setError("");
    const cursor = eventsRef.current[0];
    if (!cursor) {
      setLoadingOlder(false);
      return;
    }
    const generation = requestGenerationRef.current;
    const currentEvents = eventsRef.current;
    try {
      const older = await loadEventsPage({
        cursor: {
          id: cursor.id,
          sourceSequence: cursor.sourceSequence,
          timestamp: cursor.timestamp
        },
        limit: olderEventLimit,
        thread
      });
      if (generation !== requestGenerationRef.current) return;
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
      if (generation !== requestGenerationRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === requestGenerationRef.current) setLoadingOlder(false);
    }
  }, [hasOlderEvents, loadEventsPage, loadingOlder, thread]);

  return (
    <ConversationPresentation
      model={{
        error,
        events,
        hasOlderEvents,
        status: loading || loadingOlder ? "loading" : error ? "error" : "ready"
      }}
      markdownAdapters={markdownAdapters}
      onInspectEvent={onInspectEvent}
      onLoadOlder={loadOlder}
      onRetry={() => setRequestRevision((revision) => revision + 1)}
      thread={thread}
    />
  );
}

export function NativeConversationSurface(
  props: NativeConversationSurfaceProps
) {
  if ("model" in props && props.model) {
    return (
      <ConversationPresentation
        model={props.model}
        markdownAdapters={props.markdownAdapters}
        onInspectEvent={props.onInspectEvent}
        onLoadOlder={props.onLoadOlder}
        onRetry={props.onRetry}
        thread={props.thread}
      />
    );
  }
  return (
    <LegacyConversationController
      loadEventsPage={props.loadEventsPage}
      markdownAdapters={props.markdownAdapters}
      onInspectEvent={props.onInspectEvent}
      thread={props.thread}
    />
  );
}
