import { timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  floatingKinActivitySchema,
  floatingKinEvidenceRequestSchema,
  floatingKinEvidenceSchema,
  isLoopbackHostname
} from "@koed-labs/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ApiRouteContext } from "../server/context.js";

const runtimeBearer = /^Bearer [A-Za-z0-9_-]{43}$/;
const isLoopbackHost = (host: string) =>
  host === "::1" || isLoopbackHostname(host);
const isLoopbackAddress = (address: string | undefined) =>
  address === "::1" ||
  address === "127.0.0.1" ||
  address === "::ffff:127.0.0.1";

const isLocalRuntimeRequest = async (
  request: FastifyRequest,
  context: ApiRouteContext
) => {
  const supplied = request.headers["x-koed-local-runtime-authorization"];
  if (
    context.config.deploymentProfile !== "local_personal" ||
    !isLoopbackAddress(request.raw.socket.remoteAddress) ||
    !isLoopbackHost(request.hostname) ||
    typeof supplied !== "string" ||
    !runtimeBearer.test(supplied)
  )
    return false;

  try {
    const file = await open(
      join(context.config.koedHome, "run", "local-ai-runtime.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.size > 4096 ||
        (stat.mode & 0o077) !== 0 ||
        typeof process.getuid !== "function" ||
        stat.uid !== process.getuid()
      )
        return false;
      const buffer = Buffer.alloc(4097);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 4096) return false;
      const value: unknown = JSON.parse(buffer.toString("utf8", 0, bytesRead));
      if (
        !value ||
        typeof value !== "object" ||
        !("protocolVersion" in value) ||
        value.protocolVersion !== 1 ||
        !("pid" in value) ||
        typeof value.pid !== "number" ||
        !Number.isSafeInteger(value.pid) ||
        value.pid < 1 ||
        !("authorization" in value) ||
        typeof value.authorization !== "string" ||
        !runtimeBearer.test(value.authorization) ||
        !("url" in value) ||
        typeof value.url !== "string"
      )
        return false;
      const url = new URL(value.url);
      if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname))
        return false;
      process.kill(value.pid, 0);
      return timingSafeEqual(
        Buffer.from(supplied),
        Buffer.from(value.authorization)
      );
    } finally {
      await file.close();
    }
  } catch {
    return false;
  }
};

export const registerFloatingKinRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const options = { preHandler: context.rateLimit.memoryRead };
  app.get(
    "/v1/memory/floating-kin/activity",
    options,
    async (request, reply) => {
      const user = await context.auth.authenticateApiToken(request);
      if (
        context.auth.authenticatedCredentialKind(request) !== "api_token" ||
        !(await isLocalRuntimeRequest(request, context))
      )
        return reply
          .code(403)
          .send({ error: "Local AI Runtime and Personal API Token required" });
      reply.header("cache-control", "no-store");
      return floatingKinActivitySchema.parse(
        await context
          .requireRepository()
          .getFloatingKinActivity({ userId: user.id })
      );
    }
  );
  app.post(
    "/v1/memory/floating-kin/evidence",
    options,
    async (request, reply) => {
      const user = await context.auth.authenticateApiToken(request);
      if (
        context.auth.authenticatedCredentialKind(request) !== "api_token" ||
        !(await isLocalRuntimeRequest(request, context))
      )
        return reply
          .code(403)
          .send({ error: "Local AI Runtime and Personal API Token required" });
      const input = floatingKinEvidenceRequestSchema.parse(request.body);
      reply.header("cache-control", "no-store");
      return floatingKinEvidenceSchema.parse(
        await context
          .requireRepository()
          .getFloatingKinEvidence({ userId: user.id }, input)
      );
    }
  );
};
