import { describe, expect, it } from "vitest";

import { buildProjectGroups, threadSelectionKey } from "./graph";
import { isTimelineEventVisible } from "./eventVisibility";
import {
  applyThreadEventShellUpdates,
  emptyThreadIndex,
  ingestThreadIndex,
  selectThread
} from "./threadIndex";
import type { GraphEvent, ProjectGroup, ThreadGroup } from "./types";

const wrappedIdePrompt = (request: string) => `# Context from my IDE setup:

## Active file: koed-self-hosted/SECURITY.md

## Open tabs:
- SECURITY.md: koed-self-hosted/SECURITY.md

## My request for Codex:
${request}`;

const standaloneIdeContext = `Context from my IDE setup:

Active file: koed-self-hosted/SECURITY.md

Open tabs:

- SECURITY.md: koed-self-hosted/SECURITY.md`;

const project: ProjectGroup = {
  eventCount: 1,
  id: "project-1",
  name: "Project 1",
  path: "/tmp/project-1",
  threads: []
};

const thread: ThreadGroup = {
  eventCount: 1,
  id: "thread-1",
  invalidatedCount: 0,
  latestAt: "2026-01-01T00:00:00.000Z",
  name: "Thread 1",
  projectId: project.id,
  projectName: project.name,
  sample: "Original sample"
};

project.threads = [thread];

const makeEvent = (overrides: Partial<GraphEvent> = {}): GraphEvent => ({
  actor: "user",
  captureMethod: "transcript",
  contentPreview: "Preview",
  eventType: "captured",
  id: "event-1",
  invalidatedAt: null,
  invalidationReason: null,
  linkedNodeIds: [],
  metadata: {},
  model: "gpt-test",
  projectId: project.id,
  projectName: project.name,
  projectPath: project.path,
  rawContent: "Raw content",
  sessionId: "session-1",
  sourceRuntime: "codex-cli",
  threadId: thread.id,
  threadName: thread.name,
  timestamp: "2026-01-01T00:00:01.000Z",
  sourceEventTime: "2026-01-01T00:00:01.000Z",
  sourceSequence: 1,
  capturedAt: "2026-01-01T00:00:01.000Z",
  createdAt: "2026-01-01T00:00:01.000Z",
  visibility: "personal",
  ...overrides
});

describe("IDE context display samples", () => {
  it("sanitizes grouped thread samples", () => {
    const [group] = buildProjectGroups([
      makeEvent({
        contentPreview: wrappedIdePrompt("Summarize the active file.")
      })
    ]);

    expect(group?.threads[0]?.sample).toBe("Summarize the active file.");
    expect(group?.threads[0]?.sample).not.toContain(
      "Context from my IDE setup"
    );
    expect(group?.threads[0]?.sample).not.toContain("Open tabs");
  });

  it("sanitizes grouped thread titles", () => {
    const [group] = buildProjectGroups([
      makeEvent({
        threadName: wrappedIdePrompt("Review the screenshot."),
        contentPreview: "Preview"
      })
    ]);

    expect(group?.threads[0]?.name).toBe("Review the screenshot.");
    expect(group?.threads[0]?.name).not.toContain("Context from my IDE setup");
  });

  it("hides image-only thread index titles and samples", () => {
    const state = ingestThreadIndex(emptyThreadIndex(), [
      {
        ...project,
        threads: [
          {
            ...thread,
            name: wrappedIdePrompt("<image>local screenshot payload</image>"),
            sample: wrappedIdePrompt("<image>local screenshot payload</image>")
          }
        ]
      }
    ]);
    const indexedThread = selectThread(state, threadSelectionKey(thread));

    expect(indexedThread?.name).toBe("Untitled conversation");
    expect(indexedThread?.name).not.toContain("Context from my IDE setup");
    expect(indexedThread?.sample).not.toContain("Context from my IDE setup");
  });

  it("sanitizes live-updated thread samples", () => {
    const state = ingestThreadIndex(emptyThreadIndex(), [project]);
    const liveEvent = makeEvent({
      contentPreview: wrappedIdePrompt("Review the selected file."),
      timestamp: "2026-01-01T00:00:09.000Z"
    });

    const updated = applyThreadEventShellUpdates(state, thread, [liveEvent]);
    const updatedThread = selectThread(updated, threadSelectionKey(thread));

    expect(updatedThread?.sample).toBe("Review the selected file.");
    expect(updatedThread?.sample).not.toContain("Context from my IDE setup");
    expect(updatedThread?.sample).not.toContain("Open tabs");
  });

  it("hides standalone IDE context events from the timeline", () => {
    expect(
      isTimelineEventVisible(
        makeEvent({
          actor: "user",
          contentPreview: standaloneIdeContext
        })
      )
    ).toBe(false);
    expect(
      isTimelineEventVisible(
        makeEvent({
          actor: "user",
          contentPreview: "Review the selected file."
        })
      )
    ).toBe(true);
  });
});
