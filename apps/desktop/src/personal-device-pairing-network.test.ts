import { describe, expect, it } from "vitest";
import {
  listPersonalDevicePairingNetworkAddresses,
  resolvePersonalDevicePairingBindAddress
} from "./personal-device-pairing-network.js";

describe("Personal Device pairing network binding", () => {
  it("lists only non-loopback private IPv4 interface addresses", () => {
    expect(
      listPersonalDevicePairingNetworkAddresses({
        ethernet: [
          { address: "192.168.1.22", family: "IPv4", internal: false },
          { address: "203.0.113.9", family: "IPv4", internal: false },
          { address: "fe80::1", family: "IPv6", internal: false }
        ],
        tailscale: [
          { address: "100.98.6.2", family: 4, internal: false },
          { address: "100.98.6.2", family: 4, internal: false }
        ],
        loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }]
      })
    ).toEqual(["100.98.6.2", "192.168.1.22"]);
  });

  it("selects one concrete private interface", () => {
    expect(
      resolvePersonalDevicePairingBindAddress(undefined, [
        "192.168.1.22",
        "100.98.6.2"
      ])
    ).toBe("100.98.6.2");
    expect(
      resolvePersonalDevicePairingBindAddress("100.98.6.2", ["192.168.1.22"])
    ).toBe("100.98.6.2");
  });

  it("rejects wildcard and public bind addresses", () => {
    for (const host of ["0.0.0.0", "::", "203.0.113.9", "pairing.local"]) {
      expect(() =>
        resolvePersonalDevicePairingBindAddress(host, ["192.168.1.22"])
      ).toThrow("private IPv4 interface address");
    }
  });

  it("fails closed when no non-loopback private interface exists", () => {
    expect(() =>
      resolvePersonalDevicePairingBindAddress(undefined, ["127.0.0.1"])
    ).toThrow("No private network interface");
  });
});
