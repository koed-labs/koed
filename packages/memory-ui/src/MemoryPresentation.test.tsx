// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EvidenceBundle,
  LcmSummaryFrame,
  MemoryEventFrame,
  MemorySourceParts
} from "./MemoryPresentation.js";

describe("memory presentation", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("preserves scope, content type, source semantics, actions, and metadata", async () => {
    await act(async () =>
      root.render(
        <MemoryEventFrame
          actions={<button type="button">Inspect</button>}
          contentType="memory_event"
          header="Captured turn"
          metadata={<time dateTime="2026-07-23T00:00:00.000Z">Today</time>}
          scope="workspace"
        >
          <MemorySourceParts
            parts={[
              {
                actorName: "AI Client",
                body: "Checked the implementation.",
                id: "source-1",
                sourceKind: "agent_message",
                toolCallId: null,
                toolName: null
              }
            ]}
          />
        </MemoryEventFrame>
      )
    );
    const event = container.querySelector("article");
    expect(event?.dataset.memoryScope).toBe("workspace");
    expect(event?.dataset.memoryContentType).toBe("memory_event");
    expect(
      container.querySelector('[data-source-kind="agent_message"]')?.textContent
    ).toContain("Checked the implementation.");
    expect(container.textContent).toContain("Inspect");
    expect(container.querySelector("time")?.dateTime).toBe(
      "2026-07-23T00:00:00.000Z"
    );
  });

  it("renders LCM and Evidence Bundle semantics without app-specific behavior", async () => {
    await act(async () =>
      root.render(
        <>
          <LcmSummaryFrame
            occurredAt="2026-07-23T00:00:00.000Z"
            representation="lcm_rollups"
            sourceCount={12}
            summary="A concise semantic summary."
            timeLabel="Today"
          />
          <EvidenceBundle
            evidence={[
              {
                excerpt: "The decision was recorded.",
                id: "evidence-1",
                source: "Captured Session"
              }
            ]}
          />
        </>
      )
    );
    expect(
      container.querySelector('[data-representation="lcm_rollups"]')
        ?.textContent
    ).toContain("12 source items");
    expect(container.textContent).toContain("Evidence Bundle");
    expect(container.textContent).toContain("The decision was recorded.");
  });
});
