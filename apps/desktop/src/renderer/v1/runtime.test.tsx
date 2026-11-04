// @vitest-environment happy-dom
import { act, type ReactNode, type Ref } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { V1ConversationSurface } from "./runtime.js";
import type {
  DesktopConversationEvent,
  DesktopConversationTimelineItem
} from "../../desktop-conversation.js";
import type { DesktopThreadGroup } from "../../project-memory-ui.js";
const timelineMock = vi.hoisted(() => ({
  scrollToEnd: vi.fn(),
  retryOlder: vi.fn(() => true),
  onLoadOlder: null as null | (() => Promise<void> | void),
  onLoadingOlderChange: null as null | ((loading: boolean) => void),
  onAtEndChange: null as null | ((atEnd: boolean) => void)
}));
vi.mock("@koed/memory-ui", async (importOriginal) => {
  const React = await import("react");
  const actual = await importOriginal<typeof import("@koed/memory-ui")>();
  return {
    ...actual,
    VirtualizedTimeline: ({
      events,
      renderEvent,
      controllerRef,
      onAtEndChange,
      onLoadOlder,
      onLoadingOlderChange
    }: {
      controllerRef?: Ref<{
        retryOlder: () => boolean;
        scrollToEnd: () => void;
      }>;
      onAtEndChange?: (atEnd: boolean) => void;
      onLoadOlder?: () => Promise<void> | void;
      onLoadingOlderChange?: (loading: boolean) => void;
      events: DesktopConversationTimelineItem[];
      renderEvent: (event: DesktopConversationTimelineItem) => ReactNode;
    }) => {
      React.useImperativeHandle(controllerRef, () => ({
        retryOlder: timelineMock.retryOlder,
        scrollToEnd: timelineMock.scrollToEnd
      }));
      timelineMock.onAtEndChange = onAtEndChange ?? null;
      timelineMock.onLoadOlder = onLoadOlder ?? null;
      timelineMock.onLoadingOlderChange = onLoadingOlderChange ?? null;
      return (
        <>
          {events.map((event) => (
            <div key={event.id}>{renderEvent(event)}</div>
          ))}
        </>
      );
    }
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

describe("conversation inspector presentation", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;
  const timestamp = "2026-11-03T14:32:00.000Z";
  const event = (
    id: string,
    overrides: Partial<DesktopConversationEvent> = {}
  ): DesktopConversationEvent => ({
    id,
    actor: "assistant",
    eventType: "message",
    timestamp,
    sourceEventTime: null,
    sourceSequence: null,
    content: "Recorded answer",
    contentPreview: "Recorded answer",
    invalidatedAt: null,
    metadata: {},
    ...overrides
  });
  const thread: DesktopThreadGroup = {
    id: "thread",
    sessionId: "session",
    name: "Conversation",
    projectId: "project",
    projectName: "koed",
    sourceAiClient: "claude-code",
    eventCount: 2,
    invalidatedCount: 0,
    latestAt: timestamp,
    sample: ""
  };
  const adapters = {
    writeClipboard: vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValue(),
    openExternal: vi.fn(async () => {})
  };
  const render = async (
    events: DesktopConversationEvent[],
    extra: Partial<
      Extract<
        React.ComponentProps<typeof V1ConversationSurface>,
        { model: object }
      >
    > = {}
  ) => {
    if (!container) {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    await act(async () =>
      root.render(
        <V1ConversationSurface
          thread={thread}
          model={{ events, error: "", hasOlderEvents: false, status: "ready" }}
          onLoadOlder={() => {}}
          onRetry={() => {}}
          markdownAdapters={adapters}
          {...extra}
        />
      )
    );
  };
  const click = async (selector: string) => {
    const target = document.querySelector<HTMLButtonElement>(selector);
    expect(target).not.toBeNull();
    await act(async () => target!.click());
  };
  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    container = undefined!;
    adapters.writeClipboard.mockReset();
    timelineMock.scrollToEnd.mockClear();
    timelineMock.retryOlder.mockClear();
  });

  it("labels the recorded AI Client and copies the exact response", async () => {
    await render([event("answer", { content: "  Keep this whitespace.\n" })]);
    expect(
      container.querySelector(".v1-conversation-client.claude svg")
    ).not.toBeNull();
    expect(container.textContent).toContain("Claude Code");
    await click('[aria-label="Copy response"]');
    expect(adapters.writeClipboard).toHaveBeenCalledWith(
      "  Keep this whitespace.\n"
    );
    expect(container.querySelector('[aria-label="Copied"]')).not.toBeNull();
  });

  it("shows a central loading status only while the initial conversation is loading", async () => {
    await render([], {
      model: { events: [], error: "", hasOlderEvents: false, status: "loading" }
    });
    expect(
      container.querySelector('[aria-label="Loading conversation"] svg')
    ).not.toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.textContent).not.toContain("No messages yet.");
    await render([event("loaded")]);
    expect(
      container.querySelector('[aria-label="Loading conversation"]')
    ).toBeNull();
    expect(container.textContent).toContain("Recorded answer");
  });

  it("keeps the conversation readable during earlier-page loading", async () => {
    await render([event("loaded")]);
    await act(async () => timelineMock.onLoadingOlderChange?.(true));
    expect(container.textContent).toContain("Loading earlier messages…");
    expect(container.textContent).toContain("Recorded answer");
    expect(
      container.querySelector('[aria-label="Loading conversation"]')
    ).toBeNull();
    await act(async () => timelineMock.onLoadingOlderChange?.(false));
    expect(container.textContent).not.toContain("Loading earlier messages…");
  });

  it("exposes source and event IDs for user messages without altering their content", async () => {
    await render([
      event("user-event", {
        actor: "user",
        content: "Original source\n\n",
        sourceSequence: 0
      })
    ]);
    await click('[aria-label="View source details"]');
    expect(
      document.querySelector('[data-slot="sheet-popup"] pre')?.textContent
    ).toBe("Original source\n\n");
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((tab) => tab.textContent === "Details")!
        .click();
    });
    expect(
      document.querySelector('[data-slot="sheet-popup"]')?.textContent
    ).toContain("user-event");
    await click('[aria-label="Copy event ID"]');
    expect(adapters.writeClipboard).toHaveBeenCalledWith("user-event");
  });

  it("retains tool state and expanded output without inventing success", async () => {
    await render([
      event("tool", {
        actor: "tool",
        content: "command failed",
        presentation: {
          mode: "expanded",
          renderer: "tool_result",
          policyKey: null,
          policyRevision: 0,
          reason: "test"
        },
        toolDisplay: {
          kind: "command",
          label: "Run command",
          preview: "run",
          status: "failed",
          toolName: "exec"
        }
      })
    ]);
    expect(container.querySelector('[aria-expanded="true"]')).not.toBeNull();
    expect(container.textContent).toContain("failed");
    expect(container.textContent).toContain("command failed");
    expect(container.textContent).not.toContain("Complete");
    await click('[aria-label="Copy code"]');
    expect(adapters.writeClipboard).toHaveBeenCalledWith("command failed");
  });

  it("routes expanded transcript segments back to the retained source event", async () => {
    const source = event("original", {
      actor: "activity",
      transcriptDisplay: {
        kind: "approval_review",
        version: 1,
        truncated: false,
        segments: [
          {
            kind: "message",
            actor: "agent",
            sequence: 1,
            content: "Expanded reply"
          }
        ]
      }
    });
    const onInspectEvent = vi.fn();
    await render([source], { onInspectEvent });
    await click('[aria-label="View source details"]');
    expect(onInspectEvent).toHaveBeenCalledWith(source);
  });

  it("keeps an expanded tool group open when an older page extends it", async () => {
    const tools = [
      event("tool-1", { actor: "tool" }),
      event("tool-2", { actor: "tool" })
    ];
    await render(tools);
    await click('[data-slot="trace-collapsible-trigger"]');
    expect(
      container
        .querySelector('[data-slot="trace-collapsible-trigger"]')
        ?.getAttribute("aria-expanded")
    ).toBe("true");
    await render([event("tool-0", { actor: "tool" }), ...tools]);
    expect(
      container
        .querySelector('[data-slot="trace-collapsible-trigger"]')
        ?.getAttribute("aria-expanded")
    ).toBe("true");
    expect(container.textContent).toContain("3 steps");
  });

  it("closes stale source details when the conversation changes", async () => {
    await render([event("first")]);
    await click('[aria-label="View source details"]');
    await render([event("second", { content: "New conversation" })], {
      thread: { ...thread, id: "other", sessionId: "other" }
    });
    expect(document.querySelector('[data-slot="sheet-popup"]')).toBeNull();
    expect(container.textContent).toContain("New conversation");
  });

  const retryButton = () =>
    [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Retry")
    );

  it("retries a failed earlier page without reloading the initial page", async () => {
    const onLoadOlder = vi.fn();
    const onRetry = vi.fn();
    const model = {
      events: [event("answer")],
      error: "",
      hasOlderEvents: true,
      status: "ready" as const
    };
    await render([], { model, onLoadOlder, onRetry });
    await act(async () => timelineMock.onLoadOlder?.());
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    await render([], {
      model: { ...model, error: "offline", status: "error" },
      onLoadOlder,
      onRetry
    });
    await act(async () => retryButton()!.click());
    expect(timelineMock.retryOlder).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("reloads the initial page when the initial load failed", async () => {
    const onRetry = vi.fn();
    await render([], {
      model: {
        events: [],
        error: "offline",
        hasOlderEvents: false,
        status: "error"
      },
      onRetry
    });
    await act(async () => retryButton()!.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(timelineMock.retryOlder).not.toHaveBeenCalled();
  });

  it("jumps to the latest message only when requested", async () => {
    await render([event("answer")]);
    await act(async () => timelineMock.onAtEndChange?.(false));
    const latest = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Latest")
    );
    expect(latest).toBeDefined();
    await act(async () => latest!.click());
    expect(timelineMock.scrollToEnd).toHaveBeenCalledTimes(1);
  });
});
