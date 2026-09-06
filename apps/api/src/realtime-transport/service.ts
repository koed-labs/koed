import { randomBytes, randomUUID } from "node:crypto";
import type {
  RealtimeTransportAdmissionRecord,
  RealtimeTransportPrincipalState,
  RealtimeTransportTicketRepository
} from "@koed/db";
import {
  REALTIME_TRANSPORT_TICKET_TTL_SECONDS,
  REALTIME_TRANSPORT_TICKET_VERSION,
  type RealtimeTransportId,
  type RealtimeTransportOperationFamily,
  type RealtimeTransportTicketResponse
} from "@koed/shared";
import type { HashSecret } from "../auth/session.js";

export interface RealtimeTransportAdapterDescriptor {
  transport: RealtimeTransportId;
  protocolVersions: readonly number[];
  endpoint: string;
}

export type RealtimeTransportTicketPrincipal =
  | {
      authKind: "session";
      ownerUserId: string;
      userSessionId: string;
      origin: string;
    }
  | {
      authKind: "device_credential";
      ownerUserId: string;
      deviceCredentialId: string;
      deviceInstanceId: string;
      credentialOperationFamilies: readonly string[];
    };

export interface IssueRealtimeTransportTicketInput {
  transport: RealtimeTransportId;
  protocolVersion: number;
  clientInstanceId: string;
  clientKind: "browser" | "native";
  operationFamilies: RealtimeTransportOperationFamily[];
}

export interface ConsumeRealtimeTransportTicketInput {
  ticket: string;
  transport: RealtimeTransportId;
  protocolVersion: number;
  clientInstanceId: string;
  clientKind: "browser" | "native";
  origin: string | null;
  nativeDeviceInstanceId: string | null;
  connectionId: string;
}

export interface RealtimeTransportAdmissionService {
  adapters(): RealtimeTransportAdapterDescriptor[];
  registerAdapter(adapter: RealtimeTransportAdapterDescriptor): () => void;
  issueTicket(
    principal: RealtimeTransportTicketPrincipal,
    input: IssueRealtimeTransportTicketInput
  ): Promise<RealtimeTransportTicketResponse>;
  consumeTicket(
    input: ConsumeRealtimeTransportTicketInput
  ): Promise<RealtimeTransportAdmissionRecord>;
  reauthenticate(
    admission: RealtimeTransportAdmissionRecord
  ): Promise<RealtimeTransportPrincipalState>;
}

const unavailable = (message: string) =>
  Object.assign(new Error(message), {
    statusCode: 409,
    code: "realtime_transport_unavailable"
  });

const forbidden = (message: string) =>
  Object.assign(new Error(message), { statusCode: 403 });

const unauthorized = () =>
  Object.assign(new Error("Transport admission failed"), { statusCode: 401 });

const normalizeOrigin = (value: string): string => {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.origin === "null" ||
      parsed.origin !== value
    ) {
      throw new Error("invalid origin");
    }
    return parsed.origin;
  } catch {
    throw forbidden("A canonical browser origin is required");
  }
};

const ticketPattern =
  /^rtt1_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

const parseTicket = (ticket: string): { id: string; secret: string } => {
  const match = ticketPattern.exec(ticket);
  if (!match?.[1] || !match[2]) throw unauthorized();
  return { id: match[1], secret: match[2] };
};

export const createRealtimeTransportAdmissionService = (options: {
  repository: RealtimeTransportTicketRepository;
  hashSecret: HashSecret;
  backendIdentity: string;
  adapters: readonly RealtimeTransportAdapterDescriptor[];
  now?: () => Date;
}): RealtimeTransportAdmissionService => {
  const adapters = new Map(
    options.adapters.map((adapter) => [adapter.transport, adapter] as const)
  );
  if (adapters.size !== options.adapters.length) {
    throw new Error("Realtime transport adapter IDs must be unique");
  }
  const now = options.now ?? (() => new Date());
  let nextCleanupAt = 0;
  const digest = (kind: string, value: string): string =>
    options.hashSecret(`realtime-transport:${kind}:v1\n${value}`);

  return {
    adapters: () =>
      [...adapters.values()].map((adapter) => ({
        ...adapter,
        protocolVersions: [...adapter.protocolVersions]
      })),

    registerAdapter(adapter) {
      if (adapters.has(adapter.transport)) {
        throw new Error(
          `Realtime transport adapter ${adapter.transport} is already registered`
        );
      }
      adapters.set(adapter.transport, {
        ...adapter,
        protocolVersions: [...adapter.protocolVersions]
      });
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        if (adapters.get(adapter.transport)?.endpoint === adapter.endpoint) {
          adapters.delete(adapter.transport);
        }
      };
    },

    async issueTicket(principal, input) {
      const adapter = adapters.get(input.transport);
      if (
        !adapter ||
        !adapter.protocolVersions.includes(input.protocolVersion)
      ) {
        throw unavailable("Requested realtime transport is not available");
      }
      if (principal.authKind === "session" && input.clientKind !== "browser") {
        throw forbidden(
          "Browser sessions can only issue browser transport tickets"
        );
      }
      if (
        principal.authKind === "device_credential" &&
        input.clientKind !== "native"
      ) {
        throw forbidden(
          "Device credentials can only issue native transport tickets"
        );
      }
      if (
        principal.authKind === "device_credential" &&
        input.operationFamilies.some(
          (family) => !principal.credentialOperationFamilies.includes(family)
        )
      ) {
        throw forbidden(
          "Device credential is not allowed for a requested operation family"
        );
      }

      const issuedAt = now();
      if (issuedAt.getTime() >= nextCleanupAt) {
        await options.repository.deleteExpiredTickets(issuedAt);
        nextCleanupAt = issuedAt.getTime() + 60_000;
      }
      const expiresAt = new Date(
        issuedAt.getTime() + REALTIME_TRANSPORT_TICKET_TTL_SECONDS * 1_000
      );
      const id = randomUUID();
      const secret = randomBytes(32).toString("base64url");
      const originHash =
        principal.authKind === "session"
          ? digest("origin", normalizeOrigin(principal.origin))
          : null;
      const nativeBindingHash =
        principal.authKind === "device_credential"
          ? digest("native-device", principal.deviceInstanceId)
          : null;

      await options.repository.createTicket({
        id,
        secretHash: options.hashSecret(secret),
        ticketVersion: REALTIME_TRANSPORT_TICKET_VERSION,
        transport: input.transport,
        protocolVersion: input.protocolVersion,
        ownerUserId: principal.ownerUserId,
        authKind: principal.authKind,
        userSessionId:
          principal.authKind === "session" ? principal.userSessionId : null,
        deviceCredentialId:
          principal.authKind === "device_credential"
            ? principal.deviceCredentialId
            : null,
        backendIdentityHash: digest("backend", options.backendIdentity),
        clientInstanceHash: digest("client", input.clientInstanceId),
        clientKind: input.clientKind,
        originHash,
        nativeBindingHash,
        operationFamilies: input.operationFamilies,
        expiresAt
      });

      return {
        ticket: `rtt1_${id}.${secret}`,
        ticketVersion: REALTIME_TRANSPORT_TICKET_VERSION,
        transport: input.transport,
        protocolVersion: input.protocolVersion,
        clientInstanceId: input.clientInstanceId,
        operationFamilies: [...input.operationFamilies],
        expiresAt: expiresAt.toISOString()
      };
    },

    async consumeTicket(input) {
      const adapter = adapters.get(input.transport);
      if (
        !adapter ||
        !adapter.protocolVersions.includes(input.protocolVersion)
      ) {
        throw unauthorized();
      }
      const parsed = parseTicket(input.ticket);
      if (
        (input.clientKind === "browser" &&
          (!input.origin || input.nativeDeviceInstanceId !== null)) ||
        (input.clientKind === "native" &&
          (input.origin !== null || !input.nativeDeviceInstanceId))
      ) {
        throw unauthorized();
      }
      const admitted = await options.repository.consumeTicket({
        id: parsed.id,
        secretHash: options.hashSecret(parsed.secret),
        transport: input.transport,
        protocolVersion: input.protocolVersion,
        backendIdentityHash: digest("backend", options.backendIdentity),
        clientInstanceHash: digest("client", input.clientInstanceId),
        clientKind: input.clientKind,
        originHash: input.origin
          ? digest(
              "origin",
              (() => {
                try {
                  return normalizeOrigin(input.origin!);
                } catch {
                  throw unauthorized();
                }
              })()
            )
          : null,
        nativeBindingHash: input.nativeDeviceInstanceId
          ? digest("native-device", input.nativeDeviceInstanceId)
          : null,
        connectionIdHash: digest("connection", input.connectionId)
      });
      if (!admitted) throw unauthorized();
      return admitted;
    },

    async reauthenticate(admission) {
      const principal =
        await options.repository.resolveActivePrincipal(admission);
      if (!principal) throw unauthorized();
      const currentFamilies =
        principal.operationFamilies === null
          ? null
          : new Set(principal.operationFamilies);
      if (
        currentFamilies !== null &&
        admission.operationFamilies.some(
          (operationFamily) => !currentFamilies.has(operationFamily)
        )
      ) {
        throw unauthorized();
      }
      return {
        user: principal.user,
        operationFamilies: [...admission.operationFamilies]
      };
    }
  };
};
