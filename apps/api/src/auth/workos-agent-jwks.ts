import {
  createRemoteJWKSet,
  customFetch,
  decodeProtectedHeader,
  errors,
  jwtVerify
} from "jose";
import { fetchBoundedJsonObject } from "@koed/shared";
import { z } from "zod";
import { DelegatedAuthenticationError } from "./remote-mcp-oauth.js";

const refreshCooldownMs = 30_000;
const keySetSchema = z.object({
  keys: z
    .array(
      z
        .object({
          kty: z.literal("RSA"),
          kid: z.string().min(1).max(256),
          n: z.string().min(1).max(2048),
          e: z.string().min(1).max(16),
          alg: z.literal("RS256").optional(),
          use: z.literal("sig").optional(),
          key_ops: z.array(z.literal("verify")).optional()
        })
        .passthrough()
    )
    .min(1)
    .max(32)
});

export const createWorkosAgentTokenVerifier = (options: {
  issuer: string;
  resourceUrl: string;
  requestFetch: typeof fetch;
}) => {
  let nextRefreshAt = 0;
  const unavailable = () =>
    new DelegatedAuthenticationError(
      503,
      Math.max(1000, nextRefreshAt - Date.now())
    );
  const keys = createRemoteJWKSet(new URL("/oauth2/jwks", options.issuer), {
    timeoutDuration: 5000,
    cooldownDuration: refreshCooldownMs,
    cacheMaxAge: 300_000,
    [customFetch]: async (url) => {
      if (Date.now() < nextRefreshAt) throw unavailable();
      // JOSE shares in-flight refreshes; this also bounds retries after failed fetches.
      nextRefreshAt = Date.now() + refreshCooldownMs;
      try {
        const { response, payload } = await fetchBoundedJsonObject(
          options.requestFetch,
          url,
          {
            method: "GET",
            redirect: "error",
            headers: { accept: "application/json" }
          },
          { timeoutMs: 5000, maxBytes: 32_768 }
        );
        if (response.status !== 200) throw unavailable();
        const jwks = keySetSchema.parse(payload);
        if (
          new Set(jwks.keys.map((key) => key.kid)).size !== jwks.keys.length ||
          jwks.keys.some((key) =>
            ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some(
              (field) => field in key
            )
          )
        )
          throw unavailable();
        return Response.json(jwks);
      } catch {
        throw unavailable();
      }
    }
  });
  return async (token: string) => {
    try {
      const header = decodeProtectedHeader(token);
      if (
        header.alg !== "RS256" ||
        typeof header.kid !== "string" ||
        !header.kid ||
        header.kid.length > 256 ||
        header.jku !== undefined ||
        header.jwk !== undefined ||
        header.x5u !== undefined
      )
        throw new DelegatedAuthenticationError(401);
      const verified = await jwtVerify(token, keys, {
        issuer: options.issuer,
        audience: options.resourceUrl,
        algorithms: ["RS256"],
        requiredClaims: ["iss", "aud", "sub", "exp"]
      });
      return verified.payload;
    } catch (error) {
      if (error instanceof DelegatedAuthenticationError) throw error;
      if (
        error instanceof errors.JWSSignatureVerificationFailed ||
        error instanceof errors.JWTClaimValidationFailed ||
        error instanceof errors.JWTExpired ||
        error instanceof errors.JWTInvalid ||
        error instanceof errors.JWSInvalid ||
        error instanceof errors.JWKSNoMatchingKey ||
        error instanceof errors.JOSEAlgNotAllowed ||
        error instanceof errors.JOSENotSupported
      )
        throw new DelegatedAuthenticationError(401);
      throw unavailable();
    }
  };
};
