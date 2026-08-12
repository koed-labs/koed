#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const logPath = process.env.CURATED_MEMORY_INTAKE_LOG_PATH;

const createServer = (): McpServer => {
  const server = new McpServer(
    {
      name: "koed-curated-memory-intake-eval",
      title: "Koed Memory",
      version: "0.1.0"
    },
    {
      instructions:
        "Propose Curated Memory only for stable user-provided facts, preferences, corrections, decisions, plans, or relationships that will be useful later. Do not propose public facts, acknowledgements, one-off requests, task control, transient output, or agent-originated claims. Submit a concise candidate and the exact supporting User statement; a separate reviewer will verify and rewrite it from source evidence.",
      supportedProtocolVersions: ["2026-07-28"]
    }
  );

  server.registerTool(
    "memory_intake_propose",
    {
      title: "Propose Curated Memory",
      description:
        "Propose a durable Curated Memory candidate for asynchronous evidence review. Include the exact supporting User statement in evidence_exact_quote. Do not call for public facts, transient task state, acknowledgements, guesses, agent-originated claims, or facts without direct user evidence.",
      inputSchema: z
        .object({
          proposed_claim: z.string().min(1).max(4000),
          proposed_topic: z.string().min(1).max(500).optional(),
          rationale: z.string().max(4000).optional(),
          tags: z.array(z.string().min(1).max(80)).max(20).default([]),
          sensitivity_hint: z
            .enum(["normal", "sensitive", "review_required"])
            .default("normal"),
          expires_at: z.string().datetime({ offset: true }).optional(),
          evidence_exact_quote: z
            .string()
            .min(1)
            .max(16_000)
            .describe("The exact supporting User statement.")
        })
        .strict()
    },
    async (input) => {
      if (logPath) {
        await appendFile(
          logPath,
          `${JSON.stringify({
            toolName: "memory_intake_propose",
            arguments: input,
            observedAt: new Date().toISOString()
          })}\n`
        );
      }
      const payload = { accepted: true, status: "pending" };
      return {
        structuredContent: payload,
        content: [{ type: "text", text: JSON.stringify(payload) }]
      };
    }
  );
  return server;
};

serveStdio(() => createServer(), { legacy: "reject" });
