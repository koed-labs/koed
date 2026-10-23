// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../types.js";
import type {
  LocalAiClientResponse,
  LocalAiClientUsageChanged
} from "../../../ipc/local-ai-client-protocol.js";
import { HqUsageTable } from "./HqUsageTable.js";
import { usageFixture, usageFixtureNow } from "./hq-usage.fixture.js";

const readModel = {
  instances: [
    {
      instanceId: "codex.default",
      driverId: "codex" as const,
      displayName: "Codex",
      enabled: true
    },
    {
      instanceId: "claude.default",
      driverId: "claude" as const,
      displayName: "Claude",
      enabled: true
    },
    {
      instanceId: "pi.default",
      driverId: "pi" as const,
      displayName: "Pi",
      enabled: true
    }
  ],
  capabilitySnapshots: [],
  settings: [],
  defaults: {} as LocalAiClientResponse["readModel"]["defaults"]
};
const response = (
  usage: LocalAiClientResponse["usage"],
  usageOutcome?: LocalAiClientResponse["usageOutcome"]
): LocalAiClientResponse => ({
  operation: "usage",
  readModel,
  usage,
  usageOutcome
});

describe("HQ usage table lifecycle", () => {
  let host: HTMLDivElement;
  let root: Root;
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

  it("subscribes before reading, then updates when a probe completes", async () => {
    const order: string[] = [];
    let listener: ((change: LocalAiClientUsageChanged) => void) | undefined;
    const bridge = {
      onUsageChanged: vi.fn((fn: typeof listener) => {
        order.push("subscribe");
        listener = fn;
        return () => {
          order.push("unsubscribe");
        };
      }),
      usage: vi.fn(async () => {
        order.push("read");
        return response(usageFixture.codexLow);
      })
    } as unknown as DesktopApi["localAiClients"];
    await act(async () =>
      root.render(
        <HqUsageTable
          localAiClients={bridge}
          authorityKey="owner:profile:backend"
        />
      )
    );
    expect(order.slice(0, 2)).toEqual(["subscribe", "read"]);
    expect(host.textContent).toContain("96%");
    expect(host.textContent).toContain("Not shared by Pi");
    expect(host.querySelector('[title*="free resets left"]')).not.toBeNull();
    bridge!.usage = vi.fn(async () =>
      response([...usageFixture.allFine, ...usageFixture.claudeAllowed])
    );
    await act(async () =>
      listener?.({
        kind: "completion",
        instanceId: "codex.default",
        completionId: "2",
        outcome: "checked",
        observedAt: new Date().toISOString()
      })
    );
    expect(host.textContent).toContain("32%");
    expect(host.textContent).toContain("OK");
    expect(host.textContent).toContain("as of 25m ago");
  });

  it("keeps a selected model's five-hour Codex bucket beside the default window only", async () => {
    const selected = {
      ...usageFixture.codexLow[0]!,
      bucketId: "spark",
      bucketName: "Spark",
      usedPercent: 91,
      status: "near_limit" as const,
      details: {
        ...usageFixture.codexLow[0]!.details,
        normalModelSlug: "gpt-5.5-spark"
      }
    };
    const selectedReadModel = {
      ...readModel,
      settings: [
        {
          flowKey: "conversations" as const,
          provider: "codex" as const,
          aiClientInstanceId: "codex.default",
          model: "gpt-5.5-spark",
          reasoningEffort: "low",
          timeoutMs: 30_000,
          maxAttempts: 1,
          createdAt: "2026-10-23T11:00:00Z",
          updatedAt: "2026-10-23T11:00:00Z"
        }
      ]
    };
    const bridge = {
      onUsageChanged: vi.fn(() => () => undefined),
      usage: vi.fn(async () => ({
        ...response([...usageFixture.codexLow, selected]),
        readModel: selectedReadModel
      }))
    } as unknown as NonNullable<DesktopApi["localAiClients"]>;
    await act(async () =>
      root.render(
        <HqUsageTable localAiClients={bridge} authorityKey="selected-spark" />
      )
    );
    const codex = host.querySelectorAll<HTMLElement>(".hq-usage__row")[1]!;
    const cells = codex.querySelectorAll<HTMLElement>('[role="cell"]');
    expect(cells[1]!.textContent).toContain("12%");
    expect(cells[1]!.textContent).toContain("Spark 91%");
    expect(cells[2]!.textContent).toContain("96%");
    expect(cells[2]!.textContent).not.toContain("Spark");
    bridge.usage = vi.fn(async () => ({
      ...response([
        ...usageFixture.codexLow,
        { ...selected, usedPercent: null, status: "unknown" }
      ]),
      readModel: selectedReadModel
    }));
    await act(async () =>
      root.render(
        <HqUsageTable
          localAiClients={bridge}
          authorityKey="selected-spark-unknown"
        />
      )
    );
    const unknownCells = host
      .querySelectorAll<HTMLElement>(".hq-usage__row")[1]!
      .querySelectorAll<HTMLElement>('[role="cell"]');
    expect(unknownCells[1]!.textContent).toContain("12%");
    expect(unknownCells[1]!.textContent).toContain("Spark —");
    expect(unknownCells[2]!.textContent).not.toContain("Spark");
  });

  it("drops a response from an earlier authority and unsubscribes", async () => {
    let resolveOld!: (value: LocalAiClientResponse) => void;
    const oldRead = new Promise<LocalAiClientResponse>((resolve) => {
      resolveOld = resolve;
    });
    const unsubscribe = vi.fn();
    const bridge = {
      onUsageChanged: vi.fn(() => unsubscribe),
      usage: vi.fn(() => oldRead)
    } as unknown as DesktopApi["localAiClients"];
    await act(async () =>
      root.render(<HqUsageTable localAiClients={bridge} authorityKey="old" />)
    );
    bridge!.usage = vi.fn(async () => response(usageFixture.allFine));
    await act(async () =>
      root.render(<HqUsageTable localAiClients={bridge} authorityKey="new" />)
    );
    expect(host.textContent).toContain("32%");
    await act(async () => resolveOld(response(usageFixture.codexLow)));
    expect(host.textContent).toContain("32%");
    expect(host.textContent).not.toContain("96%");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("reports refresh outcomes truthfully", async () => {
    const bridge = {
      onUsageChanged: vi.fn(() => () => undefined),
      usage: vi.fn(async (instanceId?: string) =>
        instanceId
          ? response(usageFixture.codexLow, "failed")
          : response(usageFixture.codexLow)
      )
    } as unknown as DesktopApi["localAiClients"];
    await act(async () =>
      root.render(
        <HqUsageTable localAiClients={bridge} authorityKey="current" />
      )
    );
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Check usage now"]'
        )
        ?.click()
    );
    expect(host.textContent).toContain("Couldn't check Codex.");
    expect(host.textContent).toContain("Claude updates on its next run.");
    expect(host.textContent).not.toContain("Checked Codex just now.");
  });

  it("clears a pending refresh on account change and ignores its late checked result", async () => {
    let resolveRefresh!: (value: LocalAiClientResponse) => void;
    const pendingRefresh = new Promise<LocalAiClientResponse>((resolve) => {
      resolveRefresh = resolve;
    });
    const bridge = {
      onUsageChanged: vi.fn(() => () => undefined),
      usage: vi.fn(async (instanceId?: string) =>
        instanceId ? pendingRefresh : response(usageFixture.codexLow)
      )
    } as unknown as DesktopApi["localAiClients"];
    await act(async () =>
      root.render(
        <HqUsageTable localAiClients={bridge} authorityKey="old-account" />
      )
    );
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Check usage now"]'
        )!
        .click()
    );
    expect(
      host.querySelector<HTMLButtonElement>(
        'button[aria-label="Check usage now"]'
      )?.disabled
    ).toBe(true);
    bridge!.usage = vi.fn(async () => response(usageFixture.allFine));
    await act(async () =>
      root.render(
        <HqUsageTable localAiClients={bridge} authorityKey="new-account" />
      )
    );
    expect(
      host.querySelector<HTMLButtonElement>(
        'button[aria-label="Check usage now"]'
      )?.disabled
    ).toBe(false);
    expect(host.textContent).toContain("32%");
    await act(async () =>
      resolveRefresh(response(usageFixture.codexLow, "checked"))
    );
    expect(host.textContent).toContain("32%");
    expect(host.textContent).not.toContain("Checked Codex just now.");
    expect(
      host.querySelector<HTMLButtonElement>(
        'button[aria-label="Check usage now"]'
      )?.disabled
    ).toBe(false);
  });

  it("clears pending refresh state when the usage stream invalidates", async () => {
    let listener: ((change: LocalAiClientUsageChanged) => void) | undefined;
    let resolveRefresh!: (value: LocalAiClientResponse) => void;
    const bridge = {
      onUsageChanged: vi.fn((fn: typeof listener) => {
        listener = fn;
        return () => undefined;
      }),
      usage: vi.fn(async (instanceId?: string) =>
        instanceId
          ? new Promise<LocalAiClientResponse>((resolve) => {
              resolveRefresh = resolve;
            })
          : response(usageFixture.codexLow)
      )
    } as unknown as DesktopApi["localAiClients"];
    await act(async () =>
      root.render(
        <HqUsageTable localAiClients={bridge} authorityKey="account" />
      )
    );
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Check usage now"]'
        )!
        .click()
    );
    await act(async () => listener?.({ kind: "invalidated" }));
    expect(host.textContent).not.toContain("96%");
    await act(async () =>
      resolveRefresh(response(usageFixture.codexLow, "checked"))
    );
    expect(host.textContent).not.toContain("Checked Codex just now.");
    await act(async () => listener?.({ kind: "catch_up" }));
    expect(
      host.querySelector<HTMLButtonElement>(
        'button[aria-label="Check usage now"]'
      )?.disabled
    ).toBe(false);
  });
});
