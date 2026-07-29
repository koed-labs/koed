import { describe, expect, it } from "vitest";
import {
  pairingLinkFromDeepLink,
  parsePersonalDevicePairingLink
} from "./personal-device-pairing-link.js";

const invitationId = "11111111-2222-4333-8444-555555555555";
const token = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
const link = `http://192.168.1.20:3310/pair/${invitationId}#token=${token}`;

describe("Personal Device pairing links", () => {
  it("accepts exact private-network invitation and deep-link forms", () => {
    expect(parsePersonalDevicePairingLink(link)).toMatchObject({
      invitationId,
      token
    });
    expect(
      parsePersonalDevicePairingLink(
        `http://192.168.1.20:80/pair/${invitationId}#token=${token}`
      )
    ).toMatchObject({ invitationId, token });
    expect(
      pairingLinkFromDeepLink(
        `koed-pair://redeem?url=${encodeURIComponent(link)}`
      )
    ).toBe(link);
  });

  it.each([
    `https://192.168.1.20:3310/pair/${invitationId}#token=${token}`,
    `http://example.com:3310/pair/${invitationId}#token=${token}`,
    `http://203.0.113.5:3310/pair/${invitationId}#token=${token}`,
    `http://user:pass@192.168.1.20:3310/pair/${invitationId}#token=${token}`,
    `http://192.168.1.20:3310/pair/${invitationId}?next=x#token=${token}`,
    `http://192.168.1.20:3310/pair/${invitationId}#token=${token}&extra=x`,
    `http://192.168.1.20:3310/pair/not-a-uuid#token=${token}`,
    `http://192.168.001.20:3310/pair/${invitationId}#token=${token}`,
    `http://0xc0a80114:3310/pair/${invitationId}#token=${token}`,
    `http://192.168.1.20:03310/pair/${invitationId}#token=${token}`,
    `http://192.168.1.20/pair/${invitationId}#token=${token}`,
    `http://192.168.1.20:3310/pair/11111111-2222-3333-8444-555555555555#token=${token}`,
    `http://192.168.1.20:3310/pair/11111111-2222-4333-7444-555555555555#token=${token}`
  ])("rejects unsafe invitation link %s", (value) => {
    expect(() => parsePersonalDevicePairingLink(value)).toThrow();
  });

  it.each([
    "koed-pair://other?url=x",
    `koed-pair://redeem/path?url=${encodeURIComponent(link)}`,
    `koed-pair://redeem?url=${encodeURIComponent(link)}&extra=x`,
    `koed-pair://redeem?url=${encodeURIComponent(link)}&url=${encodeURIComponent(link)}`,
    "https://example.com/"
  ])("rejects malformed deep link %s", (value) => {
    expect(pairingLinkFromDeepLink(value)).toBeNull();
  });
});
