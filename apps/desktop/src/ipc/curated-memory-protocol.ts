import { z } from "zod";

export const curatedMemoryCommandChannel = "koed:curated-memory:command";
const id = z.uuid();
const scope = z.enum(["project", "me", "unscoped"]);
export const memoryCursorSchema = z
  .object({ updatedAt: z.string().datetime({ offset: true }), id })
  .strict();
export type MemoryCursor = z.infer<typeof memoryCursorSchema>;
export type CuratedMemoryPage = {
  assertions: CuratedAssertion[];
  nextCursor: MemoryCursor | null;
};
const kind = z.enum(["decision", "fact", "learning", "preference"]).nullable();
const author = z
  .object({ kind: z.string(), ref: z.string() })
  .strict()
  .nullable();
const source = z
  .object({
    id,
    sourceType: z.string(),
    sourceRole: z.string(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.string()
  })
  .passthrough();
export const curatedAssertionSchema = z
  .object({
    id,
    ownerUserId: id,
    scope,
    projectId: id.nullable(),
    kind,
    authorKind: z.string().nullable(),
    authorRef: z.string().nullable(),
    visibility: z.string(),
    sharedBy: z.string().optional(),
    classificationVersion: z.number().int().positive(),
    assertionText: z.string(),
    status: z.string(),
    createdAt: z.string(),
    observedAt: z.string(),
    updatedAt: z.string(),
    suppressionToken: z.string().nullable(),
    sources: z.array(source),
    replaces: z.array(
      z.object({ id, text: z.string(), author, at: z.string() }).strict()
    )
  })
  .passthrough();
export type CuratedAssertion = z.infer<typeof curatedAssertionSchema>;

export const curatedMemoryRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("list"),
      scope,
      projectId: id.optional(),
      cursor: memoryCursorSchema.optional(),
      since: z.string().datetime({ offset: true }).optional()
    })
    .strict(),
  z.object({ operation: z.literal("detail"), assertionId: id }).strict(),
  z.object({ operation: z.literal("forget"), assertionId: id }).strict(),
  z
    .object({
      operation: z.literal("undo"),
      assertionId: id,
      suppressionToken: z.string().regex(/^\d{1,20}$/)
    })
    .strict(),
  z
    .object({
      operation: z.literal("move"),
      assertionId: id,
      scope: z.enum(["project", "me"]),
      projectId: id.optional(),
      expectedVersion: z.number().int().positive()
    })
    .strict()
]);
export type CuratedMemoryRequest = z.infer<typeof curatedMemoryRequestSchema>;
export const curatedMemoryResultSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("list"),
      assertions: z.array(curatedAssertionSchema),
      nextCursor: memoryCursorSchema.nullable()
    })
    .strict(),
  z
    .object({
      operation: z.literal("detail"),
      assertion: curatedAssertionSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("forget"),
      assertion: curatedAssertionSchema
    })
    .strict(),
  z
    .object({ operation: z.literal("undo"), assertion: curatedAssertionSchema })
    .strict(),
  z
    .object({
      operation: z.literal("move"),
      assertion: curatedAssertionSchema.nullable(),
      pending: z.boolean()
    })
    .strict()
]);
export type CuratedMemoryResult = z.infer<typeof curatedMemoryResultSchema>;
export interface CuratedMemoryDesktopApi {
  page(
    scope: "project" | "me" | "unscoped",
    projectId?: string,
    cursor?: MemoryCursor,
    since?: string
  ): Promise<CuratedMemoryPage>;
  list(
    scope: "project" | "me" | "unscoped",
    projectId?: string
  ): Promise<CuratedAssertion[]>;
  detail(assertionId: string): Promise<CuratedAssertion>;
  forget(assertionId: string): Promise<CuratedAssertion>;
  undo(
    assertionId: string,
    suppressionToken: string
  ): Promise<CuratedAssertion>;
  move(
    assertionId: string,
    scope: "project" | "me",
    expectedVersion: number,
    projectId?: string
  ): Promise<{ assertion: CuratedAssertion | null; pending: boolean }>;
}
