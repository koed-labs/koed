import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import {
  decryptPersonalDevicePairingMessage,
  encryptPersonalDevicePairingMessage,
  PERSONAL_DEVICE_PAIRING_PROTOCOL
} from "./personal-device-pairing-crypto.js";
import { canonicalizePdsJson, PDS_PROTOCOL } from "@koed/shared";
import { exchangeOverPaseoRelay, paseoRelayServerId } from "@koed/koed-server";
import {
  resolvePersonalDevicePairingPort,
  startPersonalDevicePairingServer,
  type PersonalDevicePairingInvitation
} from "./personal-device-pairing-server.js";

const challenge = Buffer.alloc(32, 1).toString("base64url");
const authorityPublicKey = Buffer.alloc(32, 2).toString("base64url");

const baseInvitation = (): Omit<
  PersonalDevicePairingInvitation,
  "protocol" | "control_url" | "relay_url"
> => ({
  group_id: "group-1",
  challenge_id: "11111111-2222-4333-8444-555555555555",
  challenge,
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  browser_subject_id: "user-1",
  browser_deployment_id: "deployment-1",
  authority: { key_id: "authority-1", public_key: authorityPublicKey }
});

const signedRequest = (
  invitation: Omit<
    PersonalDevicePairingInvitation,
    "protocol" | "control_url" | "relay_url"
  >,
  deviceId = "device-2"
): Record<string, unknown> => {
  const keyPair = generateKeyPairSync("ed25519");
  const publicKey = (
    keyPair.publicKey.export({ format: "jwk" }) as { x: string }
  ).x;
  const request = {
    group_id: invitation.group_id,
    device_id: deviceId,
    signing_key_id: "signing-key-2",
    signing_public_key: publicKey,
    kem_key_id: "kem-key-2",
    kem_public_key: Buffer.alloc(32, 3).toString("base64url"),
    operation_families: ["pds_relay"],
    proof: {
      challenge_id: invitation.challenge_id,
      challenge: invitation.challenge,
      device_id: deviceId,
      signature: "",
      expires_at: invitation.expires_at
    }
  };
  const unsigned = {
    challengeId: invitation.challenge_id,
    challenge: invitation.challenge,
    groupId: invitation.group_id,
    deviceId,
    deviceSigningKeyId: request.signing_key_id,
    deviceSigningPublicKey: publicKey,
    deviceKemKeyId: request.kem_key_id,
    deviceKemPublicKey: request.kem_public_key,
    browserSubjectId: invitation.browser_subject_id,
    browserDeploymentId: invitation.browser_deployment_id,
    expiresAt: invitation.expires_at
  };
  request.proof.signature = sign(
    null,
    Buffer.from(
      `${PDS_PROTOCOL}/enrollment-proof\n${canonicalizePdsJson(unsigned)}`,
      "utf8"
    ),
    keyPair.privateKey
  ).toString("base64url");
  return request;
};

const memoryPersistence = () => {
  let value: string | null = null;
  return {
    get: vi.fn(async () => value),
    put: vi.fn(async (_reference: string, next: string) => {
      value = next;
    }),
    delete: vi.fn(async () => {
      value = null;
    })
  };
};

// Pairing tests restart HTTP servers on same port. Close each fixture
// connection so undici cannot reuse a socket owned by a stopped server.
const fixtureFetch = (input: string | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set("connection", "close");
  return fetch(input, { ...init, headers });
};

const invitationUrlFromDisplayLink = (value: string): URL => {
  const link = new URL(value);
  if (link.protocol !== "koed:") return link;
  const invitationUrl = link.searchParams.get("url");
  if (!invitationUrl) throw new Error("missing wrapped invitation URL");
  return new URL(invitationUrl);
};

const exchange = async (
  url: string,
  payload: Record<string, unknown>,
  reuse?: ReturnType<typeof encryptPersonalDevicePairingMessage>
) => {
  const parsed = invitationUrlFromDisplayLink(url);
  const invitationId = parsed.pathname.split("/").at(-1)!;
  const token = parsed.hash.slice("#token=".length);
  const encrypted =
    reuse ??
    encryptPersonalDevicePairingMessage(payload, {
      invitationId,
      token,
      direction: "request"
    });
  const response = await fixtureFetch(
    `${parsed.origin}/v1/pair/${invitationId}/exchange`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(encrypted)
    }
  );
  const body = await response.json();
  return {
    body,
    encrypted,
    response,
    opened: response.ok
      ? decryptPersonalDevicePairingMessage(body, {
          invitationId,
          token,
          direction: "response"
        })
      : null
  };
};

describe("Personal Device LAN pairing server", () => {
  it("uses one validated pairing port configuration", () => {
    expect(resolvePersonalDevicePairingPort(undefined)).toBe(3310);
    expect(resolvePersonalDevicePairingPort(" 43110 ")).toBe(43110);
    for (const invalid of ["0", "65536", "1.5", "3310x", "-1"]) {
      expect(() => resolvePersonalDevicePairingPort(invalid)).toThrow(
        "valid TCP port"
      );
    }
  });

  it("rejects public listener addresses before binding", async () => {
    await expect(
      startPersonalDevicePairingServer({
        port: 0,
        host: "203.0.113.5",
        addresses: () => ["203.0.113.5"],
        forwardControl: vi.fn()
      })
    ).rejects.toThrow("private IPv4 interface address");
  });

  it("binds selected interface and uses same invitation origin", async () => {
    const server = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      addresses: () => ["127.0.0.1"],
      forwardControl: vi.fn()
    });
    try {
      const view = server.createInvitation(baseInvitation());
      const invitationUrl = invitationUrlFromDisplayLink(view.url);
      const origin = invitationUrl.origin;
      expect(new URL(view.url).protocol).toBe("koed:");
      expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/);
      expect(server.relayUrl).toBe(`${origin}/pds`);
      expect(await fixtureFetch(`${origin}/pair/${view.id}`)).toMatchObject({
        status: 200
      });
    } finally {
      await server.close();
    }
  });

  it("issues relay-bound pairing capabilities without exposing listener address", async () => {
    const stored = new Map<string, string>();
    const server = await startPersonalDevicePairingServer({
      port: 0,
      addresses: () => [],
      relayUrl: "wss://koed-relay.fly.dev/ws",
      persistence: {
        get: async (key) => stored.get(key) ?? null,
        put: async (key, value) => void stored.set(key, value),
        delete: async (key) => void stored.delete(key)
      },
      forwardControl: vi.fn()
    });
    try {
      const view = server.createInvitation(baseInvitation());
      const deepLink = new URL(view.url);
      const link = invitationUrlFromDisplayLink(view.url);
      expect(deepLink.protocol).toBe("koed:");
      expect(deepLink.hostname).toBe("pair");
      expect(deepLink.pathname).toBe("/redeem");
      expect(link.origin).toBe("https://koed-relay.fly.dev");
      expect(link.pathname).toBe(`/pair/${view.id}`);
      expect(link.hash).toMatch(/^#token=[A-Za-z0-9_-]{43}$/);
      expect(server.relayUrl).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("forwards encrypted invitation exchanges through Paseo without exposing HTTP listener", async () => {
    const relay = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      path: "/ws"
    });
    await new Promise<void>((resolve) => relay.once("listening", resolve));
    const address = relay.address();
    if (!address || typeof address === "string")
      throw new Error("relay bind failed");
    const relayUrl = `ws://127.0.0.1:${address.port}/ws`;
    const peers = new Map<string, { server?: WebSocket; client?: WebSocket }>();
    let resolveServer!: () => void;
    const serverConnected = new Promise<void>(
      (resolve) => (resolveServer = resolve)
    );
    relay.on("connection", (socket, request) => {
      const url = new URL(request.url ?? "/", "http://relay.invalid");
      const route = url.searchParams.get("serverId") ?? "";
      const role = url.searchParams.get("role");
      const pair = peers.get(route) ?? {};
      if (role === "server") {
        pair.server = socket;
        resolveServer();
      }
      if (role === "client") pair.client = socket;
      peers.set(route, pair);
      socket.on("message", (frame) => {
        const target = role === "server" ? pair.client : pair.server;
        target?.send(frame);
      });
    });
    const stored = new Map<string, string>();
    const forwardControl = vi.fn(async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"tunnelled":true}'
    }));
    const server = await startPersonalDevicePairingServer({
      port: 0,
      addresses: () => [],
      relayUrl,
      persistence: {
        get: async (key) => stored.get(key) ?? null,
        put: async (key, value) => void stored.set(key, value),
        delete: async (key) => void stored.delete(key)
      },
      forwardControl
    });
    try {
      const pairing = server.createInvitation(baseInvitation());
      await serverConnected;
      const url = invitationUrlFromDisplayLink(pairing.url);
      const id = url.pathname.split("/").at(-1)!;
      const token = url.hash.slice("#token=".length);
      const request = encryptPersonalDevicePairingMessage(
        { operation: "invitation" },
        { invitationId: id, token, direction: "request" }
      );
      const raw = await exchangeOverPaseoRelay({
        relayUrl,
        id,
        token,
        routeContext: PERSONAL_DEVICE_PAIRING_PROTOCOL,
        frame: JSON.stringify(request)
      });
      const response = JSON.parse(raw) as Record<string, unknown>;
      expect(response).toMatchObject({
        protocol: "koed/pair-http-response/v1",
        status: 200
      });
      const opened = decryptPersonalDevicePairingMessage(
        JSON.parse(String(response.body)),
        { invitationId: id, token, direction: "response" }
      );
      expect(opened.value.invitation).toMatchObject({
        group_id: "group-1",
        control_url: `http://127.0.0.1:${address.port}/v1/pair/${id}/exchange`
      });
      const pdsRelayUrl = new URL(
        String((opened.value.invitation as Record<string, unknown>).relay_url)
      );
      const pdsId = pdsRelayUrl.pathname.split("/").at(-1)!;
      const pdsToken = pdsRelayUrl.hash.slice("#token=".length);
      expect(pdsId).not.toBe(id);
      await vi.waitFor(() =>
        expect(
          peers.get(
            paseoRelayServerId(
              PERSONAL_DEVICE_PAIRING_PROTOCOL,
              pdsId,
              pdsToken
            )
          )?.server
        ).toBeDefined()
      );
      const requestId = randomUUID();
      const pdsResponse = JSON.parse(
        await exchangeOverPaseoRelay({
          relayUrl,
          id: pdsId,
          token: pdsToken,
          routeContext: PERSONAL_DEVICE_PAIRING_PROTOCOL,
          frame: JSON.stringify({
            protocol: "koed/pds-http-tunnel/v1",
            request_id: requestId,
            method: "GET",
            path: "/v1/personal-device-sync/relay/transports",
            headers: {
              accept: "application/json",
              "x-pds-membership-certificate": "certificate",
              "x-pds-relay-proof": "proof"
            }
          })
        })
      ) as Record<string, unknown>;
      expect(pdsResponse).toMatchObject({
        protocol: "koed/pds-http-tunnel/v1",
        request_id: requestId,
        status: 200,
        body: '{"tunnelled":true}'
      });
      expect(forwardControl).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "relay",
          method: "GET",
          path: "/v1/personal-device-sync/relay/transports",
          headers: {
            accept: "application/json",
            "x-pds-membership-certificate": "certificate",
            "x-pds-relay-proof": "proof"
          }
        })
      );
    } finally {
      await server.close();
      for (const client of relay.clients) client.terminate();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });

  it("persists relay capability only after pairing completion", async () => {
    const stored = new Map<string, string>();
    const relayUrl = "ws://127.0.0.1:1/ws";
    const server = await startPersonalDevicePairingServer({
      port: 0,
      addresses: () => [],
      relayUrl,
      persistence: {
        get: async (key) => stored.get(key) ?? null,
        put: async (key, value) => void stored.set(key, value),
        delete: async (key) => void stored.delete(key)
      },
      forwardControl: vi.fn()
    });
    try {
      const invitation = baseInvitation();
      const pairing = server.createInvitation(invitation);
      const link = invitationUrlFromDisplayLink(pairing.url);
      const id = link.pathname.split("/").at(-1)!;
      const token = link.hash.slice("#token=".length);
      const localLink = `http://127.0.0.1:${server.port}/pair/${id}#token=${token}`;
      const request = exchange(localLink, {
        operation: "request",
        request: signedRequest(invitation),
        device_label: "Remote device"
      });
      await server.waitForRequest(id);
      await server.claimApproval(id);
      await server.approve(id);
      await expect(request).resolves.toMatchObject({
        opened: { value: { approved: true } }
      });
      await expect(
        exchange(localLink, { operation: "complete" })
      ).resolves.toMatchObject({
        opened: { value: { completed: true } }
      });
      expect(
        JSON.parse(stored.get("pds-pairing-relay-routes")!).routes
      ).toEqual(
        expect.arrayContaining([
          { id, token, relayUrl, purpose: "pairing" },
          expect.objectContaining({ relayUrl, purpose: "pds" })
        ])
      );
    } finally {
      await server.close();
    }
  });

  it("restores encrypted relay route capabilities after server restart", async () => {
    const stored = new Map<string, string>([
      [
        "pds-pairing-relay-routes",
        JSON.stringify({
          version: 1,
          routes: [
            {
              id: "11111111-2222-4333-8444-555555555555",
              token: Buffer.alloc(32, 5).toString("base64url"),
              relayUrl: "wss://koed-relay.fly.dev/ws"
            }
          ]
        })
      ]
    ]);
    const server = await startPersonalDevicePairingServer({
      port: 0,
      addresses: () => [],
      relayUrl: "wss://koed-relay.fly.dev/ws",
      persistence: {
        get: async (key) => stored.get(key) ?? null,
        put: async (key, value) => void stored.set(key, value),
        delete: async (key) => void stored.delete(key)
      },
      forwardControl: vi.fn()
    });
    await server.close();
    expect(JSON.parse(stored.get("pds-pairing-relay-routes")!)).toMatchObject({
      version: 1,
      routes: [{ id: "11111111-2222-4333-8444-555555555555" }]
    });
  });

  it("restores separate pairing and PDS relay sessions after restart", async () => {
    const relay = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => relay.once("listening", resolve));
    const address = relay.address();
    if (!address || typeof address === "string")
      throw new Error("relay bind failed");
    const relayUrl = `ws://127.0.0.1:${address.port}/ws`;
    const connectedServerIds = new Set<string>();
    relay.on("connection", (socket, request) => {
      const url = new URL(request.url ?? "/", "http://relay.invalid");
      if (url.searchParams.get("role") === "server")
        connectedServerIds.add(url.searchParams.get("serverId") ?? "");
      else socket.terminate();
    });
    const stored = new Map<string, string>([
      [
        "pds-pairing-relay-routes",
        JSON.stringify({
          version: 2,
          routes: [
            {
              id: "11111111-2222-4333-8444-555555555555",
              token: Buffer.alloc(32, 5).toString("base64url"),
              relayUrl,
              purpose: "pairing"
            },
            {
              id: "22222222-3333-4444-8555-666666666666",
              token: Buffer.alloc(32, 6).toString("base64url"),
              relayUrl,
              purpose: "pds"
            }
          ]
        })
      ]
    ]);
    const server = await startPersonalDevicePairingServer({
      port: 0,
      addresses: () => [],
      relayUrl,
      persistence: {
        get: async (key) => stored.get(key) ?? null,
        put: async (key, value) => void stored.set(key, value),
        delete: async (key) => void stored.delete(key)
      },
      forwardControl: vi.fn()
    });
    try {
      await vi.waitFor(() => expect(connectedServerIds.size).toBe(2));
    } finally {
      await server.close();
      for (const client of relay.clients) client.terminate();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });

  it("keeps the invitation secret out of HTTP and encrypts invitation data", async () => {
    const server = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      addresses: () => ["127.0.0.1"],
      forwardControl: vi.fn()
    });
    try {
      const pairing = server.createInvitation(baseInvitation());
      const parsed = invitationUrlFromDisplayLink(pairing.url);
      const landing = await fixtureFetch(`${parsed.origin}${parsed.pathname}`);
      const html = await landing.text();
      expect(landing.status).toBe(200);
      expect(html).not.toContain(parsed.hash.slice("#token=".length));
      expect(html).toContain("koed://pair/redeem?url=");
      expect(html.match(/id="open"/g)).toHaveLength(1);
      expect(landing.headers.get("cache-control")).toBe("no-store");
      expect(landing.headers.get("referrer-policy")).toBe("no-referrer");

      const result = await exchange(pairing.url, { operation: "invitation" });
      expect(result.response.status).toBe(200);
      expect(JSON.stringify(result.body)).not.toContain("browser_subject_id");
      expect(result.opened?.value).toMatchObject({
        invitation: {
          group_id: "group-1",
          protocol: "koed/pds-lan-pair/v1"
        }
      });
    } finally {
      await server.close();
    }
  });

  it("rejects wrong secrets, replay, oversized bodies, and non-pairing routes", async () => {
    const server = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      addresses: () => ["127.0.0.1"],
      forwardControl: vi.fn()
    });
    try {
      const pairing = server.createInvitation(baseInvitation());
      const parsed = invitationUrlFromDisplayLink(pairing.url);
      const invitationId = parsed.pathname.split("/").at(-1)!;
      const wrong = encryptPersonalDevicePairingMessage(
        { operation: "invitation" },
        {
          invitationId,
          token: "A".repeat(43),
          direction: "request"
        }
      );
      expect(
        await fixtureFetch(
          `${parsed.origin}/v1/pair/${invitationId}/exchange`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(wrong)
          }
        )
      ).toMatchObject({ status: 400 });

      const first = await exchange(pairing.url, { operation: "invitation" });
      const replay = await exchange(
        pairing.url,
        { operation: "invitation" },
        first.encrypted
      );
      expect(replay.response.status).toBe(409);
      expect(
        await fixtureFetch(`${parsed.origin}/v1/users`, { method: "GET" })
      ).toMatchObject({ status: 404 });
      expect(
        await fixtureFetch(
          `${parsed.origin}/v1/pair/${invitationId}/exchange`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "x".repeat(257 * 1_024)
          }
        )
      ).toMatchObject({ status: 400 });
    } finally {
      await server.close();
    }
  });

  it("rejects altered signed requests without claiming invitation", async () => {
    const server = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      addresses: () => ["127.0.0.1"],
      forwardControl: vi.fn()
    });
    try {
      const invitation = baseInvitation();
      const pairing = server.createInvitation(invitation);
      const request = signedRequest(invitation);
      (request.proof as Record<string, unknown>).device_id = "other-device";
      const result = await exchange(pairing.url, {
        operation: "request",
        request,
        device_label: "Untrusted device"
      });
      expect(result.response.status).toBe(400);
      expect(server.inspect(pairing.id)[0]).toMatchObject({
        state: "waiting",
        joiningDeviceLabel: null
      });
    } finally {
      await server.close();
    }
  });

  it("rejects a request signed for another group and leaves invitation waiting", async () => {
    const server = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      addresses: () => ["127.0.0.1"],
      forwardControl: vi.fn()
    });
    try {
      const invitation = baseInvitation();
      const pairing = server.createInvitation(invitation);
      const request = signedRequest(invitation);
      request.group_id = "another-group";
      const result = await exchange(pairing.url, {
        operation: "request",
        request,
        device_label: "Wrong group"
      });
      expect(result.response.status).toBe(400);
      expect(server.inspect(pairing.id)[0]).toMatchObject({
        state: "waiting",
        phase: "waiting"
      });
    } finally {
      await server.close();
    }
  });

  it("resolves concurrent manager waits from one signed request", async () => {
    const server = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      addresses: () => ["127.0.0.1"],
      forwardControl: vi.fn()
    });
    try {
      const invitation = baseInvitation();
      const pairing = server.createInvitation(invitation);
      const first = server.waitForRequest(pairing.id);
      const second = server.waitForRequest(pairing.id);
      const submission = exchange(pairing.url, {
        operation: "request",
        request: signedRequest(invitation),
        device_label: "Concurrent laptop"
      });
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ device_id: "device-2" }),
        expect.objectContaining({ device_id: "device-2" })
      ]);
      await server.claimApproval(pairing.id);
      await server.approve(pairing.id);
      await expect(submission).resolves.toMatchObject({
        opened: { value: { approved: true } }
      });
    } finally {
      await server.close();
    }
  });

  it("expires invitations before accepting a late claim", async () => {
    let current = new Date();
    const server = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      now: () => current,
      addresses: () => ["127.0.0.1"],
      forwardControl: vi.fn()
    });
    try {
      const invitation = baseInvitation();
      invitation.expires_at = new Date(current.getTime() + 1_000).toISOString();
      const pairing = server.createInvitation(invitation);
      current = new Date(current.getTime() + 2_000);
      const result = await exchange(pairing.url, { operation: "invitation" });
      expect(result.response.status).toBe(410);
      expect(server.inspect(pairing.id)[0]?.state).toBe("expired");
    } finally {
      await server.close();
    }
  });

  it("holds the signed request while low-level approval releases enrollment", async () => {
    const forwardControl = vi.fn(async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: { group_id: "group-1" } })
    }));
    const server = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      addresses: () => ["127.0.0.1"],
      forwardControl
    });
    try {
      const invitation = baseInvitation();
      const pairing = server.createInvitation(invitation);
      const request = signedRequest(invitation);
      const submission = exchange(pairing.url, {
        operation: "request",
        request,
        device_label: "Alice's laptop"
      });
      await expect(server.waitForRequest(pairing.id)).resolves.toMatchObject({
        device_id: "device-2"
      });
      expect(server.inspect(pairing.id)[0]).toMatchObject({
        state: "connecting",
        joiningDeviceLabel: "Alice's laptop"
      });

      const controlBeforeApproval = await exchange(pairing.url, {
        operation: "control",
        method: "GET",
        path: "/v1/personal-device-sync/groups/group-1",
        headers: {}
      });
      expect(controlBeforeApproval.response.status).toBe(403);
      await server.approve(pairing.id);
      await expect(submission).resolves.toMatchObject({
        opened: { value: { approved: true } }
      });
      const completionWait = server.waitForCompletion(pairing.id);
      const exactRetry = await exchange(pairing.url, {
        operation: "request",
        request,
        device_label: "Alice's laptop"
      });
      expect(exactRetry.opened?.value).toEqual({ approved: true });
      const changedRetry = await exchange(pairing.url, {
        operation: "request",
        request: signedRequest(invitation, "different-device"),
        device_label: "Alice's laptop"
      });
      expect(changedRetry.response.status).toBe(409);

      const allowed = await exchange(pairing.url, {
        operation: "control",
        method: "GET",
        path: "/v1/personal-device-sync/groups/group-1",
        headers: { accept: "application/json" }
      });
      expect(allowed.opened?.value).toMatchObject({
        status: 200,
        body: expect.stringContaining("group-1")
      });
      expect(forwardControl).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "pairing",
          method: "GET",
          path: "/v1/personal-device-sync/groups/group-1"
        })
      );
      const signedLog = await exchange(pairing.url, {
        operation: "control",
        method: "GET",
        path: "/v1/personal-device-sync/groups/group-1/log",
        headers: { accept: "application/json" }
      });
      expect(signedLog.opened?.value).toMatchObject({ status: 200 });

      const escaped = await exchange(pairing.url, {
        operation: "control",
        method: "GET",
        path: "/v1/users",
        headers: {}
      });
      expect(escaped.response.status).toBe(404);
      const adjacentLogPath = await exchange(pairing.url, {
        operation: "control",
        method: "GET",
        path: "/v1/personal-device-sync/groups/group-1/logs",
        headers: {}
      });
      expect(adjacentLogPath.response.status).toBe(404);
      const completed = await exchange(pairing.url, { operation: "complete" });
      expect(completed.opened?.value).toEqual({ completed: true });
      await expect(completionWait).resolves.toBeUndefined();
      expect(server.inspect(pairing.id)[0]?.state).toBe("completed");
      expect(() => server.cancel(pairing.id)).toThrow(
        "Completed device pairing cannot be cancelled"
      );
      expect(
        (await exchange(pairing.url, { operation: "invitation" })).response
          .status
      ).toBe(410);
      expect(server.inspect(pairing.id)[0]?.url).toBe("");
    } finally {
      await server.close();
    }
  });

  it("does not cancel after approval claim crosses durable commit boundary", async () => {
    const server = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      addresses: () => ["127.0.0.1"],
      forwardControl: async () => ({ status: 200, body: "{}" })
    });
    try {
      const invitation = baseInvitation();
      const pairing = server.createInvitation(invitation);
      const submission = exchange(pairing.url, {
        operation: "request",
        request: signedRequest(invitation),
        device_label: "Joining laptop"
      });
      await expect(server.waitForRequest(pairing.id)).resolves.toMatchObject({
        device_id: "device-2"
      });
      await server.claimApproval(pairing.id);
      expect(server.inspect(pairing.id)[0]).toMatchObject({
        state: "connecting",
        phase: "committing"
      });
      expect(() => server.cancel(pairing.id)).toThrow(
        "cannot be cancelled after commit started"
      );
      expect(server.inspect(pairing.id)[0]?.state).toBe("connecting");
      await server.approve(pairing.id);
      await expect(submission).resolves.toMatchObject({
        opened: { value: { approved: true } }
      });
    } finally {
      await server.close();
    }
  });

  it("keeps claimed binding through disconnect and bounds post-expiry recovery", async () => {
    let current = new Date();
    const server = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      now: () => current,
      addresses: () => ["127.0.0.1"],
      forwardControl: vi.fn(async () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: { group_id: "group-1" } })
      }))
    });
    try {
      const invitation = baseInvitation();
      invitation.expires_at = new Date(current.getTime() + 1_000).toISOString();
      const pairing = server.createInvitation(invitation);
      const parsed = invitationUrlFromDisplayLink(pairing.url);
      const invitationId = parsed.pathname.split("/").at(-1)!;
      const request = signedRequest(invitation);
      const encrypted = encryptPersonalDevicePairingMessage(
        {
          operation: "request",
          request,
          device_label: "Recoverable laptop"
        },
        {
          invitationId,
          token: parsed.hash.slice("#token=".length),
          direction: "request"
        }
      );
      const controller = new AbortController();
      const submitted = fixtureFetch(
        `${parsed.origin}/v1/pair/${invitationId}/exchange`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(encrypted),
          signal: controller.signal
        }
      );
      await expect(server.waitForRequest(pairing.id)).resolves.toMatchObject({
        device_id: "device-2"
      });
      await server.claimApproval(pairing.id);
      controller.abort();
      await expect(submitted).rejects.toThrow();
      await vi.waitFor(() =>
        expect(server.inspect(pairing.id)[0]).toMatchObject({
          state: "connecting",
          phase: "committing"
        })
      );

      current = new Date(new Date(invitation.expires_at).getTime() + 1);
      expect(
        (await exchange(pairing.url, { operation: "invitation" })).response
          .status
      ).toBe(410);
      expect(server.inspect(pairing.id)[0]).toMatchObject({
        state: "connecting",
        url: ""
      });
      expect(
        (
          await exchange(pairing.url, {
            operation: "request",
            request: signedRequest(invitation, "different-device"),
            device_label: "Recoverable laptop"
          })
        ).response.status
      ).toBe(410);

      // Durable membership can finish without original HTTP response. Only
      // exact bound request may recover approval; metadata and new requests
      // remain unavailable after invitation expiry.
      await server.approve(pairing.id);
      const recovered = await exchange(pairing.url, {
        operation: "request",
        request,
        device_label: "Recoverable laptop"
      });
      expect(recovered.opened?.value).toEqual({ approved: true });
      expect(
        (await exchange(pairing.url, { operation: "invitation" })).response
          .status
      ).toBe(410);
      const recoveredControl = await exchange(pairing.url, {
        operation: "control",
        method: "GET",
        path: "/v1/personal-device-sync/groups/group-1",
        headers: {}
      });
      expect(recoveredControl.opened?.value).toMatchObject({ status: 200 });
      const recoveredCompletion = await exchange(pairing.url, {
        operation: "complete"
      });
      expect(recoveredCompletion.opened?.value).toEqual({ completed: true });
      expect(server.inspect(pairing.id)[0]?.state).toBe("completed");
    } finally {
      await server.close();
    }
  });

  it("rejects approved recovery after bounded recovery deadline", async () => {
    let current = new Date();
    const server = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      now: () => current,
      addresses: () => ["127.0.0.1"],
      forwardControl: vi.fn()
    });
    try {
      const invitation = baseInvitation();
      invitation.expires_at = new Date(current.getTime() + 1_000).toISOString();
      const pairing = server.createInvitation(invitation);
      const submission = exchange(pairing.url, {
        operation: "request",
        request: signedRequest(invitation),
        device_label: "Deadline laptop"
      });
      await expect(server.waitForRequest(pairing.id)).resolves.toMatchObject({
        device_id: "device-2"
      });
      await server.claimApproval(pairing.id);
      current = new Date(new Date(invitation.expires_at).getTime() + 1);
      await server.approve(pairing.id);
      await expect(submission).resolves.toMatchObject({
        opened: { value: { approved: true } }
      });

      current = new Date(current.getTime() + 10 * 60_000 + 1);
      expect(
        (
          await exchange(pairing.url, {
            operation: "control",
            method: "GET",
            path: "/v1/personal-device-sync/groups/group-1",
            headers: {}
          })
        ).response.status
      ).toBe(410);
      expect(
        (await exchange(pairing.url, { operation: "complete" })).response.status
      ).toBe(410);
      expect(server.inspect(pairing.id)[0]?.state).toBe("expired");
    } finally {
      await server.close();
    }
  });

  it("replays completed enrollment with a fresh encrypted message id", async () => {
    const server = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      addresses: () => ["127.0.0.1"],
      forwardControl: vi.fn()
    });
    try {
      const invitation = baseInvitation();
      const pairing = server.createInvitation(invitation);
      const request = signedRequest(invitation);
      const submission = exchange(pairing.url, {
        operation: "request",
        request,
        device_label: "Replay laptop"
      });
      await expect(server.waitForRequest(pairing.id)).resolves.toEqual(request);
      await server.approve(pairing.id);
      await expect(submission).resolves.toMatchObject({
        opened: { value: { approved: true } }
      });
      const original = await exchange(pairing.url, { operation: "complete" });
      expect(original.opened?.value).toEqual({ completed: true });
      const reused = await exchange(
        pairing.url,
        { operation: "complete" },
        original.encrypted
      );
      expect(reused.response.status).toBe(409);
      const retry = await exchange(pairing.url, { operation: "complete" });
      expect(retry.response.status).toBe(200);
      expect(retry.opened?.value).toEqual({ completed: true });
    } finally {
      await server.close();
    }
  });

  it("restores claimed request binding from encrypted application persistence", async () => {
    const current = new Date();
    const persistence = memoryPersistence();
    const first = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      now: () => current,
      addresses: () => ["127.0.0.1"],
      persistence,
      forwardControl: vi.fn()
    });
    const invitation = baseInvitation();
    const pairing = first.createInvitation(invitation);
    const request = signedRequest(invitation);
    const submission = exchange(pairing.url, {
      operation: "request",
      request,
      device_label: "Crash laptop"
    });
    await expect(first.waitForRequest(pairing.id)).resolves.toEqual(request);
    await first.claimApproval(pairing.id);
    expect(persistence.put).toHaveBeenCalledTimes(1);
    await first.close();
    await expect(submission).rejects.toThrow("fetch failed");

    const restored = await startPersonalDevicePairingServer({
      port: first.port,
      host: "127.0.0.1",
      now: () => current,
      addresses: () => ["127.0.0.1"],
      persistence,
      forwardControl: vi.fn()
    });
    try {
      expect(restored.inspect(pairing.id)[0]).toMatchObject({
        state: "connecting",
        phase: "committing",
        joiningDeviceLabel: "Crash laptop"
      });
      const recovery = exchange(pairing.url, {
        operation: "request",
        request,
        device_label: "Crash laptop"
      });
      await restored.approve(pairing.id);
      await expect(recovery).resolves.toMatchObject({
        opened: { value: { approved: true } }
      });
    } finally {
      await restored.close();
    }
  });

  it("restores previous durable snapshot when a queued persistence update fails", async () => {
    let current = new Date();
    let value: string | null = null;
    let rejectFirst: ((error: Error) => void) | null = null;
    let putCount = 0;
    const persistence = {
      get: vi.fn(async () => value),
      put: vi.fn(async (_reference: string, next: string) => {
        putCount += 1;
        if (putCount === 1) {
          await new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          });
        }
        value = next;
      }),
      delete: vi.fn(async () => {
        value = null;
      })
    };
    const first = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      now: () => current,
      addresses: () => ["127.0.0.1"],
      persistence,
      forwardControl: vi.fn()
    });
    const invitation = baseInvitation();
    invitation.expires_at = new Date(current.getTime() + 1_000).toISOString();
    const pairing = first.createInvitation(invitation);
    const submission = exchange(pairing.url, {
      operation: "request",
      request: signedRequest(invitation),
      device_label: "Queued snapshot laptop"
    });
    await first.waitForRequest(pairing.id);
    const claim = first.claimApproval(pairing.id);
    await vi.waitFor(() => expect(persistence.put).toHaveBeenCalledTimes(1));

    current = new Date(current.getTime() + 2_000);
    expect(first.inspect(pairing.id)[0]?.url).toBe("");
    rejectFirst!(new Error("first snapshot failed"));
    await expect(claim).rejects.toThrow("could not be persisted");
    await vi.waitFor(() => expect(value).not.toBeNull());
    expect(JSON.parse(value!).invitations[0]).toMatchObject({
      authorizationExpired: true,
      approvalClaimed: true
    });
    await first.close();
    await expect(submission).rejects.toThrow("fetch failed");
  });

  it("persists control message reservation before forwarding side effects", async () => {
    const persistence = memoryPersistence();
    const forwardControl = vi.fn(async () => {
      throw new Error("control side effect failed");
    });
    const first = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      addresses: () => ["127.0.0.1"],
      persistence,
      forwardControl
    });
    const invitation = baseInvitation();
    const pairing = first.createInvitation(invitation);
    const request = signedRequest(invitation);
    const submission = exchange(pairing.url, {
      operation: "request",
      request,
      device_label: "Reserved message laptop"
    });
    await first.waitForRequest(pairing.id);
    await first.approve(pairing.id);
    await expect(submission).resolves.toMatchObject({
      opened: { value: { approved: true } }
    });
    const control = encryptPersonalDevicePairingMessage(
      {
        operation: "control",
        method: "GET",
        path: "/v1/personal-device-sync/groups/group-1",
        headers: {}
      },
      {
        invitationId: pairing.id,
        token: invitationUrlFromDisplayLink(pairing.url).hash.slice(
          "#token=".length
        ),
        direction: "request"
      }
    );
    const failed = await exchange(
      pairing.url,
      {
        operation: "control",
        method: "GET",
        path: "/v1/personal-device-sync/groups/group-1",
        headers: {}
      },
      control
    );
    expect(failed.response.status).toBe(400);
    await first.close();

    const restored = await startPersonalDevicePairingServer({
      port: first.port,
      host: "127.0.0.1",
      addresses: () => ["127.0.0.1"],
      persistence,
      forwardControl: vi.fn()
    });
    try {
      const replay = await exchange(
        pairing.url,
        {
          operation: "control",
          method: "GET",
          path: "/v1/personal-device-sync/groups/group-1",
          headers: {}
        },
        control
      );
      expect(replay.response.status).toBe(409);
    } finally {
      await restored.close();
    }
  });

  it("does not forward control while approval persistence is uncommitted", async () => {
    let value: string | null = null;
    let putCount = 0;
    let rejectApproval: ((error: Error) => void) | null = null;
    const persistence = {
      get: vi.fn(async () => value),
      put: vi.fn(async (_reference: string, next: string) => {
        putCount += 1;
        if (putCount === 2) {
          await new Promise<void>((_resolve, reject) => {
            rejectApproval = reject;
          });
        }
        value = next;
      }),
      delete: vi.fn(async () => {
        value = null;
      })
    };
    const forwardControl = vi.fn(async () => ({ status: 200, body: "{}" }));
    const server = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      addresses: () => ["127.0.0.1"],
      persistence,
      forwardControl
    });
    const invitation = baseInvitation();
    const pairing = server.createInvitation(invitation);
    const submission = exchange(pairing.url, {
      operation: "request",
      request: signedRequest(invitation),
      device_label: "Approval transaction laptop"
    });
    await server.waitForRequest(pairing.id);
    await server.claimApproval(pairing.id);
    const approval = server.approve(pairing.id);
    await vi.waitFor(() => expect(persistence.put).toHaveBeenCalledTimes(2));
    const control = exchange(pairing.url, {
      operation: "control",
      method: "GET",
      path: "/v1/personal-device-sync/groups/group-1",
      headers: {}
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    rejectApproval!(new Error("approval snapshot failed"));
    await expect(approval).rejects.toThrow("could not be persisted");
    expect((await control).response.status).toBe(400);
    expect(forwardControl).not.toHaveBeenCalled();
    await server.close();
    await expect(submission).rejects.toThrow("fetch failed");
  });

  it("rejects completion after recovery expires during validation", async () => {
    let current = new Date();
    let validationEntered = false;
    let releaseValidation: ((value: boolean) => void) | null = null;
    const validation = new Promise<boolean>((resolve) => {
      releaseValidation = resolve;
    });
    const server = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      now: () => current,
      addresses: () => ["127.0.0.1"],
      forwardControl: vi.fn(),
      validateCompletion: async () => {
        validationEntered = true;
        return await validation;
      }
    });
    try {
      const invitation = baseInvitation();
      const pairing = server.createInvitation(invitation);
      const submission = exchange(pairing.url, {
        operation: "request",
        request: signedRequest(invitation),
        device_label: "Validation deadline laptop"
      });
      await server.waitForRequest(pairing.id);
      await server.approve(pairing.id);
      await expect(submission).resolves.toMatchObject({
        opened: { value: { approved: true } }
      });
      const completion = exchange(pairing.url, { operation: "complete" });
      await vi.waitFor(() => expect(validationEntered).toBe(true));
      current = new Date(current.getTime() + 10 * 60_000 + 1);
      releaseValidation!(true);
      expect((await completion).response.status).toBe(410);
      expect(server.inspect(pairing.id)[0]?.state).toBe("expired");
    } finally {
      await server.close();
    }
  });

  it("drops persisted claimed requests after recovery deadline", async () => {
    let current = new Date();
    const persistence = memoryPersistence();
    const first = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      now: () => current,
      addresses: () => ["127.0.0.1"],
      persistence,
      forwardControl: vi.fn()
    });
    const invitation = baseInvitation();
    const pairing = first.createInvitation(invitation);
    const submission = exchange(pairing.url, {
      operation: "request",
      request: signedRequest(invitation),
      device_label: "Expired laptop"
    });
    await first.waitForRequest(pairing.id);
    await first.claimApproval(pairing.id);
    await first.close();
    await expect(submission).rejects.toThrow("fetch failed");
    current = new Date(current.getTime() + 10 * 60_000 + 1);
    const restored = await startPersonalDevicePairingServer({
      port: first.port,
      host: "127.0.0.1",
      now: () => current,
      addresses: () => ["127.0.0.1"],
      persistence,
      forwardControl: vi.fn()
    });
    try {
      expect(restored.inspect(pairing.id)).toEqual([]);
      expect(persistence.delete).toHaveBeenCalled();
    } finally {
      await restored.close();
    }
  });

  it("preserves PUT relay operations and signed relay headers", async () => {
    const forwardControl = vi.fn(async () => ({
      status: 202,
      body: "{}"
    }));
    const server = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      addresses: () => ["127.0.0.1"],
      forwardControl
    });
    try {
      const response = await fixtureFetch(
        `http://127.0.0.1:${server.port}/pds/v1/personal-device-sync/relay/packages/package-1`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-pds-membership-certificate": "certificate",
            "x-pds-relay-proof": "proof"
          },
          body: JSON.stringify({ encrypted: true })
        }
      );
      expect(response.status).toBe(202);
      expect(forwardControl).toHaveBeenCalledWith({
        mode: "relay",
        method: "PUT",
        path: "/v1/personal-device-sync/relay/packages/package-1",
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-pds-membership-certificate": "certificate",
          "x-pds-relay-proof": "proof"
        }),
        body: JSON.stringify({ encrypted: true })
      });
    } finally {
      await server.close();
    }
  });

  it("terminates held relay requests during shutdown", async () => {
    let forwardedSignal: AbortSignal | null = null;
    const forwardControl = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          forwardedSignal = signal;
          signal.addEventListener(
            "abort",
            () => reject(new Error("forwarding aborted")),
            { once: true }
          );
        })
    );
    const server = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      addresses: () => ["127.0.0.1"],
      forwardControl
    });
    const held = fixtureFetch(
      `http://127.0.0.1:${server.port}/pds/v1/personal-device-sync/relay/wake`,
      {
        headers: {
          "x-pds-membership-certificate": "certificate",
          "x-pds-relay-proof": "proof"
        }
      }
    );

    await vi.waitFor(() => expect(forwardControl).toHaveBeenCalledOnce());
    await expect(server.close()).resolves.toBeUndefined();
    await expect(held).rejects.toThrow();
    await vi.waitFor(() => expect(forwardedSignal?.aborted).toBe(true));
  });
});
