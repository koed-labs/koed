import { EventEmitter } from "node:events";
import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationConnectionEventSchema,
  collaborationRendererCommandSchema,
  collaborationSafeErrorMessages,
  type CollaborationRendererEvent
} from "@koed/shared";
import {
  DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
  desktopCollaborationBrokerParentMessageSchema,
  type DesktopCollaborationBrokerChildMessage,
  type DesktopCollaborationBrokerParentMessage
} from "@koed/koed-server";
import { describe, expect, it, vi } from "vitest";
import { createCollaborationLocalTransport } from "./local-transport.js";

const requestId = "768ae5ae-fcbe-4e17-9d83-14a97d5f92a6";

class FakeBrokerChild extends EventEmitter {
  killed = false;
  sent: DesktopCollaborationBrokerParentMessage[] = [];

  send(message: unknown): boolean {
    this.sent.push(
      desktopCollaborationBrokerParentMessageSchema.parse(message)
    );
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

const command = collaborationRendererCommandSchema.parse({
  contractVersion: COLLABORATION_CONTRACT_VERSION,
  requestId,
  command: "collaboration.load",
  input: {}
});

const context = (
  ownerId = "renderer-1",
  events: CollaborationRendererEvent[] = [],
  controller = new AbortController()
) => ({
  ownerId,
  signal: controller.signal,
  emitCollaborationEvent: (event: CollaborationRendererEvent) => {
    events.push(event);
  }
});

const ready = (
  sessionToken: string
): DesktopCollaborationBrokerChildMessage => ({
  protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
  contractVersion: COLLABORATION_CONTRACT_VERSION,
  sessionToken,
  type: "ready",
  brokerPid: 1234
});

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition was not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("Desktop collaboration broker transport", () => {
  it("forwards correlated commands over the inherited broker IPC channel", async () => {
    const child = new FakeBrokerChild();
    const transport = createCollaborationLocalTransport({
      openExternal: vi.fn(async () => undefined),
      spawnBroker: (sessionToken) => {
        queueMicrotask(() => {
          child.emit("message", ready(sessionToken));
        });
        return child as never;
      }
    });

    const pending = transport.request(command, context());
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
        requestId: command.requestId,
        command: command.command,
        ok: false,
        error: {
          code: "not_available",
          userMessage: collaborationSafeErrorMessages.not_available,
          retryable: false,
          retryAfterMs: null
        }
      }
    });

    await expect(pending).resolves.toMatchObject({
      requestId,
      command: "collaboration.load",
      ok: false,
      error: { code: "not_available" }
    });
    expect(sent.type).toBe("command");
    expect(sent.command).toEqual(command);
    expect(JSON.stringify(sent)).not.toContain("desktop-local-secret-sentinel");
  });

  it("releases owner state when the renderer lifecycle aborts", async () => {
    const child = new FakeBrokerChild();
    const controller = new AbortController();
    const transport = createCollaborationLocalTransport({
      openExternal: vi.fn(async () => undefined),
      spawnBroker: (sessionToken) => {
        queueMicrotask(() => {
          child.emit("message", ready(sessionToken));
        });
        return child as never;
      }
    });

    const pending = transport.request(
      command,
      context("renderer-7", [], controller)
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
        requestId: command.requestId,
        command: command.command,
        ok: true,
        data: {
          snapshot: {
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            snapshotRevision: "snapshot.personal-0001",
            generatedAt: "2026-07-17T08:30:00.000Z",
            connection: {
              state: "disconnected",
              backendId: null,
              connectedAt: null,
              retryAt: null,
              reconnectAttempt: 0,
              protocolVersion: COLLABORATION_CONTRACT_VERSION
            },
            limits: {
              nameMaxNormalizedCodePoints: 80,
              displayNameMaxNormalizedCodePoints: 128,
              topicDescriptionMaxUtf8Bytes: 1024,
              messageMaxUtf8Bytes: 32768,
              historyPageMaxItems: 100,
              rendererMaxPendingEvents: 500,
              rendererMaxPendingBytes: 5242880,
              rendererAcknowledgementDeadlineMs: 30000,
              messageBurstMaxCount: 20,
              messageBurstWindowMs: 10000,
              messageSustainedMaxCount: 60,
              messageSustainedWindowMs: 60000,
              teamMessageMaxPerMinute: 600,
              deploymentMessageMaxPerMinute: 6000,
              inviteCreationMaxPerHour: 10,
              channelCreationMaxPerHour: 20,
              connectionAttemptMaxPerMinute: 10,
              reconnectMaxAttempts: 10,
              reconnectWindowMs: 300000,
              reconnectBackoffCapMs: 30000,
              reconnectUnavailableCooldownMs: 60000,
              sendRetryMaxAttempts: 5,
              renderedRowMaxCount: 250,
              decryptBatchMaxItems: 100,
              splitViewBreakpointPx: 900,
              splitViewSourceMinPx: 360,
              splitViewDiscussionMinPx: 320
            },
            navigation: {
              personalOwner: {
                id: "00000000-0000-4000-8000-000000000001",
                displayName: "Mark",
                presence: "available",
                membershipState: "enabled"
              },
              teamPrincipal: null,
              personal: {
                memory: [],
                notesToSelf: {
                  id: "00000000-0000-4000-8000-000000000002",
                  logicalId: "00000000-0000-4000-8000-000000000003",
                  scope: "personal",
                  ownerUserId: "00000000-0000-4000-8000-000000000001",
                  kind: "notes_to_self",
                  name: null,
                  topic: null,
                  participants: [
                    {
                      id: "00000000-0000-4000-8000-000000000001",
                      displayName: "Mark",
                      membershipState: "enabled"
                    }
                  ],
                  version: 1,
                  lifecycle: "active",
                  canPost: true,
                  latestSequence: 0,
                  unreadCount: 0,
                  lastReadMessageId: null,
                  lastReadSequence: 0,
                  createdAt: "2026-07-17T08:30:00.000Z",
                  updatedAt: "2026-07-17T08:30:00.000Z",
                  lastActivityAt: "2026-07-17T08:30:00.000Z",
                  archivedAt: null
                },
                channels: []
              },
              teams: []
            },
            selection: { kind: "personal_memory" },
            view: { kind: "personal_memory", entries: [] }
          }
        }
      }
    });
    await pending;
    controller.abort();
    await Promise.resolve();

    expect(child.sent.at(-1)).toMatchObject({
      type: "release_owner",
      ownerId: "renderer-7"
    });
  });

  it("restarts after a command timeout and recovers on the next request", async () => {
    const children: FakeBrokerChild[] = [];
    const transport = createCollaborationLocalTransport({
      commandTimeoutMs: 10,
      openExternal: vi.fn(async () => undefined),
      spawnBroker: (sessionToken) => {
        const child = new FakeBrokerChild();
        children.push(child);
        queueMicrotask(() => {
          child.emit("message", ready(sessionToken));
        });
        return child as never;
      }
    });

    await expect(transport.request(command, context())).resolves.toMatchObject({
      ok: false,
      error: { code: "temporarily_unavailable" }
    });
    expect(children).toHaveLength(1);
    expect(children[0]?.killed).toBe(true);

    const next = transport.request(
      {
        ...command,
        requestId: "5a1f3c7c-72f2-49c1-9c83-d8e81e5c57ec"
      },
      context()
    );
    await waitFor(
      () => children.length === 2 && children[1]!.sent.length === 1
    );
    const secondChild = children[1]!;
    const sent = sentCommand(secondChild);
    secondChild.emit("message", {
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken: sent.sessionToken,
      type: "command_result",
      envelopeId: sent.envelopeId,
      ownerId: sent.ownerId,
      result: {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: sent.command.requestId,
        command: sent.command.command,
        ok: false,
        error: {
          code: "offline",
          userMessage: collaborationSafeErrorMessages.offline,
          retryable: true,
          retryAfterMs: null
        }
      }
    });
    await expect(next).resolves.toMatchObject({
      requestId: "5a1f3c7c-72f2-49c1-9c83-d8e81e5c57ec",
      ok: false,
      error: { code: "offline" }
    });
    expect(children).toHaveLength(2);
  });

  it("keeps the broker alive while an Action Grant long-poll is still within its wider timeout", async () => {
    const child = new FakeBrokerChild();
    const transport = createCollaborationLocalTransport({
      commandTimeoutMs: 10,
      longPollCommandTimeoutMs: 100,
      openExternal: vi.fn(async () => undefined),
      spawnBroker: (sessionToken) => {
        queueMicrotask(() => {
          child.emit("message", ready(sessionToken));
        });
        return child as never;
      }
    });
    const longPoll = collaborationRendererCommandSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: "5a1f3c7c-72f2-49c1-9c83-d8e81e5c57ec",
      command: "collaboration.await_action_grant",
      input: {
        actionGrant: { id: "00000000-0000-4000-8000-000000000008" }
      }
    });

    const pending = transport.request(longPoll, context());
    await waitFor(() => child.sent.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(child.killed).toBe(false);
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
        requestId: longPoll.requestId,
        command: longPoll.command,
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
      requestId: longPoll.requestId,
      command: "collaboration.await_action_grant",
      ok: false,
      error: { code: "temporarily_unavailable" }
    });
    expect(child.killed).toBe(false);
  });

  it("purges active owners when the broker emits a wrong-owner event", async () => {
    const child = new FakeBrokerChild();
    const events: CollaborationRendererEvent[] = [];
    const transport = createCollaborationLocalTransport({
      openExternal: vi.fn(async () => undefined),
      spawnBroker: (sessionToken) => {
        queueMicrotask(() => {
          child.emit("message", ready(sessionToken));
        });
        return child as never;
      }
    });

    const pending = transport.request(command, context("renderer-1", events));
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
        requestId: sent.command.requestId,
        command: sent.command.command,
        ok: false,
        error: {
          code: "offline",
          userMessage: collaborationSafeErrorMessages.offline,
          retryable: true,
          retryAfterMs: null
        }
      }
    });
    await pending;

    child.emit("message", {
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken: sent.sessionToken,
      type: "renderer_event",
      ownerId: "renderer-2",
      event: collaborationConnectionEventSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        type: "connection",
        connection: {
          state: "disconnected",
          backendId: null,
          connectedAt: null,
          retryAt: null,
          reconnectAttempt: 0,
          protocolVersion: COLLABORATION_CONTRACT_VERSION
        },
        error: null
      })
    });

    expect(events.at(-1)).toMatchObject({
      type: "connection",
      connection: { state: "disconnected", backendId: null }
    });
    expect(child.killed).toBe(true);
  });

  it("forwards broker browser-open requests without leaking them into renderer events", async () => {
    const child = new FakeBrokerChild();
    const openExternal = vi.fn(async () => undefined);
    const events: CollaborationRendererEvent[] = [];
    void createCollaborationLocalTransport({
      openExternal,
      spawnBroker: (sessionToken) => {
        queueMicrotask(() => {
          child.emit("message", ready(sessionToken));
          child.emit("message", {
            protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            sessionToken,
            type: "open_external",
            envelopeId: "58ffde92-7980-4a48-b29a-d9bd85a22f3f",
            ownerId: "renderer-1",
            url: "https://team.example.test/device-enrollment/challenge-1"
          });
        });
        return child as never;
      }
    }).request(command, context("renderer-1", events));

    await Promise.resolve();
    await Promise.resolve();
    expect(openExternal).toHaveBeenCalledWith(
      "https://team.example.test/device-enrollment/challenge-1"
    );
    expect(events).toEqual([]);
  });
});
