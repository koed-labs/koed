import {
  COLLABORATION_CONTRACT_VERSION,
  COLLABORATION_DEFAULT_LIMITS,
  COLLABORATION_RECONNECT_BACKOFF_CAP_MS,
  collaborationRendererCommandSchema,
  collaborationSnapshotSchema,
  collaborationSafeErrorMessages,
  type CollaborationRendererCommand,
  type CollaborationRendererEvent,
  type CollaborationSnapshot
} from "@koed/shared";
import { describe, expect, it, vi } from "vitest";
import {
  calculateCollaborationReconnectDelay,
  collaborationCommandPath,
  collaborationRealtimeBackendSubscriptionsPath,
  createDesktopCollaborationBrokerLocalTransport
} from "./desktop-collaboration-broker-local-transport.js";
import {
  createCollaborationRendererClient,
  type CollaborationRendererBridge
} from "../../../apps/desktop/src/collaboration/renderer-client.js";

const requestId = "768ae5ae-fcbe-4e17-9d83-14a97d5f92a6";
const teamId = "cf9c6804-c83f-4a35-bb0d-12d8dc697e21";
const subscriptionId = "2a153f8e-00ed-4b65-a8f5-06b873b95934";
const connection = {
  apiUrl: "http://127.0.0.1:3300",
  backendId: "team-vps",
  authorization:
    "Koed-Desktop koed_desktop_0123456789abcdef0123456789abcdef01234567:0123456789abcdef0123456789abcdef0123456789a"
};
const personalConnection = { ...connection, backendId: null };
const userId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";
const notesId = "00000000-0000-4000-8000-000000000003";
const channelId = "00000000-0000-4000-8000-000000000004";
const teamPrincipalId = "00000000-0000-4000-8000-000000000007";
const timestamp = "2026-07-17T01:00:00.000Z";
const deliveryId = "delivery_id_00000000000000000000000000000001";

const fullSnapshot = (selectedTeam: boolean): CollaborationSnapshot => {
  const person = {
    id: userId,
    displayName: "Mark",
    presence: "available" as const,
    membershipState: "enabled" as const
  };
  const teamPrincipal = { ...person, id: teamPrincipalId };
  const teamPerson = {
    ...teamPrincipal,
    teamPresence: {
      mode: "auto" as const,
      manualStatus: "available" as const,
      activityLevel: "active" as const,
      lastActivityAt: timestamp,
      nextTransitionAt: "2026-07-17T01:05:00.001Z",
      preferenceVersion: 1
    }
  };
  const baseThread = {
    name: null,
    topic: null,
    version: 1,
    lifecycle: "active" as const,
    canPost: true,
    latestSequence: 0,
    unreadCount: 0,
    lastReadMessageId: null,
    lastReadSequence: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastActivityAt: timestamp,
    archivedAt: null
  };
  const notes = {
    ...baseThread,
    id: notesId,
    logicalId: "00000000-0000-4000-8000-000000000005",
    scope: "personal" as const,
    ownerUserId: userId,
    kind: "notes_to_self" as const,
    participants: [
      {
        id: userId,
        displayName: "Mark",
        membershipState: "enabled" as const
      }
    ]
  };
  const channel = {
    ...baseThread,
    id: channelId,
    logicalId: "00000000-0000-4000-8000-000000000006",
    scope: "team" as const,
    teamId,
    workspaceId,
    kind: "workspace_channel" as const,
    name: "general"
  };
  const selection = selectedTeam
    ? ({
        kind: "workspace_channel",
        teamId,
        workspaceId,
        threadId: channelId
      } as const)
    : ({ kind: "notes_to_self" } as const);
  const thread = selectedTeam ? channel : notes;
  return collaborationSnapshotSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    snapshotRevision: "snapshot.revision-000001",
    generatedAt: timestamp,
    connection: {
      state: "live",
      backendId: connection.backendId,
      connectedAt: timestamp,
      retryAt: null,
      reconnectAttempt: 0,
      protocolVersion: COLLABORATION_CONTRACT_VERSION
    },
    limits: COLLABORATION_DEFAULT_LIMITS,
    navigation: {
      personalOwner: person,
      teamPrincipal,
      personal: { memory: [], notesToSelf: notes, channels: [] },
      teams: [
        {
          id: teamId,
          name: "Koed Team",
          role: "owner",
          lifecycle: "active",
          unreadCount: 0,
          people: [teamPerson],
          directMessages: [],
          version: 1,
          workspaces: [
            {
              id: workspaceId,
              name: "Product",
              description: null,
              access: "write",
              lifecycle: "active",
              version: 1,
              channels: [channel],
              sharedMemory: []
            }
          ]
        }
      ]
    },
    selection,
    view: {
      kind: "thread",
      thread,
      messages: {
        snapshotRevision: "snapshot.revision-000001",
        threadId: thread.id,
        items: [],
        olderCursor: null,
        newerCursor: null,
        hasOlder: false,
        hasNewer: false
      }
    }
  });
};

const commandSuccess = (
  command: CollaborationRendererCommand,
  snapshot: CollaborationSnapshot
) =>
  Response.json({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    requestId: command.requestId,
    command: command.command,
    ok: true,
    data: { snapshot }
  });

const brokerSnapshot = (scope: "personal" | "team", version = 1) => ({
  protocolVersion: COLLABORATION_CONTRACT_VERSION,
  subscription: {
    id: subscriptionId,
    protocolVersion: COLLABORATION_CONTRACT_VERSION,
    scope: scope === "team" ? { scope, teamId } : { scope },
    state: "awaiting_snapshot_ack",
    version,
    expiresAt: "2026-07-17T02:00:00.000Z"
  },
  delivery: {
    deliveryId,
    eventId: null,
    type: "snapshot",
    snapshot:
      scope === "team"
        ? { scope, teamId, threads: [] }
        : {
            scope,
            personalOwnerUserId: userId,
            highWaterCursor: 10,
            threads: []
          }
  }
});

const context = (controller = new AbortController()) => ({
  ownerId: "renderer-1",
  signal: controller.signal,
  emitCollaborationEvent: vi.fn<(event: CollaborationRendererEvent) => void>()
});

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition was not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("Desktop collaboration local transport", () => {
  it("revokes persisted local subscriptions for exactly one backend", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        protocolVersion: COLLABORATION_CONTRACT_VERSION,
        revokedSubscriptionCount: 2
      })
    );
    const resolveConnection = vi.fn(async () => personalConnection);
    const transport = createDesktopCollaborationBrokerLocalTransport({
      fetch: fetchMock,
      resolveConnection
    });

    await expect(
      transport.revokeBackendSubscriptions("team-vps")
    ).resolves.toBe(true);
    expect(resolveConnection).toHaveBeenCalledWith(false);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      new URL(
        collaborationRealtimeBackendSubscriptionsPath("team-vps"),
        personalConnection.apiUrl
      ).toString()
    );
    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(requestInit).toMatchObject({
      method: "DELETE",
      redirect: "error"
    });
    expect(new Headers(requestInit?.headers).get("authorization")).toBe(
      personalConnection.authorization
    );
  });
  it("calculates deterministic capped exponential reconnect delays", () => {
    expect(calculateCollaborationReconnectDelay(1, 0)).toBe(200);
    expect(calculateCollaborationReconnectDelay(1, 0.5)).toBe(250);
    expect(calculateCollaborationReconnectDelay(2, 1)).toBe(600);
    expect(calculateCollaborationReconnectDelay(30, 1)).toBe(
      COLLABORATION_RECONNECT_BACKOFF_CAP_MS
    );
  });

  it.each([
    { kind: "notes_to_self" as const },
    { kind: "personal_channel" as const, threadId: notesId }
  ])("keeps $kind selection on the Personal local path", async (selection) => {
    const resolveConnection = vi.fn(async (requiresTeamBackend: boolean) =>
      requiresTeamBackend ? connection : personalConnection
    );
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        upstream_backend_id?: string;
        command: CollaborationRendererCommand;
      };
      expect(body.upstream_backend_id).toBeUndefined();
      return commandSuccess(body.command, fullSnapshot(false));
    });
    const transport = createDesktopCollaborationBrokerLocalTransport({
      fetch: fetchMock,
      resolveConnection
    });
    const result = await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId,
        command: "collaboration.select",
        input: { selection }
      }),
      context()
    );

    expect(result.ok).toBe(true);
    expect(resolveConnection).toHaveBeenCalledWith(false, undefined);
  });

  it.each([
    { kind: "team_people" as const, teamId },
    {
      kind: "workspace_channel" as const,
      teamId,
      workspaceId,
      threadId: channelId
    },
    {
      kind: "team_direct_message" as const,
      teamId,
      threadId: channelId
    },
    {
      kind: "workspace_shared_memory" as const,
      teamId,
      workspaceId
    },
    {
      kind: "shared_session" as const,
      teamId,
      workspaceId,
      sharedSessionId: notesId
    }
  ])(
    "routes $kind selection through the active Team backend",
    async (selection) => {
      const resolveConnection = vi.fn(async (requiresTeamBackend: boolean) =>
        requiresTeamBackend ? connection : personalConnection
      );
      const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          upstream_backend_id?: string;
          command: CollaborationRendererCommand;
        };
        expect(body.upstream_backend_id).toBe(connection.backendId);
        return commandSuccess(body.command, fullSnapshot(true));
      });
      const transport = createDesktopCollaborationBrokerLocalTransport({
        fetch: fetchMock,
        resolveConnection
      });

      const result = await transport.request(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId,
          command: "collaboration.select",
          input: { selection }
        }),
        context()
      );

      expect(result.ok).toBe(true);
      expect(resolveConnection).toHaveBeenCalledWith(true, undefined);
    }
  );

  it("maps oversized and uncorrelated command responses to correlated safe errors", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("{}", {
          headers: { "content-length": String(33 * 1024 * 1024) }
        })
      )
      .mockResolvedValueOnce(
        Response.json({
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
        })
      );
    const transport = createDesktopCollaborationBrokerLocalTransport({
      fetch: fetchMock,
      resolveConnection: async () => personalConnection
    });
    const command = collaborationRendererCommandSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId,
      command: "collaboration.load",
      input: {}
    });

    await expect(transport.request(command, context())).resolves.toMatchObject({
      requestId,
      command: "collaboration.load",
      ok: false,
      error: { code: "internal_error" }
    });
    await expect(transport.request(command, context())).resolves.toMatchObject({
      requestId,
      command: "collaboration.load",
      ok: false,
      error: { code: "internal_error" }
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${connection.apiUrl}${collaborationCommandPath}`
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      command
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: personalConnection.authorization
    });
  });

  it("requires a backend only for Team commands while always using the Desktop local credential", async () => {
    const resolveConnection = vi.fn(async (requiresTeamBackend: boolean) =>
      requiresTeamBackend ? connection : personalConnection
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
          ok: false,
          error: {
            code: "not_available",
            userMessage: collaborationSafeErrorMessages.not_available,
            retryable: false,
            retryAfterMs: null
          }
        });
      });
    const transport = createDesktopCollaborationBrokerLocalTransport({
      fetch: fetchMock,
      resolveConnection
    });
    const personal = collaborationRendererCommandSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId,
      command: "collaboration.load",
      input: {}
    });
    const team = collaborationRendererCommandSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: "5a1f3c7c-72f2-49c1-9c83-d8e81e5c57ec",
      command: "collaboration.create_workspace_channel",
      input: {
        teamId,
        workspaceId: "6fbd9d67-aead-4eca-a85a-c24330a9f3a1",
        name: "delivery",
        topic: null
      }
    });

    await transport.request(personal, context());
    await transport.request(team, context());

    expect(resolveConnection).toHaveBeenNthCalledWith(1, false, undefined);
    expect(resolveConnection).toHaveBeenNthCalledWith(2, true, undefined);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      command: personal
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      upstream_backend_id: connection.backendId,
      command: team
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: personalConnection.authorization
    });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: connection.authorization
    });
  });

  it("uses the atomic Team broker snapshot, applies before ack, and binds every realtime request", async () => {
    const brokerEvent = {
      protocolVersion: COLLABORATION_CONTRACT_VERSION,
      deliveryId: "delivery_id_00000000000000000000000000000002",
      eventId: "703af56b-8e88-4945-b395-eeac7c68a4a6",
      type: "message_created",
      occurredAt: timestamp,
      subscription: { id: subscriptionId },
      resource: {
        scope: "team",
        type: "message",
        id: "703af56b-8e88-4945-b395-eeac7c68a4a6",
        teamId,
        teamWorkspaceId: workspaceId,
        threadId: channelId,
        messageId: "703af56b-8e88-4945-b395-eeac7c68a4a6",
        shareGrantId: null,
        logicalMemoryId: null
      },
      actor: { principalId: userId }
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, init) => {
        const value = String(url);
        if (value.endsWith(collaborationCommandPath)) {
          const body = JSON.parse(String(init?.body)) as {
            command: CollaborationRendererCommand;
          };
          return commandSuccess(body.command, fullSnapshot(true));
        }
        if (value.endsWith("/realtime/subscriptions")) {
          return Response.json(brokerSnapshot("team", 0));
        }
        if (value.endsWith("/ack")) {
          return Response.json({
            protocolVersion: COLLABORATION_CONTRACT_VERSION,
            subscription: {
              id: subscriptionId,
              protocolVersion: COLLABORATION_CONTRACT_VERSION,
              scope: { scope: "team", teamId },
              state: "active",
              version: 1,
              expiresAt: "2026-07-17T02:00:00.000Z"
            }
          });
        }
        if (value.includes("/stream?")) {
          return new Response(
            `event: ready\ndata: ${JSON.stringify({ protocolVersion: COLLABORATION_CONTRACT_VERSION, subscription: { id: subscriptionId, state: "active", version: 1 } })}\n\n: heartbeat\n\nevent: collaboration_event\ndata: ${JSON.stringify(brokerEvent)}\n\n`,
            { headers: { "content-type": "text/event-stream" } }
          );
        }
        throw new Error(`Unexpected URL ${value}`);
      });
    const owner = new AbortController();
    const events: CollaborationRendererEvent[] = [];
    const transportContext = {
      ownerId: "renderer-1",
      signal: owner.signal,
      emitCollaborationEvent: (event: CollaborationRendererEvent) => {
        events.push(event);
        if (event.type === "control") owner.abort();
      }
    };
    const transport = createDesktopCollaborationBrokerLocalTransport({
      fetch: fetchMock,
      resolveConnection: async () => connection,
      now: () => Date.parse("2026-07-17T01:00:00.000Z")
    });
    const select = collaborationRendererCommandSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId,
      command: "collaboration.select",
      input: { selection: fullSnapshot(true).selection }
    });
    await transport.request(select, transportContext);
    const subscribe = collaborationRendererCommandSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: "5a1f3c7c-72f2-49c1-9c83-d8e81e5c57ec",
      command: "collaboration.subscribe",
      input: { scope: { scope: "team", teamId } }
    });

    await expect(
      transport.request(subscribe, transportContext)
    ).resolves.toMatchObject({
      ok: true,
      data: { subscription: { id: subscriptionId } }
    });
    await waitFor(() => events.some((event) => event.type === "snapshot"));
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/stream?"))
    ).toBe(false);
    const snapshotEvent = events.find((event) => event.type === "snapshot")!;
    await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "7159acdc-4c81-4a31-b2f0-221119a0d88d",
        command: "collaboration.acknowledge_delivery",
        input: {
          subscriptionId,
          deliveryId: snapshotEvent.deliveryId,
          eventId: null,
          expectedSubscriptionVersion: snapshotEvent.subscription.version
        }
      }),
      transportContext
    );
    await waitFor(() => owner.signal.aborted);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "control", reason: "requires_snapshot" })
    );
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/stream?"))
    ).toHaveLength(1);
    const streamCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/stream?")
    );
    expect(String(streamCall?.[0])).toBe(
      `${connection.apiUrl}/v1/local-edge/collaboration/realtime/subscriptions/${subscriptionId}/stream?scope=team&upstream_backend_id=team-vps&team_id=${teamId}`
    );
    const createCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/realtime/subscriptions")
    );
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      scope: "team",
      upstream_backend_id: connection.backendId,
      team_id: teamId
    });
    const ackCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/ack")
    );
    expect(JSON.parse(String(ackCall?.[1]?.body))).toEqual({
      scope: "team",
      upstream_backend_id: connection.backendId,
      team_id: teamId,
      delivery_id: deliveryId,
      event_id: null,
      expected_version: 0
    });
  });

  it("requires an authoritative snapshot when a delivery acknowledgement conflicts", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, init) => {
        const value = String(url);
        if (value.endsWith(collaborationCommandPath)) {
          const body = JSON.parse(String(init?.body)) as {
            command: CollaborationRendererCommand;
          };
          return commandSuccess(body.command, fullSnapshot(true));
        }
        if (value.endsWith("/realtime/subscriptions")) {
          return Response.json(brokerSnapshot("team", 0));
        }
        if (value.endsWith("/ack")) {
          return Response.json(
            { error: "Delivery order changed" },
            { status: 409 }
          );
        }
        throw new Error(`Unexpected URL ${value}`);
      });
    const events: CollaborationRendererEvent[] = [];
    const transportContext = {
      ownerId: "renderer-1",
      signal: new AbortController().signal,
      emitCollaborationEvent: (event: CollaborationRendererEvent) =>
        events.push(event)
    };
    const transport = createDesktopCollaborationBrokerLocalTransport({
      fetch: fetchMock,
      resolveConnection: async () => connection
    });
    await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId,
        command: "collaboration.select",
        input: { selection: fullSnapshot(true).selection }
      }),
      transportContext
    );
    await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "5a1f3c7c-72f2-49c1-9c83-d8e81e5c57ec",
        command: "collaboration.subscribe",
        input: { scope: { scope: "team", teamId } }
      }),
      transportContext
    );
    await waitFor(() => events.some((event) => event.type === "snapshot"));
    const snapshotEvent = events.find((event) => event.type === "snapshot")!;
    const result = await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "7159acdc-4c81-4a31-b2f0-221119a0d88d",
        command: "collaboration.acknowledge_delivery",
        input: {
          subscriptionId,
          deliveryId: snapshotEvent.deliveryId,
          eventId: null,
          expectedSubscriptionVersion: snapshotEvent.subscription.version
        }
      }),
      transportContext
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "conflict", retryable: true }
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "control", reason: "requires_snapshot" })
    );
    expect(
      events.some(
        (event) =>
          event.type === "connection" &&
          event.connection.state === "access_revoked"
      )
    ).toBe(false);
  });

  it("requires an authoritative snapshot when the broker stream conflicts", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, init) => {
        const value = String(url);
        if (value.endsWith(collaborationCommandPath)) {
          const body = JSON.parse(String(init?.body)) as {
            command: CollaborationRendererCommand;
          };
          return commandSuccess(body.command, fullSnapshot(true));
        }
        if (value.endsWith("/realtime/subscriptions")) {
          return Response.json(brokerSnapshot("team", 0));
        }
        if (value.endsWith("/ack")) {
          return Response.json({
            protocolVersion: COLLABORATION_CONTRACT_VERSION,
            subscription: {
              id: subscriptionId,
              protocolVersion: COLLABORATION_CONTRACT_VERSION,
              scope: { scope: "team", teamId },
              state: "active",
              version: 1,
              expiresAt: "2026-07-17T02:00:00.000Z"
            }
          });
        }
        if (value.includes("/stream?")) {
          return new Response(null, { status: 409 });
        }
        throw new Error(`Unexpected URL ${value}`);
      });
    const owner = new AbortController();
    const events: CollaborationRendererEvent[] = [];
    const transport = createDesktopCollaborationBrokerLocalTransport({
      fetch: fetchMock,
      resolveConnection: async () => connection
    });
    const transportContext = {
      ownerId: "renderer-1",
      signal: owner.signal,
      emitCollaborationEvent: (event: CollaborationRendererEvent) =>
        events.push(event)
    };
    await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId,
        command: "collaboration.select",
        input: { selection: fullSnapshot(true).selection }
      }),
      transportContext
    );
    await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "5a1f3c7c-72f2-49c1-9c83-d8e81e5c57ec",
        command: "collaboration.subscribe",
        input: { scope: { scope: "team", teamId } }
      }),
      transportContext
    );
    await waitFor(() => events.some((event) => event.type === "snapshot"));
    const event = events.find((item) => item.type === "snapshot")!;
    await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "7159acdc-4c81-4a31-b2f0-221119a0d88d",
        command: "collaboration.acknowledge_delivery",
        input: {
          subscriptionId,
          deliveryId: event.deliveryId,
          eventId: null,
          expectedSubscriptionVersion: event.subscription.version
        }
      }),
      transportContext
    );
    await waitFor(() =>
      events.some(
        (item) => item.type === "control" && item.reason === "requires_snapshot"
      )
    );
    expect(
      events.some(
        (item) =>
          item.type === "connection" &&
          item.connection.state === "access_revoked"
      )
    ).toBe(false);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/stream?"))
    ).toHaveLength(1);
    owner.abort();
  });

  it("refreshes the bound Team connection before reconnecting a stream", async () => {
    const rotatedConnection = {
      ...connection,
      authorization:
        "Koed-Desktop koed_desktop_abcdefabcdefabcdefabcdefabcdefabcdefabcd:abcdefabcdefabcdefabcdefabcdefabcdefabcdefa"
    };
    let streamAttempts = 0;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, init) => {
        const value = String(url);
        if (value.endsWith(collaborationCommandPath)) {
          const body = JSON.parse(String(init?.body)) as {
            command: CollaborationRendererCommand;
          };
          return commandSuccess(body.command, fullSnapshot(true));
        }
        if (value.endsWith("/realtime/subscriptions")) {
          return Response.json(brokerSnapshot("team", 0));
        }
        if (value.endsWith("/ack")) {
          return Response.json({
            protocolVersion: COLLABORATION_CONTRACT_VERSION,
            subscription: {
              id: subscriptionId,
              protocolVersion: COLLABORATION_CONTRACT_VERSION,
              scope: { scope: "team", teamId },
              state: "active",
              version: 1,
              expiresAt: "2026-07-17T02:00:00.000Z"
            }
          });
        }
        if (value.includes("/stream?")) {
          streamAttempts += 1;
          if (streamAttempts === 1) return new Response(null, { status: 424 });
          expect(init?.headers).toMatchObject({
            authorization: rotatedConnection.authorization
          });
          return new Response(
            `event: control\ndata: ${JSON.stringify({ protocolVersion: COLLABORATION_CONTRACT_VERSION, subscription: { id: subscriptionId }, reason: "server_shutdown" })}\n\n`,
            { headers: { "content-type": "text/event-stream" } }
          );
        }
        throw new Error(`Unexpected URL ${value}`);
      });
    const resolveConnection = vi
      .fn()
      .mockResolvedValueOnce(connection)
      .mockResolvedValueOnce(connection)
      .mockResolvedValueOnce(rotatedConnection);
    const owner = new AbortController();
    const events: CollaborationRendererEvent[] = [];
    const transport = createDesktopCollaborationBrokerLocalTransport({
      fetch: fetchMock,
      resolveConnection,
      sleep: async () => undefined
    });
    const transportContext = {
      ownerId: "renderer-1",
      signal: owner.signal,
      emitCollaborationEvent: (event: CollaborationRendererEvent) =>
        events.push(event)
    };
    await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId,
        command: "collaboration.select",
        input: { selection: fullSnapshot(true).selection }
      }),
      transportContext
    );
    await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "5a1f3c7c-72f2-49c1-9c83-d8e81e5c57ec",
        command: "collaboration.subscribe",
        input: { scope: { scope: "team", teamId } }
      }),
      transportContext
    );
    await waitFor(() => events.some((event) => event.type === "snapshot"));
    const snapshot = events.find((event) => event.type === "snapshot")!;
    await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "7159acdc-4c81-4a31-b2f0-221119a0d88d",
        command: "collaboration.acknowledge_delivery",
        input: {
          subscriptionId,
          deliveryId: snapshot.deliveryId,
          eventId: null,
          expectedSubscriptionVersion: snapshot.subscription.version
        }
      }),
      transportContext
    );

    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "control" && event.reason === "server_shutdown"
      )
    );
    expect(streamAttempts).toBe(2);
    expect(resolveConnection).toHaveBeenLastCalledWith(
      true,
      connection.backendId
    );
    owner.abort();
  });

  it("keeps inactive Team stream health out of the active renderer state", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    let releaseDelayedTeamSelection: (() => void) | null = null;
    let teamSelectionCount = 0;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, init) => {
        const value = String(url);
        if (value.endsWith(collaborationCommandPath)) {
          const body = JSON.parse(String(init?.body)) as {
            command: CollaborationRendererCommand;
          };
          const selectedTeam =
            body.command.command === "collaboration.select" &&
            "teamId" in body.command.input.selection;
          if (selectedTeam) teamSelectionCount += 1;
          if (selectedTeam && teamSelectionCount === 2) {
            await new Promise<void>((resolve) => {
              releaseDelayedTeamSelection = resolve;
            });
          }
          return commandSuccess(body.command, fullSnapshot(selectedTeam));
        }
        if (value.endsWith("/realtime/subscriptions")) {
          return Response.json(brokerSnapshot("team"));
        }
        if (value.endsWith("/ack")) {
          return Response.json({
            protocolVersion: COLLABORATION_CONTRACT_VERSION,
            subscription: {
              id: subscriptionId,
              protocolVersion: COLLABORATION_CONTRACT_VERSION,
              scope: { scope: "team", teamId },
              state: "active",
              version: 1,
              expiresAt: "2026-07-17T02:00:00.000Z"
            }
          });
        }
        if (value.includes("/stream?")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
              }
            }),
            { headers: { "content-type": "text/event-stream" } }
          );
        }
        throw new Error(`Unexpected URL ${value}`);
      });
    const owner = new AbortController();
    const events: CollaborationRendererEvent[] = [];
    const transport = createDesktopCollaborationBrokerLocalTransport({
      fetch: fetchMock,
      resolveConnection: async (requiresTeamBackend) =>
        requiresTeamBackend ? connection : personalConnection
    });
    const transportContext = {
      ownerId: "renderer-1",
      signal: owner.signal,
      emitCollaborationEvent: (event: CollaborationRendererEvent) =>
        events.push(event)
    };
    const select = (
      selectedTeam: boolean,
      requestId: string,
      navigationIntent?: "foreground" | "prewarm"
    ) =>
      transport.request(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId,
          command: "collaboration.select",
          input: {
            selection: fullSnapshot(selectedTeam).selection,
            ...(navigationIntent ? { navigationIntent } : {})
          }
        }),
        transportContext
      );

    await select(true, requestId);
    const delayedTeamSelection = select(
      true,
      "44dfb243-f750-4d36-8360-e8de8768819e"
    );
    await waitFor(() => releaseDelayedTeamSelection !== null);
    await select(false, "5a1f3c7c-72f2-49c1-9c83-d8e81e5c57ec");
    releaseDelayedTeamSelection!();
    await delayedTeamSelection;
    await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "7159acdc-4c81-4a31-b2f0-221119a0d88d",
        command: "collaboration.subscribe",
        input: { scope: { scope: "team", teamId } }
      }),
      transportContext
    );
    await waitFor(() => events.some((event) => event.type === "snapshot"));
    const snapshot = events.find((event) => event.type === "snapshot")!;
    await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "99dfb243-f750-4d36-8360-e8de8768819e",
        command: "collaboration.acknowledge_delivery",
        input: {
          subscriptionId,
          deliveryId: snapshot.deliveryId,
          eventId: null,
          expectedSubscriptionVersion: snapshot.subscription.version
        }
      }),
      transportContext
    );
    await waitFor(() => streamController !== null);
    expect(events.filter((event) => event.type === "connection")).toEqual([]);

    await select(true, "5fb03c7c-72f2-49c1-9c83-d8e81e5c57ec", "prewarm");
    streamController!.enqueue(
      new TextEncoder().encode(
        `event: connection\ndata: ${JSON.stringify({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          type: "connection",
          connection: fullSnapshot(true).connection,
          error: null
        })}\n\n`
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.filter((event) => event.type === "connection")).toEqual([]);

    await select(true, "88dfb243-f750-4d36-8360-e8de8768819e");
    streamController!.enqueue(
      new TextEncoder().encode(
        `event: connection\ndata: ${JSON.stringify({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          type: "connection",
          connection: fullSnapshot(true).connection,
          error: null
        })}\n\n`
      )
    );
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "connection" && event.connection.state === "live"
      )
    );
    expect(events.some((event) => event.type === "snapshot")).toBe(true);

    await select(false, "13dfb243-f750-4d36-8360-e8de8768819e");
    streamController!.enqueue(
      new TextEncoder().encode(
        `event: connection\ndata: ${JSON.stringify({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          type: "connection",
          connection: {
            ...fullSnapshot(true).connection,
            state: "access_revoked",
            connectedAt: null
          },
          error: {
            code: "access_revoked",
            userMessage: collaborationSafeErrorMessages.access_revoked,
            retryable: false,
            retryAfterMs: null
          }
        })}\n\n`
      )
    );
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "connection" &&
          event.connection.state === "access_revoked"
      )
    );
    owner.abort();
  });

  it("acknowledges and unsubscribes Personal deliveries with the complete binding", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, init) => {
        const value = String(url);
        if (value.endsWith(collaborationCommandPath)) {
          const body = JSON.parse(String(init?.body)) as {
            command: CollaborationRendererCommand;
          };
          return commandSuccess(body.command, fullSnapshot(false));
        }
        if (value.endsWith("/realtime/subscriptions")) {
          return Response.json(brokerSnapshot("personal"));
        }
        if (value.endsWith("/ack")) {
          return Response.json({
            protocolVersion: COLLABORATION_CONTRACT_VERSION,
            subscription: {
              id: subscriptionId,
              protocolVersion: COLLABORATION_CONTRACT_VERSION,
              scope: { scope: "personal" },
              state: "active",
              version: 1,
              expiresAt: "2026-07-17T02:00:00.000Z"
            }
          });
        }
        if (init?.method === "DELETE") {
          return Response.json({
            protocolVersion: COLLABORATION_CONTRACT_VERSION,
            subscription: {}
          });
        }
        if (value.includes("/stream?")) {
          return new Response(
            `event: connection\ndata: ${JSON.stringify({ contractVersion: COLLABORATION_CONTRACT_VERSION, type: "connection", connection: { state: "live", backendId: null, connectedAt: timestamp, retryAt: null, reconnectAttempt: 0, protocolVersion: COLLABORATION_CONTRACT_VERSION }, error: null })}\n\nevent: ready\ndata: ${JSON.stringify({ protocolVersion: COLLABORATION_CONTRACT_VERSION, subscription: { id: subscriptionId, state: "active", version: 1 } })}\n\n`,
            { headers: { "content-type": "text/event-stream" } }
          );
        }
        throw new Error(`Unexpected URL ${value}`);
      });
    const owner = new AbortController();
    const events: CollaborationRendererEvent[] = [];
    const transport = createDesktopCollaborationBrokerLocalTransport({
      fetch: fetchMock,
      resolveConnection: async () => personalConnection,
      sleep: async (_delay, signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true })
        );
      }
    });
    const transportContext = {
      ownerId: "renderer-1",
      signal: owner.signal,
      emitCollaborationEvent: (event: CollaborationRendererEvent) =>
        events.push(event)
    };
    await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId,
        command: "collaboration.load",
        input: {}
      }),
      transportContext
    );
    await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "5a1f3c7c-72f2-49c1-9c83-d8e81e5c57ec",
        command: "collaboration.subscribe",
        input: { scope: { scope: "personal" } }
      }),
      transportContext
    );
    await waitFor(() => events.some((event) => event.type === "snapshot"));
    expect(events.some((event) => event.type === "connection")).toBe(false);
    const event = events.find((item) => item.type === "snapshot")!;
    await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "7159acdc-4c81-4a31-b2f0-221119a0d88d",
        command: "collaboration.acknowledge_delivery",
        input: {
          subscriptionId,
          deliveryId: event.deliveryId,
          eventId: null,
          expectedSubscriptionVersion: event.subscription.version
        }
      }),
      transportContext
    );
    await expect(
      transport.request(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: "99dfb243-f750-4d36-8360-e8de8768819e",
          command: "collaboration.unsubscribe",
          input: { subscriptionId }
        }),
        transportContext
      )
    ).resolves.toMatchObject({ ok: true, data: {} });
    const ackCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/ack")
    );
    expect(JSON.parse(String(ackCall?.[1]?.body))).toEqual({
      scope: "personal",
      delivery_id: deliveryId,
      event_id: null,
      expected_version: 1
    });
    const unsubscribeCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "DELETE"
    );
    expect(JSON.parse(String(unsubscribeCall?.[1]?.body))).toEqual({
      scope: "personal",
      expected_version: 1
    });
    owner.abort();
  });

  it("does not reconnect when an intentional Team unsubscribe closes the stream first", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, init) => {
        const value = String(url);
        if (value.endsWith(collaborationCommandPath)) {
          const body = JSON.parse(String(init?.body)) as {
            command: CollaborationRendererCommand;
          };
          return commandSuccess(body.command, fullSnapshot(true));
        }
        if (value.endsWith("/realtime/subscriptions")) {
          return Response.json(brokerSnapshot("team"));
        }
        if (value.endsWith("/ack")) {
          return Response.json({
            protocolVersion: COLLABORATION_CONTRACT_VERSION,
            subscription: {
              id: subscriptionId,
              protocolVersion: COLLABORATION_CONTRACT_VERSION,
              scope: { scope: "team", teamId },
              state: "active",
              version: 1,
              expiresAt: "2026-07-17T02:00:00.000Z"
            }
          });
        }
        if (value.includes("/stream?")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
                controller.enqueue(
                  new TextEncoder().encode(
                    `event: ready\ndata: ${JSON.stringify({ protocolVersion: COLLABORATION_CONTRACT_VERSION, subscription: { id: subscriptionId, state: "active", version: 1 } })}\n\n`
                  )
                );
              }
            }),
            { headers: { "content-type": "text/event-stream" } }
          );
        }
        if (init?.method === "DELETE") {
          try {
            streamController?.close();
          } catch {
            // The intentional local abort may already have canceled the body.
          }
          await new Promise((resolve) => setTimeout(resolve, 0));
          return Response.json({
            protocolVersion: COLLABORATION_CONTRACT_VERSION,
            subscription: {}
          });
        }
        throw new Error(`Unexpected URL ${value}`);
      });
    const owner = new AbortController();
    const events: CollaborationRendererEvent[] = [];
    const transport = createDesktopCollaborationBrokerLocalTransport({
      fetch: fetchMock,
      resolveConnection: async () => connection,
      random: () => 0
    });
    const transportContext = {
      ownerId: "renderer-1",
      signal: owner.signal,
      emitCollaborationEvent: (event: CollaborationRendererEvent) =>
        events.push(event)
    };

    await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId,
        command: "collaboration.select",
        input: { selection: fullSnapshot(true).selection }
      }),
      transportContext
    );
    await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "5a1f3c7c-72f2-49c1-9c83-d8e81e5c57ec",
        command: "collaboration.subscribe",
        input: { scope: { scope: "team", teamId } }
      }),
      transportContext
    );
    await waitFor(() => events.some((event) => event.type === "snapshot"));
    const snapshot = events.find((event) => event.type === "snapshot")!;
    await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "7159acdc-4c81-4a31-b2f0-221119a0d88d",
        command: "collaboration.acknowledge_delivery",
        input: {
          subscriptionId,
          deliveryId: snapshot.deliveryId,
          eventId: null,
          expectedSubscriptionVersion: snapshot.subscription.version
        }
      }),
      transportContext
    );
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "connection" && event.connection.state === "live"
      )
    );
    events.length = 0;

    await expect(
      transport.request(
        collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: "99dfb243-f750-4d36-8360-e8de8768819e",
          command: "collaboration.unsubscribe",
          input: { subscriptionId }
        }),
        transportContext
      )
    ).resolves.toMatchObject({ ok: true, data: {} });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(
      events.some(
        (event) =>
          event.type === "connection" &&
          event.connection.state === "reconnecting"
      )
    ).toBe(false);
    owner.abort();
  });

  it("waits for an in-flight acknowledgement before deleting a subscription", async () => {
    let releaseAcknowledgement!: () => void;
    const acknowledgementBlocked = new Promise<void>((resolve) => {
      releaseAcknowledgement = resolve;
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, init) => {
        const value = String(url);
        if (value.endsWith(collaborationCommandPath)) {
          const body = JSON.parse(String(init?.body)) as {
            command: CollaborationRendererCommand;
          };
          return commandSuccess(body.command, fullSnapshot(true));
        }
        if (value.endsWith("/realtime/subscriptions")) {
          return Response.json(brokerSnapshot("team"));
        }
        if (value.endsWith("/ack")) {
          await acknowledgementBlocked;
          return Response.json({
            protocolVersion: COLLABORATION_CONTRACT_VERSION,
            subscription: {
              id: subscriptionId,
              protocolVersion: COLLABORATION_CONTRACT_VERSION,
              scope: { scope: "team", teamId },
              state: "active",
              version: 2,
              expiresAt: "2026-07-17T02:00:00.000Z"
            }
          });
        }
        if (init?.method === "DELETE") {
          return Response.json({
            protocolVersion: COLLABORATION_CONTRACT_VERSION,
            subscription: {}
          });
        }
        if (value.includes("/stream?")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start() {}
            }),
            { headers: { "content-type": "text/event-stream" } }
          );
        }
        throw new Error(`Unexpected URL ${value}`);
      });
    const owner = new AbortController();
    const events: CollaborationRendererEvent[] = [];
    const transport = createDesktopCollaborationBrokerLocalTransport({
      fetch: fetchMock,
      resolveConnection: async () => connection
    });
    const transportContext = {
      ownerId: "renderer-1",
      signal: owner.signal,
      emitCollaborationEvent: (event: CollaborationRendererEvent) =>
        events.push(event)
    };
    await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId,
        command: "collaboration.select",
        input: { selection: fullSnapshot(true).selection }
      }),
      transportContext
    );
    await transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId,
        command: "collaboration.subscribe",
        input: { scope: { scope: "team", teamId } }
      }),
      transportContext
    );
    await waitFor(() => events.some((event) => event.type === "snapshot"));
    const snapshot = events.find((event) => event.type === "snapshot")!;
    const acknowledgement = transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "7159acdc-4c81-4a31-b2f0-221119a0d88d",
        command: "collaboration.acknowledge_delivery",
        input: {
          subscriptionId,
          deliveryId: snapshot.deliveryId,
          eventId: null,
          expectedSubscriptionVersion: snapshot.subscription.version
        }
      }),
      transportContext
    );
    await waitFor(() =>
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("/ack"))
    );
    const unsubscribe = transport.request(
      collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "99dfb243-f750-4d36-8360-e8de8768819e",
        command: "collaboration.unsubscribe",
        input: { subscriptionId }
      }),
      transportContext
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")
    ).toBe(false);

    releaseAcknowledgement();
    await expect(acknowledgement).resolves.toMatchObject({ ok: true });
    await expect(unsubscribe).resolves.toMatchObject({ ok: true, data: {} });
    const deleteCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "DELETE"
    );
    expect(JSON.parse(String(deleteCall?.[1]?.body))).toMatchObject({
      expected_version: 2
    });
    owner.abort();
  });

  it("reloads Team state across a composed renderer stream conflict", async () => {
    const subscriptionIds = [
      "00000000-0000-4000-8000-000000000021",
      "00000000-0000-4000-8000-000000000022",
      "00000000-0000-4000-8000-000000000023",
      "00000000-0000-4000-8000-000000000024"
    ];
    let subscriptionIndex = 0;
    let teamStreamAttempts = 0;
    const scopes = new Map<string, "personal" | "team">();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, init) => {
        const value = String(url);
        if (value.endsWith(collaborationCommandPath)) {
          const body = JSON.parse(String(init?.body)) as {
            command: CollaborationRendererCommand;
          };
          return commandSuccess(
            body.command,
            fullSnapshot(body.command.command === "collaboration.select")
          );
        }
        if (value.endsWith("/realtime/subscriptions")) {
          const body = JSON.parse(String(init?.body)) as {
            scope: "personal" | "team";
          };
          const id = subscriptionIds[subscriptionIndex++]!;
          scopes.set(id, body.scope);
          const response = brokerSnapshot(
            body.scope,
            body.scope === "team" ? 0 : 1
          );
          response.subscription.id = id;
          response.delivery.deliveryId = `delivery_000000000000000000000000000000${subscriptionIndex + 20}`;
          return Response.json(response);
        }
        if (value.endsWith("/ack")) {
          const id = value.split("/").at(-2)!;
          const scope = scopes.get(id)!;
          return Response.json({
            protocolVersion: COLLABORATION_CONTRACT_VERSION,
            subscription: {
              id,
              protocolVersion: COLLABORATION_CONTRACT_VERSION,
              scope: scope === "team" ? { scope, teamId } : { scope },
              state: "active",
              version: 1,
              expiresAt: "2026-07-17T02:00:00.000Z"
            }
          });
        }
        if (value.includes("/stream?")) {
          const scope = scopes.get(value.split("/").at(-2)!.split("?")[0]!);
          if (scope === "team" && teamStreamAttempts++ === 0) {
            return new Response(null, { status: 409 });
          }
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `event: ready\ndata: ${JSON.stringify({ protocolVersion: COLLABORATION_CONTRACT_VERSION, subscription: { id: value.split("/").at(-2)!.split("?")[0]!, state: "active", version: 1 } })}\n\n`
                  )
                );
              }
            }),
            { headers: { "content-type": "text/event-stream" } }
          );
        }
        if (init?.method === "DELETE") {
          return Response.json({
            protocolVersion: COLLABORATION_CONTRACT_VERSION,
            subscription: {}
          });
        }
        throw new Error(`Unexpected URL ${value}`);
      });
    const transport = createDesktopCollaborationBrokerLocalTransport({
      fetch: fetchMock,
      resolveConnection: async (requiresTeam) =>
        requiresTeam ? connection : personalConnection
    });

    const runRenderer = async (ownerId: string) => {
      const owner = new AbortController();
      const listeners = new Set<(event: CollaborationRendererEvent) => void>();
      const transportContext = {
        ownerId,
        signal: owner.signal,
        emitCollaborationEvent: (event: CollaborationRendererEvent) => {
          for (const listener of listeners) listener(event);
        }
      };
      const bridge: CollaborationRendererBridge = {
        command: (command) => transport.request(command, transportContext),
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }
      };
      const client = createCollaborationRendererClient(bridge);
      await client.load();
      await client.select(fullSnapshot(true).selection);
      await waitFor(
        () =>
          client.current()?.navigation.teams.length === 1 &&
          subscriptionIndex >= 4 &&
          fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/ack"))
            .length >= 4
      );
      client.dispose();
      owner.abort();
    };

    await runRenderer("renderer-1");
    expect(subscriptionIndex).toBeGreaterThanOrEqual(4);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/ack"))
    ).toHaveLength(subscriptionIndex);
  });
});
