import { isPrivateNetworkIpv4Address } from "@koed/shared/private-network";

export const isPrivatePersonalDevicePairingIpv4 = isPrivateNetworkIpv4Address;

const pairingUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isPersonalDevicePairingUuid = (value: unknown): value is string =>
  typeof value === "string" && pairingUuidPattern.test(value);
const pairingLinkPattern =
  /^https?:\/\/([^/:?#]+)(?::([1-9][0-9]{0,4}))?(\/pair\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}))#token=([A-Za-z0-9_-]{43})$/;

const relayOrigin = (configuredRelayUrl?: string): string | null => {
  if (!configuredRelayUrl) return null;
  try {
    const relay = new URL(configuredRelayUrl);
    const hostname = relay.hostname.replace(/^\[|\]$/g, "");
    const isLocalRelay = ["localhost", "127.0.0.1", "::1"].includes(hostname);
    if (
      (relay.protocol !== "wss:" &&
        !(isLocalRelay && relay.protocol === "ws:")) ||
      relay.pathname !== "/ws" ||
      relay.search ||
      relay.hash ||
      relay.username ||
      relay.password
    ) {
      return null;
    }
    const protocol = relay.protocol === "wss:" ? "https:" : "http:";
    return `${protocol}//${relay.host}`;
  } catch {
    return null;
  }
};

const unwrapPairingDeepLink = (value: string): string | null => {
  if (!value.startsWith("koed://")) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "koed:" ||
      url.hostname !== "pair" ||
      url.pathname !== "/redeem" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      [...url.searchParams.keys()].some((key) => key !== "url") ||
      url.searchParams.getAll("url").length !== 1
    ) {
      return null;
    }
    const invitationUrl = url.searchParams.get("url");
    return invitationUrl && invitationUrl.length <= 4_096
      ? invitationUrl
      : null;
  } catch {
    return null;
  }
};

const parseInvitationUrl = (
  value: string,
  configuredRelayUrl?: string
): { invitationUrl: URL; token: string; invitationId: string } => {
  const match = pairingLinkPattern.exec(value);
  if (!match) throw new Error("Pairing link is invalid.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Pairing link is invalid.");
  }
  const isPrivateNetworkLink =
    url.protocol === "http:" &&
    Boolean(match[2]) &&
    isPrivatePersonalDevicePairingIpv4(url.hostname);
  const expectedRelayOrigin = relayOrigin(configuredRelayUrl);
  const isConfiguredRelayLink =
    expectedRelayOrigin !== null && url.origin === expectedRelayOrigin;
  if (
    match[1] !== url.hostname ||
    (!isPrivateNetworkLink && !isConfiguredRelayLink) ||
    url.username ||
    url.password ||
    url.search ||
    url.pathname !== match[3] ||
    url.hash !== `#token=${match[5]}`
  ) {
    throw new Error(
      "Pairing link must be a private-network Koed link or use configured Paseo relay."
    );
  }
  return {
    invitationUrl: new URL(value.slice(0, value.indexOf("#"))),
    token: match[5]!,
    invitationId: match[4]!
  };
};

export const parsePersonalDevicePairingLink = (
  value: unknown,
  configuredRelayUrl?: string
): { invitationUrl: URL; token: string; invitationId: string } => {
  if (typeof value !== "string" || value.length > 8_192) {
    throw new Error("Pairing link is invalid.");
  }
  const normalized = value.trim();
  const nestedLink = unwrapPairingDeepLink(normalized);
  if (normalized.startsWith("koed://") && !nestedLink) {
    throw new Error("Pairing deep link is invalid.");
  }
  return parseInvitationUrl(nestedLink ?? normalized, configuredRelayUrl);
};

export const personalDevicePairingDeepLink = (invitationUrl: string): string =>
  `koed://pair/redeem?url=${encodeURIComponent(invitationUrl)}`;

export const pairingLinkFromDeepLink = (
  value: unknown,
  configuredRelayUrl?: string
): string | null => {
  if (typeof value !== "string" || value.length > 8_192) return null;
  const invitationUrl = unwrapPairingDeepLink(value);
  if (!invitationUrl) return null;
  try {
    parseInvitationUrl(invitationUrl, configuredRelayUrl);
    return invitationUrl;
  } catch {
    return null;
  }
};
