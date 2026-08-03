import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizePdsJson } from "./personal-device-sync-jcs.js";
import {
  canonicalizePdsRelayRequestTarget,
  parsePdsRelayRequestProof,
  pdsRelayBodyDigest,
  pdsRelayRequestNonceExpiresAt,
  pdsRelayRequestSigningBytes,
  verifyPdsRelayRequestProof
} from "./personal-device-sync-relay.js";

const deviceId = "AAAAAAAAAAAAAAAAAAAAAA";
const signingKeyId = "AQEBAQEBAQEBAQEBAQEBAQ";

describe("PDS relay request proofs", () => {
  it("binds exact canonical method, target, body, time, and nonce", () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "jwk" }).x!;
    const body = Buffer.from('{"chunkIndex":"0"}', "utf8");
    const unsigned = {
      method: "PUT",
      target:
        "/v1/personal-device-sync/relay/transports/x/chunks/0?z=%7e&a=two&a=one",
      bodyDigest: pdsRelayBodyDigest(body),
      timestamp: "2026-07-15T00:00:00.000Z",
      nonce: Buffer.alloc(32, 3).toString("base64url"),
      deviceId,
      deviceSigningKeyId: signingKeyId
    };
    const proof = {
      protocol: "koed/pds/v1" as const,
      bodyDigest: unsigned.bodyDigest,
      timestamp: unsigned.timestamp,
      nonce: unsigned.nonce,
      deviceId: unsigned.deviceId,
      deviceSigningKeyId: unsigned.deviceSigningKeyId,
      signature: sign(
        null,
        pdsRelayRequestSigningBytes(unsigned),
        keys.privateKey
      ).toString("base64url")
    };
    const parsed = parsePdsRelayRequestProof(canonicalizePdsJson(proof));
    expect(() =>
      verifyPdsRelayRequestProof({
        proof: parsed,
        method: unsigned.method,
        target:
          "/v1/personal-device-sync/relay/transports/x/chunks/0?a=one&a=two&z=~",
        body,
        signingPublicKey: publicKey,
        now: new Date(unsigned.timestamp)
      })
    ).not.toThrow();
    expect(() =>
      verifyPdsRelayRequestProof({
        proof: parsed,
        method: "POST",
        target: unsigned.target,
        body,
        signingPublicKey: publicKey,
        now: new Date(unsigned.timestamp)
      })
    ).toThrow("signature");
    expect(() =>
      verifyPdsRelayRequestProof({
        proof: parsed,
        method: unsigned.method,
        target:
          "/v1/personal-device-sync/relay/transports/x/chunks/0?a=three&a=one&z=~",
        body,
        signingPublicKey: publicKey,
        now: new Date(unsigned.timestamp)
      })
    ).toThrow("signature");
    expect(() =>
      verifyPdsRelayRequestProof({
        proof: parsed,
        method: unsigned.method,
        target: unsigned.target,
        body: Buffer.from("{}"),
        signingPublicKey: publicKey,
        now: new Date(unsigned.timestamp)
      })
    ).toThrow("digest");
  });

  it("keeps nonce through signed skew without extending it for future clocks", () => {
    const now = new Date("2026-07-15T00:00:00.000Z");
    expect(
      pdsRelayRequestNonceExpiresAt("2026-07-15T00:04:00.000Z", now)
    ).toEqual(new Date("2026-07-15T00:05:00.000Z"));
    expect(
      pdsRelayRequestNonceExpiresAt("2026-07-14T23:58:00.000Z", now)
    ).toEqual(new Date("2026-07-15T00:03:00.000Z"));
    expect(canonicalizePdsRelayRequestTarget("/relay?b=%7e&a=two&a=one")).toBe(
      "/relay?a=one&a=two&b=~"
    );
  });
});
