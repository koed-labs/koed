import { z } from "zod";

export const MANAGED_TERMINAL_PROTOCOL_VERSION = 1 as const;
export const MANAGED_TERMINAL_MAX_FRAME_BYTES = 64 * 1024;
export const MANAGED_TERMINAL_MAX_DATA_BYTES = 40 * 1024;
export const MANAGED_TERMINAL_MAX_CONTEXT_BYTES = 128 * 1024;
export const MANAGED_TERMINAL_CONTEXT_TTL_SECONDS = 15 * 60;

export const managedTerminalLifecycleStates = [
  "creating",
  "running",
  "detached",
  "stopping",
  "unknown",
  "exited",
  "failed"
] as const;

export const managedTerminalLifecycleStateSchema = z.enum(
  managedTerminalLifecycleStates
);
export type ManagedTerminalLifecycleState = z.infer<
  typeof managedTerminalLifecycleStateSchema
>;

export const managedTerminalShellProfileSchema = z
  .object({
    id: z.literal("system_default"),
    label: z.string().min(1).max(80),
    available: z.boolean()
  })
  .strict();
export type ManagedTerminalShellProfile = z.infer<
  typeof managedTerminalShellProfileSchema
>;

const terminalDimensions = {
  columns: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(300)
} as const;

export const createManagedTerminalInputSchema = z
  .object({
    executionGeneration: z.number().int().safe().positive(),
    idempotencyKey: z.string().trim().min(16).max(160),
    shellProfileId: z.literal("system_default"),
    ...terminalDimensions
  })
  .strict();
export type CreateManagedTerminalInput = z.infer<
  typeof createManagedTerminalInputSchema
>;

export const managedTerminalRecordSchema = z
  .object({
    id: z.uuid(),
    executionId: z.uuid(),
    executionGeneration: z.number().int().safe().positive(),
    workspaceId: z.uuid(),
    runnerDeploymentId: z.string().trim().min(1).max(160),
    runnerDeviceId: z.string().trim().min(1).max(160),
    lifecycleGeneration: z.number().int().safe().positive(),
    shellProfileId: z.literal("system_default"),
    state: managedTerminalLifecycleStateSchema,
    ...terminalDimensions,
    exitCode: z.number().int().nullable(),
    exitSignal: z.number().int().nonnegative().nullable(),
    failureCode: z.string().trim().min(1).max(120).nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    startedAt: z.iso.datetime({ offset: true }).nullable(),
    detachedAt: z.iso.datetime({ offset: true }).nullable(),
    stoppedAt: z.iso.datetime({ offset: true }).nullable(),
    updatedAt: z.iso.datetime({ offset: true })
  })
  .strict();
export type ManagedTerminalRecord = z.infer<typeof managedTerminalRecordSchema>;

const terminalFrameBase = {
  protocolVersion: z.literal(MANAGED_TERMINAL_PROTOCOL_VERSION),
  terminalId: z.uuid(),
  lifecycleGeneration: z.number().int().safe().positive()
} as const;

const terminalDataSchema = z
  .string()
  .max(Math.ceil((MANAGED_TERMINAL_MAX_DATA_BYTES * 4) / 3) + 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

export const managedTerminalClientFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...terminalFrameBase,
      type: z.literal("terminal.input"),
      inputEpoch: z.uuid(),
      sequence: z.number().int().safe().positive(),
      dataBase64: terminalDataSchema
    })
    .strict(),
  z
    .object({
      ...terminalFrameBase,
      type: z.literal("terminal.resize"),
      sequence: z.number().int().safe().positive(),
      ...terminalDimensions
    })
    .strict(),
  z
    .object({
      ...terminalFrameBase,
      type: z.literal("terminal.interrupt"),
      sequence: z.number().int().safe().positive()
    })
    .strict(),
  z
    .object({
      ...terminalFrameBase,
      type: z.literal("terminal.stop"),
      sequence: z.number().int().safe().positive()
    })
    .strict(),
  z
    .object({
      ...terminalFrameBase,
      type: z.literal("terminal.context.capture"),
      requestId: z.uuid(),
      fromOutputSequence: z.number().int().safe().nonnegative(),
      toOutputSequence: z.number().int().safe().nonnegative()
    })
    .strict()
    .refine(
      (value) => value.toOutputSequence >= value.fromOutputSequence,
      "Terminal context range is invalid"
    )
]);
export type ManagedTerminalClientFrame = z.infer<
  typeof managedTerminalClientFrameSchema
>;

export const managedTerminalServerFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...terminalFrameBase,
      type: z.literal("terminal.ready"),
      requestedAfterOutputSequence: z.number().int().safe().nonnegative(),
      earliestOutputSequence: z.number().int().safe().nonnegative(),
      latestOutputSequence: z.number().int().safe().nonnegative(),
      inputEpoch: z.uuid()
    })
    .strict(),
  z
    .object({
      ...terminalFrameBase,
      type: z.literal("terminal.output"),
      sequence: z.number().int().safe().positive(),
      dataBase64: terminalDataSchema
    })
    .strict(),
  z
    .object({
      ...terminalFrameBase,
      type: z.literal("terminal.input_ack"),
      inputEpoch: z.uuid(),
      sequence: z.number().int().safe().positive()
    })
    .strict(),
  z
    .object({
      ...terminalFrameBase,
      type: z.literal("terminal.replay_gap"),
      requestedAfterOutputSequence: z.number().int().safe().nonnegative(),
      earliestOutputSequence: z.number().int().safe().positive()
    })
    .strict(),
  z
    .object({
      ...terminalFrameBase,
      type: z.literal("terminal.context.captured"),
      requestId: z.uuid(),
      contextReference: z.string().regex(/^mtc1_[A-Za-z0-9_-]{43}$/),
      contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
      expiresAt: z.iso.datetime({ offset: true })
    })
    .strict(),
  z
    .object({
      ...terminalFrameBase,
      type: z.literal("terminal.exit"),
      exitCode: z.number().int().nullable(),
      exitSignal: z.number().int().nonnegative().nullable(),
      failureCode: z.string().trim().min(1).max(120).nullable()
    })
    .strict(),
  z
    .object({
      ...terminalFrameBase,
      type: z.literal("terminal.error"),
      code: z.string().trim().min(1).max(120)
    })
    .strict()
]);
export type ManagedTerminalServerFrame = z.infer<
  typeof managedTerminalServerFrameSchema
>;

export const managedTerminalContextReferenceSchema = z
  .object({
    contextReference: z.string().regex(/^mtc1_[A-Za-z0-9_-]{43}$/),
    terminalId: z.uuid(),
    lifecycleGeneration: z.number().int().safe().positive(),
    fromOutputSequence: z.number().int().safe().nonnegative(),
    toOutputSequence: z.number().int().safe().nonnegative(),
    contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
    expiresAt: z.iso.datetime({ offset: true })
  })
  .strict();
export type ManagedTerminalContextReference = z.infer<
  typeof managedTerminalContextReferenceSchema
>;
