import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

// These tools only emit a request. A managed worker verifies the provider
// completion, current execution lease, cited source and User authority before
// performing an action. In particular, an MCP caller cannot supply a User ID.
export const memoryActionReferenceSchema = z
  .object({
    citation_alias: z
      .string()
      .regex(/^r[0-9a-f]{32}c[1-9][0-9]*$/)
      .max(128)
      .optional(),
    reference: z.string().trim().min(1).max(500).optional()
  })
  .strict();

export const memoryForgetInputSchema = memoryActionReferenceSchema;
export const memoryCorrectInputSchema = memoryActionReferenceSchema.safeExtend({
  correction: z.string().trim().min(1).max(4_000),
  user_statement: z.string().trim().min(1).max(16_000)
});

export type MemoryForgetInput = z.infer<typeof memoryForgetInputSchema>;
export type MemoryCorrectInput = z.infer<typeof memoryCorrectInputSchema>;

export const memoryActionRequestText = (
  name: "memory_forget" | "memory_correct"
): string => `Koed ${name} request v1: {"status":"requested"}`;

export const registerMemoryActionTools = (server: McpServer): void => {
  for (const name of ["memory_forget", "memory_correct"] as const) {
    server.registerTool(
      name,
      {
        title: name === "memory_forget" ? "Forget memory" : "Correct memory",
        description:
          name === "memory_forget"
            ? "Request to forget the User's own cited Curated Memory. Use only when the User explicitly asks. Supply an exact citation alias when given; otherwise Koed checks the latest citation actually shown in this Conversation. The managed worker verifies ownership and returns the outcome with Undo. Ambiguous or teammate sources require a User decision."
            : "Request a source-linked correction to the User's own cited Curated Memory. Include the exact User statement and a proposed correction. This creates a reviewed supersede proposal; it does not overwrite the assertion.",
        inputSchema:
          name === "memory_forget"
            ? memoryForgetInputSchema
            : memoryCorrectInputSchema,
        annotations: { readOnlyHint: false, destructiveHint: true }
      },
      () =>
        Promise.resolve({
          structuredContent: { status: "requested" },
          content: [
            { type: "text" as const, text: memoryActionRequestText(name) }
          ]
        })
    );
  }
};
