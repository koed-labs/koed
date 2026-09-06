import { describe, expect, it, vi } from "vitest";

import { createManagedWorkspacePreloadApi } from "./managed-workspace-preload.js";
import {
  managedWorkspaceCommandChannel,
  managedWorkspaceEventChannel
} from "./managed-workspace-protocol.js";

const executionId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";

describe("managed workspace preload bridge", () => {
  it("validates exact requests, results, and correlation", async () => {
    const invoke = vi.fn(async () => ({
      requestId,
      executionId,
      operation: "terminal_list",
      terminals: []
    }));
    const events = {
      on: vi.fn(),
      removeListener: vi.fn()
    };
    const api = createManagedWorkspacePreloadApi(invoke, events);
    const request = {
      requestId,
      executionId,
      operation: "terminal_list" as const
    };

    await expect(api.command(request)).resolves.toEqual({
      ...request,
      terminals: []
    });
    expect(invoke).toHaveBeenCalledWith(
      managedWorkspaceCommandChannel,
      request
    );
    await expect(
      api.command({ ...request, authorization: "Bearer secret" } as never)
    ).rejects.toThrow();

    invoke.mockResolvedValueOnce({
      ...request,
      requestId: "33333333-3333-4333-8333-333333333333",
      terminals: []
    });
    await expect(api.command(request)).rejects.toThrow(
      "Invalid managed workspace command correlation"
    );
  });

  it("validates terminal events and removes only its own listener", () => {
    let registered: ((...args: unknown[]) => void) | undefined;
    const events = {
      on: vi.fn((_channel: string, listener: (...args: unknown[]) => void) => {
        registered = listener;
      }),
      removeListener: vi.fn()
    };
    const api = createManagedWorkspacePreloadApi(vi.fn(), events);
    const listener = vi.fn();
    const unsubscribe = api.subscribe(listener);
    const value = {
      kind: "terminal" as const,
      connectionId: "44444444-4444-4444-8444-444444444444",
      frame: {
        protocolVersion: 1,
        terminalId: "55555555-5555-4555-8555-555555555555",
        lifecycleGeneration: 1,
        type: "terminal.exit",
        exitCode: 0,
        exitSignal: null,
        failureCode: null
      }
    };

    registered?.({}, value);
    expect(listener).toHaveBeenCalledWith(value);
    expect(events.on).toHaveBeenCalledWith(
      managedWorkspaceEventChannel,
      expect.any(Function)
    );
    unsubscribe();
    registered?.({}, value);
    expect(listener).toHaveBeenCalledOnce();
    expect(events.removeListener).toHaveBeenCalledWith(
      managedWorkspaceEventChannel,
      registered
    );
  });

  it("validates preview lifecycle events without accepting navigation data", () => {
    let registered: ((...args: unknown[]) => void) | undefined;
    const events = {
      on: vi.fn((_channel: string, listener: (...args: unknown[]) => void) => {
        registered = listener;
      }),
      removeListener: vi.fn()
    };
    const api = createManagedWorkspacePreloadApi(vi.fn(), events);
    const listener = vi.fn();
    api.subscribe(listener);
    const event = {
      kind: "preview" as const,
      surfaceId: "44444444-4444-4444-8444-444444444444",
      previewId: "55555555-5555-4555-8555-555555555555",
      lifecycleGeneration: 1,
      state: "ready" as const
    };

    registered?.({}, event);
    expect(listener).toHaveBeenCalledWith(event);
    expect(() =>
      registered?.(
        {},
        {
          ...event,
          navigationUrl: "http://127.0.0.1:5173/"
        }
      )
    ).toThrow();
  });
});
