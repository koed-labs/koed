// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConversationSettings } from "./ConversationSettings.js";

const claudeModels = [
  {
    id: "sonnet",
    displayName: "Sonnet 5.5",
    supportedReasoningEfforts: ["low", "high"]
  },
  {
    id: "opus",
    displayName: "Opus 5.5",
    supportedReasoningEfforts: ["low", "high"]
  }
];
const claudeOptions = {
  runners: [],
  instances: [
    {
      instanceId: "claude.default",
      driverId: "claude" as const,
      displayName: "Claude Code",
      ready: true,
      readiness: "ready",
      models: claudeModels,
      capabilities: {
        defaultPermissionMode: "supervised" as const,
        permissionModes: [
          { mode: "supervised" as const, support: "supported" as const }
        ]
      }
    }
  ]
};

const clickMenuItem = async (role: string, label: string) => {
  const item = [...document.body.querySelectorAll(`[role="${role}"]`)].find(
    (candidate) => candidate.textContent?.includes(label)
  );
  expect(item).toBeDefined();
  await act(async () =>
    item!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  );
};

it.each(claudeModels)(
  "keeps $displayName label separate from model value",
  async ({ id, displayName }) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onChange = vi.fn();
    const otherModel = claudeModels.find((candidate) => candidate.id !== id)!;
    try {
      await act(async () =>
        root.render(
          <ConversationSettings
            options={claudeOptions}
            selection={{
              instanceId: "claude.default",
              model: otherModel.id,
              reasoningEffort: "low",
              permissionMode: "supervised"
            }}
            onChange={onChange}
          />
        )
      );
      expect(container.textContent).toContain(otherModel.displayName);
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            '[aria-label^="Model and reasoning:"]'
          )!
          .click()
      );
      await clickMenuItem("menuitem", otherModel.displayName);
      expect(document.body.textContent).toContain(displayName);
      await clickMenuItem("menuitemradio", displayName);
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ model: id })
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  }
);

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
