import { describe, expect, it, vi } from "vitest";
import {
  COLLABORATION_CONTRACT_VERSION,
  COLLABORATION_DEFAULT_LIMITS,
  collaborationSafeErrorMessages
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
});
