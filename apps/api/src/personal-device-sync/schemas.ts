import { z } from "zod";

const opaqueId = z.string().regex(/^[\x21-\x7e]{1,240}$/);
const canonicalPdsJson = z.string().min(2).max(1_048_576);
const base64url = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(512);

export const pdsChallengeSchema = z
  .object({
    group_id: opaqueId.optional(),
    device_deployment_id: opaqueId
  })
  .strict();
export const pdsProofSchema = z
  .object({
    challenge_id: z.uuid(),
    challenge: base64url.length(43),
    device_id: opaqueId,
    device_deployment_id: opaqueId,
    signature: base64url.length(86),
    expires_at: z.string().datetime({ offset: true, precision: 3 })
  })
  .strict();
export const pdsGenesisSchema = z
  .object({ statement: canonicalPdsJson, proof: pdsProofSchema })
  .strict();
export const pdsKeyBundleFinalizeSchema = z
  .object({ key_bundle: canonicalPdsJson })
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
export const pdsRemoteAccountLinkSchema = z
  .object({ proof_token: z.string().min(12).max(8_192) })
  .strict();
