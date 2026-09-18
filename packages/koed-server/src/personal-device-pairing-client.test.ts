import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storeDesktopLocalCredential } from "@koed/shared";
import type { PersonalSyncResult } from "./personal-sync.js";
import { redeemPersonalDevicePairing } from "./personal-device-pairing-client.js";

const protocol = "koed/pds-lan-pair/v1" as const;
const invitationId = "11111111-2222-4333-8444-555555555555";
const token = Buffer.alloc(32, 9).toString("base64url");
const invitationOrigin = "http://192.168.1.10:3310";
const controlPath = `/v1/pair/${invitationId}/exchange`;
const localOrigin = "http://127.0.0.1:43110";
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

const pairingKey = () => {
  const salt = createHash("sha256")
    .update(`${protocol}\0${invitationId}`, "utf8")
    .digest();
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(token, "base64url"),
      salt,
      Buffer.from(`${protocol}/transport-key`, "utf8"),
      32
    )
  );
};

const encryptResponse = (value: Record<string, unknown>, messageId: string) => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", pairingKey(), nonce);
  cipher.setAAD(
    Buffer.from(`${protocol}/response\n${invitationId}\n${messageId}`, "utf8")
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final()
  ]);
  return {
    protocol,
    message_id: messageId,
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url")
  };
};

const decryptRequest = (envelope: Record<string, unknown>) => {
  const nonce = Buffer.from(String(envelope.nonce), "base64url");
  const decipher = createDecipheriv("aes-256-gcm", pairingKey(), nonce);
  decipher.setAAD(
    Buffer.from(
      `${protocol}/request\n${invitationId}\n${String(envelope.message_id)}`,
      "utf8"
    )
  );
  decipher.setAuthTag(Buffer.from(String(envelope.tag), "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(String(envelope.ciphertext), "base64url")),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
};

type CompletionFailure =
  | "drop"
  | "body"
  | "stream"
  | "truncated"
  | "truncated-json"
  | "transport"
  | "stream-size"
  | "protocol"
  | "auth"
  | "malformed"
  | "size";

const harness = (completionFailure?: CompletionFailure) => {
  const koedHome = mkdtempSync(resolve(tmpdir(), "koed-pairing-client-"));
  homes.push(koedHome);
  storeDesktopLocalCredential(koedHome, {
    ownerUserId: "33333333-4444-4333-8444-555555555555",
    operationFamilies: ["personal_collaboration_read"]
  });

  const runCalls: string[][] = [];
  const localCalls: string[] = [];
  const completionMessageIds: string[] = [];
  let localRequestCount = 0;
  const invitation = {
    protocol,
    group_id: "group-1",
    challenge_id: "22222222-3333-4333-8444-555555555555",
    control_url: `${invitationOrigin}${controlPath}`,
    relay_url: `${invitationOrigin}/pds`
  };
  const runPersonalSync = vi.fn(
    async (args: string[]): Promise<PersonalSyncResult> => {
      runCalls.push(args);
      if (args[1] === "request") {
        return {
          ok: true,
          state: "pending",
          message: "",
          request: { signed: true },
          pairing: { challengeId: invitation.challenge_id }
        };
      }
      if (args[1] === "complete") {
        return {
          ok: true,
          state: "completed",
          message: "",
          localGroupReconciliation: { group_id: "group-1" }
        };
      }
      return { ok: true, state: "bound", message: "" };
    }
  );

  const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === localOrigin) {
      localCalls.push(url.pathname);
      localRequestCount += 1;
      return new Response(
        JSON.stringify(
          localRequestCount === 1
            ? { local_user_id: "33333333-4444-4333-8444-555555555555" }
            : {}
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    const envelope = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const payload = decryptRequest(envelope);
    if (payload.operation === "complete") {
      completionMessageIds.push(String(envelope.message_id));
      if (
        completionFailure === "transport" ||
        (completionFailure === "drop" && completionMessageIds.length === 1)
      )
        throw new TypeError("fetch failed");
      const completionBody = JSON.stringify(
        encryptResponse({ completed: true }, String(envelope.message_id))
      );
      if (completionFailure === "body" && completionMessageIds.length === 1) {
        return new Response(null, { status: 200 });
      }
      if (completionFailure === "stream" && completionMessageIds.length === 1) {
        let emitted = false;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!emitted) {
              emitted = true;
              controller.enqueue(Buffer.from(completionBody.slice(0, 20)));
              return;
            }
            controller.error(new TypeError("response stream failed"));
          }
        });
        return new Response(stream, { status: 200 });
      }
      if (
        completionFailure === "truncated" &&
        completionMessageIds.length === 1
      ) {
        return new Response(completionBody.slice(0, -1), {
          status: 200,
          headers: {
            "content-length": String(Buffer.byteLength(completionBody))
          }
        });
      }
      if (
        completionFailure === "truncated-json" &&
        completionMessageIds.length === 1
      ) {
        return new Response(completionBody.slice(0, -1), { status: 200 });
      }
      if (
        completionFailure === "malformed" &&
        completionMessageIds.length === 1
      ) {
        return new Response('{"x":]}', { status: 200 });
      }
      if (completionFailure === "size" && completionMessageIds.length === 1) {
        return new Response("{}", {
          status: 200,
          headers: { "content-length": "1048577" }
        });
      }
      if (
        completionFailure === "stream-size" &&
        completionMessageIds.length === 1
      ) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1_048_577));
            controller.close();
          }
        });
        return new Response(stream, { status: 200 });
      }
      if (completionFailure === "protocol") {
        return new Response(JSON.stringify({ error: "Pairing is closed." }), {
          status: 409,
          headers: { "content-type": "application/json" }
        });
      }
      if (completionFailure === "auth") {
        return new Response(JSON.stringify({ protocol }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(completionBody, {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (payload.operation === "invitation") {
      return new Response(
        JSON.stringify(
          encryptResponse({ invitation }, String(envelope.message_id))
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (payload.operation === "request") {
      return new Response(
        JSON.stringify(
          encryptResponse({ approved: true }, String(envelope.message_id))
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`Unexpected operation ${String(payload.operation)}`);
  });

  return {
    koedHome,
    runCalls,
    localCalls,
    completionMessageIds,
    fetch,
    runPersonalSync,
    withJsonFd: async <T>(
      _payload: Record<string, unknown>,
      operation: (fd: number) => Promise<T>
    ) => operation(42)
  };
};

const redeem = async (fixture: ReturnType<typeof harness>) =>
  await redeemPersonalDevicePairing({
    link: `${invitationOrigin}/pair/${invitationId}#token=${token}`,
    deviceLabel: "Joining laptop",
    requestId: randomUUID(),
    localControlUrl: localOrigin,
    koedHome: fixture.koedHome,
    environment: {},
    fetch: fixture.fetch,
    runPersonalSync: fixture.runPersonalSync,
    withJsonFd: fixture.withJsonFd
  });

describe("Personal device pairing client", () => {
  it("recovers dropped completion response with fresh message id without rerunning local commit", async () => {
    const fixture = harness("drop");

    await expect(redeem(fixture)).resolves.toMatchObject({
      ok: true,
      state: "completed"
    });
    expect(fixture.completionMessageIds).toHaveLength(2);
    expect(new Set(fixture.completionMessageIds).size).toBe(2);
    expect(fixture.runCalls.map((args) => args.slice(0, 2))).toEqual([
      ["join", "request"],
      ["join", "complete"],
      ["join", "bind-local-user"]
    ]);
    expect(fixture.localCalls).toEqual([
      "/v1/personal-device-sync/local-group-reconciliation",
      "/v1/personal-device-sync/local-runtime-wake"
    ]);
  });

  it("bounds retries after repeated transport failures", async () => {
    const fixture = harness("transport");

    await expect(redeem(fixture)).rejects.toThrow("fetch failed");
    expect(fixture.completionMessageIds).toHaveLength(3);
    expect(new Set(fixture.completionMessageIds).size).toBe(3);
  });

  it.each([
    ["dropped body", "body" as const],
    ["stream read failure", "stream" as const],
    ["truncated body", "truncated" as const],
    ["truncated JSON", "truncated-json" as const]
  ])(
    "retries ambiguous completion %s with fresh message id",
    async (_name, failure) => {
      const fixture = harness(failure);

      await expect(redeem(fixture)).resolves.toMatchObject({
        ok: true,
        state: "completed"
      });
      expect(fixture.completionMessageIds).toHaveLength(2);
      expect(new Set(fixture.completionMessageIds).size).toBe(2);
    }
  );

  it.each([
    ["protocol response", "protocol" as const],
    ["authentication response", "auth" as const],
    ["malformed JSON response", "malformed" as const],
    ["response size cap", "size" as const],
    ["streamed response size cap", "stream-size" as const]
  ])("does not retry explicit %s failure", async (_name, failure) => {
    const fixture = harness(failure);

    await expect(redeem(fixture)).rejects.toThrow();
    expect(fixture.completionMessageIds).toHaveLength(1);
    expect(fixture.runCalls.map((args) => args.slice(0, 2))).toEqual([
      ["join", "request"],
      ["join", "complete"],
      ["join", "bind-local-user"]
    ]);
  });
});
