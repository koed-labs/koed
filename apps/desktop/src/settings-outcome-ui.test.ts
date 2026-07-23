// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { renderSettingsOutcomeRows } from "./settings-outcome-ui.js";

describe("Desktop Settings outcome controls", () => {
  it("renders a focusable, labelled recovery control for the failing component", () => {
    const container = document.createElement("div");
    container.innerHTML = renderSettingsOutcomeRows(
      [
        {
          id: "capture",
          title: "Capture",
          description: "Collect new AI Client Conversations.",
          state: "needs_attention",
          stateLabel: "Needs attention",
          summary: "API is stopped.",
          recovery: {
            action: { label: "Ensure API is running", command: "start" },
            componentKey: "api",
            componentLabel: "API"
          }
        },
        {
          id: "recall",
          title: "Recall",
          description: "Recall Personal Memory.",
          state: "healthy",
          stateLabel: "Healthy",
          summary: "Recall is ready."
        }
      ],
      (value) => value
    );
    document.body.append(container);
    const button = container.querySelector<HTMLButtonElement>(
      "[data-settings-outcome='capture'] .settings-recovery"
    );
    const click = vi.fn();
    button?.addEventListener("click", click);

    expect(button?.dataset.startupAction).toBe("start");
    expect(button?.dataset.statusComponent).toBe("api");
    expect(button?.getAttribute("aria-label")).toBe(
      "Ensure API is running for Capture: API"
    );
    expect(
      container.querySelector("[data-settings-outcome='recall'] button")
    ).toBeNull();

    button?.focus();
    expect(document.activeElement).toBe(button);
    button?.click();
    expect(click).toHaveBeenCalledOnce();
    container.remove();
  });
});
