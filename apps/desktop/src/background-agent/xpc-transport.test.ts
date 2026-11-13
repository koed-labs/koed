import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildBackgroundAgentCodeRequirement,
  createBackgroundAgentXpcClient,
  createBackgroundAgentXpcServer,
  type BackgroundAgentNativeBridge,
  type NativeXpcRequestHandler
} from "./xpc-transport.js";
import {
  BACKGROUND_AGENT_PROTOCOL_VERSION,
  parseBackgroundAgentRequest,
  type BackgroundAgentRequest,
  type BackgroundAgentResponse
} from "./protocol.js";

const identity = {
  installationId: randomUUID(),
  homeIdentity: "a".repeat(64),
  teamId: "ABCDE12345",
  bundleIdentifier: "ai.koed.desktop",
  serviceName: "ai.koed.desktop.background-agent"
};

const responseFor = (
  request: BackgroundAgentRequest,
  state: BackgroundAgentResponse["state"],
  generation: number
): BackgroundAgentResponse => ({
  protocolVersion: BACKGROUND_AGENT_PROTOCOL_VERSION,
  requestId: request.requestId,
  installationId: request.installationId,
  homeIdentity: request.homeIdentity,
  kind: request.kind,
  state,
  generation,
  ok: true
});

const createBridge = () => {
  let listener: NativeXpcRequestHandler | undefined;
  let nextConnection = 0;
  const bridge: BackgroundAgentNativeBridge = {
    listen: vi.fn((_serviceName, _requirement, handler) => {
      listener = handler;
      return { close: vi.fn() };
    }),
    connect: vi.fn(() => {
      const connectionId = `client-${++nextConnection}`;
      return {
        close: vi.fn(),
        request: vi.fn(async (payload: string) => {
          if (!listener) throw new Error("No Agent listener is registered.");
          return new Promise<string>((resolve, reject) => {
            const requestListener = listener;
            if (!requestListener) {
              reject(new Error("No Agent listener is registered."));
              return;
            }
            void Promise.resolve(
              requestListener(connectionId, payload, resolve)
            ).catch(reject);
          });
        })
      };
    })
  };
  return { bridge, getListener: () => listener };
};

describe("background-agent XPC transport", () => {
  it("builds an exact Team ID and bundle identifier peer requirement", () => {
    expect(
      buildBackgroundAgentCodeRequirement(
        identity.teamId,
        identity.bundleIdentifier
      )
    ).toBe(
      'identifier "ai.koed.desktop" and anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"'
    );
    expect(() =>
      buildBackgroundAgentCodeRequirement(
        "not-a-team",
        identity.bundleIdentifier
      )
    ).toThrow("Background Agent Team ID is invalid.");
  });

  it("validates installation and home identity before invoking the Agent handler", async () => {
    const { bridge, getListener } = createBridge();
    const handler = vi.fn(async (request: BackgroundAgentRequest) =>
      responseFor(request, "stopped", 0)
    );
    const server = createBackgroundAgentXpcServer({
      bridge,
      ...identity,
      handler
    });
    const listener = getListener();
    if (!listener) throw new Error("Test listener was not registered.");
    const request = {
      protocolVersion: BACKGROUND_AGENT_PROTOCOL_VERSION,
      requestId: randomUUID(),
      installationId: identity.installationId,
      homeIdentity: "b".repeat(64),
      kind: "status"
    } as const;
    const reply = vi.fn();

    await listener("unauthed-client", JSON.stringify(request), reply);

    expect(handler).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith("");
    server.close();
  });

  it("returns a structured protocol mismatch for a newer peer", async () => {
    const { bridge, getListener } = createBridge();
    const handler = vi.fn();
    const server = createBackgroundAgentXpcServer({
      bridge,
      ...identity,
      handler
    });
    const listener = getListener();
    if (!listener) throw new Error("Test listener was not registered.");
    const reply = vi.fn();
    await listener(
      "legacy-client",
      JSON.stringify({
        protocolVersion: BACKGROUND_AGENT_PROTOCOL_VERSION + 1,
        requestId: randomUUID(),
        installationId: identity.installationId,
        homeIdentity: identity.homeIdentity,
        kind: "status"
      }),
      reply
    );

    expect(handler).not.toHaveBeenCalled();
    expect(JSON.parse(String(reply.mock.calls[0]?.[0]))).toMatchObject({
      errorCode: "protocol_mismatch",
      kind: "status",
      ok: false
    });
    server.close();
  });

  it("completes the read-only hello before state-changing requests", async () => {
    const { bridge } = createBridge();
    const server = createBackgroundAgentXpcServer({
      bridge,
      ...identity,
      handler: vi.fn(async (request: BackgroundAgentRequest) =>
        responseFor(
          request,
          request.kind === "start" ? "starting" : "stopped",
          request.kind === "start" ? 5 : 4
        )
      )
    });
    const client = createBackgroundAgentXpcClient({ bridge, ...identity });

    await expect(client.start()).resolves.toMatchObject({
      kind: "start",
      generation: 5,
      state: "starting"
    });
    const connection = vi.mocked(bridge.connect).mock.results[0]?.value;
    if (!connection) throw new Error("Test connection was not created.");
    const requestCalls = vi.mocked(connection.request).mock.calls as Array<
      [string, number]
    >;
    const requests = requestCalls.map(
      ([payload]) => parseBackgroundAgentRequest(payload).kind
    );
    expect(bridge.connect).toHaveBeenCalledTimes(1);
    expect(requests).toEqual(["hello", "start"]);
    expect(
      parseBackgroundAgentRequest(requestCalls[1]?.[0] ?? "")
    ).toMatchObject({ expectedGeneration: 4, explicit: true, kind: "start" });
    server.close();
  });

  it("preserves non-explicit lifecycle intent over XPC", async () => {
    const { bridge } = createBridge();
    const server = createBackgroundAgentXpcServer({
      bridge,
      ...identity,
      handler: vi.fn(async (request: BackgroundAgentRequest) =>
        responseFor(request, "stopped", 1)
      )
    });
    const client = createBackgroundAgentXpcClient({ bridge, ...identity });

    await client.start(false);
    const connection = vi.mocked(bridge.connect).mock.results[0]?.value;
    if (!connection) throw new Error("Test connection was not created.");
    const requestCalls = vi.mocked(connection.request).mock.calls as Array<
      [string, number]
    >;
    const startRequest = parseBackgroundAgentRequest(
      requestCalls[1]?.[0] ?? ""
    );
    expect(startRequest).toMatchObject({ kind: "start", explicit: false });

    server.close();
  });

  it("rejects a mismatched response identity instead of accepting stale replies", async () => {
    const connection = {
      close: vi.fn(),
      request: vi.fn(async (payload: string) => {
        const request = parseBackgroundAgentRequest(payload);
        return JSON.stringify({
          ...responseFor(request, "stopped", 2),
          installationId: randomUUID()
        });
      })
    };
    const bridge: BackgroundAgentNativeBridge = {
      listen: vi.fn(() => ({ close: vi.fn() })),
      connect: vi.fn(() => connection)
    };
    const client = createBackgroundAgentXpcClient({ bridge, ...identity });

    await expect(client.status()).rejects.toThrow(
      "Background Agent response identity does not match the request."
    );
    expect(connection.close).toHaveBeenCalled();
  });
});
