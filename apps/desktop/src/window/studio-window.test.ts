import { describe, expect, it, vi } from "vitest";
import {
  COLLABORATION_CONTRACT_VERSION,
  COLLABORATION_DEFAULT_LIMITS,
  collaborationRendererCommandSchema,
  collaborationSafeErrorMessages,
  type CollaborationRendererCommand
} from "@koed/shared";
import {
  createStudioWindowController,
  resolveStudioPaths,
  type StudioGatewayOptions,
  type StudioWindowLike
} from "./studio-window.js";

const makeWindow = () => {
  let navigation:
    | ((event: { preventDefault(): void }, url: string) => void)
    | undefined;
  let closed: (() => void) | undefined;
  const window: StudioWindowLike = {
    webContents: {
      setWindowOpenHandler: vi.fn(),
      on: (_event, listener) => {
        navigation = listener;
      }
    },
    once: (_event, listener) => {
      closed = listener;
      return window;
    },
    loadURL: vi.fn(async () => undefined),
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(() => closed?.()),
    isDestroyed: vi.fn(() => false)
  };
  return { window, navigation: () => navigation!, closed: () => closed! };
};

const collaborationSnapshot = (
  input: {
    state?: "live" | "disconnected";
    teamName?: string;
  } = {}
) => {
  const timestamp = "2026-09-25T12:00:00.000Z";
  const ownerId = "11111111-1111-4111-8111-111111111111";
  const principalId = "22222222-2222-4222-8222-222222222222";
  const teamId = "33333333-3333-4333-8333-333333333333";
  return {
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    snapshotRevision: "snapshot-00000001",
    generatedAt: timestamp,
    connection: {
      state: input.state ?? "live",
      backendId: input.state === "disconnected" ? null : "up_team_example",
      connectedAt: input.state === "disconnected" ? null : timestamp,
      retryAt: null,
      reconnectAttempt: 0,
      protocolVersion: COLLABORATION_CONTRACT_VERSION
    },
    limits: { ...COLLABORATION_DEFAULT_LIMITS },
    navigation: {
      personalOwner: {
        id: ownerId,
        displayName: "Personal Owner",
        presence: "available",
        membershipState: "enabled"
      },
      teamPrincipal:
        input.state === "disconnected"
          ? null
          : {
              id: principalId,
              displayName: "Team User",
              presence: "available",
              membershipState: "enabled"
            },
      personal: { memory: [], channels: [] },
      teams:
        input.state === "disconnected"
          ? []
          : [
              {
                id: teamId,
                name: input.teamName ?? "Team A",
                role: "member",
                lifecycle: "active",
                unreadCount: 0,
                people: [
                  {
                    id: principalId,
                    displayName: "Team User",
                    presence: "available",
                    membershipState: "enabled",
                    teamPresence: {
                      mode: "auto",
                      manualStatus: "unknown",
                      activityLevel: null,
                      lastActivityAt: null,
                      nextTransitionAt: null,
                      preferenceVersion: 1
                    }
                  }
                ],
                directMessages: [],
                channels: [],
                sharedProjects: [],
                workspaces: [],
                version: 1
              }
            ]
    },
    selection: { kind: "personal_memory" },
    view: { kind: "empty" }
  };
};

const loadResult = (requestId: string, snapshot: unknown) => ({
  contractVersion: COLLABORATION_CONTRACT_VERSION,
  requestId,
  command: "collaboration.load",
  ok: true,
  data: { snapshot }
});

const actionResult = (
  command: string,
  requestId: string,
  snapshot: unknown
) => ({
  contractVersion: COLLABORATION_CONTRACT_VERSION,
  requestId,
  command,
  ok: true,
  data:
    command === "collaboration.connect_backend"
      ? {
          snapshot,
          backend: {
            id: "up_team_example",
            baseUrl: "https://team.example.test"
          }
        }
      : { snapshot }
});

const channelSnapshot = () => {
  const snapshot = collaborationSnapshot();
  const threadId = "44444444-4444-4444-8444-444444444444";
  const teamId = snapshot.navigation.teams[0]!.id;
  const at = snapshot.generatedAt;
  return {
    ...snapshot,
    navigation: {
      ...snapshot.navigation,
      teams: [
        {
          ...snapshot.navigation.teams[0]!,
          channels: [
            {
              id: threadId,
              logicalId: threadId,
              scope: "team",
              teamId,
              kind: "team_channel",
              name: "general",
              topic: null,
              systemKey: "team.general",
              version: 1,
              lifecycle: "active",
              canPost: true,
              latestSequence: 0,
              unreadCount: 0,
              lastReadMessageId: null,
              lastReadSequence: 0,
              createdAt: at,
              updatedAt: at,
              lastActivityAt: at,
              archivedAt: null
            }
          ]
        }
      ]
    }
  };
};

describe("Studio window controller", () => {
  it("stages the production export and gateway under app resources", () => {
    expect(
      resolveStudioPaths({
        appIsPackaged: true,
        repoRoot: "/checkout",
        resourcesPath: "/app/Contents/Resources"
      })
    ).toEqual({
      gatewayPath: "/app/Contents/Resources/studio/server/index.mjs",
      staticDir: "/app/Contents/Resources/studio/out"
    });
  });

  it("trusts only its exact origin, focuses duplicates, and closes the gateway", async () => {
    const allowedRendererOrigins = new Set(["koed://app"]);
    const fake = makeWindow();
    const getAccess = vi.fn().mockResolvedValue({
      apiOrigin: "http://127.0.0.1:43300",
      apiToken: "t"
    });
    const closeGateway = vi.fn(async () => undefined);
    const startGateway = vi.fn(async (_options: StudioGatewayOptions) => ({
      url: "http://127.0.0.1:49821",
      close: closeGateway
    }));
    const controller = createStudioWindowController({
      allowedRendererOrigins,
      createWindow: () => fake.window,
      getAccess,
      defaultApiOrigin: "http://127.0.0.1:43300",
      getPaths: () => ({ gatewayPath: "/unused", staticDir: "/static" }),
      startGateway,
      listLocalSources: async () => [],
      listProjects: async () => ({ ok: true, projects: [] }),
      chooseProjectDirectory: async () => null,
      registerProject: async () => ({ ok: true }),
      collaboration: async () => undefined,
      openExternal: async () => undefined
    });

    await controller.open();
    expect(allowedRendererOrigins).toEqual(
      new Set(["koed://app", "http://127.0.0.1:49821"])
    );
    expect(startGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 0,
        apiBase: "http://127.0.0.1:43300",
        staticDir: "/static"
      })
    );
    const gatewayOptions = startGateway.mock.calls[0]?.[0];
    expect(await gatewayOptions?.resolveToken()).toBe("t");
    expect(await gatewayOptions?.listProjects()).toEqual({
      ok: true,
      projects: []
    });
    expect(await gatewayOptions?.chooseProjectDirectory()).toBeNull();
    expect(
      await gatewayOptions?.registerProject({ path: "/tmp/a", name: "A" })
    ).toEqual({ ok: true });
    expect(getAccess).toHaveBeenCalledTimes(2);

    let blocked = false;
    fake.navigation()(
      { preventDefault: () => (blocked = true) },
      "http://127.0.0.1:49822/"
    );
    expect(blocked).toBe(true);
    blocked = false;
    fake.navigation()(
      { preventDefault: () => (blocked = true) },
      "https://example.com/"
    );
    expect(blocked).toBe(true);

    await controller.open();
    expect(fake.window.focus).toHaveBeenCalledTimes(1);
    await controller.close();
    expect(allowedRendererOrigins).toEqual(new Set(["koed://app"]));
    expect(closeGateway).toHaveBeenCalledTimes(1);
  });

  it("opens against the safe default API origin while Koed access is unavailable", async () => {
    const fake = makeWindow();
    let backendReady = false;
    const getAccess = vi.fn(async () => {
      if (!backendReady) throw new Error("local services are still starting");
      return {
        apiOrigin: "http://127.0.0.1:59451",
        apiToken: "paired-token"
      };
    });
    let gatewayOptions: StudioGatewayOptions | undefined;
    const controller = createStudioWindowController({
      allowedRendererOrigins: new Set(),
      createWindow: () => fake.window,
      getAccess,
      defaultApiOrigin: "http://127.0.0.1:43300",
      getPaths: () => ({ gatewayPath: "/unused", staticDir: "/static" }),
      startGateway: async (options) => {
        gatewayOptions = options;
        return { url: "http://127.0.0.1:49822", close: async () => undefined };
      },
      listLocalSources: async () => [],
      listProjects: async () => ({ ok: true, projects: [] }),
      chooseProjectDirectory: async () => null,
      registerProject: async () => ({ ok: true }),
      collaboration: async () => undefined,
      openExternal: async () => undefined
    });

    await expect(controller.open()).resolves.toBeUndefined();
    expect(fake.window.loadURL).toHaveBeenCalledWith("http://127.0.0.1:49822");
    expect(gatewayOptions?.apiBase).toBe("http://127.0.0.1:43300");
    await expect(gatewayOptions?.resolveToken()).rejects.toThrow(
      "local services are still starting"
    );
    await expect(gatewayOptions?.resolveAccess?.()).rejects.toThrow(
      "local services are still starting"
    );
    backendReady = true;
    await expect(gatewayOptions?.resolveAccess?.()).resolves.toEqual({
      apiOrigin: "http://127.0.0.1:59451",
      apiToken: "paired-token"
    });
    expect(getAccess).toHaveBeenCalledTimes(4);
    await controller.close();
  });

  it("loads fixed broker navigation and returns only live Team navigation", async () => {
    const fake = makeWindow();
    let receivedCommand: Record<string, unknown> | undefined;
    let receivedContext: { ownerId: string; signal: AbortSignal } | undefined;
    let gatewayOptions: StudioGatewayOptions | undefined;
    const controller = createStudioWindowController({
      allowedRendererOrigins: new Set(),
      createWindow: () => fake.window,
      getAccess: async () => ({
        apiOrigin: "http://127.0.0.1:43300",
        apiToken: "secret"
      }),
      defaultApiOrigin: "http://127.0.0.1:43300",
      getPaths: () => ({ gatewayPath: "/unused", staticDir: "/static" }),
      startGateway: async (options) => {
        gatewayOptions = options;
        return { url: "http://127.0.0.1:49823", close: async () => undefined };
      },
      listLocalSources: async () => [],
      listProjects: async () => ({ ok: true, projects: [] }),
      chooseProjectDirectory: async () => null,
      registerProject: async () => ({ ok: true }),
      collaboration: async (command, context) => {
        receivedCommand = command;
        receivedContext = context;
        return loadResult(
          String(command.requestId),
          collaborationSnapshot({ teamName: "Current Team" })
        );
      },
      openExternal: async () => undefined
    });

    await controller.open();
    const projected = await gatewayOptions?.loadCollaborationSnapshot?.();
    expect(receivedCommand).toMatchObject({
      command: "collaboration.load",
      input: { forceRemoteNavigation: true }
    });
    expect(receivedContext?.ownerId).toMatch(/^studio-window:/);
    expect(projected?.teams.map((team) => team.name)).toEqual(["Current Team"]);
    expect(projected).not.toHaveProperty("apiToken");
    expect(JSON.stringify(projected)).not.toContain("secret");
    await controller.close();
    expect(receivedContext?.signal.aborted).toBe(true);
  });

  it("purges Team navigation on disconnect, revocation, and backend switch", async () => {
    const fake = makeWindow();
    let callCount = 0;
    let gatewayOptions: StudioGatewayOptions | undefined;
    const controller = createStudioWindowController({
      allowedRendererOrigins: new Set(),
      createWindow: () => fake.window,
      getAccess: async () => ({
        apiOrigin: "http://127.0.0.1:43300",
        apiToken: "secret"
      }),
      defaultApiOrigin: "http://127.0.0.1:43300",
      getPaths: () => ({ gatewayPath: "/unused", staticDir: "/static" }),
      startGateway: async (options) => {
        gatewayOptions = options;
        return { url: "http://127.0.0.1:49824", close: async () => undefined };
      },
      listLocalSources: async () => [],
      listProjects: async () => ({ ok: true, projects: [] }),
      chooseProjectDirectory: async () => null,
      registerProject: async () => ({ ok: true }),
      collaboration: async (command) => {
        const call = callCount++;
        if (call === 0)
          return loadResult(
            String(command.requestId),
            collaborationSnapshot({ teamName: "Old Team" })
          );
        if (call === 1) {
          return {
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            requestId: command.requestId,
            command: "collaboration.load",
            ok: false,
            error: {
              code: "access_revoked",
              userMessage: collaborationSafeErrorMessages.access_revoked,
              retryable: false,
              retryAfterMs: null
            }
          };
        }
        return call === 2
          ? loadResult(
              String(command.requestId),
              collaborationSnapshot({ teamName: "New Team" })
            )
          : loadResult(
              String(command.requestId),
              collaborationSnapshot({ state: "disconnected" })
            );
      },
      openExternal: async () => undefined
    });

    await controller.open();
    const load = gatewayOptions!.loadCollaborationSnapshot!;
    expect((await load()).teams.map((team) => team.name)).toEqual(["Old Team"]);
    expect(await load()).toMatchObject({
      connection: { state: "access_revoked" },
      teams: []
    });
    expect((await load()).teams.map((team) => team.name)).toEqual(["New Team"]);
    expect(await load()).toMatchObject({
      connection: { state: "disconnected" },
      teams: []
    });
    await controller.close();
  });

  it("routes only connect, reconnect, and disconnect through the broker and returns a safe snapshot", async () => {
    const fake = makeWindow();
    const commands: Record<string, unknown>[] = [];
    let gatewayOptions: StudioGatewayOptions | undefined;
    const controller = createStudioWindowController({
      allowedRendererOrigins: new Set(),
      createWindow: () => fake.window,
      getAccess: async () => ({
        apiOrigin: "http://127.0.0.1:43300",
        apiToken: "renderer-never-sees-this"
      }),
      defaultApiOrigin: "http://127.0.0.1:43300",
      getPaths: () => ({ gatewayPath: "/unused", staticDir: "/static" }),
      startGateway: async (options) => {
        gatewayOptions = options;
        return { url: "http://127.0.0.1:49826", close: async () => undefined };
      },
      listLocalSources: async () => [],
      listProjects: async () => ({ ok: true, projects: [] }),
      chooseProjectDirectory: async () => null,
      registerProject: async () => ({ ok: true }),
      collaboration: async (command) => {
        commands.push(command);
        const name = String(command.command);
        const next =
          name === "collaboration.disconnect_backend"
            ? collaborationSnapshot({ state: "disconnected" })
            : collaborationSnapshot({ teamName: "New Team" });
        return actionResult(name, String(command.requestId), next);
      },
      openExternal: async () => undefined
    });

    await controller.open();
    const connect = await gatewayOptions!.connectCollaborationBackend!(
      "https://team.example.test"
    );
    expect(connect.teams.map((team) => team.name)).toEqual(["New Team"]);
    expect(connect).not.toHaveProperty("apiToken");
    expect(JSON.stringify(connect)).not.toContain("renderer-never-sees-this");
    const reconnect = await gatewayOptions!.reconnectCollaborationBackend!();
    expect(reconnect.teams.map((team) => team.name)).toEqual(["New Team"]);
    const disconnect = await gatewayOptions!.disconnectCollaborationBackend!();
    expect(disconnect).toMatchObject({
      connection: { state: "disconnected", backendId: null },
      teams: []
    });
    expect(commands).toHaveLength(3);
    expect(commands.map((command) => command.command)).toEqual([
      "collaboration.connect_backend",
      "collaboration.reconnect_backend",
      "collaboration.disconnect_backend"
    ]);
    expect(commands[0]).toMatchObject({
      input: { remoteUrl: "https://team.example.test" }
    });
    await controller.close();
  });

  it("allows native direct-message create commands through the Studio channel gateway", async () => {
    const fake = makeWindow();
    const commands: Record<string, unknown>[] = [];
    let gatewayOptions: StudioGatewayOptions | undefined;
    const teamId = "33333333-3333-4333-8333-333333333333";
    const ownerId = "11111111-1111-4111-8111-111111111111";
    const firstMemberId = "22222222-2222-4222-8222-222222222222";
    const secondMemberId = "44444444-4444-4444-8444-444444444444";
    const makeThread = (kind: "dm" | "group_dm") => ({
      id: "55555555-5555-4555-8555-555555555555",
      logicalId: "66666666-6666-4666-8666-666666666666",
      scope: "team" as const,
      teamId,
      kind,
      name: kind === "dm" ? null : "Group",
      topic: null,
      participants: [ownerId, firstMemberId, ...(kind === "group_dm" ? [secondMemberId] : [])].map((id) => ({
        id,
        displayName: "Team member",
        membershipState: "enabled" as const
      })),
      version: 1,
      lifecycle: "active" as const,
      canPost: true,
      latestSequence: 0,
      unreadCount: 0,
      lastReadMessageId: null,
      lastReadSequence: 0,
      createdAt: "2026-09-25T12:00:00.000Z",
      updatedAt: "2026-09-25T12:00:00.000Z",
      lastActivityAt: "2026-09-25T12:00:00.000Z",
      archivedAt: null
    });
    const controller = createStudioWindowController({
      allowedRendererOrigins: new Set(),
      createWindow: () => fake.window,
      getAccess: async () => ({ apiOrigin: "http://127.0.0.1:43300", apiToken: "secret" }),
      defaultApiOrigin: "http://127.0.0.1:43300",
      getPaths: () => ({ gatewayPath: "/unused", staticDir: "/static" }),
      startGateway: async (options) => {
        gatewayOptions = options;
        return { url: "http://127.0.0.1:49828", close: async () => undefined };
      },
      listLocalSources: async () => [],
      listProjects: async () => ({ ok: true, projects: [] }),
      chooseProjectDirectory: async () => null,
      registerProject: async () => ({ ok: true }),
      collaboration: async (command) => {
        commands.push(command);
        if (command.command === "collaboration.load") return loadResult(command.requestId as string, collaborationSnapshot());
        return {
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: command.requestId,
          command: command.command,
          ok: true,
          data: { thread: makeThread(command.command === "collaboration.start_direct_message" ? "dm" : "group_dm") }
        };
      },
      openExternal: async () => undefined
    });

    await controller.open();
    const requests: CollaborationRendererCommand[] = [
      {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: crypto.randomUUID(),
        command: "collaboration.start_direct_message",
        input: { teamId, participantUserId: firstMemberId }
      },
      {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: crypto.randomUUID(),
        command: "collaboration.start_group_direct_message",
        input: { teamId, participantUserIds: [firstMemberId, secondMemberId] }
      }
    ];
    for (const request of requests) {
      const result = await gatewayOptions!.runStudioCollaborationCommand!(request);
      const command = request.command;
      expect(result).toMatchObject({ ok: true, command });
    }
    expect(commands.map(({ command }) => command)).toEqual([
      "collaboration.start_direct_message",
      "collaboration.start_group_direct_message"
    ]);
    await controller.close();
  });

  it("mediates revoke through a native grant and preserves the original request identity", async () => {
    const fake = makeWindow();
    let gatewayOptions: StudioGatewayOptions | undefined;
    const teamId = "33333333-3333-4333-8333-333333333333";
    const grantReference = { id: "77777777-7777-4777-8777-777777777777" };
    const nativeReview = {
      version: 1 as const,
      title: "Revoke Shared Memory access?",
      description: "Remove Team recall through this Share Grant.",
      consequence: "Personal Memory stays unchanged.",
      confirmLabel: "Revoke access",
      details: [{ label: "Team", value: teamId }]
    };
    let expiresAt = new Date(Date.now() + 30_000).toISOString();
    const status = (state: "review_required" | "pending" | "approved") => ({
      version: 1 as const,
      actionGrant: grantReference,
      approvalTier:
        state === "pending" ? ("step_up" as const) : ("native_review" as const),
      review: nativeReview,
      state,
      activationUrl:
        state === "pending"
          ? "https://team.example.test/koed/high-risk/browser-activations/77777777-7777-4777-8777-777777777777"
          : null,
      expiresAt
    });
    const sent: CollaborationRendererCommand[] = [];
    let awaitCount = 0;
    const originalRequestId = "88888888-8888-4888-8888-888888888888";
    const controller = createStudioWindowController({
      allowedRendererOrigins: new Set(),
      createWindow: () => fake.window,
      getAccess: async () => ({ apiOrigin: "http://127.0.0.1:43300", apiToken: "secret" }),
      defaultApiOrigin: "http://127.0.0.1:43300",
      getPaths: () => ({ gatewayPath: "/unused", staticDir: "/static" }),
      startGateway: async (options) => {
        gatewayOptions = options;
        return { url: "http://127.0.0.1:49828", close: async () => undefined };
      },
      listLocalSources: async () => [],
      listProjects: async () => ({ ok: true, projects: [] }),
      chooseProjectDirectory: async () => null,
      registerProject: async () => ({ ok: true }),
      collaboration: async (command) => {
        const parsed = collaborationRendererCommandSchema.parse(command);
        sent.push(parsed);
        if (parsed.command === "collaboration.load") {
          return loadResult(parsed.requestId, collaborationSnapshot());
        }
        if (parsed.command === "collaboration.request_action_grant") {
          return {
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            requestId: parsed.requestId,
            command: parsed.command,
            ok: true,
            data: { status: status("review_required") }
          };
        }
        if (parsed.command === "collaboration.confirm_action_grant") {
          expect(parsed.input).toEqual({ actionGrant: grantReference, decision: "approve" });
          return {
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            requestId: parsed.requestId,
            command: parsed.command,
            ok: true,
            data: { status: status("pending") }
          };
        }
        if (parsed.command === "collaboration.await_action_grant") {
          awaitCount += 1;
          expect(parsed.input).toEqual({ actionGrant: grantReference });
          if (awaitCount === 1) {
            return {
              contractVersion: COLLABORATION_CONTRACT_VERSION,
              requestId: parsed.requestId,
              command: parsed.command,
              ok: false,
              error: {
                code: "temporarily_unavailable",
                userMessage: collaborationSafeErrorMessages.temporarily_unavailable,
                retryable: true,
                retryAfterMs: 0
              }
            };
          }
          return {
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            requestId: parsed.requestId,
            command: parsed.command,
            ok: true,
            data: { status: status("approved") }
          };
        }
        return {
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: parsed.requestId,
          command: parsed.command,
          ok: false,
          error: {
            code: "temporarily_unavailable",
            userMessage: collaborationSafeErrorMessages.temporarily_unavailable,
            retryable: true,
            retryAfterMs: null
          }
        };
      },
      confirmNativeReview: async (review) => {
        expect(review).toEqual(nativeReview);
        return true;
      },
      openExternal: async () => undefined
    });

    await controller.open();
    await gatewayOptions!.runStudioCollaborationCommand!({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: crypto.randomUUID(),
      command: "collaboration.load",
      input: {}
    });
    const result = await gatewayOptions!.runStudioCollaborationCommand!({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: originalRequestId,
      command: "collaboration.revoke_shared_memory",
      input: {
        mutationId: "99999999-9999-4999-8999-999999999999",
        teamId,
        workspaceId: "44444444-4444-4444-8444-444444444444",
        shareGrantId: "55555555-5555-4555-8555-555555555555",
        expectedGrantVersion: 3,
        reasonCode: "owner_revoked"
      }
    });
    expect(result).toMatchObject({ ok: false, command: "collaboration.revoke_shared_memory" });
    expect(awaitCount).toBe(2);
    const requested = sent.find((command) => command.command === "collaboration.request_action_grant");
    expect(requested).toMatchObject({
      input: {
        intent: {
          intent: "collaboration.revoke_shared_memory",
          commandRequestId: originalRequestId,
          shareGrantId: "55555555-5555-4555-8555-555555555555"
        }
      }
    });
    const mutation = sent.find((command) => command.command === "collaboration.revoke_shared_memory");
    expect(mutation).toMatchObject({
      requestId: originalRequestId,
      input: { actionGrant: grantReference }
    });

    expiresAt = new Date(Date.now() - 1).toISOString();
    const awaitCountBeforeExpiry = awaitCount;
    const mutationCountBeforeExpiry = sent.filter(
      (command) => command.command === "collaboration.revoke_shared_memory"
    ).length;
    await expect(
      gatewayOptions!.runStudioCollaborationCommand!({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: crypto.randomUUID(),
        command: "collaboration.revoke_shared_memory",
        input: {
          mutationId: crypto.randomUUID(),
          teamId,
          workspaceId: "44444444-4444-4444-8444-444444444444",
          shareGrantId: "55555555-5555-4555-8555-555555555555",
          expectedGrantVersion: 3,
          reasonCode: "owner_revoked"
        }
      })
    ).rejects.toThrow("Native Action Grant expired");
    expect(awaitCount).toBe(awaitCountBeforeExpiry);
    expect(
      sent.filter((command) => command.command === "collaboration.revoke_shared_memory")
    ).toHaveLength(mutationCountBeforeExpiry);

    await expect(
      gatewayOptions!.runStudioCollaborationCommand!({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: crypto.randomUUID(),
        command: "collaboration.revoke_shared_memory",
        input: {
          mutationId: crypto.randomUUID(),
          teamId,
          workspaceId: "44444444-4444-4444-8444-444444444444",
          shareGrantId: "55555555-5555-4555-8555-555555555555",
          expectedGrantVersion: 3,
          reasonCode: "owner_revoked",
          actionGrant: { id: crypto.randomUUID() }
        }
      })
    ).rejects.toThrow("cannot supply an Action Grant");
    const grantRequestsBeforeCandidate = sent.filter(
      (command) => command.command === "collaboration.request_action_grant"
    ).length;
    await gatewayOptions!.runStudioCollaborationCommand!({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: crypto.randomUUID(),
      command: "collaboration.preview_shared_memory_candidate",
      input: {
        source: {
          kind: "captured_session",
          sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          logicalMemoryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        },
        activationRepresentation: "memory_events",
        mode: "snapshot"
      }
    });
    expect(
      sent.filter((command) => command.command === "collaboration.request_action_grant")
    ).toHaveLength(grantRequestsBeforeCandidate);
    await controller.close();
  });

  it("stops a pending native mutation when the active principal changes during a retry wait", async () => {
    const fake = makeWindow();
    let gatewayOptions: StudioGatewayOptions | undefined;
    let activeSnapshot: ReturnType<typeof collaborationSnapshot> = collaborationSnapshot();
    let releaseReview!: (approved: boolean) => void;
    let shownReview!: () => void;
    const reviewShown = new Promise<void>((resolve) => { shownReview = resolve; });
    const grantReference = { id: "77777777-7777-4777-8777-777777777777" };
    const review = {
      version: 1 as const,
      title: "Revoke Shared Memory access?",
      description: "Remove Team recall.",
      consequence: "Personal Memory stays unchanged.",
      confirmLabel: "Revoke access",
      details: []
    };
    const nativeStatus = {
      version: 1 as const,
      actionGrant: grantReference,
      approvalTier: "native_review" as const,
      review,
      state: "review_required" as const,
      activationUrl: null,
      expiresAt: new Date(Date.now() + 30_000).toISOString()
    };
    const sent: CollaborationRendererCommand[] = [];
    let awaitCount = 0;
    const controller = createStudioWindowController({
      allowedRendererOrigins: new Set(),
      createWindow: () => fake.window,
      getAccess: async () => ({ apiOrigin: "http://127.0.0.1:43300", apiToken: "secret" }),
      defaultApiOrigin: "http://127.0.0.1:43300",
      getPaths: () => ({ gatewayPath: "/unused", staticDir: "/static" }),
      startGateway: async (options) => {
        gatewayOptions = options;
        return { url: "http://127.0.0.1:49829", close: async () => undefined };
      },
      listLocalSources: async () => [],
      listProjects: async () => ({ ok: true, projects: [] }),
      chooseProjectDirectory: async () => null,
      registerProject: async () => ({ ok: true }),
      collaboration: async (command) => {
        const parsed = collaborationRendererCommandSchema.parse(command);
        sent.push(parsed);
        if (parsed.command === "collaboration.load") return loadResult(parsed.requestId, activeSnapshot);
        if (parsed.command === "collaboration.request_action_grant") {
          return {
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            requestId: parsed.requestId,
            command: parsed.command,
            ok: true,
            data: { status: nativeStatus }
          };
        }
        if (parsed.command === "collaboration.confirm_action_grant") {
          return {
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            requestId: parsed.requestId,
            command: parsed.command,
            ok: true,
            data: {
              status: {
                ...nativeStatus,
                state: "pending",
                approvalTier: "step_up",
                activationUrl:
                  "https://team.example.test/koed/high-risk/browser-activations/77777777-7777-4777-8777-777777777777"
              }
            }
          };
        }
        if (parsed.command === "collaboration.await_action_grant") {
          awaitCount += 1;
          activeSnapshot = {
            ...activeSnapshot,
            navigation: {
              ...activeSnapshot.navigation,
              teamPrincipal: {
                ...activeSnapshot.navigation.teamPrincipal!,
                id: "66666666-6666-4666-8666-666666666666"
              },
              teams: activeSnapshot.navigation.teams.map((team) => ({
                ...team,
                people: team.people.map((person) => ({
                  ...person,
                  id: "66666666-6666-4666-8666-666666666666"
                }))
              }))
            }
          };
          await gatewayOptions!.runStudioCollaborationCommand!({
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            requestId: crypto.randomUUID(),
            command: "collaboration.load",
            input: {}
          });
          return {
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            requestId: parsed.requestId,
            command: parsed.command,
            ok: false,
            error: {
              code: "temporarily_unavailable",
              userMessage: collaborationSafeErrorMessages.temporarily_unavailable,
              retryable: true,
              retryAfterMs: 0
            }
          };
        }
        return {
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: parsed.requestId,
          command: parsed.command,
          ok: false,
          error: {
            code: "temporarily_unavailable",
            userMessage: collaborationSafeErrorMessages.temporarily_unavailable,
            retryable: true,
            retryAfterMs: null
          }
        };
      },
      confirmNativeReview: async () => {
        shownReview();
        return new Promise<boolean>((resolve) => { releaseReview = resolve; });
      },
      openExternal: async () => undefined
    });

    await controller.open();
    await gatewayOptions!.runStudioCollaborationCommand!({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: crypto.randomUUID(),
      command: "collaboration.load",
      input: {}
    });
    const pending = gatewayOptions!.runStudioCollaborationCommand!({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: "88888888-8888-4888-8888-888888888888",
      command: "collaboration.revoke_shared_memory",
      input: {
        mutationId: "99999999-9999-4999-8999-999999999999",
        teamId: "33333333-3333-4333-8333-333333333333",
        workspaceId: "44444444-4444-4444-8444-444444444444",
        shareGrantId: "55555555-5555-4555-8555-555555555555",
        expectedGrantVersion: 3,
        reasonCode: "owner_revoked"
      }
    });
    await reviewShown;
    releaseReview(true);
    await expect(pending).rejects.toThrow("Team, account, or selected source changed");
    expect(awaitCount).toBe(1);
    expect(sent.some((command) => command.command === "collaboration.revoke_shared_memory")).toBe(false);
    await controller.close();
  });

  it("shows an unavailable status without exposing broker errors", async () => {
    const fake = makeWindow();
    let gatewayOptions: StudioGatewayOptions | undefined;
    const controller = createStudioWindowController({
      allowedRendererOrigins: new Set(),
      createWindow: () => fake.window,
      getAccess: async () => ({
        apiOrigin: "http://127.0.0.1:43300",
        apiToken: "secret"
      }),
      defaultApiOrigin: "http://127.0.0.1:43300",
      getPaths: () => ({ gatewayPath: "/unused", staticDir: "/static" }),
      startGateway: async (options) => {
        gatewayOptions = options;
        return { url: "http://127.0.0.1:49825", close: async () => undefined };
      },
      listLocalSources: async () => [],
      listProjects: async () => ({ ok: true, projects: [] }),
      chooseProjectDirectory: async () => null,
      registerProject: async () => ({ ok: true }),
      collaboration: async () => {
        throw new Error("credential=private");
      },
      openExternal: async () => undefined
    });

    await controller.open();
    const snapshot = await gatewayOptions?.loadCollaborationSnapshot?.();
    expect(snapshot).toMatchObject({
      connection: { state: "unavailable" },
      teams: []
    });
    expect(JSON.stringify(snapshot)).not.toContain("credential=private");
    await controller.close();
  });
  it("authorizes protected draft access against fresh Team navigation and erases revoked drafts", async () => {
    let snapshot = channelSnapshot();
    let options!: StudioGatewayOptions;
    const fake = makeWindow();
    const store = {
      retainAuthorizedTeams: vi.fn(async () => 0),
      load: vi.fn(async () => ({ text: "Private draft", pendingSend: null })),
      save: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      deleteTeam: vi.fn(async () => undefined)
    };
    const controller = createStudioWindowController({
      allowedRendererOrigins: new Set(),
      createWindow: () => fake.window,
      getAccess: async () => ({
        apiOrigin: "http://127.0.0.1:43300",
        apiToken: "t"
      }),
      defaultApiOrigin: "http://127.0.0.1:43300",
      getPaths: () => ({ gatewayPath: "/unused", staticDir: "/static" }),
      startGateway: async (value) => {
        options = value;
        return { url: "http://127.0.0.1:49827", close: async () => undefined };
      },
      listLocalSources: async () => [],
      listProjects: async () => ({ ok: true, projects: [] }),
      chooseProjectDirectory: async () => null,
      registerProject: async () => ({ ok: true }),
      collaboration: async (command) =>
        loadResult(String(command.requestId), snapshot),
      getTeamDraftStore: async () => store,
      openExternal: async () => undefined
    });
    const authority = {
      backendId: "up_team_example",
      principalUserId: "22222222-2222-4222-8222-222222222222",
      teamId: "33333333-3333-4333-8333-333333333333",
      threadId: "44444444-4444-4444-8444-444444444444"
    };
    await controller.open();
    await expect(
      options.runStudioCollaborationCommand!({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "66666666-6666-4666-8666-666666666666",
        command: "collaboration.connect_backend",
        input: { remoteUrl: "https://other.example.test" }
      })
    ).rejects.toThrow("command is unavailable");
    await expect(
      options.loadStudioTeamDraft!({
        ...authority,
        teamId: "55555555-5555-4555-8555-555555555555"
      })
    ).rejects.toThrow("access");
    expect(store.load).not.toHaveBeenCalled();
    await expect(
      options.loadStudioTeamDraft!(authority)
    ).resolves.toMatchObject({ text: "Private draft" });
    let releaseDraft!: (draft: { text: string; pendingSend: null }) => void;
    store.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDraft = resolve;
        })
    );
    const pendingLoad = options.loadStudioTeamDraft!(authority);
    const deniedAfterRevocation = expect(pendingLoad).rejects.toThrow("access");
    await vi.waitFor(() => expect(store.load).toHaveBeenCalledTimes(2));
    snapshot = {
      ...snapshot,
      navigation: { ...snapshot.navigation, teams: [] }
    };
    await expect(options.loadStudioTeamDraft!(authority)).rejects.toThrow(
      "access"
    );
    releaseDraft({ text: "Private draft", pendingSend: null });
    await deniedAfterRevocation;
    expect(store.load).toHaveBeenCalledTimes(2);
    expect(store.deleteTeam).toHaveBeenCalledWith({
      backendId: authority.backendId,
      principalUserId: authority.principalUserId,
      teamId: authority.teamId
    });
    await expect(
      options.saveStudioTeamDraft!({
        authority,
        draft: { text: "revoked", pendingSend: null }
      })
    ).rejects.toThrow("access");
    expect(store.save).not.toHaveBeenCalled();
    await controller.close();
  });
});
