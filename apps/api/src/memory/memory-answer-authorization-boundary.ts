import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SharedMemorySemanticAuthorizationBoundary } from "@koed/db";
import { z } from "zod";

export const MEMORY_ANSWER_AUTHORIZATION_BOUNDARY_MAX_GRANTS = 128;
const MEMORY_ANSWER_AUTHORIZATION_BOUNDARY_TTL_MS = 15 * 60 * 1000;
const processLocalBoundarySecret = randomBytes(32).toString("base64url");

/** Hosted profiles supply API_TOKEN_PEPPER; local/test runs fail closed on restart. */
export const memoryAnswerAuthorizationBoundarySecret = (
  apiTokenPepper: string
): string => apiTokenPepper || processLocalBoundarySecret;

const payloadSchema = z
  .object({
    version: z.literal(1),
    subjectUserId: z.string().uuid(),
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    boundary: z.object({
      teamId: z.string().uuid(),
      teamVersion: z.number().int().positive(),
      teamWorkspaceId: z.string().uuid(),
      workspaceVersion: z.number().int().positive(),
      membershipVersion: z.number().int().positive(),
      workspaceAccessVersion: z.number().int().positive(),
      userRowVersion: z.string().regex(/^\d+$/),
      shareGrantIds: z
        .array(z.string().uuid())
        .max(MEMORY_ANSWER_AUTHORIZATION_BOUNDARY_MAX_GRANTS)
    })
  })
  .strict();

export class MemoryAnswerAuthorizationBoundaryError extends Error {
  statusCode = 403;
  constructor(message = "Memory Answer authorization boundary is invalid") {
    super(message);
    this.name = "MemoryAnswerAuthorizationBoundaryError";
  }
}

const signature = (encodedPayload: string, secret: string): Buffer =>
  createHmac("sha256", secret)
    .update(`koed-memory-answer-authorization-boundary-v1\n${encodedPayload}`)
    .digest();

export const issueMemoryAnswerAuthorizationBoundary = (input: {
  secret: string;
  subjectUserId: string;
  boundary: SharedMemorySemanticAuthorizationBoundary;
  now?: Date;
}): string => {
  if (!input.secret) {
    throw new MemoryAnswerAuthorizationBoundaryError(
      "Memory Answer authorization boundary signing is unavailable"
    );
  }
  const now = input.now ?? new Date();
  const payload = payloadSchema.parse({
    version: 1,
    subjectUserId: input.subjectUserId,
    issuedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + MEMORY_ANSWER_AUTHORIZATION_BOUNDARY_TTL_MS
    ).toISOString(),
    boundary: input.boundary
  });
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url"
  );
  return `${encodedPayload}.${signature(encodedPayload, input.secret).toString("base64url")}`;
};

export const verifyMemoryAnswerAuthorizationBoundary = (input: {
  token: string;
  secret: string;
  subjectUserId: string;
  teamWorkspaceId: string;
  now?: Date;
}): SharedMemorySemanticAuthorizationBoundary => {
  if (!input.secret || input.token.length > 32_768) {
    throw new MemoryAnswerAuthorizationBoundaryError();
  }
  const [encodedPayload, encodedSignature, ...extra] = input.token.split(".");
  if (!encodedPayload || !encodedSignature || extra.length > 0) {
    throw new MemoryAnswerAuthorizationBoundaryError();
  }
  let receivedSignature: Buffer;
  try {
    receivedSignature = Buffer.from(encodedSignature, "base64url");
  } catch {
    throw new MemoryAnswerAuthorizationBoundaryError();
  }
  if (receivedSignature.toString("base64url") !== encodedSignature) {
    throw new MemoryAnswerAuthorizationBoundaryError();
  }
  const expectedSignature = signature(encodedPayload, input.secret);
  if (
    receivedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(receivedSignature, expectedSignature)
  ) {
    throw new MemoryAnswerAuthorizationBoundaryError();
  }
  let payload: z.infer<typeof payloadSchema>;
  try {
    const payloadBytes = Buffer.from(encodedPayload, "base64url");
    if (payloadBytes.toString("base64url") !== encodedPayload) {
      throw new MemoryAnswerAuthorizationBoundaryError();
    }
    payload = payloadSchema.parse(JSON.parse(payloadBytes.toString("utf8")));
  } catch {
    throw new MemoryAnswerAuthorizationBoundaryError();
  }
  const now = input.now ?? new Date();
  if (
    payload.subjectUserId !== input.subjectUserId ||
    payload.boundary.teamWorkspaceId !== input.teamWorkspaceId ||
    Date.parse(payload.issuedAt) > now.getTime() ||
    Date.parse(payload.expiresAt) <= now.getTime()
  ) {
    throw new MemoryAnswerAuthorizationBoundaryError();
  }
  return payload.boundary;
};
