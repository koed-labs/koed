import { EventEmitter } from "node:events";
import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationSafeErrorMessages,
  type CollaborationRendererEvent
} from "@koed/shared";
import {
  DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
  type DesktopCollaborationBrokerParentMessage
} from "@koed/koed-server";
import { describe, expect, it, vi } from "vitest";
import { createKoedServerManager } from "./manager.js";

const requestId = "768ae5ae-fcbe-4e17-9d83-14a97d5f92a6";

class FakeBrokerChild extends EventEmitter {
  killed = false;
  sent: DesktopCollaborationBrokerParentMessage[] = [];

  send(message: unknown): boolean {
    this.sent.push(message as DesktopCollaborationBrokerParentMessage);
    return true;
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit", 0);
    return true;
  }
}

const sentCommand = (
  child: FakeBrokerChild,
  index = 0
): Extract<DesktopCollaborationBrokerParentMessage, { type: "command" }> => {
  const message = child.sent[index];
  if (!message || message.type !== "command") {
    throw new Error("Expected a broker command frame.");
  }
  return message;
};

const collaborationContext = (events: CollaborationRendererEvent[] = []) => ({
  ownerId: "renderer-1",
  signal: new AbortController().signal,
  emitCollaborationEvent: (event: CollaborationRendererEvent) => {
    events.push(event);
  }
});

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition was not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("Koed server desktop manager collaboration broker", () => {
  it("spawns one broker child and forwards collaboration commands over inherited IPC", async () => {
    const execFile = vi.fn();
    const spawnCalls: Array<{
      command: string;
      args: string[];
      options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        stdio: ["ignore", "ignore", "ignore", "ipc"];
        detached: false;
      };
    }> = [];
    const child = new FakeBrokerChild();
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: { KOED_HOME: "/tmp/koed" },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_HOME: "/tmp/koed" }
      }),
      existsSync: () => true,
      execFile: execFile as never,
      spawn: ((
        command: string,
        args: string[],
        options: {
          cwd: string;
          env: NodeJS.ProcessEnv;
          stdio: ["ignore", "ignore", "ignore", "ipc"];
          detached: false;
        }
      ) => {
        spawnCalls.push({ command, args, options });
        queueMicrotask(() => {
          child.emit("message", {
            protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            sessionToken:
              options.env.KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN,
            type: "ready",
            brokerPid: 4242
          });
        });
        return child as never;
      }) as never,
      openExternal: async () => undefined
    });
    expect(manager.handlers).not.toHaveProperty("team_read");

    const pending = manager.handlers.collaboration!(
      {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId,
        command: "collaboration.load",
        input: {}
      },
      collaborationContext()
    );
    await waitFor(() => child.sent.length === 1);
    const sent = sentCommand(child);
    child.emit("message", {
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken: sent.sessionToken,
      type: "command_result",
      envelopeId: sent.envelopeId,
      ownerId: sent.ownerId,
      result: {
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
      }
    });

    await expect(pending).resolves.toMatchObject({
      requestId,
      command: "collaboration.load",
      ok: false,
      error: { code: "offline" }
    });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({
      command: "/node",
      args: ["/repo/cli.js", "desktop", "collaboration-broker"],
      options: {
        cwd: "/repo",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        detached: false
      }
    });
    expect(
      spawnCalls[0]?.options.env.KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN
    ).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(execFile).not.toHaveBeenCalled();
    expect(JSON.stringify(sent)).not.toContain("Koed-Desktop");
  });

  it("purges active owners and respawns the broker after an unexpected child exit", async () => {
    const children: FakeBrokerChild[] = [];
    const spawn = vi.fn((command, args, options) => {
      const child = new FakeBrokerChild();
      children.push(child);
      queueMicrotask(() => {
        child.emit("message", {
          protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          sessionToken:
            options.env.KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN,
          type: "ready",
          brokerPid: children.length
        });
      });
      return child as never;
    });
    const events: CollaborationRendererEvent[] = [];
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: { KOED_HOME: "/tmp/koed" },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_HOME: "/tmp/koed" }
      }),
      existsSync: () => true,
      execFile: vi.fn() as never,
      spawn: spawn as never,
      openExternal: async () => undefined
    });

    const first = manager.handlers.collaboration!(
      {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId,
        command: "collaboration.load",
        input: {}
      },
      collaborationContext(events)
    );
    await waitFor(() => children[0]!.sent.length === 1);
    const firstSent = sentCommand(children[0]!);
    children[0]!.emit("message", {
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken: firstSent.sessionToken,
      type: "command_result",
      envelopeId: firstSent.envelopeId,
      ownerId: firstSent.ownerId,
      result: {
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
      }
    });
    await first;

    children[0]!.emit("exit", 1);
    expect(events.at(-1)).toMatchObject({
      type: "connection",
      connection: { state: "disconnected", backendId: null }
    });

    const second = manager.handlers.collaboration!(
      {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "5a1f3c7c-72f2-49c1-9c83-d8e81e5c57ec",
        command: "collaboration.load",
        input: {}
      },
      collaborationContext(events)
    );
    await waitFor(
      () => children.length === 2 && children[1]!.sent.length === 1
    );
    const secondSent = sentCommand(children[1]!);
    children[1]!.emit("message", {
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken: secondSent.sessionToken,
      type: "command_result",
      envelopeId: secondSent.envelopeId,
      ownerId: secondSent.ownerId,
      result: {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "5a1f3c7c-72f2-49c1-9c83-d8e81e5c57ec",
        command: "collaboration.load",
        ok: false,
        error: {
          code: "not_available",
          userMessage: collaborationSafeErrorMessages.not_available,
          retryable: false,
          retryAfterMs: null
        }
      }
    });

    await expect(second).resolves.toMatchObject({
      requestId: "5a1f3c7c-72f2-49c1-9c83-d8e81e5c57ec",
      ok: false,
      error: { code: "not_available" }
    });
    expect(children).toHaveLength(2);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("forwards collaboration lifecycle commands to the broker without local exec or fetch handling", async () => {
    const child = new FakeBrokerChild();
    const execFile = vi.fn();
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: { KOED_HOME: "/tmp/koed" },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_HOME: "/tmp/koed" }
      }),
      existsSync: () => true,
      execFile: execFile as never,
      spawn: ((
        command: string,
        args: string[],
        options: {
          cwd: string;
          env: NodeJS.ProcessEnv;
          stdio: ["ignore", "ignore", "ignore", "ipc"];
          detached: false;
        }
      ) => {
        queueMicrotask(() => {
          child.emit("message", {
            protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            sessionToken:
              options.env.KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN,
            type: "ready",
            brokerPid: 12
          });
        });
        return child as never;
      }) as never,
      openExternal: async () => undefined
    });

    const pending = manager.handlers.collaboration!(
      {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "58ffde92-7980-4a48-b29a-d9bd85a22f3f",
        command: "collaboration.connect_backend",
        input: { remoteUrl: "https://team.example.test" }
      },
      collaborationContext()
    );
    await waitFor(() => child.sent.length === 1);
    const sent = sentCommand(child);
    child.emit("message", {
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken: sent.sessionToken,
      type: "command_result",
      envelopeId: sent.envelopeId,
      ownerId: sent.ownerId,
      result: {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "58ffde92-7980-4a48-b29a-d9bd85a22f3f",
        command: "collaboration.connect_backend",
        ok: false,
        error: {
          code: "temporarily_unavailable",
          userMessage: collaborationSafeErrorMessages.temporarily_unavailable,
          retryable: true,
          retryAfterMs: null
        }
      }
    });

    await expect(pending).resolves.toMatchObject({
      command: "collaboration.connect_backend",
      ok: false,
      error: { code: "temporarily_unavailable" }
    });
    expect(sent.command).toMatchObject({
      command: "collaboration.connect_backend",
      input: { remoteUrl: "https://team.example.test" }
    });
    expect(execFile).not.toHaveBeenCalled();
  });
});
