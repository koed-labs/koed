import { describe, expect, it } from "vitest";
import {
  pairingLinkFromDeepLink,
  parsePersonalDevicePairingLink
} from "./personal-device-pairing-link.js";

const invitationId = "11111111-2222-4333-8444-555555555555";
const hexadecimalInvitationId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const token = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
const link = `http://192.168.1.20:3310/pair/${invitationId}#token=${token}`;
const tailscaleLink = `http://100.98.6.2:3310/pair/${invitationId}#token=${token}`;
const relayUrl = "wss://koed-relay.fly.dev/ws";
const relayInvitation = `https://koed-relay.fly.dev/pair/${invitationId}#token=${token}`;
const deepLink = (url: string) =>
  `koed://pair/redeem?url=${encodeURIComponent(url)}`;

describe("Personal Device pairing links", () => {
  it("accepts exact private-network invitation and deep-link forms", () => {
    expect(parsePersonalDevicePairingLink(link)).toMatchObject({
      invitationId,
      token
    });
    expect(parsePersonalDevicePairingLink(tailscaleLink)).toMatchObject({
      invitationId,
      token
    });
    expect(
      parsePersonalDevicePairingLink(
        `http://192.168.1.20:80/pair/${invitationId}#token=${token}`
      )
    ).toMatchObject({ invitationId, token });
    expect(pairingLinkFromDeepLink(deepLink(link))).toBe(link);
  });

  it("accepts relay invitation links only for configured relay", () => {
    expect(
      parsePersonalDevicePairingLink(relayInvitation, relayUrl)
    ).toMatchObject({ invitationId, token });
    expect(
      parsePersonalDevicePairingLink(deepLink(relayInvitation), relayUrl)
    ).toMatchObject({ invitationId, token });
    expect(() =>
      parsePersonalDevicePairingLink(
        `https://other-relay.example/pair/${invitationId}#token=${token}`,
        relayUrl
      )
    ).toThrow();
    expect(() => parsePersonalDevicePairingLink(relayInvitation)).toThrow();
    expect(pairingLinkFromDeepLink(deepLink(relayInvitation), relayUrl)).toBe(
      relayInvitation
    );
    expect(pairingLinkFromDeepLink(deepLink(relayInvitation))).toBeNull();
  });

  it("accepts hexadecimal UUID invitation ids", () => {
    const hexadecimalLink = `http://192.168.1.20:3310/pair/${hexadecimalInvitationId}#token=${token}`;
    expect(parsePersonalDevicePairingLink(hexadecimalLink)).toMatchObject({
      invitationId: hexadecimalInvitationId,
      token
    });
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
    "koed://other?url=x",
    `koed://pair/path?url=${encodeURIComponent(link)}`,
    `koed://pair/redeem?url=${encodeURIComponent(link)}&extra=x`,
    `koed://pair/redeem?url=${encodeURIComponent(link)}&url=${encodeURIComponent(link)}`,
    "https://example.com/"
  ])("rejects malformed deep link %s", (value) => {
    expect(pairingLinkFromDeepLink(value)).toBeNull();
  });
});
