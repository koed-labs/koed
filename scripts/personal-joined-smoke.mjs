#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  assertMemoryAnswerDetailModes,
  parseToolJson
} from "./personal-joined-smoke-lib.mjs";

const apiUrl = (process.env.MEMORY_API_URL ?? "http://127.0.0.1:3300").replace(
  /\/+$/,
  ""
);
const apiToken = process.env.MEMORY_API_TOKEN?.trim();
const databaseUrl = process.env.DATABASE_URL?.trim();
const mcpTimeoutMs = Number.parseInt(
  process.env.PERSONAL_JOINED_MCP_TIMEOUT_MS ?? "240000",
  10
);
if (!apiToken || !databaseUrl) {
  throw new Error("MEMORY_API_TOKEN and DATABASE_URL are required.");
}
if (!Number.isFinite(mcpTimeoutMs) || mcpTimeoutMs < 1_000) {
  throw new Error("PERSONAL_JOINED_MCP_TIMEOUT_MS must be at least 1000.");
}

const marker = `personal-joined-${Date.now()}-${randomUUID().slice(0, 8)}`;

execFileSync(
  process.execPath,
  [
    "scripts/lcm-smoke-test.mjs",
    "--api-url",
    apiUrl,
    "--api-token",
    apiToken,
    "--database-url",
    databaseUrl,
    "--marker",
    marker
  ],
  { cwd: process.cwd(), env: process.env, stdio: "inherit" }
);

const client = new Client({
  name: "koed-personal-joined-smoke",
  version: "1.0.0"
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["packages/mcp-server/dist/cli.js"],
  cwd: process.cwd(),
  env: process.env,
  stderr: "inherit"
});
await client.connect(transport);
try {
  const responses = {};
  for (const mode of ["answer_only", "with_citations", "with_evidence"]) {
    const result = await client.callTool(
      {
        name: "memory_answer",
        arguments: {
          query: `What durable fact contains summary-check-${marker}-01?`,
          retrieval_hints: { exact: [`summary-check-${marker}-01`] },
          response_detail: mode,
          search_domain: "global",
          limit: 10
        }
      },
      { timeout: mcpTimeoutMs }
    );
    responses[mode] = parseToolJson(result, mode);
  }
  const detailModes = assertMemoryAnswerDetailModes(responses, marker);
  process.stdout.write(
    `${JSON.stringify({ ok: true, marker, lcmExpansion: "passed", detailModes }, null, 2)}\n`
  );
} finally {
  await client.close();
}
