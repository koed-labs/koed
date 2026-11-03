import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

  it.each(["fetch", "body"] as const)(
    "aborts a stalled transport %s with the caller's signal",
    async (stage) => {
      const keys = generateKeyPairSync("ed25519");
      const controller = new AbortController();
      let observedSignal: AbortSignal | null | undefined;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const fetcher: typeof fetch = async (_url, init) => {
        observedSignal = init?.signal;
        if (stage === "fetch") {
          started();
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("aborted"))
            );
          });
        }
        return new Response(
          new ReadableStream({
            start(stream) {
              init?.signal?.addEventListener("abort", () =>
                stream.error(new Error("aborted"))
              );
              started();
            }
          })
        );
      };
      const client = new PdsRelayClient({
        baseUrl: "http://127.0.0.1:3310",
        identity: {
          certificate: "{}",
          deviceId: "AAAAAAAAAAAAAAAAAAAAAA",
          signingKeyId: "AQEBAQEBAQEBAQEBAQEBAQ",
          signingPublicKey: keys.publicKey.export({ format: "jwk" }).x!,
          signingPrivateSeed: keys.privateKey.export({ format: "jwk" }).d!
        },
        fetch: fetcher
      });
      const result = client.transport("transport", controller.signal);
      await ready;
      expect(observedSignal).toBe(controller.signal);
      controller.abort();
      await expect(result).rejects.toThrow("aborted");
    }
  );

  it.each(["headers", "body"] as const)(
    "aborts native fetch while waiting for %s",
    async (stage) => {
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let headersReceived!: () => void;
      const received = new Promise<void>((resolve) => {
        headersReceived = resolve;
      });
      const server = createServer((_request, response) => {
        if (stage === "body") {
          response.writeHead(200, { "content-type": "application/json" });
          response.write("{");
        }
        ready();
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve)
      );
      const keys = generateKeyPairSync("ed25519");
      const controller = new AbortController();
      const client = new PdsRelayClient({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        identity: {
          certificate: "{}",
          deviceId: "AAAAAAAAAAAAAAAAAAAAAA",
          signingKeyId: "AQEBAQEBAQEBAQEBAQEBAQ",
          signingPublicKey: keys.publicKey.export({ format: "jwk" }).x!,
          signingPrivateSeed: keys.privateKey.export({ format: "jwk" }).d!
        },
        fetch: async (url, init) => {
          const response = await fetch(url, init);
          headersReceived();
          return response;
        }
      });
      try {
        const result = client.transport("transport", controller.signal);
        await started;
        if (stage === "body") await received;
        controller.abort();
        await expect(result).rejects.toMatchObject({ name: "AbortError" });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  );

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

  it("renews the exact semantic work generation through a signed request", async () => {
    const keys = generateKeyPairSync("ed25519");
    const privateJwk = keys.privateKey.export({ format: "jwk" });
    const publicJwk = keys.publicKey.export({ format: "jwk" });
    const workIdentity = Buffer.alloc(32, 5).toString("base64url");
    const expiresAt = new Date("2026-07-29T00:05:00.000Z").toISOString();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          claim: { workIdentity, claimGeneration: "7", expiresAt }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
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

    await expect(
      client.renewSemanticWorkClaim({
        workIdentity,
        claimGeneration: "7",
        leaseSeconds: 120
      })
    ).resolves.toEqual({ workIdentity, claimGeneration: "7", expiresAt });

    const [requestedUrl, requestedInit] = fetcher.mock.calls[0]!;
    expect(requestedUrl).toBe(
      "http://192.168.1.2:3310/v1/personal-device-sync/relay/semantic-work/claims/renew"
    );
    expect(requestedInit?.method).toBe("POST");
    expect(JSON.parse(String(requestedInit?.body))).toEqual({
      claimGeneration: "7",
      leaseSeconds: "120",
      workIdentity
    });
    expect(
      new Headers(requestedInit?.headers).get("x-pds-relay-proof")
    ).toEqual(expect.any(String));
  });
});
