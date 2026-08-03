import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  PdsRelayClient,
  normalizePdsRelayBaseUrl
} from "./personal-device-sync-relay-client.js";

describe("PDS relay URL boundary", () => {
  it.each([
    ["https://relay.example.com", "https://relay.example.com"],
    ["https://relay.example.com/", "https://relay.example.com"],
    ["https://relay.example.com/pds", "https://relay.example.com/pds"],
    ["http://localhost:3310", "http://localhost:3310"],
    ["http://127.0.0.1:3310", "http://127.0.0.1:3310"],
    ["http://10.0.0.2:3310", "http://10.0.0.2:3310"],
    ["http://172.30.104.30:3310", "http://172.30.104.30:3310"],
    ["http://172.30.104.30:3310/pds", "http://172.30.104.30:3310/pds"],
    ["http://192.168.1.2:3310", "http://192.168.1.2:3310"],
    ["http://169.254.1.2:3310", "http://169.254.1.2:3310"]
  ])("accepts an authenticated relay origin %s", (input, expected) => {
    expect(normalizePdsRelayBaseUrl(input)).toBe(expected);
  });

  it.each([
    "http://example.com",
    "http://203.0.113.2:3310",
    "ftp://192.168.1.2:3310",
    "https://user:password@relay.example.com",
    "https://relay.example.com?query=yes",
    "https://relay.example.com/#fragment",
    "https://relay.example.com/pds/../admin",
    "https://relay.example.com/pds/%2e%2e/admin",
    "http://192.168.001.2:3310",
    "not a URL"
  ])("rejects a non-origin or unsafe relay URL %s", (input) => {
    expect(() => normalizePdsRelayBaseUrl(input)).toThrow();
  });

  it("uses a signed long-lived request for relay wakeups", async () => {
    const keys = generateKeyPairSync("ed25519");
    const privateJwk = keys.privateKey.export({ format: "jwk" });
    const publicJwk = keys.publicKey.export({ format: "jwk" });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ wake: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const controller = new AbortController();
    const client = new PdsRelayClient({
      baseUrl: "http://192.168.1.2:3310/pds",
      identity: {
        certificate: "{}",
        deviceId: "AAAAAAAAAAAAAAAAAAAAAA",
        signingKeyId: "AQEBAQEBAQEBAQEBAQEBAQ",
        signingPublicKey: publicJwk.x!,
        signingPrivateSeed: privateJwk.d!
      },
      fetch: fetcher
    });

    await client.waitForWake(controller.signal);

    expect(fetcher).toHaveBeenCalledOnce();
    const [requestedUrl, requestedInit] = fetcher.mock.calls[0]!;
    expect(requestedUrl).toBe(
      "http://192.168.1.2:3310/pds/v1/personal-device-sync/relay/wake"
    );
    expect(requestedInit?.method).toBe("GET");
    expect(requestedInit?.signal).toBe(controller.signal);
    const headers = new Headers(requestedInit?.headers);
    expect(headers.get("x-pds-membership-certificate")).toEqual(
      expect.any(String)
    );
    expect(headers.get("x-pds-relay-proof")).toEqual(expect.any(String));
  });

  it("binds pending sender transports into the signed wake target", async () => {
    const keys = generateKeyPairSync("ed25519");
    const privateJwk = keys.privateKey.export({ format: "jwk" });
    const publicJwk = keys.publicKey.export({ format: "jwk" });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ wake: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const transportId = Buffer.alloc(32, 9).toString("base64url");
    const client = new PdsRelayClient({
      baseUrl: "http://192.168.1.2:3310/pds",
      identity: {
        certificate: "{}",
        deviceId: "AAAAAAAAAAAAAAAAAAAAAA",
        signingKeyId: "AQEBAQEBAQEBAQEBAQEBAQ",
        signingPublicKey: publicJwk.x!,
        signingPrivateSeed: privateJwk.d!
      },
      fetch: fetcher
    });

    await client.waitForWake(undefined, [transportId]);

    expect(fetcher).toHaveBeenCalledWith(
      `http://192.168.1.2:3310/pds/v1/personal-device-sync/relay/wake?transportId=${transportId}`,
      expect.objectContaining({ method: "GET" })
    );
  });

  it("signs semantic capability advertisements without credentials in the payload", async () => {
    const keys = generateKeyPairSync("ed25519");
    const privateJwk = keys.privateKey.export({ format: "jwk" });
    const publicJwk = keys.publicKey.export({ format: "jwk" });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const client = new PdsRelayClient({
      baseUrl: "http://192.168.1.2:3310",
      identity: {
        certificate: "{}",
        deviceId: "AAAAAAAAAAAAAAAAAAAAAA",
        signingKeyId: "AQEBAQEBAQEBAQEBAQEBAQ",
        signingPublicKey: publicJwk.x!,
        signingPrivateSeed: privateJwk.d!
      },
      fetch: fetcher
    });
    const advertisedAt = new Date("2026-07-29T00:00:00.000Z");

    await expect(
      client.advertiseSemanticCapability({
        capability: "memory_embedding",
        compatibilityContractHash: Buffer.alloc(32, 3).toString("base64url"),
        readiness: "ready",
        advertisedAt: advertisedAt.toISOString(),
        expiresAt: new Date(advertisedAt.getTime() + 120_000).toISOString()
      })
    ).resolves.toBe(true);

    const [requestedUrl, requestedInit] = fetcher.mock.calls[0]!;
    expect(requestedUrl).toBe(
      "http://192.168.1.2:3310/v1/personal-device-sync/relay/semantic-work/capabilities"
    );
    expect(requestedInit?.method).toBe("POST");
    expect(String(requestedInit?.body)).not.toContain("signingPrivateSeed");
    expect(
      new Headers(requestedInit?.headers).get("x-pds-relay-proof")
    ).toEqual(expect.any(String));
  });
});
