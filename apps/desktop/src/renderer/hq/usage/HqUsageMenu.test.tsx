// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../types.js";
import type { ManagedConversationLaunchOptions } from "../../../ipc/managed-conversation-protocol.js";
import { HqConversationSettings } from "../conversation/HqConversation.js";
import { usageFixture, usageFixtureNow } from "./hq-usage.fixture.js";

const options = {
  instances: [
    {
      instanceId: "codex.default",
      driverId: "codex",
      displayName: "Codex",
      ready: true,
      models: [
        {
          id: "gpt",
          displayName: "GPT",
          isDefault: true,
          supportedReasoningEfforts: ["low"]
        }
      ],
      capabilities: {
        permissionModes: [{ mode: "supervised", support: "supported" }]
      }
    },
    {
      instanceId: "claude.default",
      driverId: "claude",
      displayName: "Claude",
      ready: true,
      models: [
        {
          id: "claude-opus",
          displayName: "Opus",
          isDefault: true,
          supportedReasoningEfforts: ["low"]
        },
        {
          id: "claude-sonnet",
          displayName: "Sonnet",
          isDefault: false,
          supportedReasoningEfforts: ["low"]
        }
      ],
      capabilities: {
        permissionModes: [{ mode: "supervised", support: "supported" }]
      }
    },
    {
      instanceId: "pi.default",
      driverId: "pi",
      displayName: "Pi",
      ready: true,
      models: [
        {
          id: "pi",
          displayName: "Pi",
          isDefault: true,
          supportedReasoningEfforts: ["low"]
        }
      ],
      capabilities: {
        permissionModes: [{ mode: "supervised", support: "supported" }]
      }
    }
  ]
} as unknown as ManagedConversationLaunchOptions;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(usageFixtureNow);
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it("shows a usage line under each AI Client and opens Settings usage", async () => {
  const onSeeUsage = vi.fn();
  const bridge = {
    onUsageChanged: vi.fn(() => () => undefined),
    usage: vi.fn(async () => ({
      operation: "usage",
      readModel: {
        instances: [],
        capabilitySnapshots: [],
        settings: [],
        defaults: {}
      },
      usage: [...usageFixture.codexLow, ...usageFixture.claudeNear]
    }))
  } as unknown as DesktopApi["localAiClients"];
  await act(async () =>
    root.render(
      <HqConversationSettings
        options={options}
        selection={{
          instanceId: "codex.default",
          model: "gpt",
          reasoningEffort: "low",
          permissionMode: "supervised"
        }}
        onChange={() => undefined}
        localAiClients={bridge}
        usageAuthorityKey="owner:profile:backend"
        onSeeUsage={onSeeUsage}
      />
    )
  );
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label^="Model and reasoning"]')!
      .click()
  );
  await act(async () =>
    document.body
      .querySelector<HTMLButtonElement>(
        '[aria-label="Choose AI Client and model"]'
      )!
      .click()
  );
  expect(document.body.textContent).toContain("Codex: 4% of this week left");
  expect(document.body.textContent).toContain(
    "Claude: near its weekly limit (91% used)"
  );
  expect(document.body.textContent).toContain("Pi: Not shared by Pi");
  await act(async () =>
    [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.includes("See usage"))!
      .click()
  );
  expect(onSeeUsage).toHaveBeenCalledTimes(1);
});

it("colors the selected model's usage rather than the first model's usage", async () => {
  const bridge = {
    onUsageChanged: vi.fn(() => () => undefined),
    usage: vi.fn(async () => ({
      operation: "usage",
      readModel: {
        instances: [],
        capabilitySnapshots: [],
        settings: [],
        defaults: {}
      },
      usage: [...usageFixture.claudeNear]
    }))
  } as unknown as DesktopApi["localAiClients"];
  await act(async () =>
    root.render(
      <HqConversationSettings
        options={options}
        selection={{
          instanceId: "claude.default",
          model: "claude-sonnet",
          reasoningEffort: "low",
          permissionMode: "supervised"
        }}
        onChange={() => undefined}
        localAiClients={bridge}
        usageAuthorityKey="owner:profile:backend"
        onSeeUsage={() => undefined}
      />
    )
  );
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label^="Model and reasoning"]')!
      .click()
  );
  await act(async () =>
    document.body
      .querySelector<HTMLButtonElement>(
        '[aria-label="Choose AI Client and model"]'
      )!
      .click()
  );
  const claude = [
    ...document.body.querySelectorAll<HTMLElement>(
      ".hq-conversation-menu__usage"
    )
  ].find((item) => item.textContent?.startsWith("Claude:"));
  expect(claude?.textContent).toContain("not reported");
  expect(claude?.classList.contains("hq-conversation-menu__usage--low")).toBe(
    false
  );
});
