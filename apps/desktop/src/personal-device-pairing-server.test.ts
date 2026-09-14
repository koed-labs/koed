import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  decryptPersonalDevicePairingMessage,
  encryptPersonalDevicePairingMessage
} from "./personal-device-pairing-crypto.js";
import { canonicalizePdsJson, PDS_PROTOCOL } from "@koed/shared";
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

  it("issues pairing links for Tailscale addresses", async () => {
    const server = await startPersonalDevicePairingServer({
      port: 0,
      host: "127.0.0.1",
      addresses: () => ["100.98.6.2"],
      forwardControl: vi.fn()
    });
    try {
      const view = server.createInvitation(baseInvitation());
      expect(view.url).toMatch(/^http:\/\/100\.98\.6\.2:[1-9][0-9]*\/pair\//);
      expect(view).not.toHaveProperty("shortCode");
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
      server.claimApproval(pairing.id);
      server.approve(pairing.id);
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
      server.approve(pairing.id);
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
      server.claimApproval(pairing.id);
      expect(server.inspect(pairing.id)[0]).toMatchObject({
        state: "connecting",
        phase: "committing"
      });
      expect(() => server.cancel(pairing.id)).toThrow(
        "cannot be cancelled after commit started"
      );
      expect(server.inspect(pairing.id)[0]?.state).toBe("connecting");
      server.approve(pairing.id);
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
      const parsed = new URL(pairing.url);
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
      const submitted = fetch(
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
      server.claimApproval(pairing.id);
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
      server.approve(pairing.id);
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
      server.claimApproval(pairing.id);
      current = new Date(new Date(invitation.expires_at).getTime() + 1);
      server.approve(pairing.id);
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
    await vi.waitFor(() => expect(forwardedSignal?.aborted).toBe(true));
  });
});
