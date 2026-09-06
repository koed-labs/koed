import type { FastifyInstance, FastifyRequest } from "fastify";
import { realtimeTransportTicketRequestSchema } from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";
import type {
  RealtimeTransportAdmissionService,
  RealtimeTransportTicketPrincipal
} from "./service.js";

const BODY_LIMIT_BYTES = 8 * 1024;

const authScheme = (request: FastifyRequest): string => {
  const header = request.headers.authorization?.trim();
  const separator = header?.indexOf(" ") ?? -1;
  return header && separator > 0
    ? header.slice(0, separator).toLowerCase()
    : "";
};

const singleOrigin = (request: FastifyRequest): string => {
  const value = request.headers.origin;
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error("Browser origin is required"), {
      statusCode: 403
    });
  }
  return value.trim();
};

const authenticateTicketPrincipal = async (
  request: FastifyRequest,
  auth: ApiRouteContext["auth"]
): Promise<RealtimeTransportTicketPrincipal> => {
  const scheme = authScheme(request);
  if (scheme === "bearer") {
    throw Object.assign(
      new Error("API Tokens cannot issue realtime transport tickets"),
      { statusCode: 403 }
    );
  }
  if (scheme === "koed-device") {
    const context = await auth.authenticateDeviceCredential(request);
    return {
      authKind: "device_credential",
      ownerUserId: context.user.id,
      deviceCredentialId: context.credential.id,
      deviceInstanceId: context.credential.deviceInstanceId,
      credentialOperationFamilies: context.credential.operationFamilies
    };
  }
  const context = await auth.authenticateSessionContext(request);
  return {
    authKind: "session",
    ownerUserId: context.user.id,
    userSessionId: context.sessionId,
    origin: singleOrigin(request)
  };
};

export const registerRealtimeTransportRoutes = (
  app: FastifyInstance,
  context: {
    auth: ApiRouteContext["auth"];
    writeRateLimit: ApiRouteContext["rateLimit"]["memoryWrite"];
    admissionService: RealtimeTransportAdmissionService | null;
  }
): void => {
  app.post(
    "/v1/realtime/transport-tickets",
    { preHandler: context.writeRateLimit, bodyLimit: BODY_LIMIT_BYTES },
    async (request, reply) => {
      const principal = await authenticateTicketPrincipal(
        request,
        context.auth
      );
      if (!context.admissionService) {
        throw Object.assign(new Error("Realtime transport is not available"), {
          statusCode: 503
        });
      }
      const input = realtimeTransportTicketRequestSchema.parse(request.body);
      const ticket = await context.admissionService.issueTicket(
        principal,
        input
      );
      reply.header("cache-control", "no-store");
      return reply.status(201).send(ticket);
    }
  );
};
