import { describe, expect, it, vi } from "vitest";
import {
  captureMessageEvent,
  captureToolEvent,
  ensureBackendSession,
  type CaptureRuntimeState
} from "./capture.js";
import type { KoedApiClient } from "./koed-client.js";

describe("Pi capture flow", () => {
  it("creates a Pi backend session once and captures message events as Pi API writes", async () => {
    const createSession = vi.fn(async () => ({ session: { id: "session-1" } }));
    const capturePersonalEvent = vi.fn(async () => ({}));
    const client = {
      createSession,
      capturePersonalEvent
    } as unknown as KoedApiClient;
    const runtimeState: CaptureRuntimeState = {
      externalSessionId: "ext-1",
      backendSessionRegistered: false
    };

    await ensureBackendSession(client, runtimeState, {
      cwd: "/repo/koed",
      model: { provider: "openai", id: "gpt-5.4-mini" }
    });
    await captureMessageEvent(
      client,
      runtimeState,
      {
        actor: "user",
        eventType: "pi_user_message",
        content: "Remember this Pi fact"
      },
      {
        cwd: "/repo/koed",
        model: { provider: "openai", id: "gpt-5.4-mini" }
      }
    );

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        externalSessionId: "ext-1",
        sourceRuntime: "pi",
        captureMethod: "api",
        cwd: "/repo/koed",
        model: "openai/gpt-5.4-mini"
      }),
      undefined
    );
    expect(runtimeState.backendSessionId).toBe("session-1");
    expect(capturePersonalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "/repo/koed",
        sessionId: "session-1",
        actor: "user",
        eventType: "pi_user_message",
        sourceRuntime: "pi",
        captureMethod: "api",
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        metadata: expect.objectContaining({
          externalSessionId: "ext-1",
          automaticCaptureScope: "personal"
        })
      }),
      undefined
    );
  });

  it("skips Koed memory tools but captures other tool results as Pi API writes", async () => {
    const createSession = vi.fn(async () => ({ session: { id: "session-2" } }));
    const capturePersonalEvent = vi.fn(async () => ({}));
    const client = {
      createSession,
      capturePersonalEvent
    } as unknown as KoedApiClient;
    const runtimeState: CaptureRuntimeState = {
      externalSessionId: "ext-2",
      backendSessionRegistered: false
    };

    await captureToolEvent(
      client,
      runtimeState,
      {
        toolName: "memory_answer",
        content: "should be skipped",
        isError: false
      },
      { cwd: "/repo/koed" }
    );
    await captureToolEvent(
      client,
      runtimeState,
      {
        toolName: "bash",
        content: "tool output",
        isError: true
      },
      { cwd: "/repo/koed" }
    );

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(capturePersonalEvent).toHaveBeenCalledTimes(1);
    expect(capturePersonalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "tool",
        eventType: "pi_tool_result",
        sourceRuntime: "pi",
        captureMethod: "api",
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        metadata: expect.objectContaining({
          toolName: "bash",
          isError: true,
          externalSessionId: "ext-2"
        })
      }),
      undefined
    );
  });
});
