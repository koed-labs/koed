import { z } from "zod";
import { createHash } from "node:crypto";
import { sharedMemorySourceCapabilitiesSchema } from "./collaboration-contract.js";
import { sharedMemorySourceRefSchema } from "./shared-memory-source.js";
import { projectSharePolicyProofSchema } from "./project-share-policy-proof.js";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const authority = z
  .object({
    action: z.literal("workspace.memory.share_owned"),
    source: z.literal("device_action_grant"),
    referenceId: z.uuid()
  })
  .strict();
export const projectShareManifestEntrySchema = z
  .object({
    sessionId: z.uuid(),
    logicalMemoryId: z.uuid(),
    sourceRevision: z.number().int().positive(),
    mappingRevision: z.number().int().positive(),
    reviewLabel: z.string().trim().min(1).max(160)
  })
  .strict();
export const projectSharePolicyManifestHash = (
  entries: readonly z.infer<typeof projectShareManifestEntrySchema>[],
  signingPublicKey: string
): string => {
  const key = z.base64().min(40).max(128).parse(signingPublicKey);
  const normalized = entries
    .map((entry) => {
      const exact = projectShareManifestEntrySchema.parse(entry);
      return {
        ...exact,
        sessionId: exact.sessionId.toLowerCase(),
        logicalMemoryId: exact.logicalMemoryId.toLowerCase(),
        reviewLabel: exact.reviewLabel.trim()
      };
    })
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  if (
    new Set(normalized.map((row) => row.sessionId)).size !==
      normalized.length ||
    new Set(normalized.map((row) => row.logicalMemoryId)).size !==
      normalized.length
  )
    throw new TypeError("Duplicate Project policy manifest source");
  return createHash("sha256")
    .update(JSON.stringify({ entries: normalized, signingPublicKey: key }))
    .digest("hex");
};

/** Trusted owner-local edge to Team backend only. Never expose this schema as
 * a renderer operation: the renderer must not choose Captured Sessions. */
export const prepareProjectShareManifestSchema = z
  .object({
    expectedPolicyVersion: z.number().int().nonnegative(),
    personalProjectBindingHash: digest,
    signingPublicKey: z.base64().min(40).max(128),
    entries: z.array(projectShareManifestEntrySchema).max(100)
  })
  .strict();
export const projectShareManifestReceiptSchema = z
  .object({
    manifestId: z.uuid(),
    manifestHash: digest,
    expiresAt: z.iso.datetime({ offset: true }),
    projectId: z.uuid(),
    ownerTeamMemberId: z.uuid(),
    deviceCredentialId: z.uuid(),
    upstreamBackendId: z.string().min(1).max(160),
    expectedPolicyVersion: z.number().int().nonnegative(),
    personalProjectBindingHash: digest,
    signingPublicKey: z.base64().min(40).max(128),
    entries: z.array(projectShareManifestEntrySchema).max(100)
  })
  .strict();
export const projectSharePolicyEnableSchema = z
  .object({
    expectedPolicyVersion: z.number().int().nonnegative(),
    manifestId: z.uuid(),
    manifestHash: digest,
    signingPublicKey: z.base64().min(40).max(128),
    authority,
    // Recomputed by the trusted owner local edge at consumption. The Team
    // backend checks equality with the reviewed, stored manifest atomically.
    currentEntries: z.array(projectShareManifestEntrySchema).max(100)
  })
  .strict();
export const projectSharePolicyRevokeSchema = z
  .object({
    expectedPolicyVersion: z.number().int().positive(),
    authority
  })
  .strict();
export const projectSharePolicyExcludeSessionSchema = z
  .object({
    sessionId: z.uuid(),
    expectedPolicyVersion: z.number().int().nonnegative()
  })
  .strict();
export const projectSharePolicyReceiptReadSchema = z
  .object({
    action: z.enum(["enable", "revoke"]),
    clientRequestId: z.uuid(),
    actionGrantId: z.uuid(),
    teamId: z.uuid(),
    expectedPolicyVersion: z.number().int().nonnegative(),
    manifestId: z.uuid().optional(),
    manifestHash: digest.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "enable" && (!value.manifestId || !value.manifestHash))
      context.addIssue({
        code: "custom",
        message: "Exact approved manifest required"
      });
    if (value.action === "revoke" && (value.manifestId || value.manifestHash))
      context.addIssue({
        code: "custom",
        message: "Revoke cannot adopt a manifest"
      });
  });
export const projectSharePolicyInitialBundleSchema = z
  .object({
    expectedPolicyVersion: z.number().int().positive(),
    personalProjectBindingHash: digest,
    sessionId: z.uuid(),
    mappingRevision: z.number().int().positive(),
    candidate: z
      .object({
        logicalMemoryId: z.uuid(),
        source: sharedMemorySourceRefSchema,
        sourceDeploymentProtocolId: z.uuid(),
        sourceOwnerPrincipalId: z.uuid(),
        deviceCredentialId: z.uuid(),
        sourceCapabilities: sharedMemorySourceCapabilitiesSchema,
        activationRepresentation: z.literal("lcm_leaves"),
        candidateHash: digest,
        sourceRevision: z.number().int().positive(),
        itemCount: z.number().int().positive().max(100),
        excludedItemCount: z.number().int().nonnegative(),
        manifest: z
          .array(
            z.object({ sourceId: z.uuid(), revisionHash: digest }).strict()
          )
          .min(1)
          .max(100),
        byteCount: z
          .number()
          .int()
          .positive()
          .max(256 * 1024)
      })
      .strict()
  })
  .strict();
export const projectSharePolicyFutureBundleSchema =
  projectSharePolicyInitialBundleSchema.extend({
    proof: projectSharePolicyProofSchema
  });
export const projectSharePolicyReviewSchema = z
  .object({
    policyId: z.uuid().nullable(),
    ownerTeamMemberId: z.uuid(),
    projectId: z.uuid(),
    teamId: z.uuid(),
    workspaceId: z.uuid(),
    projectName: z.string(),
    policyVersion: z.number().int().nonnegative(),
    status: z.enum(["absent", "active", "revoked"]),
    manifestId: z.uuid().nullable(),
    manifestHash: digest.nullable(),
    signingPublicKey: z.base64().min(40).max(128).nullable(),
    personalProjectBindingHash: digest.nullable(),
    deviceCredentialId: z.uuid().nullable(),
    eligibleCount: z.number().int().nonnegative().max(100),
    reviewSources: z
      .array(
        z
          .object({
            sessionId: z.uuid(),
            reviewLabel: z.string(),
            eligible: z.boolean()
          })
          .strict()
      )
      .max(100)
  })
  .strict();
export type ProjectShareManifestEntry = z.infer<
  typeof projectShareManifestEntrySchema
>;
