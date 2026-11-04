import { memo } from "react";
import {
  Activity,
  Code2,
  FileCode2,
  FileSearch,
  Search,
  Terminal,
  Wrench,
  ShieldCheck,
  ShieldX
} from "lucide-react";
import {
  Badge,
  Bubble,
  BubbleContent,
  Message,
  MessageContent,
  MessageHeader,
  MessageFooter,
  Trace,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent
} from "@koed/ui";
import { SourceDiff, type MarkdownPlatformAdapters } from "@koed/memory-ui";
import {
  conversationEventText,
  conversationEventPatch,
  conversationEventToolDisplay,
  summarizeToolActivity,
  type DesktopConversationEvent,
  type DesktopConversationTimelineItem
} from "../../../desktop-conversation.js";
import {
  ConversationClientMark,
  ConversationCode,
  ConversationCopyButton,
  ConversationIconButton,
  ConversationMarkdown,
  ConversationTime
} from "./ConversationContent.js";
import type { ConversationClient } from "./presentation.js";

type RowProps = {
  item: DesktopConversationTimelineItem;
  client: ConversationClient;
  adapters: MarkdownPlatformAdapters;
  expanded: ReadonlyMap<string, boolean>;
  onExpand: (id: string, open: boolean) => void;
  onInspect: (event: DesktopConversationEvent) => void;
  onError: (message: string) => void;
};
type EventProps = Omit<RowProps, "item"> & { event: DesktopConversationEvent };

function Invalidation({ event }: { event: DesktopConversationEvent }) {
  return event.invalidatedAt ? (
    <Badge variant="outline" className="v1-conversation-invalidated">
      Excluded from current memory recall
    </Badge>
  ) : null;
}
function EventFooter({ event, adapters, onInspect, onError }: EventProps) {
  const text = event.content ?? event.contentPreview ?? "";
  return (
    <MessageFooter className="v1-conversation-actions">
      {text && (
        <ConversationCopyButton
          text={text}
          label={event.actor === "user" ? "Copy message" : "Copy response"}
          adapters={adapters}
          onError={onError}
        />
      )}
      <ConversationIconButton
        label="View source details"
        onClick={() => onInspect(event)}
      >
        <Code2 />
      </ConversationIconButton>
      <ConversationTime value={event.sourceEventTime ?? event.timestamp} />
      <Invalidation event={event} />
    </MessageFooter>
  );
}
const toolIcons = {
  command: Terminal,
  file_change: FileCode2,
  file_read: FileSearch,
  search: Search,
  tool: Wrench
};
function ActivityEvent(props: EventProps) {
  const { event, expanded, onExpand, adapters, onError } = props;
  const tool = event.actor === "tool";
  const display = tool ? conversationEventToolDisplay(event) : null;
  const open =
    expanded.get(event.id) ?? event.presentation?.mode === "expanded";
  const patch = tool && open ? conversationEventPatch(event) : null;
  const Icon = display ? toolIcons[display.kind] : Activity;
  const label =
    display?.label ??
    event.activityDisplay?.label ??
    (event.presentation?.renderer === "reasoning_summary"
      ? "Reasoning summary"
      : "Activity");
  const text = conversationEventText(event);
  return (
    <TraceCollapsible
      open={open}
      onOpenChange={(open) => onExpand(event.id, open)}
    >
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon>
            <Icon />
          </TraceIcon>
          <TraceTitle title={display?.preview || label}>{label}</TraceTitle>
          {display?.status && (
            <TraceDescription>{display.status}</TraceDescription>
          )}
          {event.invalidatedAt && <TraceDescription>Excluded</TraceDescription>}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <div className="v1-conversation-activity-body">
          {display?.toolName && (
            <div className="v1-conversation-tool-name">{display.toolName}</div>
          )}
          {patch ? (
            <SourceDiff details={patch} sourceText={patch.sourceText} />
          ) : tool ? (
            <ConversationCode
              text={
                (event.content ?? event.contentPreview) ||
                "No output was recorded."
              }
              title={display?.toolName ?? "Tool output"}
              adapters={adapters}
              onError={onError}
            />
          ) : (
            <ConversationMarkdown
              text={text}
              adapters={adapters}
              onError={onError}
            />
          )}
          <EventFooter {...props} />
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

export const ConversationEvent = memo(function ConversationEvent(
  props: RowProps
) {
  const { item, expanded, onExpand, client, adapters, onError } = props;
  if (item.kind === "tool-group") {
    return (
      <div
        className="v1-conversation-row v1-conversation-activity"
        role="listitem"
      >
        <Trace>
          <TraceCollapsible
            open={
              expanded.get(item.id) ??
              item.events.some(
                (event) => event.presentation?.mode === "expanded"
              )
            }
            onOpenChange={(open) => onExpand(item.id, open)}
          >
            <TraceCollapsibleTrigger>
              <TraceLine>
                <TraceIcon>
                  <Wrench />
                </TraceIcon>
                <TraceTitle title={summarizeToolActivity(item.events)}>
                  {summarizeToolActivity(item.events)}
                </TraceTitle>
                <TraceDescription>{item.events.length} steps</TraceDescription>
              </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent>
              <Trace className="v1-conversation-activity-list">
                {item.events.map((event) => (
                  <ActivityEvent key={event.id} {...props} event={event} />
                ))}
              </Trace>
            </TraceCollapsibleContent>
          </TraceCollapsible>
        </Trace>
      </div>
    );
  }
  const event = item.event;
  const decision = event.approvalDecisionDisplay;
  if (decision) {
    const allowed = decision.outcome === "allow";
    return (
      <section
        className="v1-conversation-row v1-conversation-approval"
        role="listitem"
        aria-label="Auto approval"
      >
        <header>
          {allowed ? <ShieldCheck /> : <ShieldX />}
          <strong>Auto approval</strong>
          <Badge variant={allowed ? "outline" : "destructive"}>
            {allowed ? "Allowed" : "Denied"}
          </Badge>
        </header>
        <div className="v1-conversation-approval-levels">
          <span>Risk: {decision.riskLevel}</span>
          <span>Authorization: {decision.userAuthorization}</span>
        </div>
        <ConversationMarkdown
          text={decision.rationale}
          adapters={adapters}
          onError={onError}
        />
        <EventFooter {...props} event={event} />
      </section>
    );
  }
  if (
    event.actor === "tool" ||
    event.presentation?.mode === "collapsed" ||
    !["user", "agent", "assistant"].includes(event.actor ?? "")
  ) {
    return (
      <div
        className="v1-conversation-row v1-conversation-activity"
        role="listitem"
      >
        <Trace>
          <ActivityEvent {...props} event={event} />
        </Trace>
      </div>
    );
  }
  const user = event.actor === "user";
  const text = conversationEventText(event);
  const content = text ? (
    <ConversationMarkdown text={text} adapters={adapters} onError={onError} />
  ) : (
    <p role="status">{client.label} is working…</p>
  );
  return (
    <Message
      align={user ? "end" : "start"}
      className={`v1-conversation-row v1-conversation-message ${user ? "is-user" : "is-assistant"}`}
      role="listitem"
    >
      <MessageContent>
        <MessageHeader>
          {user ? (
            "You"
          ) : (
            <>
              <ConversationClientMark client={client} />
              <strong>{client.label}</strong>
            </>
          )}
        </MessageHeader>
        {user ? (
          <Bubble align="end" variant="muted">
            <BubbleContent>{content}</BubbleContent>
          </Bubble>
        ) : (
          content
        )}
        <EventFooter {...props} event={event} />
      </MessageContent>
    </Message>
  );
});
