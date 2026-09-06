import { z } from "zod";
import { COLLABORATION_REALTIME_CURSOR_MAX_BYTES } from "./collaboration-contract.js";

export const REALTIME_TRANSPORT_TICKET_VERSION = 1 as const;
export const REALTIME_TRANSPORT_TICKET_TTL_SECONDS = 30 as const;
export const REALTIME_TRANSPORT_CLIENT_INSTANCE_ID_MAX_LENGTH = 160 as const;

export const realtimeTransportClientInstanceIdSchema = z
  .string()
  .trim()
  .min(16)
  .max(REALTIME_TRANSPORT_CLIENT_INSTANCE_ID_MAX_LENGTH)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const realtimeTransportIdSchema = z.enum(["webtransport", "websocket"]);
export type RealtimeTransportId = z.infer<typeof realtimeTransportIdSchema>;

export const realtimeTransportOperationFamilySchema = z.enum([
  "personal_collaboration_read",
  "team_chat_read",
  "team_workspace_read",
  "managed_execution",
  "managed_terminal",
  "sync"
]);
export type RealtimeTransportOperationFamily = z.infer<
  typeof realtimeTransportOperationFamilySchema
>;

export const realtimeTransportTicketRequestSchema = z
  .object({
    transport: realtimeTransportIdSchema,
    protocolVersion: z.number().int().positive(),
    clientInstanceId: realtimeTransportClientInstanceIdSchema,
    clientKind: z.enum(["browser", "native"]),
    operationFamilies: z
      .array(realtimeTransportOperationFamilySchema)
      .min(1)
      .max(realtimeTransportOperationFamilySchema.options.length)
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.operationFamilies).size !== value.operationFamilies.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["operationFamilies"],
        message: "Operation families must be unique"
      });
    }
  });

export type RealtimeTransportTicketRequest = z.infer<
  typeof realtimeTransportTicketRequestSchema
>;

const realtimeTransportTicketSchema = z
  .string()
  .regex(
    /^rtt1_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/
  );

const realtimeTransportCursorSchema = z
  .string()
  .min(16)
  .max(COLLABORATION_REALTIME_CURSOR_MAX_BYTES)
  .regex(/^crt1\.[A-Za-z0-9_-]+$/);

export const webTransportSessionAdmissionSchema = z
  .object({
    frameVersion: z.literal(1),
    type: z.literal("session.admit"),
    ticket: realtimeTransportTicketSchema,
    connectionId: z.uuid(),
    clientInstanceId: realtimeTransportClientInstanceIdSchema,
    clientKind: z.enum(["browser", "native"]),
    nativeDeviceInstanceId: z.string().trim().min(16).max(160).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.clientKind === "browser" &&
        value.nativeDeviceInstanceId !== null) ||
      (value.clientKind === "native" && value.nativeDeviceInstanceId === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["nativeDeviceInstanceId"],
        message: "Native device binding does not match client kind"
      });
    }
  });

const webTransportDurableAttachCommonSchema = z
  .object({
    frameVersion: z.literal(1),
    type: z.literal("durable_events.attach"),
    subscriptionKey: realtimeTransportClientInstanceIdSchema,
    cursor: realtimeTransportCursorSchema
  })
  .strict();

export const webTransportDurableAttachSchema = z.discriminatedUnion("scope", [
  webTransportDurableAttachCommonSchema.extend({
    scope: z.literal("personal")
  }),
  webTransportDurableAttachCommonSchema.extend({
    scope: z.literal("team"),
    teamId: z.uuid()
  })
]);

export type WebTransportDurableAttach = z.infer<
  typeof webTransportDurableAttachSchema
>;

export const webTransportInteractiveAttachSchema = z.discriminatedUnion(
  "channel",
  [
    z
      .object({
        frameVersion: z.literal(1),
        type: z.literal("interactive.attach"),
        channel: z.literal("managed_execution"),
        operationFamily: z.literal("managed_execution"),
        resourceId: z.uuid()
      })
      .strict(),
    z
      .object({
        frameVersion: z.literal(1),
        type: z.literal("interactive.attach"),
        channel: z.literal("managed_terminal"),
        operationFamily: z.literal("managed_terminal"),
        resourceId: z.uuid(),
        executionId: z.uuid(),
        lifecycleGeneration: z.number().int().safe().positive(),
        afterOutputSequence: z.number().int().safe().nonnegative()
      })
      .strict()
  ]
);

export const webTransportStreamAttachSchema = z.union([
  webTransportDurableAttachSchema,
  webTransportInteractiveAttachSchema
]);

export const webTransportDisposableDatagramSchema = z
  .object({
    frameVersion: z.literal(1),
    type: z.literal("disposable_hint"),
    channel: z.enum(["typing", "pointer", "progress"]),
    sequence: z.number().int().nonnegative(),
    resourceId: z.uuid(),
    payload: z.string().max(512)
  })
  .strict();

export type WebTransportSessionAdmission = z.infer<
  typeof webTransportSessionAdmissionSchema
>;
export type WebTransportInteractiveAttach = z.infer<
  typeof webTransportInteractiveAttachSchema
>;
export type WebTransportStreamAttach = z.infer<
  typeof webTransportStreamAttachSchema
>;
export type WebTransportDisposableDatagram = z.infer<
  typeof webTransportDisposableDatagramSchema
>;

export interface RealtimeTransportTicketResponse {
  ticket: string;
  ticketVersion: typeof REALTIME_TRANSPORT_TICKET_VERSION;
  transport: RealtimeTransportId;
  protocolVersion: number;
  clientInstanceId: string;
  operationFamilies: RealtimeTransportOperationFamily[];
  expiresAt: string;
}

export interface RealtimeTransportOffer {
  id: "sse" | RealtimeTransportId;
  availability: "available" | "unavailable";
  protocolVersions: number[];
  endpoint: string | null;
  authentication: "session_or_device_credential" | "single_use_ticket";
  reliability: "reliable_ordered";
  direction: "server_to_client" | "bidirectional";
}
