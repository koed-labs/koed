import { z } from "zod";

import { isPrivateNetworkIpv4Address } from "./private-network.js";
import {
  certificateIsPdsValid,
  PDS_PROTOCOL,
  validatePdsPackageAck
} from "./personal-device-sync.js";
import { parseCanonicalPdsJson } from "./personal-device-sync-jcs.js";
import {
  parsePdsRelayRequestProof,
  verifyPdsRelayRequestProof
} from "./personal-device-sync-relay.js";

export const PDS_PEER_PROTOCOL = "koed/pds-peer/v1" as const;
export const PDS_PEER_ENDPOINT_RUNTIME_FILE = "pds-peer-endpoint.json";
export const PDS_PEER_ROUTE_TTL_MS = 3 * 60_000;
export const PDS_PEER_ROUTE_REFRESH_MS = 60_000;
export const PDS_PEER_RECEIPT_WAIT_MS = 15_000;

const peerIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

export const normalizePdsPeerEndpoint = (value: string): string => {
  if (value.length > 2_048) throw new TypeError("PDS peer endpoint is invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("PDS peer endpoint is invalid");
  }
  const privateHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      isPrivateNetworkIpv4Address(url.hostname));
  if (
    (url.protocol !== "https:" && !privateHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/+$/, "") !== "/pds"
  ) {
    throw new TypeError("PDS peer endpoint is invalid");
  }
  return `${url.origin}/pds`;
};

export const pdsPeerRouteAdvertisementSchema = z
  .object({
    protocol: z.literal(PDS_PEER_PROTOCOL),
    endpointUrl: z.string().transform(normalizePdsPeerEndpoint),
    advertisedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true })
  })
  .strict();
export type PdsPeerRouteAdvertisement = z.infer<
  typeof pdsPeerRouteAdvertisementSchema
>;

export const pdsPeerRouteRecordSchema = z
  .object({
    deviceId: peerIdSchema,
    canonicalAdvertisement: z.string().min(1).max(4_096),
    canonicalRequestProof: z.string().min(1).max(8_192)
  })
  .strict();
export type PdsPeerRouteRecord = z.infer<typeof pdsPeerRouteRecordSchema>;

export const createPdsPeerRouteAdvertisement = (input: {
  endpointUrl: string;
  now?: Date;
}): PdsPeerRouteAdvertisement => {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("PDS peer advertisement time is invalid");
  }
  return pdsPeerRouteAdvertisementSchema.parse({
    protocol: PDS_PEER_PROTOCOL,
    endpointUrl: input.endpointUrl,
    advertisedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PDS_PEER_ROUTE_TTL_MS).toISOString()
  });
};

type PeerCertificate = {
  protocol: typeof PDS_PROTOCOL;
  groupId: string;
  deviceId: string;
  deviceSigningKeyId: string;
  deviceSigningPublicKey: string;
  epoch: string;
  statementHash: string;
};

const certificateForDevice = (
  certificates: readonly string[],
  deviceId: string,
  authorityPublicKey: string,
  authorityKeyId: string,
  now: Date
): PeerCertificate => {
  const certificate = certificates
    .map((value) => ({
      canonical: value,
      value: parseCanonicalPdsJson(value) as PeerCertificate
    }))
    .find((value) => value.value.deviceId === deviceId);
  if (!certificate) throw new TypeError("PDS peer device is not active");
  if (
    !certificateIsPdsValid(
      certificate.value,
      authorityPublicKey,
      authorityKeyId,
      now
    )
  ) {
    throw new TypeError("PDS peer membership certificate is invalid");
  }
  return certificate.value;
};

export const verifyPdsPeerRouteRecord = (input: {
  record: unknown;
  groupId: string;
  authorityHead: string;
  currentEpoch: string;
  authorityPublicKey: string;
  authorityKeyId: string;
  activeCertificates: readonly string[];
  now?: Date;
}): { deviceId: string; endpointUrl: string; expiresAt: string } => {
  const record = pdsPeerRouteRecordSchema.parse(input.record);
  const advertisement = pdsPeerRouteAdvertisementSchema.parse(
    parseCanonicalPdsJson(record.canonicalAdvertisement)
  );
  const proof = parsePdsRelayRequestProof(record.canonicalRequestProof);
  const now = input.now ?? new Date();
  const certificate = certificateForDevice(
    input.activeCertificates,
    record.deviceId,
    input.authorityPublicKey,
    input.authorityKeyId,
    now
  );
  if (
    certificate.protocol !== PDS_PROTOCOL ||
    certificate.groupId !== input.groupId ||
    certificate.statementHash !== input.authorityHead ||
    certificate.epoch !== input.currentEpoch ||
    certificate.deviceId !== proof.deviceId ||
    certificate.deviceSigningKeyId !== proof.deviceSigningKeyId
  ) {
    throw new TypeError("PDS peer authority binding is invalid");
  }
  verifyPdsRelayRequestProof({
    proof,
    method: "POST",
    target: "/v1/personal-device-sync/relay/peer-routes",
    body: Buffer.from(record.canonicalAdvertisement, "utf8"),
    signingPublicKey: certificate.deviceSigningPublicKey,
    now
  });
  const advertisedAt = new Date(advertisement.advertisedAt).getTime();
  const expiresAt = new Date(advertisement.expiresAt).getTime();
  if (
    expiresAt <= now.getTime() ||
    expiresAt - advertisedAt !== PDS_PEER_ROUTE_TTL_MS
  ) {
    throw new TypeError("PDS peer route is stale");
  }
  return {
    deviceId: record.deviceId,
    endpointUrl: advertisement.endpointUrl,
    expiresAt: advertisement.expiresAt
  };
};

export const selectCompletePdsPeerRouteSet = (input: {
  records: readonly unknown[];
  intendedRecipientDeviceIds: readonly string[];
  groupId: string;
  authorityHead: string;
  currentEpoch: string;
  authorityPublicKey: string;
  authorityKeyId: string;
  activeCertificates: readonly string[];
  now?: Date;
}): Map<string, string> | null => {
  const routes = new Map<string, string>();
  const endpoints = new Set<string>();
  for (const value of input.records) {
    const route = verifyPdsPeerRouteRecord({ ...input, record: value });
    if (routes.has(route.deviceId) || endpoints.has(route.endpointUrl)) {
      throw new TypeError("PDS peer route advertisement is ambiguous");
    }
    routes.set(route.deviceId, route.endpointUrl);
    endpoints.add(route.endpointUrl);
  }
  const selected = new Map<string, string>();
  for (const deviceId of input.intendedRecipientDeviceIds) {
    const endpoint = routes.get(deviceId);
    if (!endpoint) return null;
    selected.set(deviceId, endpoint);
  }
  return selected;
};

export const verifyPdsPeerReceipt = (input: {
  canonicalAck: string;
  certificate: string;
  authorityPublicKey: string;
  authorityKeyId: string;
  authorityHead: string;
  currentEpoch: string;
  groupId: string;
  transportId: string;
  packageId: string;
  sourceManifestHash: string;
  intendedRecipientSnapshotHash: string;
  recipientDeviceId: string;
  now?: Date;
}): void => {
  const certificate = certificateForDevice(
    [input.certificate],
    input.recipientDeviceId,
    input.authorityPublicKey,
    input.authorityKeyId,
    input.now ?? new Date()
  );
  if (
    certificate.groupId !== input.groupId ||
    certificate.deviceId !== input.recipientDeviceId ||
    certificate.statementHash !== input.authorityHead ||
    certificate.epoch !== input.currentEpoch
  ) {
    throw new TypeError("PDS peer receipt authority is invalid");
  }
  const ack = parseCanonicalPdsJson(input.canonicalAck) as Record<
    string,
    unknown
  >;
  validatePdsPackageAck(ack, {
    signingPublicKey: certificate.deviceSigningPublicKey,
    expectedSignerKeyId: certificate.deviceSigningKeyId,
    expectedGroupId: input.groupId,
    expectedDeviceId: input.recipientDeviceId
  });
  if (
    ack.transportId !== input.transportId ||
    ack.packageId !== input.packageId ||
    ack.sourceManifestHash !== input.sourceManifestHash ||
    ack.intendedRecipientSnapshotHash !== input.intendedRecipientSnapshotHash ||
    ack.result !== "materialized"
  ) {
    throw new TypeError("PDS peer receipt identity is invalid");
  }
};
