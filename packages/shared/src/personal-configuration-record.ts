import { pdsPersonalProjectDefaultDecisionSchema } from "./personal-project-default-contract.js";
import {
  decodePdsPersonalMembershipEntitySnapshot,
  pdsPersonalMembershipEntitySnapshotSchema
} from "./personal-membership-transport.js";
import { createHash, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { canonicalizePdsJson } from "./personal-device-sync-jcs.js";
import {
  decodePdsBase64url,
  pdsEd25519PublicKey
} from "./personal-device-sync.js";
import { personalIdentifierSchema } from "./personal-source-contract.js";
import {
  decodePdsPersonalSourceContextSnapshot,
  pdsPersonalSourceContextSnapshotSchema
} from "./personal-source-context-transport.js";
import { PERSONAL_CONFIGURATION_PROTOCOL } from "./personal-configuration-capability.js";

const digest = z.string().refine((value) => {
  try {
    decodePdsBase64url(value, 32);
    return true;
  } catch {
    return false;
  }
}, "Invalid configuration digest");
export const personalConfigurationPayloadSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("project_default"),
        snapshot: pdsPersonalProjectDefaultDecisionSchema
      })
      .strict(),
    z
      .object({
        kind: z.literal("source_context"),
        snapshot: pdsPersonalSourceContextSnapshotSchema
      })
      .strict(),
    z
      .object({
        kind: z.literal("project_membership"),
        snapshot: pdsPersonalMembershipEntitySnapshotSchema
      })
      .strict()
  ])
  .superRefine((payload, ctx) => {
    try {
      if (payload.kind === "source_context")
        decodePdsPersonalSourceContextSnapshot(payload.snapshot);
      else if (payload.kind === "project_membership")
        decodePdsPersonalMembershipEntitySnapshot(payload.snapshot);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Configuration history is incomplete or invalid"
      });
    }
  });
export type PersonalConfigurationPayload = z.infer<
  typeof personalConfigurationPayloadSchema
>;

const revisionFields = z
  .object({
    protocol: z.literal(PERSONAL_CONFIGURATION_PROTOCOL),
    groupId: personalIdentifierSchema,
    authorDeviceId: personalIdentifierSchema,
    authorSigningKeyId: personalIdentifierSchema,
    payload: personalConfigurationPayloadSchema
  })
  .strict();
const contentIdentity = (input: z.infer<typeof revisionFields>): string =>
  createHash("sha256")
    .update(
      `${PERSONAL_CONFIGURATION_PROTOCOL}/record\0${canonicalizePdsJson(input)}`
    )
    .digest("base64url");
export const personalConfigurationRevisionSchema = revisionFields
  .extend({ recordId: digest })
  .strict()
  .superRefine((revision, ctx) => {
    const { recordId, ...fields } = revision;
    if (contentIdentity(fields) !== recordId)
      ctx.addIssue({
        code: "custom",
        message: "Configuration content identity differs"
      });
  });
export const personalConfigurationRecordSchema = z
  .object({
    revision: personalConfigurationRevisionSchema,
    signature: z.string().refine((value) => {
      try {
        decodePdsBase64url(value, 64);
        return true;
      } catch {
        return false;
      }
    }, "Invalid configuration signature")
  })
  .strict();
export type PersonalConfigurationRecord = z.infer<
  typeof personalConfigurationRecordSchema
>;
const signingBytes = (
  revision: PersonalConfigurationRecord["revision"]
): Buffer =>
  Buffer.from(
    `${PERSONAL_CONFIGURATION_PROTOCOL}/revision\n${canonicalizePdsJson(revision)}`
  );
/** Sign independently of transport so encrypted retained records remain verifiable on replay. */
export const signPersonalConfigurationRecord = (
  input: z.infer<typeof revisionFields>,
  privateKey: KeyObject
): PersonalConfigurationRecord => {
  const fields = revisionFields.parse(input);
  const revision = personalConfigurationRevisionSchema.parse({
    ...fields,
    recordId: contentIdentity(fields)
  });
  return personalConfigurationRecordSchema.parse({
    revision,
    signature: sign(null, signingBytes(revision), privateKey).toString(
      "base64url"
    )
  });
};
/** The caller must first authenticate this exact active author certificate and outer transport. */
export const verifyPersonalConfigurationRecord = (
  input: unknown,
  author: {
    groupId: string;
    deviceId: string;
    signingKeyId: string;
    publicKey: string | Buffer | KeyObject;
  }
): PersonalConfigurationRecord => {
  const record = personalConfigurationRecordSchema.parse(input),
    revision = record.revision;
  if (
    revision.groupId !== author.groupId ||
    revision.authorDeviceId !== author.deviceId ||
    revision.authorSigningKeyId !== author.signingKeyId
  )
    throw new TypeError("PdsCryptoConfigurationAuthorityError");
  const key =
    typeof author.publicKey === "object" && "type" in author.publicKey
      ? (author.publicKey as KeyObject)
      : pdsEd25519PublicKey(author.publicKey as string | Buffer);
  if (
    !verify(
      null,
      signingBytes(revision),
      key,
      Buffer.from(record.signature, "base64url")
    )
  )
    throw new TypeError("PdsCryptoConfigurationSignatureError");
  return record;
};
export const personalConfigurationRecordHash = (
  input: PersonalConfigurationRecord
): string =>
  createHash("sha256")
    .update(canonicalizePdsJson(personalConfigurationRecordSchema.parse(input)))
    .digest("base64url");
/** Re-encryption and recipient rotation may deliver the same semantic record under a new transport. */
export const personalConfigurationPackageId = (
  recordHash: string,
  transportId: string
): string => {
  decodePdsBase64url(recordHash, 32);
  decodePdsBase64url(transportId, 32);
  return createHash("sha256")
    .update(
      `${PERSONAL_CONFIGURATION_PROTOCOL}/delivery\0${recordHash}\0${transportId}`
    )
    .digest("base64url");
};
