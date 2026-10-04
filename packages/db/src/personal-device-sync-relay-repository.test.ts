import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { parseCanonicalPdsJson } from "@koed/shared";
import {
  PDS_PROTOCOL,
  canonicalizePdsJson,
  pdsRelayBodyDigest,
  pdsRelayRequestSigningBytes,
  signPdsRecord,
  type PdsRelayRequestProof
} from "@koed/shared";
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import {
  pdsCanonicalRelayRecipients,
  pdsRedactedRelayReceipt,
  pdsRelayCertificateEpochAllowed,
  pdsRelayControlAllowedDuringPending,
  pdsRelayDeliveryRecipients,
  createPersonalDeviceSyncRelayRepository
} from "./personal-device-sync-relay-repository.js";

const groupId = Buffer.alloc(16, 1).toString("base64url");
const deviceId = Buffer.alloc(16, 2).toString("base64url");
const signingKeyId = Buffer.alloc(16, 3).toString("base64url");
const authorityKeyId = Buffer.alloc(16, 4).toString("base64url");
const currentHead = Buffer.alloc(32, 5).toString("base64url");
const oldHead = Buffer.alloc(32, 6).toString("base64url");
const authorityKeys = generateKeyPairSync("ed25519");
const deviceKeys = generateKeyPairSync("ed25519");
const authorityPublicKey = authorityKeys.publicKey.export({ format: "jwk" }).x!;
const devicePublicKey = deviceKeys.publicKey.export({ format: "jwk" }).x!;
const otherDevicePublicKey = generateKeyPairSync("ed25519").publicKey.export({
  format: "jwk"
}).x!;
const publicBytes = (key: KeyObject): string =>
  key.export({ format: "jwk" }).x!;

const signedCertificate = (overrides: Record<string, unknown> = {}): string => {
  const now = Date.now();
  const unsigned = {
    protocol: PDS_PROTOCOL,
    groupId,
    deviceId,
    deviceSigningKeyId: signingKeyId,
    deviceSigningPublicKey: publicBytes(deviceKeys.publicKey),
    deviceKemKeyId: Buffer.alloc(16, 7).toString("base64url"),
    deviceKemPublicKey: Buffer.alloc(32, 8).toString("base64url"),
    epoch: "1",
    operationFamilies: ["pds_relay"],
    statementSequence: "1",
    statementHash: oldHead,
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    ...overrides
  };
  return canonicalizePdsJson({
    ...unsigned,
    authoritySignature: {
      keyId: authorityKeyId,
      signature: signPdsRecord(
        "membership-certificate",
        unsigned,
        authorityKeys.privateKey
      )
    }
  });
};

const signedProof = (): PdsRelayRequestProof => {
  const unsigned = {
    method: "GET",
    target: "/v1/personal-device-sync/relay/mailbox",
    bodyDigest: pdsRelayBodyDigest(Buffer.alloc(0)),
    timestamp: new Date().toISOString(),
    nonce: Buffer.alloc(32, 9).toString("base64url"),
    deviceId,
    deviceSigningKeyId: signingKeyId
  };
  return {
    protocol: PDS_PROTOCOL,
    deviceId,
    deviceSigningKeyId: signingKeyId,
    timestamp: unsigned.timestamp,
    nonce: unsigned.nonce,
    bodyDigest: unsigned.bodyDigest,
    signature: sign(
      null,
      pdsRelayRequestSigningBytes(unsigned),
      deviceKeys.privateKey
    ).toString("base64url")
  };
};

const relayRepositoryHarness = (input: {
  status: "active" | "revoked";
  epoch?: string;
  pendingEpoch?: string | null;
  headHash?: string;
  cert?: string;
  memberPublicKey?: string;
}) => {
  const calls: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      calls.push(sql.trim().toLowerCase());
      if (sql.includes("from personal_device_groups"))
        return {
          rowCount: 1,
          rows: [
            {
              id: "group-db",
              group_id: groupId,
              authority_key_id: authorityKeyId,
              authority_public_key: authorityPublicKey,
              current_epoch: input.epoch ?? "2",
              head_hash: input.headHash ?? currentHead,
              state: "active",
              pending_epoch: input.pendingEpoch ?? null
            }
          ]
        };
      if (
        sql.includes("from personal_device_group_members") &&
        sql.includes("status in")
      )
        return {
          rowCount: 1,
          rows: [
            {
              device_id: deviceId,
              signing_key_id: signingKeyId,
              signing_public_key: input.memberPublicKey ?? devicePublicKey,
              status: input.status
            }
          ]
        };
      if (sql.includes("from personal_device_group_members"))
        return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    }),
    release: vi.fn()
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
  const repository = createPersonalDeviceSyncRelayRepository(pool);
  const authenticate = (certificate = input.cert ?? signedCertificate()) =>
    repository.authenticatePdsRelayRequest({
      certificate,
      proof: signedProof()
    });
  return { authenticate, calls, client };
};

describe("Personal Device Sync relay authentication", () => {
  it("accepts a signed revoked prior-epoch certificate during pending transition as revoked", async () => {
    const harness = relayRepositoryHarness({
      status: "revoked",
      pendingEpoch: "3"
    });
    await expect(harness.authenticate()).resolves.toMatchObject({
      deviceRevoked: true,
      epoch: "2",
      allowStaleHead: false
    });
    expect(harness.calls).toContain("commit");
    expect(harness.calls).not.toContain("rollback");
    expect(harness.client.release).toHaveBeenCalledOnce();
  });

  it("rejects active stale certificates rather than treating them as revoked", async () => {
    const harness = relayRepositoryHarness({ status: "active" });
    await expect(harness.authenticate()).rejects.toMatchObject({
      statusCode: 404
    });
    expect(harness.calls).toContain("rollback");
    expect(harness.client.release).toHaveBeenCalledOnce();
  });

  it.each([
    ["future epoch", { epoch: "3" }],
    [
      "expired certificate",
      { expiresAt: new Date(Date.now() - 1_000).toISOString() }
    ],
    ["forged authority signature", { signatureForgery: true }]
  ])("rejects %s certificate", async (_label, options) => {
    const overrides = { ...options } as Record<string, unknown>;
    const forged = overrides.signatureForgery === true;
    delete overrides.signatureForgery;
    const certificate = signedCertificate(overrides);
    const selected = forged
      ? canonicalizePdsJson({
          ...(parseCanonicalPdsJson(certificate) as Record<string, unknown>),
          authoritySignature: {
            keyId: authorityKeyId,
            signature: Buffer.alloc(64).toString("base64url")
          }
        })
      : certificate;
    const harness = relayRepositoryHarness({
      status: "revoked",
      cert: selected
    });
    await expect(harness.authenticate()).rejects.toMatchObject({
      statusCode: 404
    });
    expect(harness.calls).toContain("rollback");
    expect(harness.client.release).toHaveBeenCalledOnce();
  });

  it("rejects a certificate whose signing key differs from persisted member key", async () => {
    const harness = relayRepositoryHarness({
      status: "revoked",
      memberPublicKey: otherDevicePublicKey
    });
    await expect(harness.authenticate()).rejects.toMatchObject({
      statusCode: 404
    });
    expect(harness.calls).toContain("rollback");
    expect(harness.client.release).toHaveBeenCalledOnce();
  });
});

describe("Personal Device Sync relay receipts", () => {
  it("accepts old certificate epochs only for recovery control operations", () => {
    expect(pdsRelayCertificateEpochAllowed("3", "3", false)).toBe(true);
    expect(pdsRelayCertificateEpochAllowed("2", "3", false)).toBe(false);
    expect(pdsRelayCertificateEpochAllowed("2", "3", true)).toBe(true);
    expect(pdsRelayCertificateEpochAllowed("4", "3", true)).toBe(false);
    expect(pdsRelayCertificateEpochAllowed("02", "3", true)).toBe(false);
  });
  it("allows only stale-head control operations through pending epoch transitions", () => {
    expect(pdsRelayControlAllowedDuringPending(null, false)).toBe(true);
    expect(pdsRelayControlAllowedDuringPending("4", false)).toBe(false);
    expect(pdsRelayControlAllowedDuringPending("4", true)).toBe(true);
  });

  it("serializes numeric audit fields as canonical decimal strings", () => {
    const receipt = pdsRedactedRelayReceipt({
      groupId: "group",
      transportId: "transport",
      packageId: "package",
      sourceManifestHash: "manifest",
      relayAcceptedAt: "2026-07-29T00:00:00.000Z",
      ciphertextBytes: "2048",
      recipientCount: 2
    });

    expect(parseCanonicalPdsJson(receipt)).toMatchObject({
      receiptVersion: "1",
      ciphertextBytes: "2048",
      recipientCount: "2"
    });
  });

  it("canonicalizes unordered database recipient IDs before snapshot checks", () => {
    expect(
      pdsCanonicalRelayRecipients(["z-device", "A-device", "a-device"])
    ).toEqual(["A-device", "a-device", "z-device"]);
  });

  it("delivers to peers without making the serving device ACK itself", () => {
    expect(
      pdsRelayDeliveryRecipients(
        ["device-a", "device-b", "device-c"],
        "device-b"
      )
    ).toEqual(["device-a", "device-c"]);
  });
});
