import { describe, expect, it, vi } from "vitest";
import {
  decryptPersonalDevicePairingMessage,
  encryptPersonalDevicePairingMessage
} from "./personal-device-pairing-crypto.js";
import {
  resolvePersonalDevicePairingPort,
  startPersonalDevicePairingServer,
  type PersonalDevicePairingInvitation
} from "./personal-device-pairing-server.js";

const baseInvitation = (): Omit<
  PersonalDevicePairingInvitation,
  "protocol" | "control_url" | "relay_url"
> => ({
  group_id: "group-1",
  challenge_id: "11111111-2222-4333-8444-555555555555",
  challenge: "challenge",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  browser_subject_id: "user-1",
  browser_deployment_id: "deployment-1",
  authority: { key_id: "authority-1", public_key: "public-key" }
});

const exchange = async (
  url: string,
  payload: Record<string, unknown>,
  reuse?: ReturnType<typeof encryptPersonalDevicePairingMessage>
) => {
  const parsed = new URL(url);
  const invitationId = parsed.pathname.split("/").at(-1)!;
  const token = parsed.hash.slice("#token=".length);
  const encrypted =
    reuse ??
    encryptPersonalDevicePairingMessage(payload, {
      invitationId,
      token,
      direction: "request"
    });
  const response = await fetch(
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

  it("does not issue pairing links for public listener addresses", async () => {
    const server = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      addresses: () => ["203.0.113.5"],
      forwardControl: vi.fn()
    });
    try {
      expect(() => server.createInvitation(baseInvitation())).toThrow(
        "No private network address"
      );
    } finally {
      await server.close();
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
      const parsed = new URL(pairing.url);
      const landing = await fetch(`${parsed.origin}${parsed.pathname}`);
      const html = await landing.text();
      expect(landing.status).toBe(200);
      expect(html).not.toContain(parsed.hash.slice("#token=".length));
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
      const parsed = new URL(pairing.url);
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
        await fetch(`${parsed.origin}/v1/pair/${invitationId}/exchange`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(wrong)
        })
      ).toMatchObject({ status: 400 });

      const first = await exchange(pairing.url, { operation: "invitation" });
      const replay = await exchange(
        pairing.url,
        { operation: "invitation" },
        first.encrypted
      );
      expect(replay.response.status).toBe(409);
      expect(
        await fetch(`${parsed.origin}/v1/users`, { method: "GET" })
      ).toMatchObject({ status: 404 });
      expect(
        await fetch(`${parsed.origin}/v1/pair/${invitationId}/exchange`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "x".repeat(257 * 1_024)
        })
      ).toMatchObject({ status: 400 });
    } finally {
      await server.close();
    }
  });

  it("holds the signed request for explicit approval and exposes only whitelisted control", async () => {
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
      const pairing = server.createInvitation(baseInvitation());
      const submission = exchange(pairing.url, {
        operation: "request",
        request: {
          group_id: "group-1",
          device_id: "device-2",
          proof: { signature: "signed" }
        },
        device_label: "Alice's laptop"
      });
      await expect(server.waitForRequest(pairing.id)).resolves.toMatchObject({
        device_id: "device-2"
      });
      expect(server.inspect(pairing.id)[0]).toMatchObject({
        state: "approval_required",
        joiningDeviceLabel: "Alice's laptop"
      });

      const parsed = new URL(pairing.url);
      const controlBeforeApproval = await exchange(pairing.url, {
        operation: "control",
        method: "GET",
        path: "/v1/personal-device-sync/groups/group-1",
        headers: {}
      });
      expect(controlBeforeApproval.response.status).toBe(403);
      server.approve(pairing.id);
      await expect(submission).resolves.toMatchObject({
        opened: { value: { approved: true } }
      });
      expect(() => server.cancel(pairing.id)).toThrow(
        "Approved device pairing cannot be cancelled"
      );
      const completionWait = server.waitForCompletion(pairing.id);
      const exactRetry = await exchange(pairing.url, {
        operation: "request",
        request: {
          group_id: "group-1",
          device_id: "device-2",
          proof: { signature: "signed" }
        },
        device_label: "Alice's laptop"
      });
      expect(exactRetry.opened?.value).toEqual({ approved: true });
      const changedRetry = await exchange(pairing.url, {
        operation: "request",
        request: {
          group_id: "group-1",
          device_id: "different-device",
          proof: { signature: "signed" }
        },
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
      expect(
        (await exchange(pairing.url, { operation: "invitation" })).response
          .status
      ).toBe(410);
      expect(parsed.hash).toMatch(/^#token=/);
    } finally {
      await server.close();
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
      const response = await fetch(
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
    const forwardControl = vi.fn(() => new Promise<never>(() => undefined));
    const server = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      addresses: () => ["127.0.0.1"],
      forwardControl
    });
    const held = fetch(
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
  });
});
