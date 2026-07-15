import { z } from "zod";

const opaqueId = z.string().regex(/^[\x21-\x7e]{1,240}$/);
const canonicalPdsJson = z.string().min(2).max(1_048_576);
const base64url = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(512);

export const pdsChallengeSchema = z
  .object({ group_id: opaqueId.optional() })
  .strict();
export const pdsProofSchema = z
  .object({
    challenge_id: z.uuid(),
    challenge: base64url.length(43),
    device_id: opaqueId,
    signature: base64url.length(86),
    expires_at: z.string().datetime({ offset: true, precision: 3 })
  })
  .strict();
export const pdsGenesisSchema = z
  .object({
    statement: canonicalPdsJson,
    proof: pdsProofSchema,
    first_device: z
      .object({
        device_id: opaqueId,
        signing_key_id: opaqueId,
        signing_public_key: base64url.length(43),
        kem_key_id: opaqueId,
        kem_public_key: base64url.length(43),
        operation_families: z.tuple([z.literal("pds_relay")])
      })
      .strict()
  })
  .strict();
export const pdsTransitionSchema = z
  .object({
    statement: canonicalPdsJson,
    key_bundle: canonicalPdsJson.optional(),
    proof: pdsProofSchema.optional()
  })
  .strict();
export const pdsGroupParamsSchema = z.object({ groupId: opaqueId }).strict();
export const pdsCertificateParamsSchema = z
  .object({ groupId: opaqueId, deviceId: opaqueId })
  .strict();
export const pdsKeyBundleParamsSchema = z
  .object({ groupId: opaqueId, epoch: z.string().regex(/^(0|[1-9][0-9]*)$/) })
  .strict();
export const pdsPolicySchema = z
  .object({
    enabled: z.boolean(),
    future_closed_sessions_only: z.literal(true),
    historical_backfill_enabled: z.literal(false)
  })
  .strict();
export const pdsEpochAckSchema = z.object({ ack: canonicalPdsJson }).strict();
export const pdsRemoteAccountLinkSchema = z
  .object({ proof_token: z.string().min(12).max(8_192) })
  .strict();
export const pdsCloseSessionParamsSchema = z
  .object({ groupId: opaqueId, sessionId: z.uuid() })
  .strict();
export const pdsPauseSchema = z.object({ paused: z.boolean() }).strict();
export const pdsLifecycleRecordSchema = z
  .object({ record: canonicalPdsJson, statement: canonicalPdsJson })
  .strict();
