import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  listWorkItemsFromDocSources,
  readWorkItemsFromDocPage
} from "./work-items-from-doc-tool.js";

const inputSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("list"),
      cursor: z.number().int().nonnegative().optional()
    })
    .strict(),
  z
    .object({
      mode: z.literal("read"),
      source_id: z.uuid().optional(),
      cursor: z.number().int().nonnegative().optional()
    })
    .strict()
]);

/** Reuses the 406 owner-scoped, revision-bound Project Source read path. */
export const registerFlashcardSourcesTool = (
  server: McpServer,
  environment: NodeJS.ProcessEnv = process.env,
  send: typeof fetch = fetch
): void => {
  server.registerTool(
    "flashcard_sources",
    {
      title: "Read Project Sources for flashcards",
      description:
        "List and read authorized current Project Sources in pages before generating flashcards. This tool only reads the current managed Conversation's Project and never reads Team Chat or another User's private content. Use memory_answer separately for exam scope, learning preferences and weak spots. Honor excluded material. A source ID or sourceRef is never write authority.",
      inputSchema,
      annotations: { readOnlyHint: true }
    },
    async (value) => {
      const parsed = inputSchema.parse(value);
      const page =
        parsed.mode === "list"
          ? await listWorkItemsFromDocSources(parsed, environment, send)
          : await readWorkItemsFromDocPage(parsed, environment, send);
      return {
        structuredContent: page,
        content: [{ type: "text" as const, text: JSON.stringify(page) }]
      };
    }
  );
};
