import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  Tabs,
  TabsList,
  TabsTab,
  TabsPanel
} from "@koed/ui";
import type { MarkdownPlatformAdapters } from "../../markdown/SecureMarkdown.js";
import type { DesktopConversationEvent } from "../../../desktop-conversation.js";
import type { DesktopThreadGroup } from "../../../project-memory-ui.js";
import {
  ConversationCode,
  ConversationCopyButton
} from "./ConversationContent.js";
import { conversationClient, conversationTime } from "./presentation.js";

export function ConversationSourceSheet({
  event,
  thread,
  adapters,
  onClose,
  onError,
  error
}: {
  event: DesktopConversationEvent | null;
  thread: DesktopThreadGroup;
  adapters: MarkdownPlatformAdapters;
  error: string;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  return (
    <Sheet
      open={Boolean(event)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetPopup className="v1-app v1-conversation-source-sheet">
        <SheetHeader>
          <SheetTitle>Source details</SheetTitle>
          <SheetDescription>{thread.name}</SheetDescription>
        </SheetHeader>
        {error && (
          <p className="v1-conversation-notice" role="alert">
            {error}
          </p>
        )}
        {event && (
          <Tabs
            defaultValue="source"
            key={event.id}
            className="v1-conversation-source-tabs"
          >
            <TabsList>
              <TabsTab value="source">Source</TabsTab>
              <TabsTab value="details">Details</TabsTab>
            </TabsList>
            <TabsPanel value="source">
              <ConversationCode
                text={event.content ?? event.contentPreview ?? ""}
                title={
                  event.content == null
                    ? "Recorded preview"
                    : "Recorded content"
                }
                adapters={adapters}
                onError={onError}
              />
            </TabsPanel>
            <TabsPanel value="details">
              <dl className="v1-conversation-source-fields">
                <dt>Event ID</dt>
                <dd>
                  {event.id}
                  <ConversationCopyButton
                    text={event.id}
                    label="Copy event ID"
                    adapters={adapters}
                    onError={onError}
                  />
                </dd>
                <dt>AI Client</dt>
                <dd>{conversationClient(thread.sourceAiClient).label}</dd>
                <dt>Actor</dt>
                <dd>{event.actor || "Unknown"}</dd>
                <dt>Event type</dt>
                <dd>{event.eventType}</dd>
                <dt>Recorded</dt>
                <dd>{conversationTime(event.timestamp, true)}</dd>
                {event.sourceEventTime && (
                  <>
                    <dt>Source time</dt>
                    <dd>{conversationTime(event.sourceEventTime, true)}</dd>
                  </>
                )}
                {event.sourceSequence !== null && (
                  <>
                    <dt>Source sequence</dt>
                    <dd>{event.sourceSequence}</dd>
                  </>
                )}
                {thread.sessionId && (
                  <>
                    <dt>Captured Session</dt>
                    <dd>{thread.sessionId}</dd>
                  </>
                )}
                {event.toolDisplay?.callId && (
                  <>
                    <dt>Tool call</dt>
                    <dd>{event.toolDisplay.callId}</dd>
                  </>
                )}
                {event.invalidatedAt && (
                  <>
                    <dt>Excluded from recall</dt>
                    <dd>{conversationTime(event.invalidatedAt, true)}</dd>
                  </>
                )}
              </dl>
              {Object.keys(event.metadata).length > 0 && (
                <ConversationCode
                  text={JSON.stringify(event.metadata, null, 2)}
                  title="Recorded metadata"
                  adapters={adapters}
                  onError={onError}
                />
              )}
            </TabsPanel>
          </Tabs>
        )}
      </SheetPopup>
    </Sheet>
  );
}
