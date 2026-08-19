import { EventEmitter } from "node:events";
import {
  COLLABORATION_CONTRACT_VERSION,
  PERSONAL_DESKTOP_CONTRACT_VERSION,
  collaborationSafeErrorMessages,
  personalDesktopResultSchema
} from "@koed/shared";
import type { PersonalMemoryDesktopHandler } from "../koed-server/manager.js";
import { describe, expect, it, vi } from "vitest";
import { invokeChannel, registerDesktopCommandHandlers } from "./commands.js";
import {
  clipboardWriteChannel,
  collaborationCommandChannel,
  isDesktopCommandName,
  managedConversationCommandChannel,
  personalDevicePairingLinkConsumeChannel,
  personalDevicePairingProgressChannel,
  personalMemoryCommandChannel,
  setupCommandChannel,
  setupProgressEventChannel,
  themePreferenceGetChannel,
  themePreferenceSetChannel
} from "./protocol.js";

const requestId = "768ae5ae-fcbe-4e17-9d83-14a97d5f92a6";
const pairingLink =
  "http://192.168.1.20:3310/pair/11111111-2222-4333-8444-555555555555#token=abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";

const renderer = (url = "koed://app/") => {
  const sender = new EventEmitter() as EventEmitter & {
    id: number;
    mainFrame: { url: string };
    isDestroyed: () => boolean;
    send: ReturnType<typeof vi.fn>;
  };
  sender.id = 7;
  sender.mainFrame = { url };
  sender.isDestroyed = () => false;
  sender.send = vi.fn();
  return { sender, senderFrame: sender.mainFrame };
};

describe("desktop IPC command registry", () => {
  const register = () => {
    const registered = new Map<string, (...args: any[]) => Promise<unknown>>();
    const collaboration = vi.fn(
      (
        ...invocation: [
          args?: Record<string, unknown>,
          context?: { signal: AbortSignal }
        ]
      ) => {
        void invocation;
        return {
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId,
          command: "collaboration.load",
          ok: false,
          error: {
            code: "offline",
            userMessage: collaborationSafeErrorMessages.offline,
            retryable: true,
            retryAfterMs: null
          }
        };
      }
    );
    const personalMemoryImplementation: PersonalMemoryDesktopHandler = async (
      request
    ) =>
      personalDesktopResultSchema.parse({
        contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
        operation: request.operation,
        ok: true,
        data:
          request.operation === "personal.projects.list"
            ? { projects: [] }
            : request.operation === "personal.events.load_page"
              ? { events: [] }
              : { projectId: null }
      });
    const personalMemory = vi.fn(personalMemoryImplementation);
    const managedConversation = vi.fn(async (request: any) => {
      if (request.operation === "start") {
        return {
          operation: "start" as const,
          status: "ready" as const,
          executionId: "execution-1",
          conversation: {
            executionId: "execution-1",
            projectId: request.projectId,
            capturedSessionId: "captured-1",
            threadId: "thread-1"
          }
        };
      }
      throw new Error("Unexpected Managed Conversation request.");
    });
    const setupInspect = vi.fn(async () => ({ state: "ready" }));
    const setupRun = vi.fn(async (_args, context) => {
      context.emitSetupProgress({ state: "running" });
      return { state: "complete" };
    });
    const writeClipboard = vi.fn();
    const consumePendingPersonalDevicePairingLink = vi
      .fn()
      .mockReturnValue(pairingLink);
    let themePreference: "light" | "dark" | "system" = "system";
    const getThemePreference = vi.fn(() => themePreference);
    const setThemePreference = vi.fn(
      (preference: "light" | "dark" | "system") => {
        themePreference = preference;
        return { preference, resolvedDark: preference === "dark" };
      }
    );
    const mutatingHandlers = Object.fromEntries(
      [
        "setup_codex",
        "repair_codex",
        "remove_codex",
        "setup_pi",
        "repair_pi",
        "remove_pi",
        "setup_claude",
        "repair_claude",
        "remove_claude"
      ].map((command) => [command, vi.fn(async () => ({ ok: true }))])
    );
    const checkHandlers = Object.fromEntries(
      ["check_codex", "check_pi", "check_claude"].map((command) => [
        command,
        vi.fn(async () => ({ ok: true }))
      ])
    );
    registerDesktopCommandHandlers(
      {
        handle: (channel, handler) => {
          registered.set(
            channel,
            handler as (...args: any[]) => Promise<unknown>
          );
        }
      },
      {
        status: (
          args?: Record<string, unknown>,
          context?: {
            emitPersonalDevicePairingProgress: (value: unknown) => void;
          }
        ) => {
          if (args?.emitPairing) {
            context?.emitPersonalDevicePairingProgress({
              contractVersion: 1,
              requestId: "11111111-2222-4333-8444-555555555555",
              state: "approval_pending",
              shortCode: "A1B2C3D4"
            });
          }
          return {
            ok: true,
            value: args?.value
          };
        },
        collaboration,
        setup_inspect: setupInspect,
        setup_run: setupRun,
        ...mutatingHandlers,
        ...checkHandlers
      } as never,
      {
        allowedRendererOrigins: new Set(["koed://app"]),
        personalMemory,
        managedConversation: managedConversation as never,
        consumePendingPersonalDevicePairingLink,
        writeClipboard,
        getThemePreference,
        setThemePreference
      }
    );
    return {
      registered,
      collaboration,
      managedConversation,
      personalMemory,
      setupInspect,
      setupRun,
      consumePendingPersonalDevicePairingLink,
      writeClipboard,
      getThemePreference,
      setThemePreference,
      mutatingHandlers,
      checkHandlers
    };
  };

  it("consumes retained pairing links only for the trusted main frame", async () => {
    const { registered, consumePendingPersonalDevicePairingLink } = register();
    const invoke = registered.get(personalDevicePairingLinkConsumeChannel)!;

    await expect(invoke(renderer(), pairingLink)).resolves.toBe(pairingLink);
    expect(consumePendingPersonalDevicePairingLink).toHaveBeenCalledWith(
      pairingLink
    );
    await expect(
      invoke(renderer("https://attacker.example/"), pairingLink)
    ).rejects.toThrow("Untrusted Desktop IPC sender");
    await expect(invoke(renderer(), { url: "expected-link" })).rejects.toThrow(
      "Invalid pending pairing link acknowledgement"
    );
  });

  it("isolates setup behind its trusted channel and forwards progress", async () => {
    const { registered, setupInspect, setupRun } = register();
    const invoke = registered.get(setupCommandChannel)!;
    const event = renderer();

    await expect(invoke(event, "inspect")).resolves.toEqual({
      state: "ready"
    });
    expect(setupInspect).toHaveBeenCalledOnce();

    await expect(invoke(event, "run")).resolves.toEqual({
      state: "complete"
    });
    expect(setupRun).toHaveBeenCalledWith(
      { operatorConsented: true },
      expect.objectContaining({ ownerId: "7" })
    );
    expect(event.sender.send).toHaveBeenCalledWith(setupProgressEventChannel, {
      state: "running"
    });
    await expect(
      invoke(renderer("https://attacker.example/"), "run")
    ).rejects.toThrow("Untrusted Desktop IPC sender");
    await expect(invoke(renderer(), "invalid")).rejects.toThrow(
      "Unsupported Desktop setup operation"
    );
  });

  it("allows only known legacy commands from the trusted main frame", async () => {
    const { registered } = register();
    const invoke = registered.get(invokeChannel)!;
    const event = renderer();
    await expect(invoke(event, "status", { value: 42 })).resolves.toEqual({
      ok: true,
      value: 42
    });
    await expect(invoke(event, "missing", {})).rejects.toThrow(
      "Unsupported Desktop command"
    );
    expect(isDesktopCommandName("team_read")).toBe(false);
    expect(isDesktopCommandName("explorer_credential")).toBe(false);
    await expect(invoke(event, "team_read", {})).rejects.toThrow(
      "Unsupported Desktop command"
    );
    await expect(invoke(event, "collaboration", {})).rejects.toThrow(
      "strict collaboration command channel"
    );
  });

  it("rejects every mutating AI Client command without explicit consent", async () => {
    const { registered, mutatingHandlers, checkHandlers } = register();
    const invoke = registered.get(invokeChannel)!;
    const mutationCommands = Object.keys(mutatingHandlers);
    for (const command of mutationCommands) {
      await expect(invoke(renderer(), command, undefined)).rejects.toThrow(
        "Operator consent is required"
      );
      await expect(
        invoke(renderer(), command, { operatorConsented: false })
      ).rejects.toThrow("Operator consent is required");
      expect(mutatingHandlers[command]).not.toHaveBeenCalled();
    }
    for (const command of Object.keys(checkHandlers)) {
      await expect(invoke(renderer(), command)).resolves.toEqual({ ok: true });
      expect(checkHandlers[command]).toHaveBeenCalledOnce();
    }
  });

  it("correlates validated pairing progress to the invoking renderer", async () => {
    const { registered } = register();
    const invoke = registered.get(invokeChannel)!;
    const event = renderer();

    await expect(
      invoke(event, "status", { emitPairing: true })
    ).resolves.toMatchObject({ ok: true });
    expect(event.sender.send).toHaveBeenCalledWith(
      personalDevicePairingProgressChannel,
      {
        contractVersion: 1,
        requestId: "11111111-2222-4333-8444-555555555555",
        state: "approval_pending",
        shortCode: "A1B2C3D4"
      }
    );
  });

  it("validates exact Personal Memory requests and results", async () => {
    const { registered, personalMemory } = register();
    const invoke = registered.get(personalMemoryCommandChannel)!;
    const request = {
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      operation: "personal.projects.list",
      input: {}
    };
    await expect(invoke(renderer(), request)).resolves.toMatchObject({
      operation: "personal.projects.list",
      ok: true,
      data: { projects: [] }
    });
    expect(personalMemory).toHaveBeenCalledWith(request);
    await expect(
      invoke(renderer(), {
        ...request,
        input: { authorization: "Bearer raw-token" }
      })
    ).rejects.toThrow();
    await expect(
      invoke(renderer("https://attacker.example/"), request)
    ).rejects.toThrow("Untrusted Desktop IPC sender");
  });

  it("validates Managed Conversation IPC without exposing execution authority", async () => {
    const { registered, managedConversation } = register();
    const invoke = registered.get(managedConversationCommandChannel)!;
    await expect(
      invoke(renderer(), {
        operation: "start",
        projectId: "project-1",
        aiClientDriverId: "codex",
        aiClientInstanceId: "codex.default",
        idempotencyKey: "start-1"
      })
    ).resolves.toEqual({
      operation: "start",
      status: "ready",
      executionId: "execution-1",
      conversation: {
        executionId: "execution-1",
        projectId: "project-1",
        capturedSessionId: "captured-1",
        threadId: "thread-1"
      }
    });
    expect(managedConversation).toHaveBeenCalledWith({
      operation: "start",
      projectId: "project-1",
      aiClientDriverId: "codex",
      aiClientInstanceId: "codex.default",
      idempotencyKey: "start-1"
    });
    await expect(
      invoke(renderer(), {
        operation: "start",
        projectId: "project-1",
        aiClientDriverId: "codex",
        aiClientInstanceId: "codex.default",
        idempotencyKey: "start-1",
        cwd: "/private/project"
      })
    ).rejects.toThrow("unexpected fields");
    await expect(
      invoke(renderer("https://attacker.example/"), {
        operation: "start",
        projectId: "project-1",
        aiClientDriverId: "codex",
        aiClientInstanceId: "codex.default",
        idempotencyKey: "start-1"
      })
    ).rejects.toThrow("Untrusted Desktop IPC sender");
    managedConversation.mockRejectedValueOnce(
      new Error("failed at /private/managed/codex-home")
    );
    const failedStart = invoke(renderer(), {
      operation: "start",
      projectId: "project-1",
      aiClientDriverId: "codex",
      aiClientInstanceId: "codex.default",
      idempotencyKey: "start-1"
    });
    await expect(failedStart).rejects.toThrow("Koed could not start");
    await expect(failedStart).rejects.not.toThrow("/private/managed");
  });

  it("writes bounded text to the native clipboard for trusted renderers", async () => {
    const { registered, writeClipboard } = register();
    const invoke = registered.get(clipboardWriteChannel)!;
    await expect(
      invoke(renderer(), "invitation link")
    ).resolves.toBeUndefined();
    expect(writeClipboard).toHaveBeenCalledWith("invitation link");
    await expect(
      invoke(renderer("https://attacker.example/"), "stolen")
    ).rejects.toThrow("Untrusted Desktop IPC sender");
    await expect(invoke(renderer(), { value: "not text" })).rejects.toThrow(
      "Invalid Desktop clipboard value"
    );
    await expect(invoke(renderer(), "x".repeat(32_769))).rejects.toThrow(
      "Invalid Desktop clipboard value"
    );
  });

  it("gets and sets only a bounded theme preference for trusted renderers", async () => {
    const { registered, getThemePreference, setThemePreference } = register();
    const get = registered.get(themePreferenceGetChannel)!;
    const set = registered.get(themePreferenceSetChannel)!;
    await expect(get(renderer())).resolves.toBe("system");
    await expect(set(renderer(), "dark")).resolves.toEqual({
      preference: "dark",
      resolvedDark: true
    });
    expect(getThemePreference).toHaveBeenCalledOnce();
    expect(setThemePreference).toHaveBeenCalledWith("dark");
    await expect(set(renderer(), "midnight")).rejects.toThrow(
      "Invalid Desktop theme preference"
    );
    await expect(
      set(renderer("https://attacker.example/"), "light")
    ).rejects.toThrow("Untrusted Desktop IPC sender");
  });

  it("rejects untrusted, missing, malformed, and non-main-frame senders", async () => {
    const { registered } = register();
    const invoke = registered.get(invokeChannel)!;
    await expect(
      invoke(renderer("https://attacker.example/"), "status", {})
    ).rejects.toThrow("Untrusted Desktop IPC sender");
    await expect(
      invoke({ sender: renderer().sender, senderFrame: null }, "status", {})
    ).rejects.toThrow("Untrusted Desktop IPC sender");
    await expect(invoke(renderer("not a url"), "status", {})).rejects.toThrow(
      "Untrusted Desktop IPC sender"
    );
    const childFrame = renderer();
    await expect(
      invoke(
        { ...childFrame, senderFrame: { url: "koed://app/child" } },
        "status",
        {}
      )
    ).rejects.toThrow("Untrusted Desktop IPC sender");
  });

  it("validates collaboration commands and correlated results", async () => {
    const { registered, collaboration } = register();
    const invoke = registered.get(collaborationCommandChannel)!;
    const event = renderer();
    const command = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId,
      command: "collaboration.load",
      input: {}
    };

    await expect(invoke(event, command)).resolves.toMatchObject({
      requestId,
      command: "collaboration.load",
      ok: false
    });
    expect(collaboration).toHaveBeenCalledOnce();
    await expect(
      invoke(event, { ...command, unexpected: true })
    ).rejects.toThrow();

    collaboration.mockReturnValueOnce({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: "5a1f3c7c-72f2-49c1-9c83-d8e81e5c57ec",
      command: "collaboration.load",
      ok: false,
      error: {
        code: "offline",
        userMessage: collaborationSafeErrorMessages.offline,
        retryable: true,
        retryAfterMs: null
      }
    } as never);
    await expect(invoke(event, command)).rejects.toThrow(
      "Invalid collaboration command correlation"
    );
  });

  it("aborts the sender-scoped collaboration context on teardown", async () => {
    const { registered, collaboration } = register();
    const invoke = registered.get(collaborationCommandChannel)!;
    const event = renderer();
    await invoke(event, {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId,
      command: "collaboration.load",
      input: {}
    });
    const context = collaboration.mock.calls[0]?.[1] as {
      signal: AbortSignal;
    };
    expect(context.signal.aborted).toBe(false);
    event.sender.emit("destroyed");
    expect(context.signal.aborted).toBe(true);
  });
});
