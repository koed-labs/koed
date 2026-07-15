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
}) => {
  const unsigned = {
    method: "GET",
    target: input.target,
    bodyDigest: pdsRelayBodyDigest(Buffer.alloc(0)),
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

const relayContext = (repository: Record<string, unknown>): ApiRouteContext =>
  ({
    requireRepository: () => repository,
    rateLimit: {
      memoryRead: async () => undefined,
      memoryWrite: async () => undefined
    },
    personalDeviceSync: {
      authoritySigner: {} as never,
      remoteAccountLinkVerifier: null
    }
  }) as unknown as ApiRouteContext;

describe("PDS relay routes", () => {
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
});
