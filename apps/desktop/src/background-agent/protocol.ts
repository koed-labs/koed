import { z } from "zod";

export const BACKGROUND_AGENT_PROTOCOL_VERSION = 1;

const requestId = z.uuid();
const installationId = z.uuid();
const homeIdentity = z.string().regex(/^[a-f0-9]{64}$/);
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const requestEnvelopeIdentity = {
  protocolVersion: z.number().int(),
  requestId,
  installationId,
  homeIdentity
};

const requestIdentity = {
  protocolVersion: z.literal(BACKGROUND_AGENT_PROTOCOL_VERSION),
  requestId,
  installationId,
  homeIdentity
};

export const backgroundAgentRequestEnvelopeSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({ ...requestEnvelopeIdentity, kind: z.literal("hello") }),
    z.strictObject({ ...requestEnvelopeIdentity, kind: z.literal("status") }),
    z.strictObject({
      ...requestEnvelopeIdentity,
      kind: z.literal("start"),
      expectedGeneration: generation,
      explicit: z.boolean()
    }),
    z.strictObject({
      ...requestEnvelopeIdentity,
      kind: z.literal("stop"),
      expectedGeneration: generation,
      explicit: z.boolean()
    })
  ]
);

export type BackgroundAgentRequestEnvelope = z.infer<
  typeof backgroundAgentRequestEnvelopeSchema
>;

export class BackgroundAgentProtocolVersionError extends Error {
  constructor(readonly request: BackgroundAgentRequestEnvelope) {
    super("Background Agent protocol version is not supported.");
    this.name = "BackgroundAgentProtocolVersionError";
  }
}

export const backgroundAgentRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...requestIdentity, kind: z.literal("hello") }),
  z.strictObject({ ...requestIdentity, kind: z.literal("status") }),
  z.strictObject({
    ...requestIdentity,
    kind: z.literal("start"),
    expectedGeneration: generation,
    explicit: z.boolean()
  }),
  z.strictObject({
    ...requestIdentity,
    kind: z.literal("stop"),
    expectedGeneration: generation,
    explicit: z.boolean()
  })
]);

export type BackgroundAgentRequest = z.infer<
  typeof backgroundAgentRequestSchema
>;

export const backgroundAgentResponseSchema = z.strictObject({
  protocolVersion: z.literal(BACKGROUND_AGENT_PROTOCOL_VERSION),
  requestId,
  installationId,
  homeIdentity,
  kind: z.enum(["hello", "status", "start", "stop"]),
  generation,
  state: z.enum([
    "disabled",
    "stopped",
    "starting",
    "ready",
    "needs_attention"
  ]),
  ok: z.boolean(),
  message: z.string().max(512).optional(),
  errorCode: z
    .enum([
      "protocol_mismatch",
      "installation_mismatch",
      "home_mismatch",
      "stale_generation",
      "not_authorized",
      "not_ready",
      "start_failed",
      "stop_failed"
    ])
    .optional()
});

export type BackgroundAgentResponse = z.infer<
  typeof backgroundAgentResponseSchema
>;

export const parseBackgroundAgentRequest = (payload: string) => {
  const value = parseJsonValue(payload);
  const envelope = backgroundAgentRequestEnvelopeSchema.safeParse(value);
  if (
    envelope.success &&
    envelope.data.protocolVersion !== BACKGROUND_AGENT_PROTOCOL_VERSION
  ) {
    throw new BackgroundAgentProtocolVersionError(envelope.data);
  }
  return parseValue(backgroundAgentRequestSchema, value);
};

export const createProtocolMismatchResponse = (
  request: BackgroundAgentRequestEnvelope
): BackgroundAgentResponse => ({
  protocolVersion: BACKGROUND_AGENT_PROTOCOL_VERSION,
  requestId: request.requestId,
  installationId: request.installationId,
  homeIdentity: request.homeIdentity,
  kind: request.kind,
  generation:
    request.kind === "start" || request.kind === "stop"
      ? request.expectedGeneration
      : 0,
  state: "needs_attention",
  ok: false,
  errorCode: "protocol_mismatch",
  message: "This Desktop and Background Agent use incompatible protocols."
});

export const parseBackgroundAgentResponse = (payload: string) =>
  parseJson(backgroundAgentResponseSchema, payload);

const parseJson = <T>(schema: z.ZodType<T>, payload: string): T =>
  parseValue(schema, parseJsonValue(payload));

const parseJsonValue = (payload: string): unknown => {
  try {
    return JSON.parse(payload);
  } catch {
    throw new Error("Background Agent protocol payload is not valid JSON.");
  }
};

const parseValue = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Background Agent protocol payload is invalid.");
  }
  return parsed.data;
};
