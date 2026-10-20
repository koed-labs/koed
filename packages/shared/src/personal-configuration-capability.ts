import { z } from "zod";
import { PDS_PROTOCOL, certificateIsPdsValid } from "./personal-device-sync.js";
import { parseCanonicalPdsJson } from "./personal-device-sync-jcs.js";
import {
  parsePdsRelayRequestProof,
  verifyPdsRelayRequestProof
} from "./personal-device-sync-relay.js";

export const PERSONAL_CONFIGURATION_PROTOCOL =
  "koed/personal-configuration/v1" as const;
export const PDS_CONFIGURATION_CAPABILITY_TTL_MS = 180_000;
export const PDS_CONFIGURATION_CAPABILITY_PATH =
  "/v1/personal-device-sync/relay/configuration-capabilities";
export const personalConfigurationFeatureSchema = z.enum([
  "source_context_v1",
  "project_membership_v1"
]);
export type PersonalConfigurationFeature = z.infer<
  typeof personalConfigurationFeatureSchema
>;
export const pdsConfigurationCapabilityAdvertisementSchema = z
  .object({
    protocol: z.literal(PERSONAL_CONFIGURATION_PROTOCOL),
    features: z.array(personalConfigurationFeatureSchema).min(1).max(2),
    advertisedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true })
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.features).size !== value.features.length)
      ctx.addIssue({
        code: "custom",
        message: "Configuration capabilities must be distinct"
      });
    if (
      new Date(value.expiresAt).getTime() -
        new Date(value.advertisedAt).getTime() !==
      PDS_CONFIGURATION_CAPABILITY_TTL_MS
    )
      ctx.addIssue({
        code: "custom",
        message: "Configuration capability lifetime is invalid"
      });
  });
export const pdsConfigurationCapabilityRecordSchema = z
  .object({
    deviceId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    canonicalAdvertisement: z.string().min(1).max(4096),
    canonicalRequestProof: z.string().min(1).max(8192)
  })
  .strict();
export type PdsConfigurationCapabilityRecord = z.infer<
  typeof pdsConfigurationCapabilityRecordSchema
>;
export const createPdsConfigurationCapabilityAdvertisement = (
  features: PersonalConfigurationFeature[],
  now = new Date()
) =>
  pdsConfigurationCapabilityAdvertisementSchema.parse({
    protocol: PERSONAL_CONFIGURATION_PROTOCOL,
    features,
    advertisedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + PDS_CONFIGURATION_CAPABILITY_TTL_MS
    ).toISOString()
  });

type Certificate = {
  protocol: string;
  groupId: string;
  deviceId: string;
  deviceSigningKeyId: string;
  deviceSigningPublicKey: string;
  epoch: string;
  statementHash: string;
};
export type PdsConfigurationCapabilityAuthority = {
  groupId: string;
  authorityHead: string;
  currentEpoch: string;
  authorityPublicKey: string;
  authorityKeyId: string;
  activeCertificates: readonly string[];
  now?: Date;
};
/** Device signatures and current membership, rather than relay assertions, authorize feature negotiation. */
export const verifyPdsConfigurationCapabilityRecord = (
  input: PdsConfigurationCapabilityAuthority & { record: unknown }
) => {
  const record = pdsConfigurationCapabilityRecordSchema.parse(input.record),
    now = input.now ?? new Date();
  const advertisement = pdsConfigurationCapabilityAdvertisementSchema.parse(
    parseCanonicalPdsJson(record.canonicalAdvertisement)
  );
  const proof = parsePdsRelayRequestProof(record.canonicalRequestProof);
  const certificate = input.activeCertificates
    .map((value) => parseCanonicalPdsJson(value) as Certificate)
    .find((value) => value.deviceId === record.deviceId);
  if (
    !certificate ||
    !certificateIsPdsValid(
      certificate,
      input.authorityPublicKey,
      input.authorityKeyId,
      now
    ) ||
    certificate.protocol !== PDS_PROTOCOL ||
    certificate.groupId !== input.groupId ||
    certificate.statementHash !== input.authorityHead ||
    certificate.epoch !== input.currentEpoch ||
    certificate.deviceId !== proof.deviceId ||
    certificate.deviceSigningKeyId !== proof.deviceSigningKeyId
  )
    throw new TypeError("PDS configuration capability authority is invalid");
  verifyPdsRelayRequestProof({
    proof,
    method: "POST",
    target: PDS_CONFIGURATION_CAPABILITY_PATH,
    body: Buffer.from(record.canonicalAdvertisement, "utf8"),
    signingPublicKey: certificate.deviceSigningPublicKey,
    now
  });
  if (
    new Date(advertisement.expiresAt).getTime() <= now.getTime() ||
    Math.abs(
      new Date(advertisement.advertisedAt).getTime() -
        new Date(proof.timestamp).getTime()
    ) > 60_000
  )
    throw new TypeError("PDS configuration capability is stale");
  return {
    deviceId: record.deviceId,
    features: advertisement.features,
    expiresAt: advertisement.expiresAt
  };
};
export class PdsConfigurationCompatibilityError extends Error {
  readonly code = "peer_capability_required";
  readonly statusCode = 409;
  readonly retryable = true;
  constructor(
    readonly feature: PersonalConfigurationFeature,
    readonly unsupportedDeviceIds: readonly string[]
  ) {
    super(
      "Personal synchronization is pending until every intended device supports the configuration protocol."
    );
    this.name = "PdsConfigurationCompatibilityError";
  }
}
/** Missing, invalid, duplicate, revoked, or stale advertisements cannot authorize a new format. */
export const requirePdsConfigurationCapability = (
  input: PdsConfigurationCapabilityAuthority & {
    records: readonly unknown[];
    intendedRecipientDeviceIds: readonly string[];
    feature: PersonalConfigurationFeature;
  }
) => {
  const supported = new Map<string, boolean>();
  for (const record of input.records) {
    let parsed: ReturnType<typeof verifyPdsConfigurationCapabilityRecord>;
    try {
      parsed = verifyPdsConfigurationCapabilityRecord({ ...input, record });
    } catch {
      continue;
    }
    supported.set(
      parsed.deviceId,
      supported.has(parsed.deviceId)
        ? false
        : parsed.features.includes(input.feature)
    );
  }
  const missing = [...new Set(input.intendedRecipientDeviceIds)]
    .filter((id) => supported.get(id) !== true)
    .sort();
  if (missing.length)
    throw new PdsConfigurationCompatibilityError(input.feature, missing);
};
