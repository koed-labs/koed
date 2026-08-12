#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { LocalAiRuntimeClient } from "./local-runtime-client.js";
import { logger } from "./logger.js";
import { createKoedMcpServer } from "./mcp-server-factory.js";

const command = process.argv.slice(2).find((value) => !value.startsWith("--"));

if (command === "doctor") {
  try {
    const client = new LocalAiRuntimeClient();
    const [capabilities, accessCheck] = await Promise.all([
      client.capabilities(),
      client.callTool(
        "memory_access_check",
        { include_notes: true },
        { cwd: process.cwd() }
      )
    ]);
    console.log(
      JSON.stringify({ ok: true, capabilities, accessCheck }, null, 2)
    );
    process.exit(0);
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

if (command) {
  console.error(`Unknown koed MCP command: ${command}`);
  process.exit(1);
}

const handle = serveStdio((context) => createKoedMcpServer(context), {
  legacy: "serve",
  onerror: (error) => logger.error({ err: error }, "koed MCP transport error")
});

logger.info("koed MCP v2 stdio adapter connected");

let stopping = false;
const stop = async (exitCode: number) => {
  if (stopping) return;
  stopping = true;
  logger.info("koed MCP v2 stdio adapter shutting down");
  await handle.close();
  process.exit(exitCode);
};

process.once("SIGINT", () => void stop(130));
process.once("SIGTERM", () => void stop(143));
