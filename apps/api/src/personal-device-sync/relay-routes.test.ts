import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalizePdsJson,
  pdsRelayBodyDigest,
  pdsRelayRequestSigningBytes
} from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";
import { registerPersonalDeviceSyncRelayRoutes } from "./relay-routes.js";

const deviceId = "AAAAAAAAAAAAAAAAAAAAAA";
const signingKeyId = "AQEBAQEBAQEBAQEBAQEBAQ";
const certificate = Buffer.from("{}", "utf8").toString("base64url");

const relayProof = (input: {
  privateKey: KeyObject;
  target: string;
  nonce: string;
  method?: "GET" | "POST";
  body?: Buffer;
}) => {
  const method = input.method ?? "GET";
  const body = input.body ?? Buffer.alloc(0);
  const unsigned = {
    method,
    target: input.target,
    bodyDigest: pdsRelayBodyDigest(body),
    timestamp: new Date().toISOString(),
    nonce: input.nonce,
    deviceId,
    deviceSigningKeyId: signingKeyId
  };
  return Buffer.from(
    canonicalizePdsJson({
      protocol: "koed/pds/v1",
      bodyDigest: unsigned.bodyDigest,
      timestamp: unsigned.timestamp,
      nonce: unsigned.nonce,
      deviceId: unsigned.deviceId,
      deviceSigningKeyId: unsigned.deviceSigningKeyId,
      signature: sign(
        null,
        pdsRelayRequestSigningBytes(unsigned),
        input.privateKey
      ).toString("base64url")
    }),
    "utf8"
  ).toString("base64url");
};

const relayContext = (
  repository: Record<string, unknown>,
  wakePool: ApiRouteContext["personalDeviceSync"]["wakePool"] = null
): ApiRouteContext =>
  ({
    requireRepository: () => repository,
    rateLimit: {
      memoryRead: async () => undefined,
      memoryWrite: async () => undefined
    },
    personalDeviceSync: {
      authoritySigner: {} as never,
      remoteAccountLinkVerifier: null,
      wakePool
    }
  }) as unknown as ApiRouteContext;

describe("PDS relay routes", () => {
  it("accepts only a signed, fresh semantic capability advertisement", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "jwk" }).x!;
    const advertisePdsRelayDeviceCapability = vi.fn(async () => true);
    const repository = {
      authenticatePdsRelayRequest: vi.fn(async () => ({
        groupDbId: "group-db",
        groupId: "group",
        headHash: "head",
        epoch: "1",
        deviceId,
        signingKeyId,
        signingPublicKey: publicKey,
        recipientDeviceIds: [deviceId],
        certificate: {}
      })),
      consumePdsRelayRequestNonce: vi.fn(async () => undefined),
      advertisePdsRelayDeviceCapability
    };
    const app = Fastify();
    registerPersonalDeviceSyncRelayRoutes(app, relayContext(repository));
    const target = "/v1/personal-device-sync/relay/semantic-work/capabilities";
    const advertisedAt = new Date();
    const payload = canonicalizePdsJson({
      capability: "memory_embedding",
      compatibilityContractHash: Buffer.alloc(32, 4).toString("base64url"),
      readiness: "ready",
      advertisedAt: advertisedAt.toISOString(),
      expiresAt: new Date(advertisedAt.getTime() + 120_000).toISOString()
    });
    const body = Buffer.from(payload, "utf8");
    const accepted = await app.inject({
      method: "POST",
      url: target,
      payload,
      headers: {
        "content-type": "application/json",
        "x-pds-membership-certificate": certificate,
        "x-pds-relay-proof": relayProof({
          privateKey: keys.privateKey,
          target,
          nonce: Buffer.alloc(32, 5).toString("base64url"),
          method: "POST",
          body
        })
      }
    });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ accepted: true });
    expect(advertisePdsRelayDeviceCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId,
        capability: "memory_embedding",
        readiness: "ready",
        canonicalRecord: payload
      })
    );

    const stalePayload = canonicalizePdsJson({
      capability: "memory_embedding",
      compatibilityContractHash: Buffer.alloc(32, 4).toString("base64url"),
      readiness: "ready",
      advertisedAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString()
    });
    const staleBody = Buffer.from(stalePayload, "utf8");
    const stale = await app.inject({
      method: "POST",
      url: target,
      payload: stalePayload,
      headers: {
        "content-type": "application/json",
        "x-pds-membership-certificate": certificate,
        "x-pds-relay-proof": relayProof({
          privateKey: keys.privateKey,
          target,
          nonce: Buffer.alloc(32, 6).toString("base64url"),
          method: "POST",
          body: staleBody
        })
      }
    });
    expect(stale.statusCode).toBe(400);
    expect(advertisePdsRelayDeviceCapability).toHaveBeenCalledOnce();
    await app.close();
  });

  it("rejects browser, API-token, and legacy credential bypasses", async () => {
    const app = Fastify();
    registerPersonalDeviceSyncRelayRoutes(app, relayContext({}));
    for (const authorization of [
      "Bearer api-token",
      "Koed-Device legacy-credential"
    ]) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/personal-device-sync/relay/mailbox",
        headers: { authorization }
      });
      expect(response.statusCode).toBe(403);
    }
    const browser = await app.inject({
      method: "GET",
      url: "/v1/personal-device-sync/relay/mailbox",
      headers: { cookie: "cm_session=browser-session" }
    });
    expect(browser.statusCode).toBe(403);
    await app.close();
  });

  it("serves Authority lifecycle controls through prior-head control authentication", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "jwk" }).x!;
    const authenticatePdsRelayRequest = vi.fn(async () => ({
      groupDbId: "group-db",
      groupId: "group",
      headHash: "head",
      epoch: "1",
      deviceId,
      signingKeyId,
      signingPublicKey: publicKey,
      recipientDeviceIds: [deviceId],
      certificate: {}
    }));
    const repository = {
      authenticatePdsRelayRequest,
      consumePdsRelayRequestNonce: vi.fn(async () => undefined),
      getPdsLifecycleControl: vi.fn(async () => ({
        authorityHead: { sequence: "2", hash: "head", statement: "{}" },
        deletionFloors: [],
        controls: [],
        nextCursor: null
      }))
    };
    const app = Fastify();
    registerPersonalDeviceSyncRelayRoutes(app, relayContext(repository));
    const target = "/v1/personal-device-sync/relay/lifecycle?limit=1";
    const response = await app.inject({
      method: "GET",
      url: target,
      headers: {
        "x-pds-membership-certificate": certificate,
        "x-pds-relay-proof": relayProof({
          privateKey: keys.privateKey,
          target,
          nonce: Buffer.alloc(32, 2).toString("base64url")
        })
      }
    });
    expect(response.statusCode).toBe(200);
    expect(authenticatePdsRelayRequest).toHaveBeenCalledWith(
      expect.objectContaining({ allowStaleHead: true })
    );
    await app.close();
  });

  it("binds proof query exactly and rejects nonce replay", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "jwk" }).x!;
    const consumed = new Set<string>();
    const consumePdsRelayRequestNonce = vi.fn(
      async ({ nonce }: { nonce: string }) => {
        if (consumed.has(nonce)) {
          throw Object.assign(
            new Error("PDS relay request nonce was already used"),
            {
              statusCode: 409
            }
          );
        }
        consumed.add(nonce);
      }
    );
    const repository = {
      authenticatePdsRelayRequest: vi.fn(async () => ({
        groupDbId: "group-db",
        groupId: "group",
        headHash: "head",
        epoch: "1",
        deviceId,
        signingKeyId,
        signingPublicKey: publicKey,
        recipientDeviceIds: [deviceId],
        certificate: {}
      })),
      consumePdsRelayRequestNonce,
      listPdsRelayMailbox: vi.fn(async () => ({
        transports: [],
        nextCursor: null
      }))
    };
    const app = Fastify();
    registerPersonalDeviceSyncRelayRoutes(app, relayContext(repository));
    const nonce = Buffer.alloc(32, 1).toString("base64url");
    const target = "/v1/personal-device-sync/relay/mailbox?limit=1";
    const headers = {
      "x-pds-membership-certificate": certificate,
      "x-pds-relay-proof": relayProof({
        privateKey: keys.privateKey,
        target,
        nonce
      })
    };
    const accepted = await app.inject({ method: "GET", url: target, headers });
    expect(accepted.statusCode).toBe(200);
    const altered = await app.inject({
      method: "GET",
      url: "/v1/personal-device-sync/relay/mailbox?limit=2",
      headers
    });
    expect(altered.statusCode).toBe(403);
    const replay = await app.inject({ method: "GET", url: target, headers });
    expect(replay.statusCode).toBe(409);
    expect(repository.listPdsRelayMailbox).toHaveBeenCalledOnce();
    await app.close();
  });

  it("authenticates wake requests and checks durable mailbox state after listening", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "jwk" }).x!;
    const repository = {
      authenticatePdsRelayRequest: vi.fn(async () => ({
        groupDbId: "group-db",
        groupId: "group",
        headHash: "head",
        epoch: "1",
        deviceId,
        signingKeyId,
        signingPublicKey: publicKey,
        recipientDeviceIds: [deviceId],
        certificate: {}
      })),
      consumePdsRelayRequestNonce: vi.fn(async () => undefined),
      listPdsRelayMailbox: vi.fn(async () => ({
        transports: [{ transportId: "pending" }],
        nextCursor: null
      }))
    };
    const wakeClient = {
      query: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
      release: vi.fn()
    };
    const app = Fastify();
    registerPersonalDeviceSyncRelayRoutes(
      app,
      relayContext(repository, {
        connect: vi.fn().mockResolvedValue(wakeClient)
      })
    );
    const target = "/v1/personal-device-sync/relay/wake";
    const response = await app.inject({
      method: "GET",
      url: target,
      headers: {
        "x-pds-membership-certificate": certificate,
        "x-pds-relay-proof": relayProof({
          privateKey: keys.privateKey,
          target,
          nonce: Buffer.alloc(32, 3).toString("base64url")
        })
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ wake: true });
    expect(wakeClient.query).toHaveBeenNthCalledWith(
      1,
      "listen koed_pds_relay_wake"
    );
    expect(repository.listPdsRelayMailbox).toHaveBeenCalledOnce();
    expect(wakeClient.release).toHaveBeenCalledOnce();
    await app.close();
  });

  it("closes the sender ACK race with a durable post-listen transport check", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "jwk" }).x!;
    const transportId = Buffer.alloc(32, 7).toString("base64url");
    const repository = {
      authenticatePdsRelayRequest: vi.fn(async () => ({
        groupDbId: "group-db",
        groupId: "group",
        headHash: "head",
        epoch: "1",
        deviceId,
        signingKeyId,
        signingPublicKey: publicKey,
        recipientDeviceIds: [deviceId],
        certificate: {}
      })),
      consumePdsRelayRequestNonce: vi.fn(async () => undefined),
      listPdsRelayMailbox: vi.fn(async () => ({
        transports: [],
        nextCursor: null
      })),
      hasPdsRelayAcknowledgement: vi.fn(async () => true)
    };
    const wakeClient = {
      query: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
      release: vi.fn()
    };
    const app = Fastify();
    registerPersonalDeviceSyncRelayRoutes(
      app,
      relayContext(repository, {
        connect: vi.fn().mockResolvedValue(wakeClient)
      })
    );
    const target = `/v1/personal-device-sync/relay/wake?transportId=${transportId}`;
    const response = await app.inject({
      method: "GET",
      url: target,
      headers: {
        "x-pds-membership-certificate": certificate,
        "x-pds-relay-proof": relayProof({
          privateKey: keys.privateKey,
          target,
          nonce: Buffer.alloc(32, 4).toString("base64url")
        })
      }
    });

    expect(response.statusCode).toBe(200);
    expect(repository.hasPdsRelayAcknowledgement).toHaveBeenCalledWith(
      expect.objectContaining({ transportIds: [transportId] })
    );
    expect(wakeClient.query).toHaveBeenNthCalledWith(
      1,
      "listen koed_pds_relay_wake"
    );
    await app.close();
  });
});
