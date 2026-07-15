import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizePdsJson } from "./personal-device-sync-jcs.js";
import {
  parsePdsRelayRequestProof,
  pdsRelayBodyDigest,
  pdsRelayRequestSigningBytes,
  verifyPdsRelayRequestProof
} from "./personal-device-sync-relay.js";

const deviceId = "AAAAAAAAAAAAAAAAAAAAAA";
const signingKeyId = "AQEBAQEBAQEBAQEBAQEBAQ";

describe("PDS relay request proofs", () => {
  it("binds exact canonical method, path, body, time, and nonce", () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "jwk" }).x!;
    const body = Buffer.from('{"chunkIndex":"0"}', "utf8");
    const unsigned = {
      method: "PUT",
      path: "/v1/personal-device-sync/relay/transports/x/chunks/0",
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
        path: unsigned.path,
        body,
        signingPublicKey: publicKey,
        now: new Date(unsigned.timestamp)
      })
    ).not.toThrow();
    expect(() =>
      verifyPdsRelayRequestProof({
        proof: parsed,
        method: "POST",
        path: unsigned.path,
        body,
        signingPublicKey: publicKey,
        now: new Date(unsigned.timestamp)
      })
    ).toThrow("signature");
    expect(() =>
      verifyPdsRelayRequestProof({
        proof: parsed,
        method: unsigned.method,
        path: unsigned.path,
        body: Buffer.from("{}"),
        signingPublicKey: publicKey,
        now: new Date(unsigned.timestamp)
      })
    ).toThrow("digest");
  });
});
