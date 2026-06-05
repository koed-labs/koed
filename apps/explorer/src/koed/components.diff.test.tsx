// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GraphEvent } from "./types";

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: (props: {
    fileDiff: { name: string };
    options?: {
      collapsed?: boolean;
    };
    renderHeaderPrefix?: (fileDiff: { name: string }) => ReactNode;
  }) =>
    createElement(
      "div",
      {
        "data-testid": "mock-file-diff",
        "data-collapsed": String(Boolean(props.options?.collapsed))
      },
      createElement(
        "div",
        { className: "mock-file-header" },
        props.renderHeaderPrefix?.(props.fileDiff) ?? null,
        createElement(
          "span",
          { "data-testid": "mock-file-name" },
          props.fileDiff.name
        )
      ),
      props.options?.collapsed
        ? null
        : createElement(
            "div",
            { "data-testid": "mock-file-body" },
            `body:${props.fileDiff.name}`
          )
    )
}));

import { KoedMessage } from "./components";
import { summarizePatchDetails } from "./diff";

const patchText = `*** Begin Patch
*** Update File: /Users/jedd/repos/dotfiles/macos.sh
@@
-# Note: if you’re in the US, replace \`EUR\` with \`USD\`, \`Centimeters\` with
-# \`Inches\`, \`en_GB\` with \`en_US\`, and \`true\` with \`false\`.
+# Note: this repository is documented for a US setup.
 defaults write NSGlobalDomain AppleLanguages -array "en"
-defaults write NSGlobalDomain AppleLocale -string "en_GB@currency=USD"
-defaults write NSGlobalDomain AppleMeasurementUnits -string "Centimeters"
-defaults write NSGlobalDomain AppleMetricUnits -bool true
+defaults write NSGlobalDomain AppleLocale -string "en_US@currency=USD"
+defaults write NSGlobalDomain AppleMeasurementUnits -string "Inches"
+defaults write NSGlobalDomain AppleMetricUnits -bool false
*** Update File: /Users/jedd/repos/dotfiles/settings.json
@@
-"terminal.integrated.gpuAcceleration": "on"
+"terminal.integrated.gpuAcceleration": "off"
*** End Patch
`;

function makePatchEvent(sourceText = patchText): GraphEvent {
  const details = summarizePatchDetails({
    content: `Tool call: apply_patch\n\nInput:\n${sourceText}`,
    contentFull: `Tool call: apply_patch\n\nInput:\n${sourceText}`,
    rawContent: `Tool call: apply_patch\n\nInput:\n${sourceText}`,
    metadata: {
      toolCall: {
        id: "call_patch",
        kind: "call",
        name: "apply_patch",
        type: "custom_tool_call",
        input: sourceText,
        status: "completed"
      },
      rawTranscriptPayload: {
        type: "custom_tool_call",
        name: "apply_patch",
        input: sourceText,
        status: "completed"
      }
    }
  });

  return {
    actor: "tool",
    captureMethod: "hook",
    contentPreview: details
      ? `Tool call: apply_patch`
      : "Tool call: apply_patch",
    eventType: "agent_turn",
    id: "event-1",
    invalidatedAt: null,
    invalidationReason: null,
    linkedNodeIds: [],
    metadata: {
      toolCall: {
        id: "call_patch",
        kind: "call",
        name: "apply_patch",
        type: "custom_tool_call",
        input: sourceText,
        status: "completed"
      },
      rawTranscriptPayload: {
        type: "custom_tool_call",
        name: "apply_patch",
        input: sourceText,
        status: "completed"
      }
    },
    model: "gpt-5.4-mini",
    projectId: "/Users/jedd/repos/dotfiles",
    projectName: "/Users/jedd/repos/dotfiles",
    projectPath: "/Users/jedd/repos/dotfiles",
    rawContent: `Tool call: apply_patch\n\nInput:\n${sourceText}`,
    sessionId: "session-1",
    sourceRuntime: "codex",
    timestamp: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    capturedAt: new Date().toISOString(),
    visibility: "personal",
    workspaceId: "/Users/jedd/repos/dotfiles",
    threadId: "thread-1",
    threadName: "thread-1",
    sourceEventTime: new Date().toISOString(),
    sourceSequence: 1
  } as GraphEvent;
}

describe("Codex patch rows", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    localStorage.clear();
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows file headers by default and opens one file body at a time", async () => {
    const event = makePatchEvent();

    await act(async () => {
      root.render(
        createElement(KoedMessage, {
          event,
          isSelected: false,
          onSelect: () => undefined
        })
      );
    });

    expect(
      container.querySelector('button[aria-label="Expand tool call"]')
    ).toBeNull();

    const fileDiffs = container.querySelectorAll(
      "[data-testid='mock-file-diff']"
    );
    expect(fileDiffs).toHaveLength(2);
    expect(
      container.querySelectorAll("[data-testid='mock-file-body']")
    ).toHaveLength(0);

    const fileButtons = [...container.querySelectorAll("button")].filter(
      (button) =>
        button.getAttribute("aria-label")?.startsWith("Expand file diff for")
    );
    expect(fileButtons).toHaveLength(2);

    await act(async () => {
      fileButtons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(
      container.querySelectorAll("[data-testid='mock-file-body']")
    ).toHaveLength(1);
    expect(container.textContent).toContain(
      "body:Users/jedd/repos/dotfiles/macos.sh"
    );
    expect(container.textContent).not.toContain("1 file changed:");

    await act(async () => {
      fileButtons[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(
      container.querySelectorAll("[data-testid='mock-file-body']")
    ).toHaveLength(1);
    expect(container.textContent).toContain(
      "body:Users/jedd/repos/dotfiles/settings.json"
    );
    expect(container.textContent).not.toContain(
      "body:Users/jedd/repos/dotfiles/macos.sh"
    );
  });

  it("falls back to raw patch text when normalization fails", async () => {
    const event = makePatchEvent(`*** Begin Patch
*** End Patch
`);

    await act(async () => {
      root.render(
        createElement(KoedMessage, {
          event,
          isSelected: false,
          onSelect: () => undefined
        })
      );
    });

    expect(
      container.querySelector('button[aria-label="Expand tool call"]')
    ).toBeNull();
    expect(
      container.querySelector("[data-testid='mock-file-diff']")
    ).toBeNull();
    expect(container.textContent).toContain("*** Begin Patch");
    expect(container.textContent).toContain("*** End Patch");
  });
});
