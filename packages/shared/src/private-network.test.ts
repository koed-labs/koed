import { describe, expect, it } from "vitest";
import { isPrivateNetworkIpv4Address } from "./private-network.js";

describe("private IPv4 address validation", () => {
  it.each([
    "10.0.0.1",
    "10.255.255.255",
    "127.0.0.1",
    "169.254.1.2",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "192.168.255.255"
  ])("accepts canonical private or local address %s", (address) => {
    expect(isPrivateNetworkIpv4Address(address)).toBe(true);
  });

  it.each([
    "0.0.0.0",
    "8.8.8.8",
    "11.0.0.1",
    "169.253.1.2",
    "172.15.255.255",
    "172.32.0.1",
    "192.169.0.1",
    "192.168.001.1",
    "0xc0.0xa8.0x00.0x01",
    "192.168.0",
    "192.168.0.1.",
    "localhost",
    "::1"
  ])("rejects non-private or noncanonical address %s", (address) => {
    expect(isPrivateNetworkIpv4Address(address)).toBe(false);
  });
});
