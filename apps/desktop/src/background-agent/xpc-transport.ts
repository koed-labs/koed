import { randomUUID } from "node:crypto";
import {
  BACKGROUND_AGENT_PROTOCOL_VERSION,
  BackgroundAgentProtocolVersionError,
  createProtocolMismatchResponse,
  parseBackgroundAgentRequest,
  parseBackgroundAgentResponse,
  type BackgroundAgentRequest,
  type BackgroundAgentResponse
} from "./protocol.js";

export type NativeXpcRequestHandler = (
  connectionId: string,
  payload: string,
  reply: (response: string) => void
) => void | Promise<void>;

export interface NativeXpcConnection {
  close(): void;
  request(payload: string, timeoutMs: number): Promise<string>;
}

export interface BackgroundAgentNativeBridge {
  listen(
    serviceName: string,
    codeRequirement: string,
    onRequest: NativeXpcRequestHandler,
    onDisconnect: (connectionId: string) => void
  ): { close(): void };
  connect(serviceName: string, codeRequirement: string): NativeXpcConnection;
}

export interface BackgroundAgentXpcClient {
  close(): void;
  status(): Promise<BackgroundAgentResponse>;
  start(explicit?: boolean): Promise<BackgroundAgentResponse>;
  stop(explicit?: boolean): Promise<BackgroundAgentResponse>;
}

interface AgentIdentity {
  installationId: string;
  homeIdentity: string;
  teamId: string;
  bundleIdentifier: string;
  serviceName: string;
}

const requestTimeoutMs = 45_000;

export const buildBackgroundAgentCodeRequirement = (
  teamId: string,
  bundleIdentifier: string
) => {
  if (!/^[A-Z0-9]{10}$/u.test(teamId))
    throw new Error("Background Agent Team ID is invalid.");
  if (!/^[A-Za-z0-9.-]+\.[A-Za-z0-9.-]+$/u.test(bundleIdentifier))
    throw new Error("Background Agent bundle identifier is invalid.");
  return `identifier "${bundleIdentifier}" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`;
};

export const createBackgroundAgentXpcServer = (
  input: AgentIdentity & {
    bridge: BackgroundAgentNativeBridge;
    handler: (
      request: BackgroundAgentRequest
    ) => Promise<BackgroundAgentResponse>;
  }
) => {
  const codeRequirement = buildBackgroundAgentCodeRequirement(
    input.teamId,
    input.bundleIdentifier
  );
  const authenticatedConnections = new Set<string>();
  const requestQueue = new SerialRequestQueue();
  const listener = input.bridge.listen(
    input.serviceName,
    codeRequirement,
    (connectionId, payload, reply) => {
      void requestQueue.enqueue(() =>
        handleIncomingRequest(
          connectionId,
          payload,
          reply,
          input,
          authenticatedConnections
        )
      );
    },
    (connectionId) => authenticatedConnections.delete(connectionId)
  );
  return {
    close: () => {
      authenticatedConnections.clear();
      listener.close();
    }
  };
};

class SerialRequestQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue(task: () => Promise<void>) {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

const handleIncomingRequest = async (
  connectionId: string,
  payload: string,
  reply: (response: string) => void,
  input: AgentIdentity & {
    handler: (
      request: BackgroundAgentRequest
    ) => Promise<BackgroundAgentResponse>;
  },
  authenticatedConnections: Set<string>
) => {
  try {
    const request = parseBackgroundAgentRequest(payload);
    assertRequestIdentity(request, input);
    if (
      request.kind !== "hello" &&
      !authenticatedConnections.has(connectionId)
    ) {
      tryReply(reply, "");
      return;
    }
    const response = parseBackgroundAgentResponse(
      JSON.stringify(await input.handler(request))
    );
    assertResponseMatchesRequest(response, request, input);
    if (request.kind === "hello" && response.ok)
      authenticatedConnections.add(connectionId);
    tryReply(reply, JSON.stringify(response));
  } catch (error) {
    const response =
      error instanceof BackgroundAgentProtocolVersionError
        ? JSON.stringify(createProtocolMismatchResponse(error.request))
        : "";
    tryReply(reply, response);
  }
};

const tryReply = (reply: (response: string) => void, response: string) => {
  try {
    reply(response);
  } catch {
    // The peer may have closed its XPC connection while the request was running.
  }
};

export const createBackgroundAgentXpcClient = (
  input: AgentIdentity & { bridge: BackgroundAgentNativeBridge }
): BackgroundAgentXpcClient => {
  const codeRequirement = buildBackgroundAgentCodeRequirement(
    input.teamId,
    input.bundleIdentifier
  );
  let connection: NativeXpcConnection | undefined;
  let openingConnection: Promise<NativeXpcConnection> | undefined;
  let generation = 0;
  let closed = false;

  const openConnection = async () => {
    if (closed) throw new Error("Background Agent XPC client is closed.");
    const nextConnection = input.bridge.connect(
      input.serviceName,
      codeRequirement
    );
    try {
      const hello = await sendOnConnection(nextConnection, "hello", input);
      if (!hello.ok) throw responseError(hello);
      generation = hello.generation;
      connection = nextConnection;
      if (closed) throw new Error("Background Agent XPC client is closed.");
      return nextConnection;
    } catch (error) {
      nextConnection.close();
      throw error;
    }
  };

  const ensureConnection = async () => {
    if (closed) throw new Error("Background Agent XPC client is closed.");
    if (connection) return connection;
    if (!openingConnection) openingConnection = openConnection();
    try {
      return await openingConnection;
    } finally {
      openingConnection = undefined;
    }
  };

  const send = async (kind: "status" | "start" | "stop", explicit = true) => {
    const activeConnection = await ensureConnection();
    const request = createRequest(input, kind, generation, explicit);
    let response: BackgroundAgentResponse;
    try {
      response = await sendRequest(activeConnection, request, input);
    } catch (error) {
      activeConnection.close();
      if (connection === activeConnection) {
        connection = undefined;
        generation = 0;
      }
      throw error;
    }
    generation = response.generation;
    if (!response.ok) throw responseError(response);
    return response;
  };

  return {
    close: () => {
      closed = true;
      connection?.close();
      connection = undefined;
      generation = 0;
    },
    status: () => send("status"),
    start: (explicit = true) => send("start", explicit),
    stop: (explicit = true) => send("stop", explicit)
  };
};

const createRequest = (
  identity: Pick<AgentIdentity, "installationId" | "homeIdentity">,
  kind: "hello" | "status" | "start" | "stop",
  expectedGeneration: number,
  explicit = true
): BackgroundAgentRequest => {
  const base = {
    protocolVersion: BACKGROUND_AGENT_PROTOCOL_VERSION,
    requestId: randomUUID(),
    installationId: identity.installationId,
    homeIdentity: identity.homeIdentity,
    kind
  };
  return kind === "hello" || kind === "status"
    ? parseBackgroundAgentRequest(JSON.stringify(base))
    : parseBackgroundAgentRequest(
        JSON.stringify({ ...base, expectedGeneration, explicit })
      );
};

const sendOnConnection = async (
  connection: NativeXpcConnection,
  kind: "hello",
  identity: AgentIdentity
) => {
  const request = createRequest(identity, kind, 0);
  return sendRequest(connection, request, identity);
};

const sendRequest = async (
  connection: NativeXpcConnection,
  request: BackgroundAgentRequest,
  identity: Pick<AgentIdentity, "installationId" | "homeIdentity">
) => {
  const response = parseBackgroundAgentResponse(
    await connection.request(JSON.stringify(request), requestTimeoutMs)
  );
  assertResponseMatchesRequest(response, request, identity);
  return response;
};

const assertRequestIdentity = (
  request: BackgroundAgentRequest,
  identity: Pick<AgentIdentity, "installationId" | "homeIdentity">
) => {
  if (
    request.installationId !== identity.installationId ||
    request.homeIdentity !== identity.homeIdentity
  ) {
    throw new Error("Background Agent request identity does not match.");
  }
};

const assertResponseMatchesRequest = (
  response: BackgroundAgentResponse,
  request: BackgroundAgentRequest,
  identity: Pick<AgentIdentity, "installationId" | "homeIdentity">
) => {
  if (
    response.requestId !== request.requestId ||
    response.kind !== request.kind ||
    response.installationId !== identity.installationId ||
    response.homeIdentity !== identity.homeIdentity
  ) {
    throw new Error(
      "Background Agent response identity does not match the request."
    );
  }
};

const responseError = (response: BackgroundAgentResponse) =>
  new Error(
    response.message ??
      response.errorCode ??
      "Background Agent rejected the request."
  );
