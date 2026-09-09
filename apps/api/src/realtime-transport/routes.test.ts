import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ApiRouteContext } from "../server/context.js";
import { registerRealtimeTransportRoutes } from "./routes.js";
import type { RealtimeTransportAdmissionService } from "./service.js";

const userId = randomUUID();
const sessionId = randomUUID();
const clientInstanceId = `lcb1.${"a".repeat(43)}`;
const credentialId = randomUUID();

const auth = (overrides: Partial<ApiRouteContext["auth"]> = {}) =>
  ({
    authenticateSessionContext: vi.fn(async () => ({
      sessionId,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: userId,
        email: "user@example.test",
        displayName: "User",
        passwordHash: null
      }
    })),
    authenticateDeviceCredential: vi.fn(async () => ({
      user: {
        id: userId,
        email: "user@example.test",
        displayName: "User",
        passwordHash: null
      },
      credential: {
        id: credentialId,
        deviceInstanceId: "device-a",
        operationFamilies: ["team_chat_read"]
      }
    })),
    ...overrides
  }) as unknown as ApiRouteContext["auth"];

const admission = () =>
  ({
    adapters: () => [],
    registerAdapter: vi.fn(() => vi.fn()),
    issueTicket: vi.fn(async (_principal, input) => ({
      ticket: `rtt1_${randomUUID()}.${"x".repeat(43)}`,
      ticketVersion: 1 as const,
      transport: input.transport,
      protocolVersion: input.protocolVersion,
      clientInstanceId: input.clientInstanceId,
      operationFamilies: input.operationFamilies,
      expiresAt: new Date(Date.now() + 30_000).toISOString()
    })),
    consumeTicket: vi.fn(),
    reauthenticate: vi.fn()
  }) satisfies RealtimeTransportAdmissionService;

const createApp = async (
  input: {
    auth?: ApiRouteContext["auth"];
    admission?: RealtimeTransportAdmissionService | null;
  } = {}
) => {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    reply.status((error as { statusCode?: number }).statusCode ?? 500).send({
      error: error instanceof Error ? error.message : "Request failed"
    });
  });
  registerRealtimeTransportRoutes(app, {
    auth: input.auth ?? auth(),
    writeRateLimit: async () => undefined,
    admissionService:
      input.admission === undefined ? admission() : input.admission
  });
  await app.ready();
  return app;
};

const payload = {
  transport: "webtransport",
  protocolVersion: 1,
  clientInstanceId,
  clientKind: "browser",
  operationFamilies: ["team_chat_read"]
};

describe("realtime transport ticket route", () => {
  it("binds browser issuance to the authenticated session and Origin", async () => {
    const service = admission();
    const app = await createApp({ admission: service });
    const response = await app.inject({
      method: "POST",
      url: "/v1/realtime/transport-tickets",
      headers: { origin: "https://app.example.test" },
      payload
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(service.issueTicket).toHaveBeenCalledWith(
      {
        authKind: "session",
        ownerUserId: userId,
        userSessionId: sessionId,
        origin: "https://app.example.test"
      },
      payload
    );
    await app.close();
  });

  it("binds native issuance to the exact device credential", async () => {
    const service = admission();
    const app = await createApp({ admission: service });
    const nativePayload = { ...payload, clientKind: "native" };
    const response = await app.inject({
      method: "POST",
      url: "/v1/realtime/transport-tickets",
      headers: { authorization: "Koed-Device key:secret" },
      payload: nativePayload
    });
    expect(response.statusCode).toBe(201);
    expect(service.issueTicket).toHaveBeenCalledWith(
      {
        authKind: "device_credential",
        ownerUserId: userId,
        deviceCredentialId: credentialId,
        deviceInstanceId: "device-a",
        credentialOperationFamilies: ["team_chat_read"]
      },
      nativePayload
    );
    await app.close();
  });

  it("rejects API tokens, missing browser origins, and unavailable admission", async () => {
    const app = await createApp();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/realtime/transport-tickets",
          headers: { authorization: "Bearer personal-token" },
          payload
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/realtime/transport-tickets",
          payload
        })
      ).statusCode
    ).toBe(403);
    await app.close();

    const unavailable = await createApp({ admission: null });
    expect(
      (
        await unavailable.inject({
          method: "POST",
          url: "/v1/realtime/transport-tickets",
          headers: { origin: "https://app.example.test" },
          payload
        })
      ).statusCode
    ).toBe(503);
    await unavailable.close();
  });
});
