import { z } from "zod";

export const LOCAL_CONTROL_PROTOCOL_VERSION = 1;

const identifier = z.string().min(1).max(256);
const revision = z.number().int().nonnegative().safe();
const reason = z.enum([
  "desktop-session",
  "background-agent",
  "persistent-cli"
]);

export const controlCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("status") }),
  z.strictObject({ action: z.literal("start"), explicit: z.boolean() }),
  z.strictObject({ action: z.literal("stop"), explicit: z.boolean() }),
  z.strictObject({ action: z.literal("attach"), reason }),
  z.strictObject({
    action: z.literal("detach"),
    reason,
    intentional: z.boolean()
  }),
  z.strictObject({ action: z.literal("retire") })
]);

export const controlRequestSchema = z.strictObject({
  requestId: identifier,
  instanceId: identifier,
  expectedRevision: revision,
  command: controlCommandSchema
});

export const controlSnapshotSchema = z.strictObject({
  instanceId: identifier,
  revision,
  state: z.enum([
    "stopped",
    "starting",
    "ready",
    "stopping",
    "needs_attention"
  ]),
  stopIntent: z.boolean(),
  error: z.string().max(4096).optional()
});

export const controlErrorCodeSchema = z.enum([
  "invalid_request",
  "stale_revision",
  "blocked",
  "incompatible",
  "busy",
  "unsupported_operation"
]);

export const controlReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({
    requestId: identifier,
    ok: z.literal(true),
    snapshot: controlSnapshotSchema
  }),
  z.strictObject({
    requestId: identifier,
    ok: z.literal(false),
    code: controlErrorCodeSchema,
    snapshot: controlSnapshotSchema
  })
]);

export const controlHelloSchema = z.strictObject({
  protocolVersion: z.literal(LOCAL_CONTROL_PROTOCOL_VERSION),
  home: z.string().min(1).max(4096),
  installationId: identifier,
  productVersion: identifier,
  instanceId: identifier,
  pid: z.number().int().positive().safe(),
  processIdentity: identifier,
  nonce: identifier
});

export type AvailabilityReason = z.infer<typeof reason>;
export type ControlCommand = z.infer<typeof controlCommandSchema>;
export type ControlRequest = z.infer<typeof controlRequestSchema>;
export type ControlSnapshot = z.infer<typeof controlSnapshotSchema>;
export type ControlErrorCode = z.infer<typeof controlErrorCodeSchema>;
export type ControlReply = z.infer<typeof controlReplySchema>;
export type ControlHello = z.infer<typeof controlHelloSchema>;
