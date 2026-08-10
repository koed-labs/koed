#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import {
  memoryAnswerToolDescription,
  memoryServerInstructions
} from "@koed/mcp-server";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const logPath = process.env.TOOL_CHOICE_LOG_PATH;
const fakeMemoryAnswer = (() => {
  const serialized = process.env.TOOL_CHOICE_FAKE_MEMORY_ANSWER;
  if (!serialized) {
    return undefined;
  }
  const parsed = JSON.parse(serialized) as {
    memoryStatus: "found" | "not_found";
    markdown: string;
  };
  return parsed;
})();

const description =
  process.env.TOOL_CHOICE_MEMORY_DESCRIPTION ?? memoryAnswerToolDescription;

const createServer = (): McpServer => {
  const server = new McpServer(
    {
      name: "koed-tool-choice-eval",
      title: "Koed Memory",
      version: "0.1.0"
    },
    {
      instructions: memoryServerInstructions,
      supportedProtocolVersions: ["2026-07-28"]
    }
  );

  server.registerTool(
    "memory_answer",
    {
      title: "Answer from memory",
      description,
      inputSchema: z
        .object({
          query: z.string().min(1),
          response_detail: z
            .enum(["answer_only", "with_citations", "with_evidence"])
            .default("answer_only"),
          search_domain: z
            .enum(["global", "project", "session"])
            .default("project"),
          project_id: z.string().min(1).optional(),
          session_id: z.string().uuid().optional(),
          limit: z.number().int().positive().max(50).default(10),
          include_evidence: z.boolean().default(false)
        })
        .strict()
    },
    async (input) => {
      const serializedInput = JSON.stringify(input).toLowerCase();
      const memoryStatus =
        fakeMemoryAnswer?.memoryStatus ??
        (/billing dashboard|codename/.test(serializedInput)
          ? "not_found"
          : "found");
      if (logPath) {
        await appendFile(
          logPath,
          `${JSON.stringify({
            toolName: "memory_answer",
            arguments: input,
            observedAt: new Date().toISOString()
          })}\n`
        );
      }

      const payload = {
        markdown:
          fakeMemoryAnswer?.markdown ??
          (memoryStatus === "found"
            ? "Memory contains relevant prior context for this question."
            : "No matching memory found."),
        localMemoryWorker: {
          status: "completed",
          memoryStatus
        },
        retrieval: {
          evidenceCount: memoryStatus === "found" ? 1 : 0
        }
      };

      return {
        structuredContent: payload,
        content: [
          {
            type: "text",
            text: JSON.stringify(payload)
          }
        ]
      };
    }
  );
  return server;
};

serveStdio(() => createServer(), { legacy: "reject" });
