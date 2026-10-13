/* global URL, Buffer, fetch, AbortSignal */
import { createHash, createPublicKey, verify } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { componentManifestSigningBytes } from "../../scripts/component-signature-format.mjs";
import {
  canonicalComponentManifestBytes,
  validateComponentManifest
} from "../../packages/koed-server/dist/component-verification.js";

const issuer = "https://token.actions.githubusercontent.com";
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`), {
  timeoutDuration: 5000
});
export const authorizeClaims = (claims, config) => {
  const workflows = new Map([
    ["koed-labs/koed/.github/workflows/release.yml@refs/heads/main", "push"],
    [
      "koed-labs/koed/.github/workflows/release-desktop-assets.yml@refs/heads/main",
      "workflow_dispatch"
    ]
  ]);
  const identityMatches =
    claims.repository_id === config.repositoryId &&
    claims.repository_owner_id === config.ownerId &&
    claims.repository === "koed-labs/koed";
  const releaseMatches =
    claims.ref === "refs/heads/main" &&
    workflows.get(claims.workflow_ref) === claims.event_name;
  const rehearsalMatches =
    Boolean(config.rehearsalSha) &&
    claims.sha === config.rehearsalSha &&
    claims.ref === "refs/heads/codex/headless-distribution-fixes" &&
    claims.workflow_ref ===
      "koed-labs/koed/.github/workflows/ci.yml@refs/heads/codex/headless-distribution-fixes" &&
    claims.event_name === "workflow_dispatch";
  if (!identityMatches || (!releaseMatches && !rehearsalMatches))
    throw new Error("Workflow is not authorized");
};
export const authenticate = async (authorization, config, keys = jwks) => {
  if (
    typeof authorization !== "string" ||
    !/^Bearer [A-Za-z0-9_.-]+$/.test(authorization) ||
    authorization.length > 16384
  )
    throw new Error("GitHub OIDC token required");
  const { payload } = await jwtVerify(authorization.slice(7), keys, {
    issuer,
    audience: "koed-component-signer",
    algorithms: ["RS256"],
    requiredClaims: [
      "exp",
      "iat",
      "nbf",
      "repository_id",
      "repository_owner_id",
      "workflow_ref",
      "ref",
      "event_name"
    ],
    maxTokenAge: "10 minutes",
    clockTolerance: 5
  });
  authorizeClaims(payload, config);
  return payload;
};
export const crc32c = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
export const signingMessage = (body, config) => {
  if (!body || typeof body !== "object" || body.keyId !== config.keyId)
    throw new Error("Unknown signing key");
  validateComponentManifest(body.manifest);
  return componentManifestSigningBytes(
    canonicalComponentManifestBytes(body.manifest)
  );
};
export const verifyEnvelope = (signature, message, config, publicKey) => {
  if (
    !signature ||
    Object.keys(signature).sort().join() !==
      "algorithm,keyId,schemaVersion,signature" ||
    signature.schemaVersion !== 2 ||
    signature.keyId !== config.keyId ||
    signature.algorithm !== "ed25519" ||
    typeof signature.signature !== "string"
  )
    return false;
  const raw = Buffer.from(signature.signature, "base64");
  return (
    raw.length === 64 &&
    raw.toString("base64") === signature.signature &&
    verify(null, message, publicKey, raw)
  );
};
export const createKmsClient = (config, request = fetch) => {
  let cachedToken;
  let tokenExpiry = 0;
  let cachedPublicKey;
  const token = async () => {
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
    const response = await request(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      {
        headers: { "Metadata-Flavor": "Google" },
        signal: AbortSignal.timeout(5000)
      }
    );
    if (!response.ok || response.headers.get("Metadata-Flavor") !== "Google")
      throw new Error("Service identity unavailable");
    const result = await response.json();
    if (
      typeof result.access_token !== "string" ||
      typeof result.expires_in !== "number"
    )
      throw new Error("Invalid service identity response");
    cachedToken = result.access_token;
    tokenExpiry = Date.now() + Math.max(0, result.expires_in - 60) * 1000;
    return cachedToken;
  };
  const call = async (suffix, body) => {
    const response = await request(
      `https://cloudkms.googleapis.com/v1/${config.keyVersion}${suffix}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${await token()}`,
          "content-type": "application/json"
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000)
      }
    );
    if (!response.ok)
      throw new Error(`KMS request failed (${response.status})`);
    return response.json();
  };
  const publicKey = async () => {
    if (cachedPublicKey) return cachedPublicKey;
    const result = await call("/publicKey");
    if (
      result.name !== config.keyVersion ||
      result.algorithm !== "EC_SIGN_ED25519" ||
      typeof result.pem !== "string" ||
      Number(result.pemCrc32c) !== crc32c(Buffer.from(result.pem))
    )
      throw new Error("KMS public key integrity mismatch");
    cachedPublicKey = createPublicKey(result.pem);
    return cachedPublicKey;
  };
  return {
    publicKey,
    sign: async (message) => {
      const result = await call(":asymmetricSign", {
        data: message.toString("base64"),
        dataCrc32c: String(crc32c(message))
      });
      const raw = Buffer.from(result.signature ?? "", "base64");
      if (
        result.name !== config.keyVersion ||
        result.verifiedDataCrc32c !== true ||
        raw.length !== 64 ||
        Number(result.signatureCrc32c) !== crc32c(raw) ||
        !verify(null, message, await publicKey(), raw)
      )
        throw new Error("KMS signature integrity mismatch");
      return {
        schemaVersion: 2,
        keyId: config.keyId,
        algorithm: "ed25519",
        signature: raw.toString("base64")
      };
    }
  };
};
export const manifestDigest = (manifest) =>
  createHash("sha256")
    .update(canonicalComponentManifestBytes(manifest))
    .digest("hex");
