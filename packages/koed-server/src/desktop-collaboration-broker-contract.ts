import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationCommandResultSchema,
  collaborationRemoteBackendUrlSchema,
  collaborationRendererCommandSchema,
  collaborationRendererEventSchema
} from "@koed/shared";

export const DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION = 1;
export const DESKTOP_COLLABORATION_BROKER_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
export const DESKTOP_COLLABORATION_BROKER_HANDSHAKE_TIMEOUT_MS = 10_000;
export const DESKTOP_COLLABORATION_BROKER_COMMAND_TIMEOUT_MS = 30_000;
export const DESKTOP_COLLABORATION_BROKER_SHUTDOWN_TIMEOUT_MS = 5_000;

const ownerIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/);

const sessionTokenSchema = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

const browserUrlSchema = collaborationRemoteBackendUrlSchema.or(
  z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .superRefine((value: string, context) => {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        context.addIssue({ code: "custom", message: "Browser URL is invalid" });
        return;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        context.addIssue({
          code: "custom",
          message: "Browser URL must use HTTP or HTTPS"
        });
      }
      if (!parsed.hostname || parsed.username || parsed.password) {
        context.addIssue({
          code: "custom",
          message: "Browser URL must be credential-free"
        });
      }
      if (parsed.search || parsed.hash) {
        context.addIssue({
          code: "custom",
          message: "Browser URL must not include a query string or fragment"
        });
      }
    })
);

const baseEnvelopeSchema = z.object({
  protocolVersion: z.literal(DESKTOP_COLLABORATION_BROKER_PROTOCOL_VERSION),
  contractVersion: z.literal(COLLABORATION_CONTRACT_VERSION),
  sessionToken: sessionTokenSchema
});

export const desktopCollaborationBrokerParentMessageSchema =
  z.discriminatedUnion("type", [
    baseEnvelopeSchema.extend({
      type: z.literal("command"),
      envelopeId: z.uuid(),
      ownerId: ownerIdSchema,
      command: collaborationRendererCommandSchema
    }),
    baseEnvelopeSchema.extend({
      type: z.literal("release_owner"),
      envelopeId: z.uuid(),
      ownerId: ownerIdSchema
    }),
    baseEnvelopeSchema.extend({
      type: z.literal("shutdown"),
      envelopeId: z.uuid()
    })
  ]);

export const desktopCollaborationBrokerChildErrorCodeSchema = z.enum([
  "invalid_message",
  "duplicate_request",
  "unknown_owner",
  "unknown_command",
  "timeout",
  "internal_error"
]);

export const desktopCollaborationBrokerChildMessageSchema =
  z.discriminatedUnion("type", [
    baseEnvelopeSchema.extend({
      type: z.literal("ready"),
      brokerPid: z.number().int().positive()
    }),
    baseEnvelopeSchema.extend({
      type: z.literal("command_result"),
      envelopeId: z.uuid(),
      ownerId: ownerIdSchema,
      result: collaborationCommandResultSchema
    }),
    baseEnvelopeSchema.extend({
      type: z.literal("renderer_event"),
      ownerId: ownerIdSchema,
      event: collaborationRendererEventSchema
    }),
    baseEnvelopeSchema.extend({
      type: z.literal("open_external"),
      envelopeId: z.uuid(),
      ownerId: ownerIdSchema,
      url: browserUrlSchema
    }),
    baseEnvelopeSchema.extend({
      type: z.literal("owner_released"),
      envelopeId: z.uuid(),
      ownerId: ownerIdSchema
    }),
    baseEnvelopeSchema.extend({
      type: z.literal("shutdown_ack"),
      envelopeId: z.uuid()
    }),
    baseEnvelopeSchema.extend({
      type: z.literal("error"),
      envelopeId: z.uuid().nullable(),
      ownerId: ownerIdSchema.nullable(),
      code: desktopCollaborationBrokerChildErrorCodeSchema,
      message: z.string().min(1).max(512)
    })
  ]);

export type DesktopCollaborationBrokerParentMessage = z.infer<
  typeof desktopCollaborationBrokerParentMessageSchema
>;

export type DesktopCollaborationBrokerChildMessage = z.infer<
  typeof desktopCollaborationBrokerChildMessageSchema
>;

export const measureDesktopCollaborationBrokerMessageBytes = (
  value: unknown
): number => Buffer.byteLength(JSON.stringify(value), "utf8");
