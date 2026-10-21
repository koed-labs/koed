import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify
} from "node:crypto";
import { z } from "zod";
import { canonicalJsonStringify } from "./canonical-json.js";

const signatureDomain = "koed/project-share-policy/future-proof/v1\n";
const publicKeyHashDomain = "koed/project-share-policy/public-key/v1\n";
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const name = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim(), "Expected a canonical backend ID");
const timestamp = z.string().refine((value) => {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}, "Expected a canonical UTC millisecond timestamp");
const canonicalBase64 = (value: string): Buffer => {
  if (
    value.length > 256 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  )
    throw new TypeError(
      "Project policy proof key or signature is not canonical base64"
    );
  const decoded = Buffer.from(value, "base64");
  if (!decoded.length || decoded.toString("base64") !== value)
    throw new TypeError(
      "Project policy proof key or signature is not canonical base64"
    );
  return decoded;
};

/** The signed future-summary claim is distinct from device/PDS proofs. The
 * local edge separately enforces one-use nonces and current source authority. */
export const projectSharePolicyProofPayloadSchema = z
  .object({
    protocol: z.literal("koed_project_share_policy_future_proof"),
    version: z.literal(1),
    type: z.literal("future_summary"),
    policyId: z.uuid(),
    policyVersion: z.number().int().positive(),
    backendId: name,
    workspaceProjectId: z.uuid(),
    personalOwnerUserId: z.uuid(),
    ownerUserId: z.uuid(),
    ownerTeamMemberId: z.uuid(),
    deviceCredentialId: z.uuid(),
    personalProjectBindingHash: digest,
    sessionId: z.uuid(),
    logicalMemoryId: z.uuid(),
    sourceRevision: z.number().int().positive(),
    mappingRevision: z.number().int().positive(),
    capturePolicyVersion: z.number().int().positive(),
    captureWorkspaceProjectId: z.uuid(),
    captureContextVersion: z.number().int().positive(),
    captureAt: timestamp,
    issuedAt: timestamp,
    expiresAt: timestamp,
    nonce: z.uuid(),
    candidateHash: digest,
    closureHash: digest
  })
  .strict()
  .superRefine((claim, context) => {
    const capture = Date.parse(claim.captureAt);
    const issued = Date.parse(claim.issuedAt);
    const expires = Date.parse(claim.expiresAt);
    if (
      claim.capturePolicyVersion !== claim.policyVersion ||
      claim.captureWorkspaceProjectId !== claim.workspaceProjectId ||
      capture > issued ||
      issued >= expires ||
      expires - issued > 5 * 60_000
    )
      context.addIssue({
        code: "custom",
        message: "Invalid Project policy capture or validity window"
      });
  });
export type ProjectSharePolicyProofPayload = z.infer<
  typeof projectSharePolicyProofPayloadSchema
>;
export const projectSharePolicyProofSchema = z
  .object({
    payload: projectSharePolicyProofPayloadSchema,
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/)
  })
  .strict();
export type ProjectSharePolicyProof = z.infer<
  typeof projectSharePolicyProofSchema
>;

const signingBytes = (payload: ProjectSharePolicyProofPayload): Buffer =>
  Buffer.from(`${signatureDomain}${canonicalJsonStringify(payload)}`, "utf8");

/** Raw PKCS8/SPKI DER is returned only to a trusted owner-local caller.
 * The caller must seal the private bytes before persisting them. */
export const generateProjectSharePolicyKeyPair = (): {
  publicKeyDerBase64: string;
  privateKeyDerBase64: string;
} => {
  const keys = generateKeyPairSync("ed25519");
  return {
    publicKeyDerBase64: keys.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64"),
    privateKeyDerBase64: keys.privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64")
  };
};

export const projectSharePolicyPublicKeyHash = (
  publicKeyDerBase64: string
): string => {
  const der = canonicalBase64(publicKeyDerBase64);
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  if (
    key.asymmetricKeyType !== "ed25519" ||
    key.export({ type: "spki", format: "der" }).toString("base64") !==
      publicKeyDerBase64
  )
    throw new TypeError("Project policy proof public key is invalid");
  return createHash("sha256")
    .update(publicKeyHashDomain, "utf8")
    .update(der)
    .digest("hex");
};

export const signProjectSharePolicyProof = (
  payload: ProjectSharePolicyProofPayload,
  privateKeyDerBase64: string
): ProjectSharePolicyProof => {
  const claim = projectSharePolicyProofPayloadSchema.parse(payload);
  const der = canonicalBase64(privateKeyDerBase64);
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  if (
    key.asymmetricKeyType !== "ed25519" ||
    key.export({ type: "pkcs8", format: "der" }).toString("base64") !==
      privateKeyDerBase64
  )
    throw new TypeError("Project policy proof private key is invalid");
  return {
    payload: claim,
    signature: sign(null, signingBytes(claim), key).toString("base64")
  };
};

/** Returns false for malformed, expired, future-issued, or altered proofs.
 * Replay and current Project/source authorization remain server-side checks. */
export const verifyProjectSharePolicyProof = (
  proof: unknown,
  publicKeyDerBase64: string,
  now: Date = new Date()
): boolean => {
  try {
    const parsed = projectSharePolicyProofSchema.parse(proof);
    const time = now.valueOf();
    if (
      !Number.isFinite(time) ||
      time < Date.parse(parsed.payload.issuedAt) ||
      time >= Date.parse(parsed.payload.expiresAt)
    )
      return false;
    const signature = canonicalBase64(parsed.signature);
    if (signature.length !== 64) return false;
    const der = canonicalBase64(publicKeyDerBase64);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (
      key.asymmetricKeyType !== "ed25519" ||
      key.export({ type: "spki", format: "der" }).toString("base64") !==
        publicKeyDerBase64
    )
      return false;
    return verify(null, signingBytes(parsed.payload), key, signature);
  } catch {
    return false;
  }
};
