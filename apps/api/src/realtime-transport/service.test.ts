import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ConsumeRealtimeTransportTicketInput as RepositoryConsumeInput,
  CreateRealtimeTransportTicketInput,
  RealtimeTransportAdmissionRecord,
  RealtimeTransportTicketRepository
} from "@koed/db";
import { createRealtimeTransportAdmissionService } from "./service.js";

const backendIdentity = "11111111-1111-4111-8111-111111111111";
const clientInstanceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const userId = "44444444-4444-4444-8444-444444444444";
const deviceCredentialId = "55555555-5555-4555-8555-555555555555";
const deviceInstanceId = "device-a";
const hashSecret = (value: string): string =>
  createHash("sha256").update(`pepper:${value}`).digest("hex");

class MemoryTicketRepository implements RealtimeTransportTicketRepository {
  created: CreateRealtimeTransportTicketInput | null = null;
  consumed = false;
  principalActive = true;

  async createTicket(input: CreateRealtimeTransportTicketInput): Promise<void> {
    this.created = structuredClone(input);
  }

  async consumeTicket(
    input: RepositoryConsumeInput
  ): Promise<RealtimeTransportAdmissionRecord | null> {
    const created = this.created;
    if (
      !created ||
      this.consumed ||
      created.expiresAt <= new Date() ||
      input.id !== created.id ||
      input.secretHash !== created.secretHash ||
      input.transport !== created.transport ||
      input.protocolVersion !== created.protocolVersion ||
      input.backendIdentityHash !== created.backendIdentityHash ||
      input.clientInstanceHash !== created.clientInstanceHash ||
      input.clientKind !== created.clientKind ||
      input.originHash !== created.originHash ||
      input.nativeBindingHash !== created.nativeBindingHash
    ) {
      return null;
    }
    this.consumed = true;
    return {
      ticketId: created.id,
      ownerUserId: created.ownerUserId,
      authKind: created.authKind,
      userSessionId: created.userSessionId,
      deviceCredentialId: created.deviceCredentialId,
      transport: created.transport,
      protocolVersion: created.protocolVersion,
      operationFamilies: created.operationFamilies,
      consumedAt: new Date().toISOString()
    };
  }

  async resolveActivePrincipal(admission: RealtimeTransportAdmissionRecord) {
    if (!this.principalActive) return null;
    return {
      user: {
        id: admission.ownerUserId,
        email: "user@example.test",
        displayName: "User"
      },
      operationFamilies:
        admission.authKind === "session"
          ? null
          : [...admission.operationFamilies]
    };
  }

  async revokeTicketsForPrincipal(): Promise<number> {
    return 0;
  }

  async deleteExpiredTickets(): Promise<number> {
    return 0;
  }
}

const harness = (
  input: {
    repository?: MemoryTicketRepository;
    now?: () => Date;
    backend?: string;
  } = {}
) => {
  const repository = input.repository ?? new MemoryTicketRepository();
  return {
    repository,
    service: createRealtimeTransportAdmissionService({
      repository,
      hashSecret,
      backendIdentity: input.backend ?? backendIdentity,
      adapters: [
        {
          transport: "webtransport",
          protocolVersions: [1],
          endpoint: "https://api.example.test/v1/realtime/webtransport"
        }
      ],
      now: input.now
    })
  };
};

const browserRequest = {
  transport: "webtransport" as const,
  protocolVersion: 1,
  clientInstanceId,
  clientKind: "browser" as const,
  operationFamilies: ["team_chat_read" as const]
};

describe("realtime transport admission tickets", () => {
  it("issues a hash-only browser ticket and admits it exactly once", async () => {
    const { service, repository } = harness();
    const issued = await service.issueTicket(
      {
        authKind: "session",
        ownerUserId: userId,
        userSessionId: sessionId,
        origin: "https://app.example.test"
      },
      browserRequest
    );

    expect(issued.ticket).toMatch(/^rtt1_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(repository.created).toMatchObject({
      ownerUserId: userId,
      userSessionId: sessionId,
      deviceCredentialId: null,
      authKind: "session",
      clientKind: "browser",
      operationFamilies: ["team_chat_read"]
    });
    expect(JSON.stringify(repository.created)).not.toContain(issued.ticket);
    expect(repository.created?.secretHash).toMatch(/^[0-9a-f]{64}$/);

    const admitted = await service.consumeTicket({
      ticket: issued.ticket,
      transport: "webtransport",
      protocolVersion: 1,
      clientInstanceId,
      clientKind: "browser",
      origin: "https://app.example.test",
      nativeDeviceInstanceId: null,
      connectionId: "connection-a"
    });
    expect(admitted).toMatchObject({
      ownerUserId: userId,
      userSessionId: sessionId,
      operationFamilies: ["team_chat_read"]
    });
    await expect(
      service.consumeTicket({
        ticket: issued.ticket,
        transport: "webtransport",
        protocolVersion: 1,
        clientInstanceId,
        clientKind: "browser",
        origin: "https://app.example.test",
        nativeDeviceInstanceId: null,
        connectionId: "connection-b"
      })
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("fails closed for origin, client, protocol, transport, and backend mismatches", async () => {
    const attempts = [
      { origin: "https://evil.example.test" },
      { clientInstanceId: "66666666-6666-4666-8666-666666666666" },
      { protocolVersion: 2 },
      { transport: "websocket" as const }
    ];
    for (const override of attempts) {
      const repository = new MemoryTicketRepository();
      const service = harness({ repository }).service;
      const issued = await service.issueTicket(
        {
          authKind: "session",
          ownerUserId: userId,
          userSessionId: sessionId,
          origin: "https://app.example.test"
        },
        browserRequest
      );
      await expect(
        service.consumeTicket({
          ticket: issued.ticket,
          transport: "webtransport",
          protocolVersion: 1,
          clientInstanceId,
          clientKind: "browser",
          origin: "https://app.example.test",
          nativeDeviceInstanceId: null,
          connectionId: "connection-a",
          ...override
        })
      ).rejects.toMatchObject({ statusCode: 401 });
    }

    const sharedRepository = new MemoryTicketRepository();
    const issuer = harness({ repository: sharedRepository }).service;
    const otherBackend = harness({
      repository: sharedRepository,
      backend: "77777777-7777-4777-8777-777777777777"
    }).service;
    const issued = await issuer.issueTicket(
      {
        authKind: "session",
        ownerUserId: userId,
        userSessionId: sessionId,
        origin: "https://app.example.test"
      },
      browserRequest
    );
    await expect(
      otherBackend.consumeTicket({
        ticket: issued.ticket,
        transport: "webtransport",
        protocolVersion: 1,
        clientInstanceId,
        clientKind: "browser",
        origin: "https://app.example.test",
        nativeDeviceInstanceId: null,
        connectionId: "connection-a"
      })
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("binds native tickets to a device and prevents operation-family escalation", async () => {
    const { service, repository } = harness();
    await expect(
      service.issueTicket(
        {
          authKind: "device_credential",
          ownerUserId: userId,
          deviceCredentialId,
          deviceInstanceId,
          credentialOperationFamilies: ["team_chat_read"]
        },
        {
          ...browserRequest,
          clientKind: "native",
          operationFamilies: ["managed_execution"]
        }
      )
    ).rejects.toMatchObject({ statusCode: 403 });

    const issued = await service.issueTicket(
      {
        authKind: "device_credential",
        ownerUserId: userId,
        deviceCredentialId,
        deviceInstanceId,
        credentialOperationFamilies: ["team_chat_read"]
      },
      { ...browserRequest, clientKind: "native" }
    );
    expect(repository.created).toMatchObject({
      authKind: "device_credential",
      userSessionId: null,
      deviceCredentialId,
      originHash: null
    });
    await expect(
      service.consumeTicket({
        ticket: issued.ticket,
        transport: "webtransport",
        protocolVersion: 1,
        clientInstanceId,
        clientKind: "native",
        origin: null,
        nativeDeviceInstanceId: "device-b",
        connectionId: "connection-a"
      })
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("fails closed when the admitted principal is no longer active", async () => {
    const { service, repository } = harness();
    const issued = await service.issueTicket(
      {
        authKind: "session",
        ownerUserId: userId,
        userSessionId: sessionId,
        origin: "https://app.example.test"
      },
      browserRequest
    );
    const admission = await service.consumeTicket({
      ticket: issued.ticket,
      transport: "webtransport",
      protocolVersion: 1,
      clientInstanceId,
      clientKind: "browser",
      origin: "https://app.example.test",
      nativeDeviceInstanceId: null,
      connectionId: "connection-a"
    });
    await expect(service.reauthenticate(admission)).resolves.toMatchObject({
      user: { id: userId },
      operationFamilies: ["team_chat_read"]
    });
    repository.principalActive = false;
    await expect(service.reauthenticate(admission)).rejects.toMatchObject({
      statusCode: 401
    });
  });

  it("expires tickets after thirty seconds and rejects unavailable adapters", async () => {
    const repository = new MemoryTicketRepository();
    const issuedAt = new Date();
    const service = harness({ repository, now: () => issuedAt }).service;
    const issued = await service.issueTicket(
      {
        authKind: "session",
        ownerUserId: userId,
        userSessionId: sessionId,
        origin: "https://app.example.test"
      },
      browserRequest
    );
    expect(new Date(issued.expiresAt).getTime() - issuedAt.getTime()).toBe(
      30_000
    );
    if (repository.created) {
      repository.created.expiresAt = new Date(Date.now() - 1);
    }
    await expect(
      service.consumeTicket({
        ticket: issued.ticket,
        transport: "webtransport",
        protocolVersion: 1,
        clientInstanceId,
        clientKind: "browser",
        origin: "https://app.example.test",
        nativeDeviceInstanceId: null,
        connectionId: "connection-a"
      })
    ).rejects.toMatchObject({ statusCode: 401 });

    await expect(
      service.issueTicket(
        {
          authKind: "session",
          ownerUserId: userId,
          userSessionId: sessionId,
          origin: "https://app.example.test"
        },
        { ...browserRequest, transport: "websocket" }
      )
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "realtime_transport_unavailable"
    });
  });

  it("rejects malformed ticket material without repository admission", async () => {
    const { service, repository } = harness();
    await expect(
      service.consumeTicket({
        ticket: "not-a-ticket",
        transport: "webtransport",
        protocolVersion: 1,
        clientInstanceId,
        clientKind: "browser",
        origin: "https://app.example.test",
        nativeDeviceInstanceId: null,
        connectionId: "connection-a"
      })
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(repository.consumed).toBe(false);
  });

  it("advertises a runtime adapter only for its registered lifetime", () => {
    const { service } = harness();
    expect(service.adapters().map((adapter) => adapter.transport)).toEqual([
      "webtransport"
    ]);
    const unregister = service.registerAdapter({
      transport: "websocket",
      protocolVersions: [1],
      endpoint: "wss://api.example.test/v1/realtime/websocket"
    });
    expect(service.adapters().map((adapter) => adapter.transport)).toEqual([
      "webtransport",
      "websocket"
    ]);
    expect(() =>
      service.registerAdapter({
        transport: "websocket",
        protocolVersions: [1],
        endpoint: "wss://other.example.test/realtime"
      })
    ).toThrow(/already registered/);
    unregister();
    expect(service.adapters().map((adapter) => adapter.transport)).toEqual([
      "webtransport"
    ]);
  });
});
