import { networkInterfaces } from "node:os";
import { isPrivatePersonalDevicePairingIpv4 } from "./personal-device-pairing-link.js";

export type PersonalDevicePairingNetworkInterface = {
  address: string;
  family: string | number;
  internal: boolean;
};

type NetworkInterfaceTable = Readonly<
  Record<
    string,
    readonly PersonalDevicePairingNetworkInterface[] | null | undefined
  >
>;

const isIpv4 = (family: string | number): boolean =>
  family === "IPv4" || family === 4;

/** List non-loopback private IPv4 addresses available for LAN pairing. */
export const listPersonalDevicePairingNetworkAddresses = (
  interfaces: NetworkInterfaceTable = networkInterfaces()
): string[] => {
  const addresses = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter(
      (entry) =>
        isIpv4(entry.family) &&
        !entry.internal &&
        isPrivatePersonalDevicePairingIpv4(entry.address)
    )
    .map((entry) => entry.address);
  return [...new Set(addresses)].sort((left, right) =>
    left.localeCompare(right)
  );
};

/**
 * Resolve one concrete interface address for server.listen(). Never return a
 * wildcard or public address; binding a concrete address keeps pairing and
 * relay traffic off unrelated interfaces.
 */
export const resolvePersonalDevicePairingBindAddress = (
  configuredHost?: string,
  addresses: readonly string[] = listPersonalDevicePairingNetworkAddresses()
): string => {
  const configured = configuredHost?.trim();
  if (configured) {
    if (!isPrivatePersonalDevicePairingIpv4(configured)) {
      throw new Error(
        "Pairing server host must be a private IPv4 interface address."
      );
    }
    return configured;
  }

  const address = [...new Set(addresses)]
    .filter(isPrivatePersonalDevicePairingIpv4)
    .sort((left, right) => left.localeCompare(right))[0];
  if (!address || address.startsWith("127.")) {
    throw new Error("No private network interface is available for pairing.");
  }
  return address;
};
