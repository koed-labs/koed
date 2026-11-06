// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type {
  PersonalDesktopApi,
  PersonalDesktopProject,
  PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";
import { PersonalMemoryStore } from "../state/personal-memory.js";
import { ConversationPresentationContext } from "../conversation-presentation.js";
import { StoreConversation } from "../views/personal/PersonalMemoryViews.js";
import { V1ConversationSurface, V1ManagedInput } from "./runtime.js";

vi.mock("@koed/memory-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@koed/memory-ui")>();
  return {
    ...actual,
    VirtualizedTimeline: ({
      events,
      renderEvent
    }: {
      events: Array<{ id: string }>;
      renderEvent: (event: never) => ReactNode;
    }) => (
      <>
        {events.map((event) => (
          <div key={event.id}>{renderEvent(event as never)}</div>
        ))}
      </>
    )
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("renders a captured Conversation without execution or continuation controls when managed API is null", async () => {
  const thread: PersonalDesktopProjectThread = {
    id: "thread",
    sessionId: "00000000-0000-4000-8000-000000000001",
    name: "Captured",
    eventCount: 1,
    invalidatedCount: 0,
    latestAt: "2026-01-01T00:00:00Z",
    sample: "Captured message",
    projectId: "project",
    projectName: "Project",
    projectPath: null,
    projectAssignmentSource: "detected",
    presentation: null,
    sourceAiClient: "codex"
  };
  const project: PersonalDesktopProject = {
    id: "project",
    name: "Project",
    path: null,
    eventCount: 1,
    threads: [thread]
  };
  const loadEventPage = vi.fn(async () => [
    {
      id: "00000000-0000-4000-8000-000000000002",
      actor: "user" as const,
      eventType: "message",
      content: "Captured message",
      contentPreview: "Captured message",
      timestamp: "2026-01-01T00:00:00Z",
      sourceEventTime: null,
      sourceSequence: 1,
      invalidatedAt: null,
      metadata: {}
    }
  ]);
  const store = new PersonalMemoryStore({
    loadEventPage,
    subscribe: () => () => undefined
  } as unknown as PersonalDesktopApi);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ConversationPresentationContext.Provider
          value={{
            Input: V1ManagedInput,
            Surface: V1ConversationSurface,
            compact: true
          }}
        >
          <StoreConversation
            store={store}
            project={project}
            thread={thread}
            routeSessionId={thread.sessionId!}
            managedConversationRevision={0}
            managedConversationRecoveryRevision={0}
            managedConversationUpdate={null}
            managedConversations={null}
            managedDraft={null}
            pendingCanonicalConversation={false}
            onRetryManagedConversation={null}
          />
        </ConversationPresentationContext.Provider>
      )
    );
    await vi.waitFor(() => expect(loadEventPage).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Captured message")
    );
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector('[aria-label="Send"]')).toBeNull();
    expect(container.querySelector('[aria-label="Stop"]')).toBeNull();
    expect(container.textContent).not.toMatch(
      /retry|handoff|fork conversation/i
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
