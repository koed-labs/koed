// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConversationSettings } from "./ConversationSettings.js";

it("distinguishes loading AI Clients from a completed unavailable result", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const props = {
    selection: {
      instanceId: "",
      model: "",
      reasoningEffort: "",
      permissionMode: "" as const
    },
    onChange: vi.fn()
  };
  try {
    await act(async () =>
      root.render(<ConversationSettings {...props} options={null} />)
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label^="AI Client:"]')!
        .click()
    );
    expect(document.body.textContent).toContain("Loading AI Clients…");
    expect(document.body.textContent).not.toContain(
      "Refresh its status in Preferences."
    );
    await act(async () =>
      root.render(
        <ConversationSettings
          {...props}
          options={{ instances: [], runners: [] }}
        />
      )
    );
    expect(document.body.textContent).not.toContain("Loading AI Clients…");
    expect(document.body.textContent).toContain(
      "This AI Client is unavailable."
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
