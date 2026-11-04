import { useCallback, useMemo, useRef, useState } from "react";
import { ArrowDown, RotateCcw } from "lucide-react";
import { Button, Spinner, TooltipProvider } from "@koed/ui";
import {
  VirtualizedTimeline,
  threadSelectionKey,
  type VirtualizedTimelineHandle
} from "@koed/memory-ui";
import type { NativeConversationSurfaceProps } from "../../../NativeConversationSurface.js";
import {
  approvalReviewSourceEventId,
  conversationEventText,
  expandConversationDisplayEvents,
  groupConversationEvents,
  stabilizeConversationTimelineItems,
  type DesktopConversationEvent,
  type DesktopConversationTimelineItem,
  type StableConversationTimelineItemsState
} from "../../../desktop-conversation.js";
import { createRendererPlatform } from "../../services/platform.js";
import { ConversationEvent } from "./ConversationEvent.js";
import { ConversationClientMark } from "./ConversationContent.js";
import { ConversationSourceSheet } from "./ConversationSourceSheet.js";
import { conversationClient } from "./presentation.js";
import "./conversation.css";

type ModelProps = Extract<NativeConversationSurfaceProps, { model: object }>;
export function V1ConversationSurface(props: NativeConversationSurfaceProps) {
  if (!props.model)
    return <p role="alert">Conversation state is unavailable.</p>;
  return (
    <ConversationSurface key={threadSelectionKey(props.thread)} {...props} />
  );
}
function ConversationSurface(props: ModelProps) {
  const { model, thread } = props;
  const platform = useMemo(() => createRendererPlatform(), []);
  const adapters = useMemo(
    () =>
      props.markdownAdapters ?? {
        openExternal: platform.openExternal,
        writeClipboard: platform.copyText
      },
    [platform, props.markdownAdapters]
  );
  const client = useMemo(
    () => conversationClient(thread.sourceAiClient),
    [thread.sourceAiClient]
  );
  const events = useMemo(
    () =>
      expandConversationDisplayEvents(model.events).filter(
        (event) =>
          event.responseStreaming ||
          Boolean(event.approvalDecisionDisplay) ||
          event.actor === "tool" ||
          conversationEventText(event).length > 0
      ),
    [model.events]
  );
  const previous = useRef<StableConversationTimelineItemsState>({
    byId: new Map(),
    result: []
  });
  const items = useMemo(() => {
    const state = stabilizeConversationTimelineItems(
      groupConversationEvents(events),
      previous.current
    );
    previous.current = state;
    return state.result;
  }, [events]);
  const sourceEvents = useMemo(
    () => new Map(model.events.map((event) => [event.id, event])),
    [model.events]
  );
  const sourcesRef = useRef(sourceEvents);
  sourcesRef.current = sourceEvents;
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [expanded, setExpanded] = useState<ReadonlyMap<string, boolean>>(
    new Map()
  );
  const [atEnd, setAtEnd] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const timeline = useRef<VirtualizedTimelineHandle>(null);
  const inspect = useCallback(
    (event: DesktopConversationEvent) => {
      const sourceId = approvalReviewSourceEventId(event.id) ?? event.id;
      const source = sourcesRef.current.get(sourceId) ?? event;
      if (props.onInspectEvent) props.onInspectEvent(source);
      else setSelectedSourceId(source.id);
    },
    [props.onInspectEvent]
  );
  const onExpand = useCallback(
    (id: string, open: boolean) =>
      setExpanded((previous) => new Map(previous).set(id, open)),
    []
  );
  const renderEvent = useCallback(
    (item: DesktopConversationTimelineItem) => (
      <ConversationEvent
        key={item.id}
        item={item}
        client={client}
        adapters={adapters}
        expanded={expanded}
        onExpand={onExpand}
        onInspect={inspect}
        onError={setActionError}
      />
    ),
    [client, adapters, expanded, onExpand, inspect]
  );
  const source = selectedSourceId
    ? (sourceEvents.get(selectedSourceId) ?? null)
    : null;
  const loadingInitial =
    !items.length &&
    !model.error &&
    (model.status === "loading" || model.status === "idle");
  return (
    <TooltipProvider>
      <div className="v1-conversation-content">
        <div className="v1-conversation-context">
          <ConversationClientMark client={client} />
          <span>{client.label}</span>
          {thread.eventCount > 0 && (
            <span className="v1-conversation-count">
              {thread.eventCount.toLocaleString()} events
            </span>
          )}
        </div>
        {model.error && (
          <div className="v1-conversation-notice" role="alert">
            {model.error}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void props.onRetry()}
            >
              <RotateCcw />
              Retry
            </Button>
          </div>
        )}
        {actionError && !source && (
          <div className="v1-conversation-notice" role="alert">
            {actionError}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setActionError("")}
            >
              Dismiss
            </Button>
          </div>
        )}
        <div
          className="v1-conversation-scroll-host"
          aria-busy={loadingInitial || loadingOlder}
        >
          {loadingInitial && (
            <div
              className="v1-conversation-loading"
              role="status"
              aria-label="Loading conversation"
            >
              <Spinner aria-hidden="true" role={undefined} />
              <span>Loading conversation…</span>
            </div>
          )}
          {!items.length && !loadingInitial && !model.error && (
            <p className="v1-conversation-empty" role="status">
              No messages yet.
            </p>
          )}
          {loadingOlder && items.length > 0 && (
            <div className="v1-conversation-loading-older" role="status">
              <Spinner aria-hidden="true" role={undefined} />
              <span>Loading earlier messages…</span>
            </div>
          )}
          <VirtualizedTimeline
            ariaLabel="Conversation messages"
            className="v1-conversation-scroll"
            controllerRef={timeline}
            events={items}
            hasOlderEvents={model.hasOlderEvents}
            olderPageKey={model.events[0]?.id}
            onLoadOlder={props.onLoadOlder}
            onLoadingOlderChange={setLoadingOlder}
            onAtEndChange={setAtEnd}
            onPageLoadError={() =>
              setActionError(
                "Earlier messages could not be loaded. Scroll up to try again."
              )
            }
            threadKey={threadSelectionKey(thread)}
            renderEvent={renderEvent}
          />
          {!atEnd && items.length > 0 && (
            <Button
              className="v1-conversation-latest"
              variant="outline"
              size="sm"
              onClick={() => timeline.current?.scrollToEnd()}
            >
              <ArrowDown />
              Latest
            </Button>
          )}
        </div>
        <ConversationSourceSheet
          event={source}
          thread={thread}
          adapters={adapters}
          onClose={() => setSelectedSourceId(null)}
          onError={setActionError}
          error={actionError}
        />
      </div>
    </TooltipProvider>
  );
}
