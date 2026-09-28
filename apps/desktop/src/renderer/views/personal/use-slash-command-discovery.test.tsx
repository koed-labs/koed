// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSlashCommandDiscovery } from "./use-slash-command-discovery.js";

const command = {
  name: "/test",
  description: "Test",
  kind: "command",
  source: "provider"
} as const;

type HookResult = ReturnType<typeof useSlashCommandDiscovery>;

type HookHarness = {
  result: { current: HookResult | undefined };
  rerender: (
    api: Parameters<typeof useSlashCommandDiscovery>[0],
    cwd?: Parameters<typeof useSlashCommandDiscovery>[4]
  ) => void;
  unmount: () => void;
};

function renderDiscoveryHook(
  api: Parameters<typeof useSlashCommandDiscovery>[0],
  driverId: Parameters<typeof useSlashCommandDiscovery>[1] = "codex",
  instanceId: Parameters<typeof useSlashCommandDiscovery>[2] = "test-instance",
  projectId: Parameters<typeof useSlashCommandDiscovery>[3] = "test-project",
  cwd: Parameters<typeof useSlashCommandDiscovery>[4] = "/home/test"
): HookHarness {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  const result: { current: HookResult | undefined } = { current: undefined };

  function Harness({
    currentApi,
    currentCwd
  }: {
    currentApi: Parameters<typeof useSlashCommandDiscovery>[0];
    currentCwd: Parameters<typeof useSlashCommandDiscovery>[4];
  }) {
    result.current = useSlashCommandDiscovery(
      currentApi,
      driverId,
      instanceId,
      projectId,
      currentCwd
    );
    return null;
  }

  act(() => {
    root.render(<Harness currentApi={api} currentCwd={cwd} />);
  });

  return {
    result,
    rerender: (nextApi, nextCwd = cwd) => {
      act(() => {
        root.render(<Harness currentApi={nextApi} currentCwd={nextCwd} />);
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    }
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useSlashCommandDiscovery", () => {
  const mockApi = {
    discoverCommands: vi
      .fn()
      .mockResolvedValue({ status: "ok", commands: [command] })
  };

  beforeEach(() => {
    vi.useRealTimers();
    mockApi.discoverCommands.mockReset();
    mockApi.discoverCommands.mockResolvedValue({
      status: "ok",
      commands: [command]
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches commands on mount", async () => {
    const harness = renderDiscoveryHook(mockApi);

    await settle();

    expect(mockApi.discoverCommands).toHaveBeenCalledTimes(1);
    expect(harness.result.current?.loading).toBe(false);
    expect(harness.result.current?.error).toBeNull();
    expect(harness.result.current?.commands).toHaveLength(1);
    harness.unmount();
  });

  it("returns empty on unavailable", async () => {
    mockApi.discoverCommands.mockResolvedValueOnce({
      status: "unavailable",
      commands: []
    });
    const harness = renderDiscoveryHook(mockApi);

    await settle();

    expect(harness.result.current?.commands).toEqual([]);
    expect(harness.result.current?.error).toBeNull();
    harness.unmount();
  });

  it("sets error on unknown status", async () => {
    mockApi.discoverCommands.mockResolvedValueOnce({
      status: "unauthorized",
      commands: [],
      message: "Not authorized"
    });
    const harness = renderDiscoveryHook(mockApi);

    await settle();

    expect(harness.result.current?.error).toBe("Not authorized");
    expect(harness.result.current?.commands).toEqual([]);
    harness.unmount();
  });

  it("clears commands when api is null", async () => {
    const harness = renderDiscoveryHook(mockApi);
    await settle();

    harness.rerender(null);

    expect(harness.result.current?.commands).toEqual([]);
    expect(harness.result.current?.error).toBeNull();
    expect(harness.result.current?.lastFetchedAt).toBeNull();
    harness.unmount();
  });

  it("handles fetch failure with fail-closed", async () => {
    mockApi.discoverCommands.mockRejectedValueOnce(new Error("Network error"));
    const harness = renderDiscoveryHook(mockApi);

    await settle();

    expect(harness.result.current?.error).toBe("Command discovery failed.");
    expect(harness.result.current?.commands).toEqual([]);
    harness.unmount();
  });

  it("keeps fresh cached commands when refetch fails", async () => {
    vi.useFakeTimers();
    const harness = renderDiscoveryHook(mockApi);
    await settle();

    const failingApi = {
      discoverCommands: vi.fn().mockRejectedValue(new Error("Network error"))
    };
    harness.rerender(failingApi);
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.result.current?.commands).toEqual([command]);
    expect(harness.result.current?.error).toBeNull();
    harness.unmount();
  });

  it.each([
    ["unauthorized", "Not authorized"],
    ["stale", "AI Client capability snapshot is stale."]
  ] as const)(
    "fails closed for cached commands when response is %s",
    async (status, expectedError) => {
      vi.useFakeTimers();
      const harness = renderDiscoveryHook(mockApi);
      await settle();

      const restrictedApi = {
        discoverCommands: vi.fn().mockResolvedValue({
          status,
          ...(status === "unauthorized" ? { message: "Not authorized" } : {})
        })
      };
      harness.rerender(restrictedApi);
      await act(async () => {
        vi.advanceTimersByTime(500);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(harness.result.current?.commands).toEqual([]);
      expect(harness.result.current?.error).toBe(expectedError);
      harness.unmount();
    }
  );

  it("does not pass abort signal to discovery API", () => {
    vi.useFakeTimers();
    mockApi.discoverCommands.mockImplementation(
      () => new Promise(() => undefined)
    );
    const harness = renderDiscoveryHook(mockApi);
    const firstInput = mockApi.discoverCommands.mock.calls[0]?.[0];

    expect(firstInput).toEqual({
      aiClientDriverId: "codex",
      aiClientInstanceId: "test-instance",
      projectId: "test-project",
      cwd: "/home/test"
    });

    harness.unmount();
  });

  it("invalidates cached commands after unauthorized response", async () => {
    vi.useFakeTimers();
    const harness = renderDiscoveryHook(mockApi);
    await settle();

    const unauthorizedApi = {
      discoverCommands: vi.fn().mockResolvedValue({
        status: "unauthorized",
        message: "Not authorized"
      })
    };
    harness.rerender(unauthorizedApi);
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });

    const unavailableApi = {
      discoverCommands: vi.fn().mockResolvedValue({
        status: "unavailable",
        commands: []
      })
    };
    harness.rerender(unavailableApi);
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.result.current?.commands).toEqual([]);
    harness.unmount();
  });

  it("schedules trailing fetch instead of dropping a request", async () => {
    vi.useFakeTimers();
    const harness = renderDiscoveryHook(mockApi);
    await settle();

    harness.rerender(mockApi, "/home/other");
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(mockApi.discoverCommands).toHaveBeenCalledTimes(2);
    harness.unmount();
  });

  it("isolates cached commands by scope", async () => {
    const harness = renderDiscoveryHook(mockApi);
    await settle();

    const secondCommand = { ...command, name: "/second" };
    mockApi.discoverCommands.mockResolvedValueOnce({
      status: "ok",
      commands: [secondCommand]
    });
    harness.unmount();

    const second = renderDiscoveryHook(mockApi, "codex", "other-instance");
    await settle();

    expect(second.result.current?.commands).toEqual([secondCommand]);
    expect(mockApi.discoverCommands).toHaveBeenCalledTimes(2);
    second.unmount();
  });

  it("ignores late results from a previous scope", async () => {
    let resolveFirst: (value: unknown) => void = () => undefined;
    const firstRequest = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    mockApi.discoverCommands
      .mockReturnValueOnce(firstRequest)
      .mockImplementation(() => new Promise(() => undefined));
    const harness = renderDiscoveryHook(mockApi);

    harness.rerender(mockApi, "/home/other");
    resolveFirst({ status: "ok", commands: [command] });
    await settle();

    expect(harness.result.current?.commands).toEqual([]);
    harness.unmount();
  });
});
