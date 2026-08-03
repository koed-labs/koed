import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptPersonalDevicePairingMessage,
  encryptPersonalDevicePairingMessage
} from "./personal-device-pairing-crypto.js";

const invitationId = randomUUID();
const token = randomBytes(32).toString("base64url");

describe("Personal Device pairing encrypted transport", () => {
  it("round-trips authenticated request and response messages", () => {
    const request = encryptPersonalDevicePairingMessage(
      { operation: "invitation", marker: "private-marker" },
      { invitationId, token, direction: "request" }
    );
    expect(JSON.stringify(request)).not.toContain("private-marker");
    const openedRequest = decryptPersonalDevicePairingMessage(request, {
      invitationId,
      token,
      direction: "request"
    });
    expect(openedRequest.value).toEqual({
      operation: "invitation",
      marker: "private-marker"
    });

    const response = encryptPersonalDevicePairingMessage(
      { approved: true },
      {
        invitationId,
        token,
        direction: "response",
        messageId: openedRequest.messageId
      }
    );
    expect(
      decryptPersonalDevicePairingMessage(response, {
        invitationId,
        token,
        direction: "response"
      })
    ).toEqual({
      messageId: openedRequest.messageId,
      value: { approved: true }
    });
  });

  it("rejects wrong secrets, direction swaps, tampering, and unknown fields", () => {
    const request = encryptPersonalDevicePairingMessage(
      { operation: "invitation" },
      { invitationId, token, direction: "request" }
    );
    expect(() =>
      decryptPersonalDevicePairingMessage(request, {
        invitationId,
        token: randomBytes(32).toString("base64url"),
        direction: "request"
      })
    ).toThrow("authentication failed");
    expect(() =>
      decryptPersonalDevicePairingMessage(request, {
        invitationId,
        token,
        direction: "response"
      })
    ).toThrow("authentication failed");
    expect(() =>
      decryptPersonalDevicePairingMessage(
        {
          ...request,
          ciphertext: `${request.ciphertext.slice(0, -1)}${
            request.ciphertext.endsWith("A") ? "B" : "A"
          }`
        },
        { invitationId, token, direction: "request" }
      )
    ).toThrow();
    expect(() =>
      decryptPersonalDevicePairingMessage(
        { ...request, extra: true },
        { invitationId, token, direction: "request" }
      )
    ).toThrow("invalid");
  });

  it("rejects oversized plaintext before encryption", () => {
    expect(() =>
      encryptPersonalDevicePairingMessage(
        { value: "x".repeat(256 * 1_024) },
        { invitationId, token, direction: "request" }
      )
    ).toThrow("too large");
  });

  it("rejects noncanonical pairing identifiers at the crypto boundary", () => {
    expect(() =>
      encryptPersonalDevicePairingMessage(
        { operation: "invitation" },
        {
          invitationId: "11111111-2222-3333-8444-555555555555",
          token,
          direction: "request"
        }
      )
    ).toThrow("Pairing credentials are invalid.");

    const encrypted = encryptPersonalDevicePairingMessage(
      { operation: "invitation" },
      { invitationId, token, direction: "request" }
    );
    expect(() =>
      decryptPersonalDevicePairingMessage(
        { ...encrypted, message_id: "------------------------------------" },
        { invitationId, token, direction: "request" }
      )
    ).toThrow("Pairing message is invalid.");
  });
});
