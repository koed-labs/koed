import { z } from "zod";

export const agentPermissionModeSchema = z.enum([
  "supervised",
  "auto_edit",
  "auto",
  "full_access"
]);

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type AgentLook = Record<string, JsonValue>;

/** A conservative budget leaves room for PostgreSQL JSONB's textual spacing. */
const safeLook = (root: unknown): root is AgentLook => {
  if (!root || typeof root !== "object" || Array.isArray(root)) return false;
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): boolean => {
    if (++nodes > 64 || depth > 4) return false;
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "number")
      return (
        Number.isFinite(value) &&
        Math.abs(value) <= 1_000_000_000 &&
        (value === 0 || Math.abs(value) >= 0.000001)
      );
    if (typeof value === "string")
      return value.length <= 512 && !value.includes("\u0000");
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value))
      return (
        value.length <= 16 && value.every((item) => visit(item, depth + 1))
      );
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      return false;
    const entries = Object.entries(value);
    return (
      entries.length <= 32 &&
      entries.every(
        ([key, item]) =>
          key.length > 0 &&
          key.length <= 64 &&
          !key.includes("\u0000") &&
          visit(item, depth + 1)
      )
    );
  };
  try {
    if (!visit(root, 0)) return false;
    return new TextEncoder().encode(JSON.stringify(root)).length <= 3000;
  } catch {
    return false;
  }
};

export const agentLookSchema = z.custom<AgentLook>(
  safeLook,
  "Invalid or oversized Agent look"
);

export const agentSchema = z
  .object({
    id: z.uuid(),
    ownerUserId: z.uuid(),
    name: z.string().trim().min(1).max(120),
    role: z.string().trim().min(1).max(240).nullable(),
    look: agentLookSchema,
    aiClientInstanceId: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/)
      .max(128),
    defaultPermissionMode: agentPermissionModeSchema,
    defaultModel: z.string().trim().min(1).max(512).nullable(),
    isChiefOfStaff: z.boolean(),
    createdAt: z.string().datetime()
  })
  .strict();

export const agentCreateSchema = agentSchema
  .pick({
    name: true,
    role: true,
    look: true,
    aiClientInstanceId: true,
    defaultPermissionMode: true,
    defaultModel: true
  })
  .strict();

export const agentPatchSchema = agentCreateSchema
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Agent patch must change a field"
  );

/** Only owner-bound configuration needed to choose an initial Chief binding. */
export const agentBootstrapContextSchema = z
  .object({
    ownerUserId: z.uuid(),
    savedConversations: z
      .object({
        provider: agentSchema.shape.aiClientInstanceId,
        aiClientInstanceId: agentSchema.shape.aiClientInstanceId
      })
      .strict()
      .nullable(),
    enabledInstances: z
      .array(
        z
          .object({
            instanceId: agentSchema.shape.aiClientInstanceId,
            driverId: agentSchema.shape.aiClientInstanceId
          })
          .strict()
      )
      .max(256)
  })
  .strict();

export type Agent = z.infer<typeof agentSchema>;
export type AgentCreate = z.infer<typeof agentCreateSchema>;
export type AgentPatch = z.infer<typeof agentPatchSchema>;
export type AgentBootstrapContext = z.infer<typeof agentBootstrapContextSchema>;
