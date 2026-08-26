import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  COLLABORATION_CONTRACT_VERSION,
  COLLABORATION_DEFAULT_LIMITS,
  collaborationRendererCommandSchema,
  collaborationSafeErrorMessages,
  collaborationSnapshotSchema,
  listCollaborationPendingSends,
  readCollaborationActionGrantCustodyStatus,
  readLocalEdgeClientCredentialAuthorization,
  readUpstreamCredentialAuthorization,
  storeCollaborationActionGrantCustody,
  storeCollaborationPendingSend,
  storeDesktopLocalCredential,
  storeLocalEdgeClientCredential,
  storeUpstreamCredentialSecret,
  updateCollaborationPendingSendState
} from "@koed/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
  type DesktopCollaborationBrokerChildMessage
} from "./desktop-collaboration-broker-contract.js";
import { createDesktopCollaborationBroker } from "./desktop-collaboration-broker.js";
import { resolveKoedServerPaths } from "./paths.js";
import { listUpstreamDisconnectCleanupRecords } from "./upstream-disconnect-cleanup.js";
import {
  linkProjectTeamWorkspace,
  listProjectTeamWorkspaceLinks
} from "./project-team-workspace-links.js";
import {
  getActiveUpstreamBackend,
  refreshUpstreamBackendCapabilities,
  registerUpstreamBackend,
  setActiveUpstreamBackend,
  updateUpstreamBackendCredential,
  updateUpstreamBackendRoutePolicy
} from "./upstream-registry.js";

const temps: string[] = [];
const tempRoot = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-desktop-broker-"));
  temps.push(root);
  return root;
};

const sessionToken = "broker_session_token_0123456789abcdef";

const snapshot = collaborationSnapshotSchema.parse({
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
  limits: COLLABORATION_DEFAULT_LIMITS,
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
      channels: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          logicalId: "00000000-0000-4000-8000-000000000003",
          scope: "personal",
          ownerUserId: "00000000-0000-4000-8000-000000000001",
          kind: "personal_channel",
          name: "scratch",
          topic: null,
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
        }
      ]
    },
    teams: []
  },
  selection: { kind: "personal_memory" },
  view: { kind: "personal_memory", entries: [] }
});

afterEach(() => {
  vi.useRealTimers();
  for (const root of temps.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("desktop collaboration broker", () => {
  it("keeps Personal sends local when a retained remote credential has no enabled route", async () => {
    const koedHome = tempRoot();
    const environment = {
      KOED_HOME: koedHome,
      KOED_REPO_ROOT: koedHome,
      KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN: sessionToken
    };
    const paths = resolveKoedServerPaths(environment);
    const backendId = "team-vps";
    registerUpstreamBackend(paths, {
      id: backendId,
      url: "http://localhost:3400",
      profile: "team_self_hosted"
    });
    setActiveUpstreamBackend(paths, backendId);
    storeLocalEdgeClientCredential(koedHome, {
      backendId,
      secret: "retained-personal-credential",
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    storeDesktopLocalCredential(koedHome, {
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(null, { status: 503 });
    });
    const broker = createDesktopCollaborationBroker({
      environment,
      paths,
      fetch: fetchMock,
      sleep: async () => undefined,
      sendMessage: vi.fn()
    });

    await broker.handleMessage({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken,
      type: "command",
      envelopeId: "58ffde92-7980-4a48-b29a-d9bd85a22f31",
      ownerId: "renderer-local-personal",
      command: collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "768ae5ae-fcbe-4e17-9d83-14a97d5f92a1",
        command: "collaboration.send_message",
        input: {
          thread: {
            scope: "personal",
            threadId: "00000000-0000-4000-8000-000000000002"
          },
          clientMessageId: "33333333-3333-4333-8333-333333333331",
          body: "This remains under local Personal authority"
        }
      })
    });

    expect(listCollaborationPendingSends(koedHome)).toEqual([
      expect.objectContaining({
        backendId: null,
        remotePrincipalId: null,
        deviceCredentialId: null,
        state: "manual_retry"
      })
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await broker.shutdown();
  });

  it("rejects a Personal retry when its remote principal or device binding changed", async () => {
    const koedHome = tempRoot();
    const environment = {
      KOED_HOME: koedHome,
      KOED_REPO_ROOT: koedHome,
      KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN: sessionToken
    };
    const paths = resolveKoedServerPaths(environment);
    const backendId = "team-vps";
    registerUpstreamBackend(paths, {
      id: backendId,
      url: "http://localhost:3400",
      profile: "team_self_hosted"
    });
    updateUpstreamBackendRoutePolicy(paths, backendId, {
      personalCollaboration: "enabled"
    });
    setActiveUpstreamBackend(paths, backendId);
    storeLocalEdgeClientCredential(koedHome, {
      backendId,
      secret: "current-personal-credential",
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    storeDesktopLocalCredential(koedHome, {
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(
      paths.upstreamEnrollmentsPath,
      `${JSON.stringify({
        schemaVersion: 1,
        updatedAt: "2026-07-20T00:00:00.000Z",
        enrollments: [
          {
            backendId,
            requestId: "current-enrollment",
            state: "exchanged",
            activationUrl: null,
            requestedOperationFamilies: [
              "personal_collaboration_read",
              "personal_collaboration_write"
            ],
            deviceCredentialId: "22222222-2222-4222-8222-222222222222",
            principalUserId: "33333333-3333-4333-8333-333333333333",
            createdAt: "2026-07-20T00:00:00.000Z",
            updatedAt: "2026-07-20T00:00:00.000Z",
            expiresAt: null,
            credential: {
              status: "configured",
              reference: "keychain://koed-upstream/team-vps/current"
            }
          }
        ]
      })}\n`,
      { mode: 0o600 }
    );
    const stored = storeCollaborationPendingSend(koedHome, {
      ownerId: "11111111-1111-4111-8111-111111111111",
      backendId,
      remotePrincipalId: "44444444-4444-4444-8444-444444444444",
      deviceCredentialId: "55555555-5555-4555-8555-555555555555",
      thread: {
        scope: "personal",
        threadId: "00000000-0000-4000-8000-000000000002"
      },
      clientMessageId: "33333333-3333-4333-8333-333333333332",
      body: "Never rebind this retry"
    });
    updateCollaborationPendingSendState(koedHome, {
      key: stored.key,
      attemptCount: 5,
      state: "manual_retry",
      nextAttemptAt: null
    });
    const fetchMock = vi.fn<typeof fetch>();
    const sent: DesktopCollaborationBrokerChildMessage[] = [];
    const broker = createDesktopCollaborationBroker({
      environment,
      paths,
      fetch: fetchMock,
      sendMessage: (message) => sent.push(message)
    });

    await broker.handleMessage({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken,
      type: "command",
      envelopeId: "58ffde92-7980-4a48-b29a-d9bd85a22f32",
      ownerId: "renderer-remote-personal",
      command: collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "768ae5ae-fcbe-4e17-9d83-14a97d5f92a2",
        command: "collaboration.retry_message",
        input: {
          thread: {
            scope: "personal",
            threadId: "00000000-0000-4000-8000-000000000002"
          },
          clientMessageId: "33333333-3333-4333-8333-333333333332",
          body: "Never rebind this retry"
        }
      })
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(listCollaborationPendingSends(koedHome)).toEqual([]);
    expect(
      sent.find((message) => message.type === "command_result")
    ).toMatchObject({
      type: "command_result",
      result: {
        ok: false,
        error: { code: "access_revoked" }
      }
    });
    await broker.shutdown();
  });

  it("persists encrypted sends and retries one immutable message at most five times", async () => {
    const koedHome = tempRoot();
    storeDesktopLocalCredential(koedHome, {
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    const bodyText = "Retry this exact sensitive message";
    let attempts = 0;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        attempts += 1;
        const storedText = readFileSync(
          resolve(koedHome, "secrets/upstream-credentials.json"),
          "utf8"
        );
        expect(storedText).not.toContain(bodyText);
        if (attempts < 5) return new Response(null, { status: 503 });
        const request = JSON.parse(String(init?.body)) as {
          command: { requestId: string; command: string };
        };
        return Response.json({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: request.command.requestId,
          command: request.command.command,
          ok: true,
          data: {
            message: {
              id: "44444444-4444-4444-8444-444444444444",
              threadId: "00000000-0000-4000-8000-000000000002",
              scope: "personal",
              teamId: null,
              sequence: 1,
              sender: {
                id: "00000000-0000-4000-8000-000000000001",
                displayName: "Mark",
                membershipState: "enabled"
              },
              senderKind: "user",
              body: bodyText,
              createdAt: "2026-07-18T08:30:00.000Z",
              updatedAt: "2026-07-18T08:30:00.000Z",
              editedAt: null,
              deletedAt: null,
              delivery: "sent",
              recipientStatus: null,
              failure: null
            }
          }
        });
      });
    const sent: DesktopCollaborationBrokerChildMessage[] = [];
    const broker = createDesktopCollaborationBroker({
      environment: {
        KOED_HOME: koedHome,
        KOED_REPO_ROOT: koedHome,
        KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN: sessionToken
      },
      fetch: fetchMock,
      sleep: async () => undefined,
      now: () => Date.parse("2026-07-18T08:30:00.000Z"),
      sendMessage: (message) => sent.push(message)
    });
    const requestId = "768ae5ae-fcbe-4e17-9d83-14a97d5f92a6";

    await broker.handleMessage({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken,
      type: "command",
      envelopeId: "58ffde92-7980-4a48-b29a-d9bd85a22f3f",
      ownerId: "renderer-1",
      command: collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId,
        command: "collaboration.send_message",
        input: {
          thread: {
            scope: "personal",
            threadId: "00000000-0000-4000-8000-000000000002"
          },
          clientMessageId: "33333333-3333-4333-8333-333333333333",
          body: bodyText
        }
      })
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(listCollaborationPendingSends(koedHome)).toEqual([]);
    const result = sent.find((message) => message.type === "command_result");
    expect(result).toMatchObject({
      type: "command_result",
      result: {
        ok: true,
        requestId,
        command: "collaboration.send_message",
        data: {
          durableSend: {
            body: bodyText,
            clientMessageId: "33333333-3333-4333-8333-333333333333",
            state: "queued",
            retryable: true,
            removalSupported: false
          }
        }
      }
    });
    expect(
      sent.find(
        (message) =>
          message.type === "renderer_event" &&
          message.event.type === "durable_send"
      )
    ).toMatchObject({
      type: "renderer_event",
      event: {
        type: "durable_send",
        send: {
          clientMessageId: "33333333-3333-4333-8333-333333333333",
          state: "sent"
        },
        message: {
          body: bodyText,
          clientMessageId: "33333333-3333-4333-8333-333333333333"
        }
      }
    });
  });

  it("enters explicit manual retry after five failures and resets only that retry cycle", async () => {
    const koedHome = tempRoot();
    storeDesktopLocalCredential(koedHome, {
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    let available = false;
    const bodyText = "One durable message across automatic and manual retry";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        if (!available) return new Response(null, { status: 503 });
        const request = JSON.parse(String(init?.body)) as {
          command: { requestId: string; command: string };
        };
        return Response.json({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: request.command.requestId,
          command: request.command.command,
          ok: true,
          data: {
            message: {
              id: "44444444-4444-4444-8444-444444444445",
              threadId: "00000000-0000-4000-8000-000000000002",
              scope: "personal",
              teamId: null,
              sequence: 1,
              sender: {
                id: "00000000-0000-4000-8000-000000000001",
                displayName: "Mark",
                membershipState: "enabled"
              },
              senderKind: "user",
              body: bodyText,
              createdAt: "2026-07-18T08:30:00.000Z",
              updatedAt: "2026-07-18T08:30:00.000Z",
              editedAt: null,
              deletedAt: null,
              delivery: "sent",
              recipientStatus: null,
              failure: null
            }
          }
        });
      });
    const sent: DesktopCollaborationBrokerChildMessage[] = [];
    const broker = createDesktopCollaborationBroker({
      environment: {
        KOED_HOME: koedHome,
        KOED_REPO_ROOT: koedHome,
        KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN: sessionToken
      },
      fetch: fetchMock,
      sleep: async () => undefined,
      now: () => Date.parse("2026-07-18T08:30:00.000Z"),
      sendMessage: (message) => sent.push(message)
    });
    const input = {
      thread: {
        scope: "personal" as const,
        threadId: "00000000-0000-4000-8000-000000000002"
      },
      clientMessageId: "33333333-3333-4333-8333-333333333334",
      body: bodyText
    };
    const invoke = async (
      command: "collaboration.send_message" | "collaboration.retry_message",
      requestId: string,
      envelopeId: string
    ) =>
      broker.handleMessage({
        protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        sessionToken,
        type: "command",
        envelopeId,
        ownerId: "renderer-1",
        command: collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId,
          command,
          input
        })
      });

    await invoke(
      "collaboration.send_message",
      "768ae5ae-fcbe-4e17-9d83-14a97d5f92a6",
      "58ffde92-7980-4a48-b29a-d9bd85a22f3f"
    );
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(listCollaborationPendingSends(koedHome)).toEqual([
      expect.objectContaining({
        attemptCount: 5,
        state: "manual_retry",
        body: bodyText
      })
    ]);

    available = true;
    await invoke(
      "collaboration.retry_message",
      "868ae5ae-fcbe-4e17-9d83-14a97d5f92a6",
      "68ffde92-7980-4a48-b29a-d9bd85a22f3f"
    );
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(listCollaborationPendingSends(koedHome)).toEqual([]);
    expect(
      sent.filter(
        (message) => message.type === "command_result" && message.result.ok
      )
    ).toHaveLength(2);
    expect(
      sent
        .filter(
          (message) =>
            message.type === "renderer_event" &&
            message.event.type === "durable_send"
        )
        .map((message) =>
          message.type === "renderer_event" &&
          message.event.type === "durable_send"
            ? message.event.send.state
            : null
        )
    ).toEqual(["manual_retry", "sent"]);
  });

  it("keeps per-thread durable sends ordered across manual retry and later queueing", async () => {
    const koedHome = tempRoot();
    const ownerUserId = "11111111-1111-4111-8111-111111111111";
    const threadId = "00000000-0000-4000-8000-000000000002";
    storeDesktopLocalCredential(koedHome, {
      ownerUserId,
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    let available = false;
    const attemptedBodies: string[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as {
          command: {
            requestId: string;
            command: string;
            input: { body: string; clientMessageId: string };
          };
        };
        attemptedBodies.push(request.command.input.body);
        if (!available) return new Response(null, { status: 503 });
        return Response.json({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: request.command.requestId,
          command: request.command.command,
          ok: true,
          data: {
            message: {
              id:
                request.command.input.clientMessageId ===
                "33333333-3333-4333-8333-333333333336"
                  ? "44444444-4444-4444-8444-444444444447"
                  : "44444444-4444-4444-8444-444444444448",
              threadId,
              scope: "personal",
              teamId: null,
              sequence:
                request.command.input.clientMessageId ===
                "33333333-3333-4333-8333-333333333336"
                  ? 1
                  : 2,
              sender: {
                id: ownerUserId,
                displayName: "Mark",
                membershipState: "enabled"
              },
              senderKind: "user",
              body: request.command.input.body,
              createdAt: "2026-07-18T08:30:00.000Z",
              updatedAt: "2026-07-18T08:30:00.000Z",
              editedAt: null,
              deletedAt: null,
              delivery: "sent",
              recipientStatus: null,
              failure: null
            }
          }
        });
      });
    const broker = createDesktopCollaborationBroker({
      environment: {
        KOED_HOME: koedHome,
        KOED_REPO_ROOT: koedHome,
        KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN: sessionToken
      },
      fetch: fetchMock,
      sleep: async () => undefined,
      sendMessage: vi.fn()
    });
    const invoke = (
      command: "collaboration.send_message" | "collaboration.retry_message",
      requestId: string,
      clientMessageId: string,
      body: string
    ) =>
      broker.handleMessage({
        protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        sessionToken,
        type: "command",
        envelopeId: crypto.randomUUID(),
        ownerId: "renderer-ordered",
        command: collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId,
          command,
          input: {
            thread: { scope: "personal", threadId },
            clientMessageId,
            body
          }
        })
      });

    await invoke(
      "collaboration.send_message",
      "768ae5ae-fcbe-4e17-9d83-14a97d5f92b1",
      "33333333-3333-4333-8333-333333333336",
      "first"
    );
    await invoke(
      "collaboration.send_message",
      "768ae5ae-fcbe-4e17-9d83-14a97d5f92b2",
      "33333333-3333-4333-8333-333333333337",
      "second"
    );

    expect(attemptedBodies).toEqual(Array(5).fill("first"));
    expect(
      listCollaborationPendingSends(koedHome).map((record) => ({
        body: record.body,
        state: record.state,
        order: record.localCreationOrder
      }))
    ).toEqual([
      { body: "first", state: "manual_retry", order: 1 },
      { body: "second", state: "pending", order: 2 }
    ]);

    available = true;
    await invoke(
      "collaboration.retry_message",
      "768ae5ae-fcbe-4e17-9d83-14a97d5f92b3",
      "33333333-3333-4333-8333-333333333336",
      "first"
    );

    expect(attemptedBodies.slice(-2)).toEqual(["first", "second"]);
    expect(listCollaborationPendingSends(koedHome)).toEqual([]);
  });

  it("resumes a durable pending send after the Electron renderer is recreated", async () => {
    const koedHome = tempRoot();
    const ownerUserId = "11111111-1111-4111-8111-111111111111";
    const threadId = "00000000-0000-4000-8000-000000000002";
    const clientMessageId = "33333333-3333-4333-8333-333333333335";
    const bodyText = "Resume after renderer recreation";
    storeDesktopLocalCredential(koedHome, {
      ownerUserId,
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    const pending = storeCollaborationPendingSend(koedHome, {
      ownerId: ownerUserId,
      backendId: null,
      remotePrincipalId: null,
      deviceCredentialId: null,
      thread: { scope: "personal", threadId },
      clientMessageId,
      body: bodyText
    });
    expect(pending.ownerId).toBe(ownerUserId);

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as {
          command: { requestId: string; command: string };
        };
        if (request.command.command === "collaboration.load") {
          return Response.json({
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            requestId: request.command.requestId,
            command: request.command.command,
            ok: true,
            data: { snapshot }
          });
        }
        return Response.json({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: request.command.requestId,
          command: request.command.command,
          ok: true,
          data: {
            message: {
              id: "44444444-4444-4444-8444-444444444446",
              threadId,
              scope: "personal",
              teamId: null,
              sequence: 1,
              sender: {
                id: ownerUserId,
                displayName: "Mark",
                membershipState: "enabled"
              },
              senderKind: "user",
              body: bodyText,
              createdAt: "2026-07-18T08:30:00.000Z",
              updatedAt: "2026-07-18T08:30:00.000Z",
              editedAt: null,
              deletedAt: null,
              delivery: "sent",
              recipientStatus: null,
              failure: null
            }
          }
        });
      });
    const sent: DesktopCollaborationBrokerChildMessage[] = [];
    const broker = createDesktopCollaborationBroker({
      environment: {
        KOED_HOME: koedHome,
        KOED_REPO_ROOT: koedHome,
        KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN: sessionToken
      },
      fetch: fetchMock,
      sleep: async () => undefined,
      sendMessage: (message) => sent.push(message)
    });

    await broker.handleMessage({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken,
      type: "command",
      envelopeId: "78ffde92-7980-4a48-b29a-d9bd85a22f3f",
      ownerId: "renderer-after-recreation",
      command: collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "968ae5ae-fcbe-4e17-9d83-14a97d5f92a6",
        command: "collaboration.load",
        input: {}
      })
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(listCollaborationPendingSends(koedHome)).toEqual([]);
    const commandResultIndex = sent.findIndex(
      (message) =>
        message.type === "command_result" &&
        message.result.ok &&
        message.result.command === "collaboration.load"
    );
    const sentEventIndex = sent.findIndex(
      (message) =>
        message.type === "renderer_event" &&
        message.event.type === "durable_send" &&
        message.event.send.state === "sent"
    );
    expect(commandResultIndex).toBeGreaterThanOrEqual(0);
    expect(sentEventIndex).toBeGreaterThan(commandResultIndex);
    const loaded =
      sent[commandResultIndex]?.type === "command_result"
        ? sent[commandResultIndex].result
        : null;
    expect(
      loaded?.ok && loaded.command === "collaboration.load"
        ? loaded.data.snapshot.outbox
        : null
    ).toEqual([
      expect.objectContaining({
        clientMessageId,
        body: bodyText,
        state: "queued"
      })
    ]);
  });

  it("uses the persisted automatic API port instead of the checkout default", async () => {
    const koedHome = tempRoot();
    storeDesktopLocalCredential(koedHome, {
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    writeFileSync(resolve(koedHome, ".env"), "API_HOST_PORT=3300\n");
    writeFileSync(
      resolve(koedHome, "config/local-ports.json"),
      `${JSON.stringify({ api: "43300" })}\n`
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, init) => {
        expect(String(url)).toBe(
          "http://localhost:43300/v1/local-edge/collaboration/command"
        );
        const body = JSON.parse(String(init?.body)) as {
          command: { requestId: string; command: string };
        };
        return Response.json({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: body.command.requestId,
          command: body.command.command,
          ok: true,
          data: { snapshot }
        });
      });
    const broker = createDesktopCollaborationBroker({
      environment: {
        KOED_AUTO_PORTS: "1",
        KOED_HOME: koedHome,
        KOED_REPO_ROOT: koedHome,
        KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN: sessionToken
      },
      fetch: fetchMock,
      sendMessage: vi.fn()
    });

    await broker.handleMessage({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken,
      type: "command",
      envelopeId: "58ffde92-7980-4a48-b29a-d9bd85a22f3f",
      ownerId: "renderer-1",
      command: collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "768ae5ae-fcbe-4e17-9d83-14a97d5f92a6",
        command: "collaboration.load",
        input: {}
      })
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses the active runtime API URL instead of stale generated environment values", async () => {
    const koedHome = tempRoot();
    storeDesktopLocalCredential(koedHome, {
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    writeFileSync(resolve(koedHome, ".env"), "API_HOST_PORT=3300\n");
    writeFileSync(
      resolve(koedHome, "config/local-ports.json"),
      `${JSON.stringify({ api: "43300" })}\n`
    );
    mkdirSync(resolve(koedHome, "run"), { recursive: true });
    writeFileSync(
      resolve(koedHome, "run/koed-server.json"),
      `${JSON.stringify({
        pid: process.pid,
        startedAt: "2026-07-31T07:00:44.560Z",
        repoRoot: koedHome,
        apiUrl: "http://localhost:3301",
        runtimeMode: "developer",
        dependencyMode: "bundled-local",
        automaticPorts: true,
        services: ["api"],
        processes: { api: process.pid }
      })}\n`
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, init) => {
        expect(String(url)).toBe(
          "http://localhost:3301/v1/local-edge/collaboration/command"
        );
        const body = JSON.parse(String(init?.body)) as {
          command: { requestId: string; command: string };
        };
        return Response.json({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: body.command.requestId,
          command: body.command.command,
          ok: true,
          data: { snapshot }
        });
      });
    const broker = createDesktopCollaborationBroker({
      environment: {
        KOED_AUTO_PORTS: "1",
        API_HOST_PORT: "3300",
        MEMORY_API_URL: "http://localhost:3300",
        KOED_HOME: koedHome,
        KOED_REPO_ROOT: koedHome,
        KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN: sessionToken
      },
      fetch: fetchMock,
      sendMessage: vi.fn()
    });

    await broker.handleMessage({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken,
      type: "command",
      envelopeId: "68ffde92-7980-4a48-b29a-d9bd85a22f3f",
      ownerId: "renderer-active-runtime",
      command: collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "868ae5ae-fcbe-4e17-9d83-14a97d5f92a6",
        command: "collaboration.load",
        input: {}
      })
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refreshes active backend capabilities before the cache expires", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-07-18T08:30:00.000Z");
    vi.setSystemTime(startedAt);
    const koedHome = tempRoot();
    const environment = {
      KOED_HOME: koedHome,
      KOED_REPO_ROOT: koedHome,
      KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN: sessionToken
    };
    const paths = resolveKoedServerPaths(environment);
    const registered = registerUpstreamBackend(paths, {
      id: "team-backend",
      url: "http://localhost:3300",
      profile: "team_self_hosted"
    });
    expect(registered.ok).toBe(true);
    expect(setActiveUpstreamBackend(paths, "team-backend").ok).toBe(true);
    const capabilityPayload = {
      product: "koed",
      apiVersion: "v1",
      capabilitySchemaVersion: 6,
      releaseVersion: "0.4.4",
      deployment: { profile: "team_self_hosted" }
    };
    await refreshUpstreamBackendCapabilities(paths, "team-backend", {
      now: () => startedAt,
      fetch: async () => Response.json(capabilityPayload)
    });
    storeDesktopLocalCredential(koedHome, {
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    const refreshCapabilities = vi.fn(
      async (
        targetPaths: typeof paths,
        backendId: string,
        deps: Parameters<typeof refreshUpstreamBackendCapabilities>[2]
      ) =>
        refreshUpstreamBackendCapabilities(targetPaths, backendId, {
          ...deps,
          fetch: async () => Response.json(capabilityPayload)
        })
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          command: { requestId: string; command: string };
        };
        return Response.json({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: body.command.requestId,
          command: body.command.command,
          ok: true,
          data: { snapshot }
        });
      });
    const broker = createDesktopCollaborationBroker({
      environment,
      paths,
      fetch: fetchMock,
      now: () => Date.now(),
      refreshUpstreamBackendCapabilities: refreshCapabilities,
      sendMessage: vi.fn()
    });

    await broker.handleMessage({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken,
      type: "command",
      envelopeId: "58ffde92-7980-4a48-b29a-d9bd85a22f3f",
      ownerId: "renderer-1",
      command: collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "768ae5ae-fcbe-4e17-9d83-14a97d5f92a6",
        command: "collaboration.load",
        input: {}
      })
    });
    expect(refreshCapabilities).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(14 * 60 * 1_000);

    expect(refreshCapabilities).toHaveBeenCalledOnce();
    expect(getActiveUpstreamBackend(paths)?.capabilities).toMatchObject({
      state: "validated",
      checkedAt: "2026-07-18T08:44:00.000Z",
      expiresAt: "2026-07-18T08:59:00.000Z"
    });
    await broker.shutdown();
  });

  it("replays a cached result only for an identical owner request", async () => {
    const koedHome = tempRoot();
    storeDesktopLocalCredential(koedHome, {
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    const sent: DesktopCollaborationBrokerChildMessage[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          command: { requestId: string; command: string };
        };
        return Response.json({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: body.command.requestId,
          command: body.command.command,
          ok: true,
          data: { snapshot }
        });
      });
    const broker = createDesktopCollaborationBroker({
      environment: {
        KOED_HOME: koedHome,
        KOED_REPO_ROOT: koedHome,
        KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN: sessionToken
      },
      fetch: fetchMock,
      sendMessage: (message) => {
        sent.push(message);
      }
    });
    const command = collaborationRendererCommandSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: "768ae5ae-fcbe-4e17-9d83-14a97d5f92a6",
      command: "collaboration.load",
      input: {}
    });

    await broker.handleMessage({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken,
      type: "command",
      envelopeId: "58ffde92-7980-4a48-b29a-d9bd85a22f3f",
      ownerId: "renderer-1",
      command
    });
    await broker.handleMessage({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken,
      type: "command",
      envelopeId: "5a1f3c7c-72f2-49c1-9c83-d8e81e5c57ec",
      ownerId: "renderer-1",
      command
    });
    await broker.handleMessage({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken,
      type: "command",
      envelopeId: "7effaa2f-bb77-4df8-b0ea-2ae5ee031470",
      ownerId: "renderer-1",
      command: collaborationRendererCommandSchema.parse({
        ...command,
        command: "collaboration.select",
        input: { selection: { kind: "personal_memory" } }
      })
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(3);
    expect(sent[0]?.type).toBe("command_result");
    expect(sent[0]?.type === "command_result" && sent[0].result.ok).toBe(true);
    expect(sent[1]?.type).toBe("command_result");
    expect(sent[1]?.type === "command_result" && sent[1].result.ok).toBe(true);
    expect(sent[2]?.type).toBe("command_result");
    if (sent[2]?.type !== "command_result" || sent[2].result.ok) {
      throw new Error("Expected a mismatched duplicate command to fail.");
    }
    expect(sent[2].result.error.code).toBe("conflict");
  });

  it("reissues an identical request after a retryable result", async () => {
    const koedHome = tempRoot();
    storeDesktopLocalCredential(koedHome, {
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    const sent: DesktopCollaborationBrokerChildMessage[] = [];
    let attempt = 0;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        attempt += 1;
        const body = JSON.parse(String(init?.body)) as {
          command: { requestId: string; command: string };
        };
        return Response.json(
          attempt === 1
            ? {
                contractVersion: COLLABORATION_CONTRACT_VERSION,
                requestId: body.command.requestId,
                command: body.command.command,
                ok: false,
                error: {
                  code: "temporarily_unavailable",
                  userMessage:
                    collaborationSafeErrorMessages.temporarily_unavailable,
                  retryable: true,
                  retryAfterMs: 0
                }
              }
            : {
                contractVersion: COLLABORATION_CONTRACT_VERSION,
                requestId: body.command.requestId,
                command: body.command.command,
                ok: true,
                data: { snapshot }
              }
        );
      });
    const broker = createDesktopCollaborationBroker({
      environment: {
        KOED_HOME: koedHome,
        KOED_REPO_ROOT: koedHome,
        KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN: sessionToken
      },
      fetch: fetchMock,
      sendMessage: (message) => sent.push(message)
    });
    const command = collaborationRendererCommandSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: "7c595752-8f99-41ca-b18a-cf6972010218",
      command: "collaboration.select",
      input: { selection: { kind: "personal_memory" } }
    });
    const message = (envelopeId: string) => ({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken,
      type: "command" as const,
      envelopeId,
      ownerId: "renderer-1",
      command
    });

    await broker.handleMessage(message("c6bbb2cf-73ae-4176-a213-507ba0046388"));
    await broker.handleMessage(message("32b51185-2042-477f-9052-d194978db323"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.type === "command_result" && sent[0].result.ok).toBe(false);
    expect(sent[1]?.type === "command_result" && sent[1].result.ok).toBe(true);
  });

  it("acknowledges owner release and rejects invalid session tokens", async () => {
    const koedHome = tempRoot();
    const sent: DesktopCollaborationBrokerChildMessage[] = [];
    const broker = createDesktopCollaborationBroker({
      environment: {
        KOED_HOME: koedHome,
        KOED_REPO_ROOT: koedHome,
        KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN: sessionToken
      },
      fetch: vi.fn<typeof fetch>(),
      sendMessage: (message) => {
        sent.push(message);
      }
    });

    await broker.handleMessage({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken,
      type: "release_owner",
      envelopeId: "096f9348-6524-464b-a6f5-883052b6e36d",
      ownerId: "renderer-1"
    });
    await broker.handleMessage({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken: `${sessionToken}_wrong`,
      type: "shutdown",
      envelopeId: "71cb58de-aa9f-43eb-9588-bf5ce252e61a"
    });

    expect(sent).toEqual([
      expect.objectContaining({
        type: "owner_released",
        ownerId: "renderer-1"
      }),
      expect.objectContaining({
        type: "error",
        code: "invalid_message"
      })
    ]);
  });

  it("never echoes rejected input or validation details across broker IPC", async () => {
    const sent: DesktopCollaborationBrokerChildMessage[] = [];
    const broker = createDesktopCollaborationBroker({
      environment: {
        KOED_HOME: tempRoot(),
        KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN: sessionToken
      },
      sendMessage: (message) => sent.push(message)
    });
    const secretSentinel =
      "Koed-Desktop koed_desktop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:credential-sentinel";

    await broker.handleMessage({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken,
      type: "command",
      envelopeId: "58ffde92-7980-4a48-b29a-d9bd85a22f3f",
      ownerId: "renderer-1",
      command: secretSentinel
    });

    expect(sent).toEqual([
      expect.objectContaining({
        type: "error",
        envelopeId: "58ffde92-7980-4a48-b29a-d9bd85a22f3f",
        ownerId: "renderer-1",
        code: "invalid_message",
        message: "Desktop collaboration broker rejected an invalid message."
      })
    ]);
    expect(JSON.stringify(sent)).not.toContain(secretSentinel);
    expect(JSON.stringify(sent)).not.toContain("expected");
    await broker.shutdown();
  });

  it("broadcasts a live transition after browser enrollment exchanges", async () => {
    const koedHome = tempRoot();
    const environment = {
      KOED_HOME: koedHome,
      KOED_REPO_ROOT: koedHome,
      KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN: sessionToken
    };
    const paths = resolveKoedServerPaths(environment);
    const registered = registerUpstreamBackend(paths, {
      id: "team-backend",
      url: "http://localhost:3300",
      profile: "team_self_hosted"
    });
    expect(registered.ok).toBe(true);
    expect(setActiveUpstreamBackend(paths, "team-backend").ok).toBe(true);
    storeDesktopLocalCredential(koedHome, {
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    const enrollment = (state: "pending" | "exchanged") => ({
      ok: true,
      state,
      backend: registered.backend,
      enrollment: {
        backendId: "team-backend",
        requestId: "enrollment-request-1",
        state,
        activationUrl:
          state === "pending"
            ? "http://localhost:3300/device-enrollment/enrollment-request-1"
            : null,
        requestedOperationFamilies: [
          "personal_collaboration_read",
          "personal_collaboration_write",
          "team_workspace_read",
          "team_chat_read",
          "team_chat_write",
          "share_grant_management",
          "sync",
          "managed_execution",
          "action_grant"
        ],
        createdAt: "2026-07-18T08:30:00.000Z",
        updatedAt: "2026-07-18T08:30:00.000Z",
        expiresAt: "2026-07-18T09:30:00.000Z",
        credential: {
          status: state === "exchanged" ? "configured" : "not_configured"
        }
      },
      message: state
    });
    const getEnrollmentStatus = vi
      .fn()
      .mockResolvedValueOnce(enrollment("pending"))
      .mockResolvedValueOnce(enrollment("exchanged"));
    const refreshCapabilities = vi.fn().mockResolvedValue({
      ok: true,
      state: "validated",
      backend: registered.backend,
      message: "validated"
    });
    const sent: DesktopCollaborationBrokerChildMessage[] = [];
    const opened: string[] = [];
    const broker = createDesktopCollaborationBroker({
      environment,
      paths,
      getUpstreamEnrollmentStatus: getEnrollmentStatus,
      refreshUpstreamBackendCapabilities: refreshCapabilities,
      sleep: async () => undefined,
      now: () => Date.parse("2026-07-18T08:31:00.000Z"),
      sendMessage: (message) => sent.push(message),
      onBrowserOpenRequest: ({ url }) => opened.push(url)
    });

    await broker.handleMessage({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken,
      type: "command",
      envelopeId: "58ffde92-7980-4a48-b29a-d9bd85a22f3f",
      ownerId: "renderer-1",
      command: collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "768ae5ae-fcbe-4e17-9d83-14a97d5f92a6",
        command: "collaboration.reconnect_backend",
        input: {}
      })
    });

    await vi.waitFor(() => {
      expect(
        sent
          .filter((message) => message.type === "renderer_event")
          .map((message) =>
            message.type === "renderer_event" &&
            message.event.type === "connection"
              ? message.event.connection.state
              : null
          )
      ).toEqual(["reconnecting", "live"]);
    });
    expect(opened).toEqual([
      "http://localhost:3300/device-enrollment/enrollment-request-1"
    ]);
    expect(getEnrollmentStatus).toHaveBeenCalledTimes(2);
    expect(refreshCapabilities).toHaveBeenCalledOnce();
    expect(getActiveUpstreamBackend(paths)?.routePolicy).toEqual({
      personalMemoryRead: "disabled",
      personalCollaboration: "enabled",
      teamWorkspaceRead: "enabled",
      shareGrantManagement: "enabled",
      captureWrites: "disabled",
      sync: "enabled",
      managedExecution: "enabled",
      admin: "enabled"
    });
    const result = sent.find((message) => message.type === "command_result");
    expect(result?.type === "command_result" && result.result.ok).toBe(false);
    await broker.shutdown();
  });

  it("revokes and clears the old trust domain before activating a different backend", async () => {
    const koedHome = tempRoot();
    const environment = {
      KOED_HOME: koedHome,
      KOED_REPO_ROOT: koedHome,
      KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN: sessionToken
    };
    const paths = resolveKoedServerPaths(environment);
    const oldBackend = registerUpstreamBackend(paths, {
      id: "old-team-backend",
      url: "http://localhost:3300",
      profile: "team_self_hosted"
    });
    expect(oldBackend.ok).toBe(true);
    expect(setActiveUpstreamBackend(paths, "old-team-backend").ok).toBe(true);
    storeDesktopLocalCredential(koedHome, {
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    const order: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.includes("/realtime/backends/")) {
        order.push("local-cleanup");
        return Response.json({
          protocolVersion: COLLABORATION_CONTRACT_VERSION,
          revokedSubscriptionCount: 1
        });
      }
      const request = JSON.parse(String(init?.body)) as {
        command: { requestId: string; command: string };
      };
      order.push("load-new-snapshot");
      const activeBackendId = getActiveUpstreamBackend(paths)?.id ?? null;
      return Response.json({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: request.command.requestId,
        command: request.command.command,
        ok: true,
        data: {
          snapshot: {
            ...snapshot,
            connection: {
              state: activeBackendId ? "live" : "disconnected",
              backendId: activeBackendId,
              connectedAt: activeBackendId ? "2026-07-18T08:30:00.000Z" : null,
              retryAt: null,
              reconnectAttempt: 0,
              protocolVersion: COLLABORATION_CONTRACT_VERSION
            }
          }
        }
      });
    });
    const disconnectEnrollment = vi.fn(async () => {
      order.push("remote-revoke");
      return { ok: true, state: "revoked", message: "revoked" } as const;
    });
    const refreshCapabilities = vi.fn(async () => {
      order.push("validate-new-backend");
      return { ok: true, state: "validated", message: "validated" } as const;
    });
    const startEnrollment = vi.fn(
      async (
        _paths,
        backendId: string,
        options?: { sourceOwnerPrincipalId?: string }
      ) => {
        order.push("start-new-enrollment");
        expect(options?.sourceOwnerPrincipalId).toBe(
          "11111111-1111-4111-8111-111111111111"
        );
        return {
          ok: true,
          state: "exchanged" as const,
          enrollment: {
            backendId,
            requestId: "new-enrollment",
            state: "exchanged" as const,
            activationUrl: null,
            requestedOperationFamilies: [
              "personal_collaboration_read",
              "personal_collaboration_write",
              "team_workspace_read",
              "team_chat_read",
              "team_chat_write",
              "share_grant_management",
              "sync",
              "managed_execution",
              "action_grant"
            ],
            createdAt: "2026-07-18T08:30:00.000Z",
            updatedAt: "2026-07-18T08:30:00.000Z",
            expiresAt: "2026-07-18T09:30:00.000Z",
            credential: { status: "configured" as const }
          },
          message: "exchanged"
        };
      }
    );
    const sent: DesktopCollaborationBrokerChildMessage[] = [];
    const broker = createDesktopCollaborationBroker({
      environment,
      paths,
      fetch: fetchMock,
      disconnectUpstreamBackendEnrollment: disconnectEnrollment,
      refreshUpstreamBackendCapabilities: refreshCapabilities,
      startUpstreamEnrollment: startEnrollment,
      sendMessage: (message) => sent.push(message)
    });

    await broker.handleMessage({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken,
      type: "command",
      envelopeId: "58ffde92-7980-4a48-b29a-d9bd85a22f3f",
      ownerId: "renderer-1",
      command: collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "768ae5ae-fcbe-4e17-9d83-14a97d5f92a6",
        command: "collaboration.connect_backend",
        input: { remoteUrl: "http://localhost:3400" }
      })
    });

    expect(order).toEqual([
      "remote-revoke",
      "local-cleanup",
      "validate-new-backend",
      "start-new-enrollment",
      "load-new-snapshot"
    ]);
    expect(getActiveUpstreamBackend(paths)?.baseUrl).toBe(
      "http://localhost:3400"
    );
    expect(
      sent.find((message) => message.type === "command_result")
    ).toMatchObject({ type: "command_result", result: { ok: true } });
    await broker.shutdown();
  });

  it("purges backend custody after revocation and retries incomplete subscription cleanup", async () => {
    const koedHome = tempRoot();
    const environment = {
      KOED_HOME: koedHome,
      KOED_REPO_ROOT: koedHome,
      KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN: sessionToken
    };
    const paths = resolveKoedServerPaths(environment);
    const backendId = "team-vps";
    const otherBackendId = "other-vps";
    const backendUrl = "http://localhost:3400";
    const principalUserId = "11111111-1111-4111-8111-111111111111";
    const deviceCredentialId = "22222222-2222-4222-8222-222222222222";
    const teamId = "33333333-3333-4333-8333-333333333333";
    const workspaceId = "44444444-4444-4444-8444-444444444444";
    const threadId = "55555555-5555-4555-8555-555555555555";
    const actionGrantId = "66666666-6666-4666-8666-666666666666";
    const actionBody = { name: "Custody proof" };
    const actionPath = `/v1/teams/${teamId}/workspaces`;
    const idempotencyKey = "77777777-7777-4777-8777-777777777777";

    registerUpstreamBackend(paths, {
      id: backendId,
      url: backendUrl,
      profile: "team_self_hosted"
    });
    const upstreamCredential = storeUpstreamCredentialSecret(koedHome, {
      backendId,
      credentialKeyId: "koed_device_disconnect",
      secret: "upstream-disconnect-secret"
    });
    updateUpstreamBackendCredential(paths, backendId, {
      status: "configured",
      reference: upstreamCredential.reference
    });
    setActiveUpstreamBackend(paths, backendId);
    storeLocalEdgeClientCredential(koedHome, {
      backendId,
      secret: "local-edge-disconnect-secret",
      operationFamilies: ["team_workspace_read"]
    });
    storeDesktopLocalCredential(koedHome, {
      ownerUserId: principalUserId,
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    storeCollaborationActionGrantCustody(koedHome, {
      referenceId: actionGrantId,
      backendId,
      deploymentBaseUrl: backendUrl,
      deviceCredentialId,
      principalUserId,
      operationFamily: "admin",
      action: "team.workspace.create",
      teamId,
      targetId: null,
      method: "POST",
      path: actionPath,
      body: actionBody,
      idempotencyKey,
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    const teamSend = storeCollaborationPendingSend(koedHome, {
      ownerId: principalUserId,
      backendId,
      remotePrincipalId: principalUserId,
      deviceCredentialId,
      thread: { scope: "team", teamId, threadId },
      clientMessageId: "88888888-8888-4888-8888-888888888888",
      body: "Remove this Team retry"
    });
    const otherTeamSend = storeCollaborationPendingSend(koedHome, {
      ownerId: principalUserId,
      backendId: otherBackendId,
      remotePrincipalId: principalUserId,
      deviceCredentialId,
      thread: {
        scope: "team",
        teamId: "99999999-9999-4999-8999-999999999999",
        threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      },
      clientMessageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      body: "Preserve another backend retry"
    });
    const personalSend = storeCollaborationPendingSend(koedHome, {
      ownerId: principalUserId,
      backendId: null,
      remotePrincipalId: null,
      deviceCredentialId: null,
      thread: {
        scope: "personal",
        threadId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
      },
      clientMessageId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      body: "Preserve Personal retry"
    });
    linkProjectTeamWorkspace(paths, {
      projectRoot: resolve(koedHome, "team-project"),
      teamWorkspaceId: workspaceId,
      backendId,
      remotePrincipalId: principalUserId,
      deviceCredentialId
    });
    linkProjectTeamWorkspace(paths, {
      projectRoot: resolve(koedHome, "other-project"),
      teamWorkspaceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      backendId: otherBackendId,
      remotePrincipalId: principalUserId,
      deviceCredentialId
    });

    let subscriptionCleanupAttempts = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/v1/local-edge/device-credentials/current") {
        expect(init?.method).toBe("DELETE");
        expect(new Headers(init?.headers).get("authorization")).toMatch(
          /^Koed-Device /
        );
        return Response.json({ revoked: true });
      }
      if (
        parsed.pathname ===
        `/v1/local-edge/collaboration/realtime/backends/${backendId}/subscriptions`
      ) {
        subscriptionCleanupAttempts += 1;
        return subscriptionCleanupAttempts === 1
          ? new Response(null, { status: 503 })
          : Response.json({
              protocolVersion: COLLABORATION_CONTRACT_VERSION,
              revokedSubscriptionCount: 1
            });
      }
      if (parsed.pathname === "/v1/local-edge/collaboration/command") {
        const request = JSON.parse(String(init?.body)) as {
          command: { requestId: string; command: string };
        };
        return Response.json({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: request.command.requestId,
          command: request.command.command,
          ok: true,
          data: { snapshot }
        });
      }
      throw new Error(`Unexpected request ${parsed}`);
    });
    const sent: DesktopCollaborationBrokerChildMessage[] = [];
    const broker = createDesktopCollaborationBroker({
      environment,
      paths,
      fetch: fetchMock,
      sendMessage: (message) => sent.push(message)
    });
    const invoke = async (
      command: "collaboration.disconnect_backend" | "collaboration.load",
      suffix: string
    ) =>
      broker.handleMessage({
        protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        sessionToken,
        type: "command",
        envelopeId: `58ffde92-7980-4a48-b29a-${suffix}`,
        ownerId: "renderer-1",
        command: collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: `768ae5ae-fcbe-4e17-9d83-${suffix}`,
          command,
          input: {}
        })
      });

    await invoke("collaboration.disconnect_backend", "000000000001");

    expect(subscriptionCleanupAttempts).toBe(1);
    expect(getActiveUpstreamBackend(paths)).toBeNull();
    expect(
      readUpstreamCredentialAuthorization(
        koedHome,
        upstreamCredential.reference
      )
    ).toBeNull();
    expect(
      readLocalEdgeClientCredentialAuthorization(koedHome, backendId)
    ).toBeNull();
    expect(
      readCollaborationActionGrantCustodyStatus(koedHome, {
        referenceId: actionGrantId,
        backendId,
        deploymentBaseUrl: backendUrl,
        deviceCredentialId,
        principalUserId
      })
    ).toBeNull();
    expect(
      listCollaborationPendingSends(koedHome).map((item) => item.key)
    ).toEqual(expect.arrayContaining([otherTeamSend.key, personalSend.key]));
    expect(
      listCollaborationPendingSends(koedHome).map((item) => item.key)
    ).not.toContain(teamSend.key);
    expect(listProjectTeamWorkspaceLinks(paths).links).toEqual([
      expect.objectContaining({ backendId: otherBackendId })
    ]);
    expect(
      sent.find(
        (message) =>
          message.type === "command_result" &&
          message.result.command === "collaboration.disconnect_backend"
      )
    ).toMatchObject({
      type: "command_result",
      result: {
        ok: false,
        error: { code: "temporarily_unavailable", retryable: true }
      }
    });
    expect(
      sent.some(
        (message) =>
          message.type === "renderer_event" &&
          message.event.type === "connection" &&
          message.event.connection.state === "disconnected"
      )
    ).toBe(true);
    expect(listUpstreamDisconnectCleanupRecords(paths)).toEqual([
      expect.objectContaining({
        backendId,
        phase: "local_cleanup_pending",
        lastFailureCategory: "local_cleanup_failed"
      })
    ]);

    await invoke("collaboration.load", "000000000002");
    expect(subscriptionCleanupAttempts).toBe(2);
    expect(listUpstreamDisconnectCleanupRecords(paths)).toEqual([]);
    await broker.shutdown();
  });

  it("drops queued Team writes and Project links from a replaced remote principal before replay", async () => {
    const koedHome = tempRoot();
    const environment = {
      KOED_HOME: koedHome,
      KOED_REPO_ROOT: koedHome,
      KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN: sessionToken
    };
    const paths = resolveKoedServerPaths(environment);
    const backendId = "team-vps";
    const backendUrl = "http://localhost:3400";
    const localOwnerId = "11111111-1111-4111-8111-111111111111";
    const stalePrincipalId = "22222222-2222-4222-8222-222222222222";
    const staleDeviceId = "33333333-3333-4333-8333-333333333333";
    const currentPrincipalId = "44444444-4444-4444-8444-444444444444";
    const currentDeviceId = "55555555-5555-4555-8555-555555555555";
    const teamId = "66666666-6666-4666-8666-666666666666";
    const threadId = "77777777-7777-4777-8777-777777777777";

    registerUpstreamBackend(paths, {
      id: backendId,
      url: backendUrl,
      profile: "team_self_hosted"
    });
    updateUpstreamBackendCredential(paths, backendId, {
      status: "configured",
      reference: "keychain://koed-upstream/team-vps/current"
    });
    setActiveUpstreamBackend(paths, backendId);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(
      paths.upstreamEnrollmentsPath,
      `${JSON.stringify({
        schemaVersion: 1,
        updatedAt: "2026-07-20T00:00:00.000Z",
        enrollments: [
          {
            backendId,
            requestId: "current-enrollment",
            state: "exchanged",
            activationUrl: null,
            requestedOperationFamilies: [
              "team_workspace_read",
              "team_chat_read",
              "team_chat_write",
              "share_grant_management",
              "sync",
              "managed_execution",
              "action_grant"
            ],
            deviceCredentialId: currentDeviceId,
            principalUserId: currentPrincipalId,
            createdAt: "2026-07-20T00:00:00.000Z",
            updatedAt: "2026-07-20T00:00:00.000Z",
            expiresAt: null,
            credential: {
              status: "configured",
              reference: "keychain://koed-upstream/team-vps/current"
            }
          }
        ]
      })}\n`,
      { mode: 0o600 }
    );
    storeDesktopLocalCredential(koedHome, {
      ownerUserId: localOwnerId,
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    storeCollaborationPendingSend(koedHome, {
      ownerId: localOwnerId,
      backendId,
      remotePrincipalId: stalePrincipalId,
      deviceCredentialId: staleDeviceId,
      thread: { scope: "team", teamId, threadId },
      clientMessageId: "88888888-8888-4888-8888-888888888888",
      body: "Never replay this as another principal"
    });
    linkProjectTeamWorkspace(paths, {
      projectRoot: resolve(koedHome, "stale-project"),
      teamWorkspaceId: "99999999-9999-4999-8999-999999999999",
      backendId,
      remotePrincipalId: stalePrincipalId,
      deviceCredentialId: staleDeviceId
    });

    const currentSnapshot = collaborationSnapshotSchema.parse({
      ...snapshot,
      connection: {
        state: "live",
        backendId,
        connectedAt: "2026-07-20T00:00:01.000Z",
        retryAt: null,
        reconnectAttempt: 0,
        protocolVersion: COLLABORATION_CONTRACT_VERSION
      },
      navigation: {
        ...snapshot.navigation,
        teamPrincipal: {
          id: currentPrincipalId,
          displayName: "Current principal",
          presence: "available",
          membershipState: "enabled"
        }
      }
    });
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        command: { requestId: string; command: string };
      };
      expect(request.command.command).toBe("collaboration.load");
      return Response.json({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: request.command.requestId,
        command: "collaboration.load",
        ok: true,
        data: { snapshot: currentSnapshot }
      });
    });
    const broker = createDesktopCollaborationBroker({
      environment,
      paths,
      fetch: fetchMock,
      refreshUpstreamBackendCapabilities: async () => ({
        ok: true,
        state: "validated",
        message: "validated"
      })
    });

    await broker.handleMessage({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken,
      type: "command",
      envelopeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ownerId: "renderer-1",
      command: collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        command: "collaboration.load",
        input: {}
      })
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(listCollaborationPendingSends(koedHome)).toEqual([]);
    expect(listProjectTeamWorkspaceLinks(paths).links).toEqual([]);
    await broker.shutdown();
  });

  it("keeps the old backend active when its remote credential cannot be revoked", async () => {
    const koedHome = tempRoot();
    const environment = {
      KOED_HOME: koedHome,
      KOED_REPO_ROOT: koedHome,
      KOED_DESKTOP_COLLABORATION_BROKER_SESSION_TOKEN: sessionToken
    };
    const paths = resolveKoedServerPaths(environment);
    registerUpstreamBackend(paths, {
      id: "old-team-backend",
      url: "http://localhost:3300",
      profile: "team_self_hosted"
    });
    setActiveUpstreamBackend(paths, "old-team-backend");
    const fetchMock = vi.fn<typeof fetch>();
    const startEnrollment = vi.fn();
    const sent: DesktopCollaborationBrokerChildMessage[] = [];
    const broker = createDesktopCollaborationBroker({
      environment,
      paths,
      fetch: fetchMock,
      disconnectUpstreamBackendEnrollment: async () => ({
        ok: false,
        state: "failed",
        message: "unavailable"
      }),
      startUpstreamEnrollment: startEnrollment,
      sendMessage: (message) => sent.push(message)
    });

    await broker.handleMessage({
      protocolVersion: DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION,
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      sessionToken,
      type: "command",
      envelopeId: "58ffde92-7980-4a48-b29a-d9bd85a22f3f",
      ownerId: "renderer-1",
      command: collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "768ae5ae-fcbe-4e17-9d83-14a97d5f92a6",
        command: "collaboration.connect_backend",
        input: { remoteUrl: "http://localhost:3400" }
      })
    });

    expect(getActiveUpstreamBackend(paths)?.id).toBe("old-team-backend");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(startEnrollment).not.toHaveBeenCalled();
    expect(
      sent.find((message) => message.type === "command_result")
    ).toMatchObject({
      type: "command_result",
      result: {
        ok: false,
        error: { code: "temporarily_unavailable" }
      }
    });
    await broker.shutdown();
  });
});
