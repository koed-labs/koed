#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
  process.env.TOOL_CHOICE_MEMORY_DESCRIPTION ??
  "Answer a question from Koed memory: captured Codex conversations, saved sessions, project history, prior decisions, remembered user preferences, user-provided facts, setup/debugging work, and past discussions. Call this tool for recall-style requests such as 'what did we decide', 'remind me', 'previously', 'ever discussed', 'do I usually', 'in that session', or 'look back'. Do not call it for public facts, current visible context, generic programming knowledge, or direct file-editing tasks. Use one concise query per distinct topic and do not repeat after a clear not-found answer. Default to search_domain=project for current workspace/project history; use search_domain=session for a known saved conversation/thread, and search_domain=global only for broad cross-project/personal-history recall. Defaults to response_detail=answer_only; use with_citations only when the user asks to verify sources, and with_evidence only for debugging or UI inspection.";

const server = new McpServer(
  {
    name: "koed-tool-choice-eval",
    title: "Koed Memory",
    version: "0.1.0"
  },
  {
    instructions:
      "Koed memory retrieves and answers from the user's captured Codex history. Use Koed memory when the user asks about prior conversations, previous project decisions, remembered preferences, user-provided facts, earlier setup/debugging work, saved sessions, or whether something was discussed before. Default to project scope for project history, project decisions, setup choices, and repo-specific context. Use session scope for a specific saved conversation/thread, exact-session recap, or a question that names this session when a backend session_id is available. Use global scope only for cross-project, anywhere, broad personal-history, or not-sure-which-project questions. Make at most one memory_answer call per distinct topic unless the first result is clearly incomplete, the user asks for source detail, or the answer needs a different scope. Do not keep querying memory after a clear not-found result. Even if something seems familiar from current context, use Koed memory to verify prior decisions, exact recaps, or remembered preferences when the relevant detail may have been compacted, summarized, or omitted. Do not use Koed memory for public facts, current visible context, generic coding knowledge, or tasks answerable from files/messages already provided."
  }
);

server.registerTool(
  "memory_answer",
  {
    title: "Answer from memory",
    description,
    inputSchema: {
      query: z.string().min(1),
      response_detail: z
        .enum(["answer_only", "with_citations", "with_evidence"])
        .default("answer_only"),
      search_domain: z
        .enum(["global", "project", "session"])
        .default("project"),
      workspace_id: z.string().min(1).optional(),
      session_id: z.string().uuid().optional(),
      limit: z.number().int().positive().max(50).default(10),
      include_evidence: z.boolean().default(false)
    }
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

await server.connect(new StdioServerTransport());
