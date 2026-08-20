import { z } from "zod";
import { metadataSchema, visibilitySchema } from "./common-schemas.js";

const captureStateSchema = z.enum(["enabled", "disabled", "ask"]);

const memoryActorSchema = z.enum([
  "user",
  "assistant",
  "agent",
  "subagent",
  "tool",
  "system"
]);

const personalProjectReferenceSchema = z
  .object({
    id: z.string().trim().min(1).max(512),
    name: z.string().trim().min(1).max(160),
    path: z.string().trim().min(1).max(4096).nullable().optional()
  })
  .strict()
  .transform((project) => ({ ...project, path: project.path ?? null }));

export const createMcpSessionSchema = z.object({
  projectId: z.string().trim().min(1).max(512).optional(),
  externalSessionId: z.string().min(1).optional(),
  sourceRuntime: z
    .enum(["codex", "codex-cli", "claude-code", "pi"])
    .default("codex"),
  captureMethod: z.enum(["transcript", "mcp", "web", "api"]).default("mcp"),
  model: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
  sourceHash: z.string().min(1).optional(),
  metadata: metadataSchema,
  detectedProjects: z.array(personalProjectReferenceSchema).max(20).optional()
});

export const latestCapturedSessionQuerySchema = z
  .object({
    project_id: z.string().trim().min(1)
  })
  .strict();

export const capturedSessionQuerySchema = z
  .object({
    project_id: z.string().trim().min(1).optional()
  })
  .strict();

export const mcpSessionEventSchema = z.object({
  projectId: z.string().min(1).default("default"),
  turnId: z.string().uuid().optional(),
  actor: memoryActorSchema,
  eventType: z.string().min(1).default("session_event"),
  content: z.string().min(1),
  metadata: metadataSchema
});

export const capturePersonalEventSchema = z.object({
  projectId: z.string().min(1).default("default"),
  sessionId: z.string().uuid().optional(),
  turnId: z.string().uuid().optional(),
  actor: memoryActorSchema,
  eventType: z.string().min(1),
  content: z.string().min(1),
  metadata: metadataSchema,
  sourceRuntime: z
    .enum(["codex", "codex-cli", "claude-code", "pi"])
    .default("codex-cli"),
  captureMethod: z
    .enum(["transcript", "mcp", "web", "api"])
    .default("transcript"),
  idempotencyKey: z.string().min(1).optional(),
  sourceHash: z.string().min(1).optional()
});

export const capturePolicySchema = z.object({
  targetType: z.enum(["global", "project", "thread"]),
  projectId: z.string().min(1).optional(),
  projectName: z.string().min(1).optional(),
  projectPath: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  threadName: z.string().min(1).optional(),
  captureState: captureStateSchema.nullable().optional(),
  visibility: visibilitySchema.nullable().optional(),
  pauseUntil: z.string().datetime({ offset: true }).nullable().optional()
});

export const effectivePolicyQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  sessionId: z.string().uuid().optional()
});

export const capturePoliciesQuerySchema = z.object({
  targetType: z.enum(["global", "project", "thread"]).optional()
});

export const sessionIdParamsSchema = z.object({
  sessionId: z.string().uuid()
});
