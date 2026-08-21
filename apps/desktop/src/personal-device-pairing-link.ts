import { isPrivateNetworkIpv4Address } from "@koed/shared/private-network";

export const isPrivatePersonalDevicePairingIpv4 = isPrivateNetworkIpv4Address;

const pairingUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isPersonalDevicePairingUuid = (value: unknown): value is string =>
  typeof value === "string" && pairingUuidPattern.test(value);

const pairingLinkPattern =
  /^http:\/\/([^/:?#]+):([1-9][0-9]{0,4})(\/pair\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}))#token=([A-Za-z0-9_-]{43})$/;

export const parsePersonalDevicePairingLink = (
  value: unknown
): { invitationUrl: URL; token: string; invitationId: string } => {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new Error("Pairing link is invalid.");
  }
  const normalized = value.trim();
  const match = pairingLinkPattern.exec(normalized);
  if (!match) {
    throw new Error("Pairing link is invalid.");
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("Pairing link is invalid.");
  }
  if (
    url.protocol !== "http:" ||
    match[1] !== url.hostname ||
    !isPrivatePersonalDevicePairingIpv4(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.pathname !== match[3]
  ) {
    throw new Error(
      "Same-network pairing requires a private-network link issued by Koed."
    );
  }
  const token = match[5]!;
  if (url.hash !== `#token=${token}`) {
    throw new Error("Pairing link is invalid.");
  }
  url.hash = "";
  return {
    invitationUrl: url,
    token,
    invitationId: match[4]!
  };
};

export const pairingLinkFromDeepLink = (value: unknown): string | null => {
  if (
    typeof value !== "string" ||
    value.length > 8_192 ||
    !value.startsWith("koed-pair://")
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "koed-pair:" ||
      url.hostname !== "redeem" ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.username ||
      url.password ||
      url.hash ||
      [...url.searchParams.keys()].some((key) => key !== "url") ||
      url.searchParams.getAll("url").length !== 1
    ) {
      return null;
    }
    const pairingUrl = url.searchParams.get("url");
    if (!pairingUrl || pairingUrl.length > 4_096) return null;
    parsePersonalDevicePairingLink(pairingUrl);
    return pairingUrl;
  } catch {
    return null;
  }
};
