import { timingSafeEqual } from "node:crypto";
import type { EmbeddingServiceEnv } from "./env-config.js";

export interface AuthStatus {
  authRequired: boolean;
  authValid: boolean;
}

export const embeddingTokenAuthStatus = (
  config: Pick<EmbeddingServiceEnv, "embeddingServiceToken">,
  token: string | null
): AuthStatus => {
  const expected = config.embeddingServiceToken;
  const authRequired = expected.length > 0;
  if (!authRequired) {
    return { authRequired: false, authValid: true };
  }
  if (!token) {
    return { authRequired: true, authValid: false };
  }
  const expectedBuffer = Buffer.from(expected);
  const tokenBuffer = Buffer.from(token);
  return {
    authRequired: true,
    authValid:
      expectedBuffer.length === tokenBuffer.length &&
      timingSafeEqual(expectedBuffer, tokenBuffer)
  };
};

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly detail: string,
    readonly code?: string
  ) {
    super(detail);
    this.name = "HttpError";
  }
}

export const requireInternalToken = (
  config: Pick<EmbeddingServiceEnv, "embeddingServiceToken">,
  token: string | null
): void => {
  const status = embeddingTokenAuthStatus(config, token);
  if (status.authRequired && !status.authValid) {
    throw new HttpError(401, "invalid embedding service token");
  }
};
