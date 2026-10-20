import { z } from "zod";
import { crossIdentitySyncDigest } from "./cross-identity-sync.js";

const itemSchema = z
  .object({
    shareGrantId: z.uuid(),
    pseudonymousSourceId: z.uuid()
  })
  .strict();

export const curatedWithdrawalBodySchema = z
  .object({
    source: z
      .object({
        kind: z.literal("captured_session"),
        sessionId: z.uuid(),
        logicalMemoryId: z.uuid()
      })
      .strict(),
    sourceDeploymentProtocolId: z.uuid(),
    sourceOwnerPrincipalId: z.uuid(),
    mutationId: z.uuid(),
    assertionId: z.uuid(),
    manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
    classificationVersion: z.number().int().safe().positive(),
    items: z.array(itemSchema).max(1000)
  })
  .strict();

export const curatedWithdrawalReceiptSchema = z
  .object({
    mutationId: z.uuid(),
    manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
    appliedVersion: z.number().int().safe().positive()
  })
  .strict();

export type CuratedWithdrawalBody = z.infer<typeof curatedWithdrawalBodySchema>;

export const curatedWithdrawalManifestHash = (
  input: Omit<CuratedWithdrawalBody, "manifestHash">
): string =>
  crossIdentitySyncDigest({
    protocol: "koed.curated-withdrawal/v1",
    mutationId: input.mutationId,
    assertionId: input.assertionId,
    source: input.source,
    sourceDeploymentProtocolId: input.sourceDeploymentProtocolId,
    sourceOwnerPrincipalId: input.sourceOwnerPrincipalId,
    classificationVersion: input.classificationVersion,
    items: [...input.items].sort(
      (a, b) =>
        a.shareGrantId.localeCompare(b.shareGrantId) ||
        a.pseudonymousSourceId.localeCompare(b.pseudonymousSourceId)
    )
  });
