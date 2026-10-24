// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedConversationLaunchOptions } from "../../../ipc/managed-conversation-protocol.js";
import type { HqSelection } from "../conversation/hq-conversation-model.js";
import type { DesktopApi } from "../../../types.js";
import type { UsageReading } from "./hq-usage-model.js";

const fixture = vi.hoisted(() => ({
  scope: "account-a",
  reads: [] as UsageReading[]
}));
vi.mock("./use-hq-usage.js", () => ({
  useHqUsage: () => ({
    readings: fixture.reads,
    readModel: {},
    usageScopeId: fixture.scope
  })
}));
import { HqUsageSuggestion } from "./HqUsageSuggestion.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const options = {
  instances: [
    {
      instanceId: "codex.fixture",
      driverId: "codex",
      displayName: "Codex",
      ready: true,
      models: [{ id: "gpt-6", isDefault: true }]
    },
    {
      instanceId: "claude.fixture",
      driverId: "claude",
      displayName: "Claude",
      ready: true,
      models: [{ id: "sonnet", isDefault: true }]
    }
  ]
} as unknown as ManagedConversationLaunchOptions;
const selection: HqSelection = {
  instanceId: "codex.fixture",
  model: "gpt-6",
  reasoningEffort: "",
  permissionMode: "supervised"
};
const row = (window: string, usedPercent: number): UsageReading => ({
  instanceId: "codex.fixture",
  accountVerified: true,
  source: "codex_app_server",
  bucketId: "codex",
  bucketName: "Codex",
  window,
  windowDurationMins: window === "primary" ? 300 : 10080,
  usedPercent,
  status: usedPercent >= 90 ? "near_limit" : "ok",
  resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
  observedAt: new Date(Date.now() - 60_000).toISOString(),
  planType: null,
  details: {
    ordinaryUsageAllowed: true,
    spendControlReached: false,
    rateLimitReachedType: null
  }
});

describe("HQ usage dismissal scope", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    window.localStorage.clear();
    fixture.scope = "account-a";
    fixture.reads = [row("primary", 12), row("secondary", 96)];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const view = (
    root: Root,
    localAiClients?: DesktopApi["localAiClients"],
    onUse?: (instanceId: string) => void
  ) =>
    act(async () =>
      root.render(
        <HqUsageSuggestion
          draft="Hello"
          selection={selection}
          options={options}
          authorityKey="owner:profile:revision-1"
          dismissalScopeKey="owner:profile"
          localAiClients={localAiClients}
          onUse={onUse}
        />
      )
    );

  it("keeps a dismissal across remount but does not carry it to another account", async () => {
    await view(root);
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          ".hq-usage-suggestion button:last-child"
        )!
        .click()
    );
    expect(host.querySelector(".hq-usage-suggestion")).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    await view(root);
    expect(host.querySelector(".hq-usage-suggestion")).toBeNull();
    fixture.scope = "account-b";
    await view(root);
    expect(host.querySelector(".hq-usage-suggestion")).not.toBeNull();
  });

  it("rechecks current readings and account scope before accepting an alternative", async () => {
    const allowed: UsageReading = {
      instanceId: "claude.fixture",
      accountVerified: true,
      source: "claude_agent_sdk",
      bucketId: "claude",
      bucketName: "Claude",
      window: "five_hour",
      windowDurationMins: null,
      usedPercent: null,
      status: "ok",
      resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
      observedAt: new Date(Date.now() - 60_000).toISOString(),
      planType: null,
      details: { status: "allowed", rateLimitType: "five_hour" }
    };
    fixture.reads = [...fixture.reads, allowed];
    const onUse = vi.fn();
    let response = { usageScopeId: "account-a", usage: [...fixture.reads] };
    const bridge = {
      usage: vi.fn(async () => response)
    } as unknown as DesktopApi["localAiClients"];
    await view(root, bridge, onUse);
    const click = () =>
      act(async () =>
        host
          .querySelector<HTMLButtonElement>(".hq-usage-suggestion__primary")!
          .click()
      );
    response = {
      usageScopeId: "account-a",
      usage: [
        ...fixture.reads.slice(0, 2),
        {
          ...allowed,
          observedAt: new Date(Date.now() - 31 * 60_000).toISOString()
        }
      ]
    };
    await click();
    expect(onUse).not.toHaveBeenCalled();
    response = { usageScopeId: "account-b", usage: [...fixture.reads] };
    await click();
    expect(onUse).not.toHaveBeenCalled();
    response = { usageScopeId: "account-a", usage: [...fixture.reads] };
    await click();
    expect(onUse).toHaveBeenCalledExactlyOnceWith("claude.fixture");
  });

  it("shows a warning without a dead action when running new-chat navigation is unavailable", async () => {
    fixture.reads.push({
      instanceId: "claude.fixture",
      accountVerified: true,
      source: "claude_agent_sdk",
      bucketId: "claude",
      bucketName: "Claude",
      window: "five_hour",
      windowDurationMins: null,
      usedPercent: null,
      status: "ok",
      resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
      observedAt: new Date(Date.now() - 60_000).toISOString(),
      planType: null,
      details: { status: "allowed", rateLimitType: "five_hour" }
    });
    await act(async () =>
      root.render(
        <HqUsageSuggestion
          draft="Hello"
          selection={selection}
          options={options}
          authorityKey="owner:profile:revision-1"
          dismissalScopeKey="owner:profile"
          running
        />
      )
    );
    expect(host.querySelector(".hq-usage-suggestion")).not.toBeNull();
    expect(host.querySelector(".hq-usage-suggestion__primary")).toBeNull();
    expect(host.textContent).not.toContain("No other AI reports room");
  });
  it("discards an accepting click when the owner changes during its usage recheck", async () => {
    fixture.reads.push({
      instanceId: "claude.fixture",
      accountVerified: true,
      source: "claude_agent_sdk",
      bucketId: "claude",
      bucketName: "Claude",
      window: "five_hour",
      windowDurationMins: null,
      usedPercent: null,
      status: "ok",
      resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
      observedAt: new Date(Date.now() - 60_000).toISOString(),
      planType: null,
      details: { status: "allowed", rateLimitType: "five_hour" }
    });
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const bridge = {
      usage: vi.fn(() => pending)
    } as unknown as DesktopApi["localAiClients"];
    const onUse = vi.fn();
    await view(root, bridge, onUse);
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(".hq-usage-suggestion__primary")!
        .click()
    );
    expect(bridge!.usage).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(
        <HqUsageSuggestion
          draft="Hello"
          selection={selection}
          options={options}
          authorityKey="other-owner:profile:revision-1"
          dismissalScopeKey="other-owner:profile"
          localAiClients={bridge}
          onUse={onUse}
        />
      )
    );
    await act(async () =>
      finish({ usageScopeId: "account-a", usage: [...fixture.reads] })
    );
    expect(onUse).not.toHaveBeenCalled();
  });
});
