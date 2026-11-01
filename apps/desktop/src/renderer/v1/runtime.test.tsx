// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { V1ConversationSurface } from "./runtime.js";
import type {
  DesktopConversationEvent,
  DesktopConversationTimelineItem
} from "../../desktop-conversation.js";
import type { DesktopThreadGroup } from "../../project-memory-ui.js";
vi.mock("@koed/memory-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@koed/memory-ui")>();
  return {
    ...actual,
    VirtualizedTimeline: ({
      events,
      renderEvent
    }: {
      events: DesktopConversationTimelineItem[];
      renderEvent: (event: DesktopConversationTimelineItem) => ReactNode;
    }) => (
      <>
        {events.map((event) => (
          <div key={event.id}>{renderEvent(event)}</div>
        ))}
      </>
    )
  };
});
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("retains approval risk and uses the injected clipboard adapter", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const timestamp = "2026-01-01T00:00:00.000Z";
  const base: DesktopConversationEvent = {
    id: "answer",
    actor: "assistant",
    eventType: "message",
    timestamp,
    sourceEventTime: timestamp,
    sourceSequence: null,
    content: "An answer",
    contentPreview: "An answer",
    invalidatedAt: null,
    metadata: {}
  };
  const thread: DesktopThreadGroup = {
    id: "thread",
    name: "Conversation",
    projectId: "project",
    projectName: "Example",
    sessionId: "session",
    eventCount: 2,
    invalidatedCount: 0,
    latestAt: timestamp,
    sample: "An answer"
  };
  const writeClipboard = vi.fn(async () => {});
  try {
    await act(async () =>
      root.render(
        <V1ConversationSurface
          thread={thread}
          model={{
            events: [
              base,
              {
                ...base,
                id: "approval",
                actor: "activity",
                content: "",
                contentPreview: "",
                approvalDecisionDisplay: {
                  kind: "auto_approval",
                  version: 1,
                  outcome: "deny",
                  riskLevel: "high",
                  userAuthorization: "low",
                  rationale: "Not authorized"
                }
              }
            ],
            error: "",
            hasOlderEvents: false,
            status: "ready"
          }}
          onLoadOlder={() => {}}
          onRetry={() => {}}
          markdownAdapters={{ writeClipboard, openExternal: async () => {} }}
        />
      )
    );
    expect(container.textContent).toContain("Denied");
    expect(container.textContent).toContain("Risk: high");
    expect(container.textContent).toContain("Authorization: low");
    await act(async () => {
      (
        container.querySelector(
          '[aria-label="Copy response"]'
        ) as HTMLButtonElement
      ).click();
    });
    expect(writeClipboard).toHaveBeenCalledWith("An answer");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
